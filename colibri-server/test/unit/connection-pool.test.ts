import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, Subscription, config as rxjsConfig } from 'rxjs';
import { ConnectionPool, NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/command-hooks/connection-pool.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';

class FakeServer implements NetworkServer {
    public clientConnectedSource = new Subject<NetworkClient>();
    public clientDisconnectedSource = new Subject<NetworkClient>();
    public messagesSource = new Subject<NetworkMessage>();
    public clients: NetworkClient[] = [];
    public broadcasts: { message: NetworkMessage; clients: ReadonlyArray<NetworkClient> }[] = [];
    public broadcastToAppCalls: { message: NetworkMessage; app: string; exceptClientId?: string }[] = [];

    public constructor(private readonly supportsBroadcastToApp = false) {
        if (supportsBroadcastToApp) {
            this.broadcastToApp = (message, app, exceptClientId) => {
                this.broadcastToAppCalls.push({ message, app, exceptClientId });
            };
        }
    }

    public get currentClients(): ReadonlyArray<NetworkClient> {
        return this.clients;
    }
    public get clientConnected$() {
        return this.clientConnectedSource.asObservable();
    }
    public get clientDisconnected$() {
        return this.clientDisconnectedSource.asObservable();
    }
    public get messages$() {
        return this.messagesSource.asObservable();
    }

    public broadcastToApp?: (message: NetworkMessage, app: string, exceptClientId?: string) => void;

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>): void {
        this.broadcasts.push({ message, clients });
    }

    public connectClient(client: NetworkClient): void {
        this.clients.push(client);
        this.clientConnectedSource.next(client);
    }

    public disconnectClient(client: NetworkClient): void {
        this.clients = this.clients.filter(c => c.id !== client.id);
        this.clientDisconnectedSource.next(client);
    }
}

const makeClient = function (id: string, app: string): NetworkClient {
    return { id, app, name: id, version: '1', metadata: {} };
};

describe('ConnectionPool', () => {
    describe('onCommand / onMessage dispatch', () => {
        it('routes a message only to handlers registered for its exact command', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const updateHandler = vi.fn();
            const deleteHandler = vi.fn();
            pool.onCommand('model::update', updateHandler);
            pool.onCommand('model::delete', deleteHandler);

            const message: NetworkMessage = { channel: 'app::chan', command: 'model::update' };
            server.messagesSource.next(message);

            expect(updateHandler).toHaveBeenCalledWith(message);
            expect(deleteHandler).not.toHaveBeenCalled();
        });

        it('calls every handler registered for the same command', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const first = vi.fn();
            const second = vi.fn();
            pool.onCommand('model::update', first);
            pool.onCommand('model::update', second);

            const message: NetworkMessage = { channel: 'c', command: 'model::update' };
            server.messagesSource.next(message);

            expect(first).toHaveBeenCalledWith(message);
            expect(second).toHaveBeenCalledWith(message);
        });

        it('runs wildcard handlers whose predicate matches, regardless of command', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const handler = vi.fn();
            pool.onMessage(msg => msg.channel.startsWith('broadcast::'), handler);

            const matching: NetworkMessage = { channel: 'broadcast::x', command: 'anything' };
            const nonMatching: NetworkMessage = { channel: 'other', command: 'anything' };
            server.messagesSource.next(matching);
            server.messagesSource.next(nonMatching);

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler).toHaveBeenCalledWith(matching);
        });

        it('dispatches messages from every registered server through the same handler', () => {
            const serverA = new FakeServer();
            const serverB = new FakeServer();
            const pool = new ConnectionPool(serverA, serverB);

            const handler = vi.fn();
            pool.onCommand('model::update', handler);

            serverA.messagesSource.next({ channel: 'c', command: 'model::update' });
            serverB.messagesSource.next({ channel: 'c', command: 'model::update' });

            expect(handler).toHaveBeenCalledTimes(2);
        });
    });

    // A synchronous throw out of the pool's message subscription is rethrown by RxJS from a
    // timer, reaches uncaughtException and shuts the server down - one malformed message from
    // one client used to be able to take everyone offline.
    describe('a handler that throws', () => {
        let unhandled: unknown[];
        let logs: LogMessage[];
        let logSubscription: Subscription;
        const originalOnUnhandledError = rxjsConfig.onUnhandledError;

        beforeEach(() => {
            unhandled = [];
            rxjsConfig.onUnhandledError = err => unhandled.push(err);
            logs = [];
            logSubscription = Service.output$.subscribe(msg => logs.push(msg));
        });

        afterEach(() => {
            rxjsConfig.onUnhandledError = originalOnUnhandledError;
            logSubscription.unsubscribe();
        });

        // RxJS reports an unhandled subscriber error on a later timer tick.
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));

        const throwingHook = function (): never {
            throw new TypeError('payload.points is not iterable');
        };

        it('costs only that handler that message', async () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const sameCommand = vi.fn();
            const wildcard = vi.fn();
            pool.onCommand('model::update', throwingHook);
            pool.onCommand('model::update', sameCommand);
            pool.onMessage(() => true, wildcard);

            const message: NetworkMessage = { channel: 'appA::chan', command: 'model::update', origin: makeClient('a1', 'appA') };
            server.messagesSource.next(message);
            await settle();

            expect(unhandled).toEqual([]);
            expect(sameCommand).toHaveBeenCalledWith(message);
            expect(wildcard).toHaveBeenCalledWith(message);
        });

        it('logs the dropped message, naming the client', async () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);
            pool.onCommand('model::update', throwingHook);

            server.messagesSource.next({ channel: 'appA::chan', command: 'model::update', origin: makeClient('a1', 'appA') });
            await settle();

            const errors = logs.filter(l => l.level === LogLevel.Error).map(l => l.message);
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain('appA::chan / model::update');
            expect(errors[0]).toContain('a1');
            expect(errors[0]).toContain('payload.points is not iterable');
        });

        it('keeps dispatching the messages after it', async () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const handler = vi.fn((msg: NetworkMessage) => {
                if (msg.channel === 'bad') throwingHook();
            });
            pool.onCommand('model::update', handler);

            server.messagesSource.next({ channel: 'bad', command: 'model::update' });
            server.messagesSource.next({ channel: 'good', command: 'model::update' });
            await settle();

            expect(unhandled).toEqual([]);
            expect(handler).toHaveBeenCalledTimes(2);
        });

        it('covers a throwing onMessage predicate too', async () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);
            const after = vi.fn();
            pool.onMessage(throwingHook, vi.fn());
            pool.onMessage(() => true, after);

            server.messagesSource.next({ channel: 'c', command: 'anything' });
            await settle();

            expect(unhandled).toEqual([]);
            expect(after).toHaveBeenCalledTimes(1);
        });
    });

    describe('broadcast app isolation', () => {
        it('filters recipients to the origin\'s app on a server without broadcastToApp', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const clientA1 = makeClient('a1', 'appA');
            const clientA2 = makeClient('a2', 'appA');
            const clientB1 = makeClient('b1', 'appB');
            server.connectClient(clientA1);
            server.connectClient(clientA2);
            server.connectClient(clientB1);

            const message: NetworkMessage = { channel: 'c', command: 'model::update', origin: clientA1 };
            pool.broadcast(message);

            expect(server.broadcasts).toHaveLength(1);
            const recipients = server.broadcasts[0]!.clients;
            expect(recipients.map(c => c.id)).toEqual(['a2']);
        });

        it('uses the broadcastToApp fast path when the server supports it, instead of filtering', () => {
            const server = new FakeServer(true);
            const pool = new ConnectionPool(server);

            const origin = makeClient('a1', 'appA');
            const message: NetworkMessage = { channel: 'c', command: 'model::update', origin };
            pool.broadcast(message);

            expect(server.broadcasts).toHaveLength(0);
            expect(server.broadcastToAppCalls).toEqual([{ message, app: 'appA', exceptClientId: 'a1' }]);
        });

        // A TCP re-handshake is reported as the same id connecting again in another app. The
        // object it replaced used to stay in the old app's Set, so the old app's broadcasts
        // still reached the client on any transport without broadcastToApp.
        it('drops a client reported connected again in another app from its old app', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const sender = makeClient('a2', 'appA');
            server.connectClient(makeClient('a1', 'appA'));
            server.connectClient(sender);
            server.connectClient(makeClient('a1', 'appB'));

            pool.broadcast({ channel: 'c', command: 'model::update', origin: sender });
            pool.broadcast({ channel: 'c', command: 'model::update', origin: makeClient('b9', 'appB') });

            expect(server.broadcasts.map(b => b.clients.map(c => `${c.id} ${c.app}`))).toEqual([['a1 appB']]);
        });

        it('broadcasts to every client when no app is specified and no origin is set', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            server.connectClient(makeClient('a1', 'appA'));
            server.connectClient(makeClient('b1', 'appB'));

            pool.broadcast({ channel: 'c', command: 'model::update' });

            expect(server.broadcasts[0]!.clients).toHaveLength(2);
        });
    });

    describe('emit (targeted send)', () => {
        it('routes to the server that currently owns the client id', () => {
            const serverA = new FakeServer();
            const serverB = new FakeServer();
            const pool = new ConnectionPool(serverA, serverB);

            const client = makeClient('c1', 'appA');
            serverB.connectClient(client);

            const message: NetworkMessage = { channel: 'c', command: 'model::update' };
            pool.emit(message, client);

            expect(serverA.broadcasts).toHaveLength(0);
            expect(serverB.broadcasts).toEqual([{ message, clients: [client] }]);
        });

        it('does nothing once the client has disconnected', () => {
            const server = new FakeServer();
            const pool = new ConnectionPool(server);

            const client = makeClient('c1', 'appA');
            server.connectClient(client);
            server.disconnectClient(client);

            pool.emit({ channel: 'c', command: 'model::update' }, client);

            expect(server.broadcasts).toHaveLength(0);
        });
    });

    // Fan-out within an app is O(n^2): a class whose groups all kept one app name overloads the
    // server with every client connected and nothing refused, so nothing else would say why.
    describe('the shared-app warning', () => {
        let logs: LogMessage[];
        let logSubscription: Subscription;

        beforeEach(() => {
            logs = [];
            logSubscription = Service.output$.subscribe(msg => logs.push(msg));
        });

        afterEach(() => {
            logSubscription.unsubscribe();
        });

        const appWarnings = (): string[] =>
            logs.filter(l => l.level === LogLevel.Warn && l.message.includes('clients, more than')).map(l => l.message);

        const pool = function (threshold: number, ...servers: FakeServer[]): ConnectionPool {
            const connectionPool = new ConnectionPool(...servers);
            connectionPool.appClientWarningThreshold = threshold;
            return connectionPool;
        };

        it('warns once when an app grows past the threshold, naming it', () => {
            const server = new FakeServer();
            pool(3, server);

            for (let i = 1; i <= 3; i++) server.connectClient(makeClient(`c${i}`, 'myAppName'));
            expect(appWarnings()).toEqual([]);

            server.connectClient(makeClient('c4', 'myAppName'));
            server.connectClient(makeClient('c5', 'myAppName'));
            server.connectClient(makeClient('c6', 'myAppName'));

            expect(appWarnings()).toHaveLength(1);
            expect(appWarnings()[0]).toContain('App \'myAppName\' now has 4 clients, more than 3');
            expect(appWarnings()[0]).toContain('app name of its own');
        });

        it('counts the clients of both transports together', () => {
            const tcp = new FakeServer();
            const web = new FakeServer(true);
            pool(3, tcp, web);

            tcp.connectClient(makeClient('u1', 'shared'));
            tcp.connectClient(makeClient('u2', 'shared'));
            web.connectClient(makeClient('w1', 'shared'));
            expect(appWarnings()).toEqual([]);

            web.connectClient(makeClient('w2', 'shared'));
            expect(appWarnings()).toHaveLength(1);
        });

        it('only counts each app\'s own clients', () => {
            const server = new FakeServer();
            pool(3, server);

            for (let i = 0; i < 12; i++) server.connectClient(makeClient(`c${i}`, `group-${i % 4}`));

            expect(appWarnings()).toEqual([]);
        });

        it('warns again only after the app has shrunk back to the threshold and grown past it again', () => {
            const server = new FakeServer();
            pool(2, server);
            const clients = [1, 2, 3, 4].map(i => makeClient(`c${i}`, 'shared'));
            for (const client of clients) server.connectClient(client);
            expect(appWarnings()).toHaveLength(1);

            server.disconnectClient(clients[3]!);
            server.connectClient(clients[3]!);
            expect(appWarnings()).toHaveLength(1);

            server.disconnectClient(clients[3]!);
            server.disconnectClient(clients[2]!);
            server.connectClient(clients[2]!);
            expect(appWarnings()).toHaveLength(2);
        });

        it('leaves the admin UI\'s app out', () => {
            const server = new FakeServer();
            pool(2, server);

            for (let i = 0; i < 5; i++) server.connectClient(makeClient(`admin${i}`, 'colibri'));

            expect(appWarnings()).toEqual([]);
        });

        it('says nothing when turned off', () => {
            const server = new FakeServer();
            pool(0, server);

            for (let i = 0; i < 50; i++) server.connectClient(makeClient(`c${i}`, 'shared'));

            expect(appWarnings()).toEqual([]);
        });

        it('defaults to more than 8 clients', () => {
            const server = new FakeServer();
            new ConnectionPool(server);

            for (let i = 1; i <= 8; i++) server.connectClient(makeClient(`c${i}`, 'shared'));
            expect(appWarnings()).toEqual([]);
            server.connectClient(makeClient('c9', 'shared'));
            expect(appWarnings()).toHaveLength(1);
        });
    });

    describe('currentClients', () => {
        it('aggregates clients across every registered server', () => {
            const serverA = new FakeServer();
            const serverB = new FakeServer();
            const pool = new ConnectionPool(serverA, serverB);

            serverA.connectClient(makeClient('a1', 'appA'));
            serverB.connectClient(makeClient('b1', 'appB'));

            expect(pool.currentClients.map(c => c.id).sort()).toEqual(['a1', 'b1']);
        });
    });
});
