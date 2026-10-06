import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject } from 'rxjs';
import { TCPServerProxy } from '../../src/server/modules/networking/tcp-server-proxy.js';
import { WorkerServiceProxy } from '../../src/server/modules/core/worker-service-proxy.js';
import { WorkerMessage } from '../../src/server/modules/core/worker-message.js';
import { ConnectionPool, NetworkClient } from '../../src/server/modules/command-hooks/connection-pool.js';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import { ModelSynchronization } from '../../src/server/modules/command-hooks/model-sync.js';
import { Payload } from '../../src/server/modules/core/payload.js';

// The proxy's only link to the worker thread is the message channel, so these tests stand in for
// the thread by pushing what TCPServerWorker would post. No thread is started: under vitest the
// worker module is a .ts file that a plain worker_threads.Worker cannot load anyway.
interface ProxyInternals {
    workerMessages: Subject<WorkerMessage>;
}

describe('TCPServerProxy', () => {
    let proxy: TCPServerProxy;

    const fromWorker = function (channel: string, content: Record<string, unknown>): void {
        (proxy as unknown as ProxyInternals).workerMessages.next({ channel, content });
    };

    const handshake = function (id: string, app: string, name = id): void {
        fromWorker('clientConnected$', { id, app, name, version: '2' });
    };

    const modelUpdate = function (id: string, channel: string, model: Record<string, unknown>): void {
        fromWorker('clientMessage$', {
            channel,
            command: 'model::update',
            payload: Buffer.from(JSON.stringify(model), 'utf8'),
            origin: { id, app: '', name: '', version: '2', metadata: {} },
        });
    };

    beforeEach(() => {
        vi.spyOn(WorkerServiceProxy.prototype as unknown as { initWorker(): void }, 'initWorker').mockImplementation(() => undefined);
        proxy = new TCPServerProxy();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The worker moves a re-handshaking client to its new app, but the proxy used to add the new
    // app without removing the old one: the old app kept the id in its index forever.
    describe('a client that handshakes again', () => {
        it('is reported as leaving its old app before joining the new one', () => {
            const events: string[] = [];
            proxy.clientConnected$.subscribe(c => events.push(`connected ${c.app}`));
            proxy.clientDisconnected$.subscribe(c => events.push(`disconnected ${c.app}`));

            handshake('c1', 'appA');
            handshake('c1', 'appB');

            expect(events).toEqual(['connected appA', 'disconnected appA', 'connected appB']);
            expect(proxy.currentClients.map(c => `${c.id} ${c.app}`)).toEqual(['c1 appB']);
            expect(proxy.hasRecipients('appA')).toBe(false);
            expect(proxy.hasRecipients('appB')).toBe(true);
        });

        it('is gone from both apps once it disconnects', () => {
            handshake('c1', 'appA');
            handshake('c1', 'appB');
            fromWorker('clientDisconnected$', { id: 'c1' });

            expect(proxy.currentClients).toEqual([]);
            expect(proxy.hasRecipients('appA')).toBe(false);
            expect(proxy.hasRecipients('appB')).toBe(false);
        });
    });

    // End to end through the hooks that care: the old app's synchronized models must be dropped
    // exactly as if the client had disconnected, and only then.
    describe('re-handshake and the model store', () => {
        let store: DataStore;

        beforeEach(() => {
            store = new DataStore();
            const pool = new ConnectionPool(proxy);
            new ModelSynchronization(pool, store);
        });

        it('clears the old app\'s store when the client was its last', () => {
            handshake('c1', 'appA');
            modelUpdate('c1', 'objects', { id: 'm1', x: 1 });
            expect(store.getAll('appA', 'objects')).toHaveLength(1);

            handshake('c1', 'appB');

            expect(store.getAll('appA', 'objects')).toEqual([]);
        });

        it('keeps the old app\'s store while another of its clients is still connected', () => {
            handshake('c1', 'appA');
            handshake('c2', 'appA');
            modelUpdate('c1', 'objects', { id: 'm1', x: 1 });

            handshake('c1', 'appB');

            expect(store.getAll('appA', 'objects')).toHaveLength(1);
        });

        // Leaving and rejoining the same app in one step must not look like the app emptying.
        it('keeps the store when the client handshakes into the same app again', () => {
            handshake('c1', 'appA', 'first-name');
            modelUpdate('c1', 'objects', { id: 'm1', x: 1 });

            handshake('c1', 'appA', 'second-name');

            expect(store.getAll('appA', 'objects')).toHaveLength(1);
            expect(proxy.currentClients.map((c: NetworkClient) => c.name)).toEqual(['second-name']);
        });
    });

    // Every broadcast is structured-cloned into the worker, which copies a payload's whole backing
    // ArrayBuffer. A payload encoded from a string (anything web-origin or built by the server) is
    // a view into the 64 KiB Buffer pool, and used to cross as 64 KiB.
    describe('payloads sent to the worker', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
            handshake('c1', 'appA');
        });

        const sentPayload = function (): Buffer {
            const msg = sent.at(-1)?.content.msg as { payload: Buffer } | undefined;
            if (!msg) throw new Error('nothing was sent to the worker');
            return msg.payload;
        };

        it('own exactly their bytes when broadcast to an app', () => {
            proxy.broadcastToApp({ channel: 'objects', command: 'model::update', payload: Payload.fromValue({ id: 'm1', x: 1 }) }, 'appA');

            const payload = sentPayload();
            expect(payload.toString()).toBe('{"id":"m1","x":1}');
            expect(payload.buffer.byteLength).toBe(payload.length);
        });

        it('own exactly their bytes when sent to one client', () => {
            proxy.broadcast({ channel: 'objects', command: 'model::update', payload: Payload.fromString('{"id":"m1"}') }, proxy.currentClients);

            const payload = sentPayload();
            expect(payload.toString()).toBe('{"id":"m1"}');
            expect(payload.buffer.byteLength).toBe(payload.length);
        });

        it('are passed through without a copy when they already own their bytes', () => {
            const bytes = Buffer.allocUnsafeSlow(11);
            bytes.write('{"id":"m1"}');

            proxy.broadcastToApp({ channel: 'objects', command: 'model::update', payload: Payload.fromBytes(bytes) }, 'appA');

            expect(sentPayload()).toBe(bytes);
        });
    });
});
