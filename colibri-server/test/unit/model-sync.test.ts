import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject, Subscription } from 'rxjs';
import { ConnectionPool, NetworkClient, NetworkMessage, NetworkServer } from '../../src/server/modules/command-hooks/connection-pool.js';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import { ModelSynchronization } from '../../src/server/modules/command-hooks/model-sync.js';
import { Payload } from '../../src/server/modules/core/payload.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';

// A transport without broadcastToApp, so every message the hooks send shows up in `sent` with
// the clients it went to. The payload is written down as it is sent, the way a real transport
// encodes it: the store keeps the very object a client's first update carried, and merges later
// updates into it.
class FakeServer implements NetworkServer {
    public readonly clientConnectedSource = new Subject<NetworkClient>();
    public readonly clientDisconnectedSource = new Subject<NetworkClient>();
    public readonly messagesSource = new Subject<NetworkMessage>();
    public clients: NetworkClient[] = [];
    public readonly sent: { command: string; payload: string | undefined; clients: ReadonlyArray<NetworkClient> }[] = [];

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

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>): void {
        this.sent.push({ command: message.command, payload: message.payload?.asString(), clients });
    }

    public connect(client: NetworkClient): NetworkClient {
        this.clients.push(client);
        this.clientConnectedSource.next(client);
        return client;
    }

    public disconnect(client: NetworkClient): void {
        this.clients = this.clients.filter(c => c.id !== client.id);
        this.clientDisconnectedSource.next(client);
    }
}

const makeClient = function (id: string, app = 'appA'): NetworkClient {
    return { id, app, name: `${id}-name`, version: '2', metadata: {} };
};

describe('ModelSynchronization', () => {
    let server: FakeServer;
    let store: DataStore;
    let logs: LogMessage[];
    let logSubscription: Subscription;

    beforeEach(() => {
        vi.useFakeTimers();
        server = new FakeServer();
        store = new DataStore();
        new ModelSynchronization(new ConnectionPool(server), store);
        logs = [];
        logSubscription = Service.output$.subscribe(msg => logs.push(msg));
    });

    afterEach(() => {
        logSubscription.unsubscribe();
        vi.useRealTimers();
    });

    const send = function (from: NetworkClient, command: string, payload: unknown, channel = 'objects'): void {
        server.messagesSource.next({ origin: from, channel, command, payload: Payload.fromValue(payload) });
    };

    // What went out, as "<command> <payload> -> <recipients>".
    const sent = (): string[] =>
        server.sent.map(s => `${s.command} ${s.payload} -> ${s.clients.map(c => c.id).join(',')}`);

    const debugLines = (): string[] => logs.filter(l => l.level === LogLevel.Debug).map(l => l.message);

    // An update that arrives after the object was deleted - another client's, sent before the
    // delete reached it, or one the server itself held back and passed on late - used to create
    // the model again and be relayed, so every client's manager spawned the object anew.
    describe('an update to a model deleted a moment ago', () => {
        it('is neither stored nor relayed when it comes from another client', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(mover, 'model::update', { id: 'cube', x: 1 });

            send(deleter, 'model::delete', { id: 'cube' });
            send(mover, 'model::update', { id: 'cube', x: 2 });

            expect(store.getModel('appA', 'objects', 'cube')).toBeUndefined();
            expect(sent()).toEqual([
                'model::update {"id":"cube","x":1} -> deleter',
                'model::delete {"id":"cube"} -> mover',
            ]);
            const ignored = debugLines().filter(l => l.includes('Ignoring a model::update'));
            expect(ignored).toHaveLength(1);
            expect(ignored[0]).toContain('\'cube\'');
            expect(ignored[0]).toContain(mover.id);
        });

        it('leaves updates to other models, and to the same id on another channel, alone', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(mover, 'model::update', { id: 'sphere', x: 1 });
            send(mover, 'model::update', { id: 'cube', x: 1 }, 'others');

            expect(store.getModel('appA', 'objects', 'sphere')).toEqual({ id: 'sphere', x: 1 });
            expect(store.getModel('appA', 'others', 'cube')).toEqual({ id: 'cube', x: 1 });
        });

        it('leaves another app\'s model of the same name alone', () => {
            const deleter = server.connect(makeClient('deleter', 'appA'));
            const other = server.connect(makeClient('other', 'appB'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(other, 'model::update', { id: 'cube', x: 1 });

            expect(store.getModel('appB', 'objects', 'cube')).toEqual({ id: 'cube', x: 1 });
        });

        // Each client's messages arrive in the order it sent them, so an update after its own
        // delete is no straggler - e.g. a scene it unloaded and loads again, whose synced objects
        // keep their ids.
        it('creates the model again when it comes from the client that deleted it', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(deleter, 'model::update', { id: 'cube', x: 5 });
            send(mover, 'model::update', { id: 'cube', y: 1 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 5, y: 1 });
            expect(sent()).toEqual([
                'model::delete {"id":"cube"} -> mover',
                'model::update {"id":"cube","x":5} -> mover',
                'model::update {"id":"cube","y":1} -> deleter',
            ]);
        });

        it('creates the model again once the deletion is 10 minutes old', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            vi.advanceTimersByTime(10 * 60 * 1000);
            send(mover, 'model::update', { id: 'cube', x: 2 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 2 });
        });

        it('creates the model again, as before, with tombstones turned off', () => {
            store.tombstoneMillis = 0;
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });

            send(mover, 'model::update', { id: 'cube', x: 2 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 2 });
        });

        // The models go when the app's last client leaves, and the deletions with them: what the
        // next client brings is the app's state afresh.
        it('creates the model again once every client of the app has left', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });
            server.disconnect(mover);
            server.disconnect(deleter);

            const next = server.connect(makeClient('next'));
            send(next, 'model::update', { id: 'cube', x: 3 });

            expect(store.getModel('appA', 'objects', 'cube')).toEqual({ id: 'cube', x: 3 });
        });

        it('is still refused while another client of the app stays connected', () => {
            const mover = server.connect(makeClient('mover'));
            const deleter = server.connect(makeClient('deleter'));
            send(deleter, 'model::delete', { id: 'cube' });
            server.disconnect(deleter);

            send(mover, 'model::update', { id: 'cube', x: 3 });

            expect(store.getModel('appA', 'objects', 'cube')).toBeUndefined();
        });
    });
});
