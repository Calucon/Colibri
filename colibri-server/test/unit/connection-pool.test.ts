import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import { ConnectionPool, NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/command-hooks/connection-pool.js';

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
