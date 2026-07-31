import { describe, it, expect } from 'vitest';
import { Subject } from 'rxjs';
import { WebLog } from '../../src/server/modules/web/web-log.js';
import { SocketIoClient, SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { NetworkMessage } from '../../src/server/modules/command-hooks/connection-pool.js';
import { Payload, Service } from '../../src/server/modules/core/index.js';

class FakeSocketIOServer {
    public messagesSource = new Subject<NetworkMessage>();
    public clients: SocketIoClient[] = [];
    public broadcasts: { message: NetworkMessage; clients: ReadonlyArray<SocketIoClient> }[] = [];

    public get messages$() {
        return this.messagesSource.asObservable();
    }

    public get currentClients(): ReadonlyArray<SocketIoClient> {
        return this.clients;
    }

    public getClient(id: string): SocketIoClient | undefined {
        return this.clients.find(c => c.id === id);
    }

    public broadcast(message: NetworkMessage, clients: ReadonlyArray<SocketIoClient>): void {
        this.broadcasts.push({ message, clients });
    }

    public connectClient(client: SocketIoClient): void {
        this.clients.push(client);
    }
}

const makeClient = function (id: string, app: string): SocketIoClient {
    return { id, app, name: id, version: '1', metadata: {}, socket: {} as never };
};

const requestLog = function (server: FakeSocketIOServer, origin: SocketIoClient, body: Record<string, unknown>): void {
    server.messagesSource.next({
        channel: 'colibri::log',
        command: 'requestLog',
        origin,
        payload: Payload.fromValue(body)
    });
};

class Emitter extends Service {
    public get serviceName(): string { return 'Emitter'; }
    public get groupName(): string { return 'test'; }

    public emitDebug(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logDebug(msg, metadata);
    }

    public emitError(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logError(msg, false, metadata);
    }

    public emitWarning(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logWarning(msg, metadata);
    }

    public emitInfo(msg: string, metadata: Record<string, string | number | boolean> = {}): void {
        this.logInfo(msg, metadata);
    }
}

describe('WebLog', () => {
    it('by default shows all levels but hides broadcast-tagged messages', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitWarning('warn');
        emitter.emitInfo('info');
        emitter.emitDebug('debug');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        expect(server.broadcasts).toHaveLength(4);
        expect(server.broadcasts.map(b => (b.message.payload!.asValue<{ message: string }>()).message))
            .toEqual(['err', 'warn', 'info', 'debug']);
    });

    it('honors a level filter set via requestLog, without broadcasting suppressed levels at all', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);
        requestLog(server, admin, { levels: [ 0 ] });

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitWarning('warn');
        emitter.emitInfo('info');
        emitter.emitDebug('debug');

        expect(server.broadcasts).toHaveLength(1);
        expect(server.broadcasts[0]!.message.payload!.asValue<{ message: string }>().message).toBe('err');
    });

    it('the sync-traffic switch overrides the level gate for broadcast-tagged messages (carve-out semantics)', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        // Debug selected, sync traffic explicitly hidden: broadcast-tagged Debug is hidden,
        // non-broadcast Debug still shows.
        requestLog(server, admin, { levels: [ 3 ], showBroadcastTraffic: false });

        const emitter = new Emitter();
        emitter.emitDebug('plain-debug');
        emitter.emitDebug('sync-tick', { broadcastTraffic: true });

        expect(server.broadcasts).toHaveLength(1);
        expect(server.broadcasts[0]!.message.payload!.asValue<{ message: string }>().message).toBe('plain-debug');

        // Debug NOT selected, sync traffic explicitly shown: broadcast-tagged message still
        // shows even though its level (Debug) is unchecked.
        requestLog(server, admin, { levels: [ 0 ], showBroadcastTraffic: true });
        // requestLog also replays matching history (here, the buffered 'sync-tick' now
        // matches the new prefs) - discard that one-off broadcast to isolate live delivery.
        server.broadcasts.length = 0;

        emitter.emitDebug('plain-debug-2');
        emitter.emitDebug('sync-tick-2', { broadcastTraffic: true });

        expect(server.broadcasts).toHaveLength(1);
        expect(server.broadcasts[0]!.message.payload!.asValue<{ message: string }>().message).toBe('sync-tick-2');
    });

    it('gives two clients with different preferences only their own wanted subset', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const debugAndSyncClient = makeClient('a', 'colibri');
        const errorOnlyClient = makeClient('b', 'colibri');
        server.connectClient(debugAndSyncClient);
        server.connectClient(errorOnlyClient);

        requestLog(server, debugAndSyncClient, { levels: [ 0, 1, 2, 3 ], showBroadcastTraffic: true });
        requestLog(server, errorOnlyClient, { levels: [ 0 ], showBroadcastTraffic: false });

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        const recipientsFor = (message: string) =>
            server.broadcasts.find(b => b.message.payload!.asValue<{ message: string }>().message === message)
                ?.clients.map(c => c.id);

        expect(recipientsFor('err')).toEqual([ 'a', 'b' ]);
        expect(recipientsFor('sync')).toEqual([ 'a' ]);
    });

    it('replays history through requestLog honoring the requested preferences', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const emitter = new Emitter();
        emitter.emitError('err');
        emitter.emitDebug('debug');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);
        server.broadcasts.length = 0;

        // requestLog broadcasts one message per matching historical entry (not a single
        // batched array), same payload shape as live delivery.
        requestLog(server, admin, { levels: [ 0 ], showBroadcastTraffic: false });

        expect(server.broadcasts).toHaveLength(1);
        expect(server.broadcasts[0]!.message.payload!.asValue<{ message: string }>().message).toBe('err');
    });

    it('merges a repeated message into one entry with an incrementing count, even with unrelated traffic interleaved', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitDebug('tick');
        // unrelated traffic between repeats - a positional lookback would lose the match here
        for (let i = 0; i < 10; i++) {
            emitter.emitDebug(`unrelated-${i}`);
        }
        emitter.emitDebug('tick');
        emitter.emitDebug('tick');

        const ticks = server.broadcasts
            .map(b => b.message.payload!.asValue<{ message: string; count: number }>())
            .filter(m => m.message === 'tick');

        expect(ticks).toHaveLength(3);
        expect(ticks.map(t => t.count)).toEqual([ 0, 1, 2 ]);
        // all three broadcasts refer to the same log entry id
        const ids = server.broadcasts
            .map(b => b.message.payload!.asValue<{ message: string; id: string }>())
            .filter(m => m.message === 'tick')
            .map(m => m.id);
        expect(new Set(ids).size).toBe(1);
    });

    it('does not merge into a message that has since been evicted from history', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        const emitter = new Emitter();
        emitter.emitDebug('tick');

        // Reach into the private ring buffer capacity via repeated unrelated messages to force
        // the 'tick' entry out of history (MAX_LOG_SIZE = 20000).
        for (let i = 0; i < 20000; i++) {
            emitter.emitDebug(`filler-${i}`);
        }
        server.broadcasts.length = 0;

        emitter.emitDebug('tick');

        const ticks = server.broadcasts
            .map(b => b.message.payload!.asValue<{ message: string; count: number }>())
            .filter(m => m.message === 'tick');

        expect(ticks).toHaveLength(1);
        expect(ticks[0]!.count).toBe(0);
    });

    it('does not throw on a missing or empty requestLog payload, and defaults to all levels / hidden broadcast', async () => {
        const server = new FakeSocketIOServer();
        const webLog = new WebLog(server as unknown as SocketIOServer);
        await webLog.init();

        const admin = makeClient('admin1', 'colibri');
        server.connectClient(admin);

        expect(() => {
            server.messagesSource.next({ channel: 'colibri::log', command: 'requestLog', origin: admin, payload: undefined });
        }).not.toThrow();

        const emitter = new Emitter();
        emitter.emitDebug('debug');
        emitter.emitDebug('sync', { broadcastTraffic: true });

        expect(server.broadcasts.map(b => b.message.payload!.asValue<{ message: string }>().message)).toEqual(['debug']);
    });
});
