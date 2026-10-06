import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, config as rxjsConfig } from 'rxjs';
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
    inboundBacklog: Int32Array;
    onWorkerExited(): void;
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

    // The worker counts every message it posts here; this side has to count each one back down
    // once it is dispatched, or the worker would think the main thread is further behind than it
    // is - and, past the limit, drop updates for good.
    describe('the inbound backlog', () => {
        let sent: { channel: string; content: Record<string, unknown> }[];
        const internals = () => proxy as unknown as ProxyInternals;

        beforeEach(() => {
            sent = [];
            vi.spyOn(WorkerServiceProxy.prototype as unknown as { postMessage(channel: string, content?: Record<string, unknown>): void }, 'postMessage')
                .mockImplementation((channel, content) => {
                    sent.push({ channel, content: content ?? {} });
                });
        });

        const startMessages = () => sent.filter(m => m.channel === 'm:start');

        it('shares its counter and the limit with the worker in the start message', () => {
            proxy.start(9012, '0.0.0.0', { inboundBacklogLimit: 1234 });

            const [start] = startMessages();
            expect(start?.content).toMatchObject({ port: 9012, host: '0.0.0.0', options: { inboundBacklogLimit: 1234 } });
            const counter = (start?.content.options as { inboundBacklog: Int32Array }).inboundBacklog;
            expect(counter).toBe(internals().inboundBacklog);
            expect(counter.buffer).toBeInstanceOf(SharedArrayBuffer);
        });

        it('counts a message back down once it has been dispatched', () => {
            handshake('c1', 'appA');
            Atomics.store(internals().inboundBacklog, 0, 3);
            let pendingWhileHandling = -1;
            proxy.messages$.subscribe(() => {
                pendingWhileHandling = Atomics.load(internals().inboundBacklog, 0);
            });

            modelUpdate('c1', 'objects', { id: 'm1' });

            expect(pendingWhileHandling).toBe(3);
            expect(Atomics.load(internals().inboundBacklog, 0)).toBe(2);
        });

        it('counts a message back down even when handling it threw', async () => {
            const unhandled: unknown[] = [];
            const original = rxjsConfig.onUnhandledError;
            rxjsConfig.onUnhandledError = err => unhandled.push(err);
            try {
                handshake('c1', 'appA');
                Atomics.store(internals().inboundBacklog, 0, 1);

                // No payload at all: turning it into a Payload throws.
                fromWorker('clientMessage$', { channel: 'objects', command: 'model::update', origin: { id: 'c1' } });

                expect(Atomics.load(internals().inboundBacklog, 0)).toBe(0);
                // RxJS reports the subscriber's error on a later timer tick.
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(unhandled).toHaveLength(1);
            } finally {
                rxjsConfig.onUnhandledError = original;
            }
        });

        it('starts a restarted worker from zero, with the same counter and settings', () => {
            vi.useFakeTimers();
            try {
                vi.spyOn(WorkerServiceProxy.prototype as unknown as { restartWorker(): boolean }, 'restartWorker').mockReturnValue(true);
                proxy.start(9012, '0.0.0.0', { inboundBacklogLimit: 77 });
                Atomics.store(internals().inboundBacklog, 0, 500);

                internals().onWorkerExited();
                expect(Atomics.load(internals().inboundBacklog, 0)).toBe(0);
                vi.advanceTimersByTime(1000);

                const [first, restarted] = startMessages();
                expect(restarted?.content).toEqual(first?.content);
                expect((restarted?.content.options as { inboundBacklog: Int32Array }).inboundBacklog).toBe(internals().inboundBacklog);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
