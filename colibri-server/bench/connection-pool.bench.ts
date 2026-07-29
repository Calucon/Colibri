import { bench, describe } from 'vitest';
import { Subject, Observable } from 'rxjs';
import {
    ConnectionPool,
    NetworkClient,
    NetworkMessage,
    NetworkServer
} from '../src/server/modules/command-hooks/connection-pool.js';

// Minimal stub server: enough surface for ConnectionPool, no sockets involved.
class FakeNetworkServer extends NetworkServer {
    private readonly messages = new Subject<NetworkMessage>();
    private readonly connected = new Subject<NetworkClient>();
    private readonly disconnected = new Subject<NetworkClient>();

    public get currentClients(): ReadonlyArray<NetworkClient> { return []; }
    public get messages$(): Observable<NetworkMessage> { return this.messages.asObservable(); }
    public get clientConnected$(): Observable<NetworkClient> { return this.connected.asObservable(); }
    public get clientDisconnected$(): Observable<NetworkClient> { return this.disconnected.asObservable(); }
    public broadcast(): void { /* no-op */ }

    public emit(msg: NetworkMessage): void {
        this.messages.next(msg);
    }
}

// Baseline for ConnectionPool.messages$ being a getter that rebuilds
// merge(...) on every access (Phase 1 makes this a stream built once).
// Mirrors main.ts: 7 command-hook classes each subscribe to pool.messages$
// once at startup, so this measures 7 independent merge() chains receiving
// the same message stream.
const HOOK_COUNT = 7;
const MESSAGE_COUNT = 1000;

describe('ConnectionPool.messages$ (v1: getter rebuilds merge() per access)', () => {
    bench(`subscribe ${HOOK_COUNT} hooks, emit ${MESSAGE_COUNT} messages`, () => {
        const serverA = new FakeNetworkServer();
        const serverB = new FakeNetworkServer();
        const pool = new ConnectionPool(serverA, serverB);

        let received = 0;
        const subs = Array.from({ length: HOOK_COUNT }, () =>
            pool.messages$.subscribe(() => { received++; })
        );

        for (let i = 0; i < MESSAGE_COUNT; i++) {
            serverA.emit({ channel: 'colibri', command: 'model::update', payload: '{}' });
        }

        subs.forEach(s => s.unsubscribe());
        if (received === 0) throw new Error('benchmark did not observe any messages');
    });
});
