import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as net from 'net';
import { TCPServerWorker, WireNetworkMessage } from '../../src/server/modules/networking/tcp-server-worker.js';
import { encodeHandshakeFrame, encodeHeartbeatFrame, encodeMessageFrame } from '../../src/server/modules/networking/protocol.js';

// Vitest runs suites inside worker threads, so the real `parentPort` here is the test
// runner's own channel: WorkerService would subscribe to it and the module bootstrap would
// try to start a second server. Pretending to be the main thread makes both inert - the
// worker's outgoing messages are captured by spying on postMessage instead.
vi.mock('worker_threads', async (importOriginal) => {
    const actual = await importOriginal<typeof import('worker_threads')>();
    return { ...actual, isMainThread: true, parentPort: null, workerData: null };
});

// A net.Socket stand-in: the worker only ever uses these members, and driving it directly
// keeps the tests free of real ports and timing.
class FakeSocket extends EventEmitter {
    public writableLength = 0;
    public readonly written: Buffer[] = [];
    public destroyed = false;
    public ended = false;
    public remoteAddress = '127.0.0.1';

    public setNoDelay(): this {
        return this;
    }

    public write(data: Buffer, callback?: (err?: Error) => void): boolean {
        this.written.push(data);
        callback?.();
        return true;
    }

    public end(): this {
        this.ended = true;
        return this;
    }

    public destroy(): this {
        this.destroyed = true;
        return this;
    }

    public asSocket(): net.Socket {
        return this as unknown as net.Socket;
    }
}

// The members under test are private; naming them here (rather than reaching through `any`)
// keeps the test honest about exactly which internals it depends on.
interface WorkerInternals {
    handleConnection(socket: net.Socket): void;
    handleParentMessage(msg: { channel: string; content: Record<string, unknown> }): void;
    postMessage(channel: string, content: Record<string, unknown>): void;
    clients: Map<string, { id: string; app: string; socket: net.Socket }>;
    waitingClients: Map<string, { id: string; socket: net.Socket }>;
    clientsByApp: Map<string, Set<{ id: string }>>;
    stop(): void;
}

const wireMessage = function (channel: string, command: string, payload = ''): WireNetworkMessage {
    return { channel, command, payload: Buffer.from(payload, 'utf8') };
};

describe('TCPServerWorker', () => {
    let worker: TCPServerWorker;
    let internals: WorkerInternals;
    let posted: { channel: string; content: Record<string, unknown> }[];

    // Every log call goes through postMessage too, so the spy doubles as the log sink.
    const logs = (): string[] =>
        posted.filter(p => p.channel === 'log').map(p => String(p.content.msg));

    const connect = function (): { socket: FakeSocket; id: string } {
        const socket = new FakeSocket();
        internals.handleConnection(socket.asSocket());
        const entry = Array.from(internals.waitingClients.values()).find(c => c.socket === socket.asSocket());
        return { socket, id: entry!.id };
    };

    beforeEach(() => {
        worker = new TCPServerWorker();
        internals = worker as unknown as WorkerInternals;
        posted = [];
        vi.spyOn(internals, 'postMessage').mockImplementation((channel, content) => {
            posted.push({ channel, content });
        });
    });

    afterEach(() => {
        internals.stop();
        vi.restoreAllMocks();
    });

    describe('handshake and the per-app index', () => {
        it('moves a client from waiting to connected and indexes it by app', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'client-a'));

            expect(internals.waitingClients.has(id)).toBe(false);
            expect(internals.clients.has(id)).toBe(true);
            expect(Array.from(internals.clientsByApp.get('appA') ?? []).map(c => c.id)).toEqual([id]);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(1);
        });

        // Regression: assignApp used to overwrite client.app before removing the client from
        // its previous app's Set, and removeFromAppIndex only ever looks at the *current*
        // app - so the stale entry survived even the client's disconnect.
        it('does not leave a stale index entry when a client re-handshakes with another app', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'client-a'));
            socket.emit('data', encodeHandshakeFrame('1', 'appB', 'client-a'));

            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(Array.from(internals.clientsByApp.get('appB') ?? []).map(c => c.id)).toEqual([id]);
        });

        it('drops the client from every index on disconnect', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'client-a'));
            socket.emit('close');

            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
        });

        it('terminates the connection on a malformed handshake', () => {
            const { socket } = connect();
            const bad = Buffer.alloc(5);
            bad.writeUInt32LE(1, 0);
            bad.writeUInt8(0xff, 4); // unknown frame type

            socket.emit('data', bad);

            expect(socket.ended).toBe(true);
        });
    });

    // Item 28: 'error' is always followed by the socket's own 'close', so without the
    // disconnected flag both paths would report the same client as gone.
    describe('disconnect deduplication', () => {
        it('reports clientDisconnected$ once when an error is followed by close', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'client-a'));

            socket.emit('error', new Error('ECONNRESET while reading'));
            socket.emit('close');
            socket.emit('close');

            expect(posted.filter(p => p.channel === 'clientDisconnected$')).toHaveLength(1);
        });
    });

    describe('broadcastToApp', () => {
        it('writes to every client of the app except the excluded one', () => {
            const a = connect();
            const b = connect();
            const other = connect();
            a.socket.emit('data', encodeHandshakeFrame('1', 'appA', 'a'));
            b.socket.emit('data', encodeHandshakeFrame('1', 'appA', 'b'));
            other.socket.emit('data', encodeHandshakeFrame('1', 'appB', 'o'));

            a.socket.written.length = 0;
            b.socket.written.length = 0;
            other.socket.written.length = 0;

            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('appA::chan', 'model::update', '{"x":1}'), app: 'appA', exclude: a.id },
            });

            expect(a.socket.written).toHaveLength(0);
            expect(other.socket.written).toHaveLength(0);
            expect(b.socket.written).toEqual([
                encodeMessageFrame({ channel: 'appA::chan', command: 'model::update', payload: Buffer.from('{"x":1}', 'utf8') }),
            ]);
        });

        it('does nothing for an app with no clients', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'a'));
            socket.written.length = 0;

            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'nobody-here' },
            });

            expect(socket.written).toHaveLength(0);
        });
    });

    // §3: an unrepresentable frame used to throw ERR_OUT_OF_RANGE out of the subscription
    // and take the whole worker thread - and with it the entire TCP transport - down.
    describe('unencodable messages', () => {
        it('drops the message and keeps serving instead of throwing', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'a'));
            socket.written.length = 0;

            expect(() => internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c'.repeat(0x10000), 'model::update'), app: 'appA' },
            })).not.toThrow();

            expect(socket.written).toHaveLength(0);
            expect(logs().some(msg => msg.includes('Dropping unencodable message'))).toBe(true);

            // Still alive: a well-formed message afterwards is delivered normally.
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
            });
            expect(socket.written).toHaveLength(1);
        });
    });

    // Item 21, plus the log volume fix: a stalled client drops at least ten heartbeats a
    // second, and every warning is forwarded to the main thread and re-broadcast to the
    // admin UI, so only the state transitions may be logged.
    describe('backpressure', () => {
        it('drops writes past the high-water mark and logs only the transitions', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'a'));
            socket.written.length = 0;
            posted = [];

            socket.writableLength = 2 * 1024 * 1024;
            for (let i = 0; i < 5; i++) {
                internals.handleParentMessage({
                    channel: 'm:broadcastToApp',
                    content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
                });
            }

            expect(socket.written).toHaveLength(0);
            expect(logs().filter(msg => msg.includes('Dropping messages to client'))).toHaveLength(1);

            socket.writableLength = 0;
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
            });

            expect(socket.written).toHaveLength(1);
            expect(logs().some(msg => msg.includes('caught up; dropped 5 message(s)'))).toBe(true);
        });
    });

    describe('heartbeat replies', () => {
        it('relays an echoed ping timestamp as a colibri/latency message', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'a'));
            posted = [];

            socket.emit('data', encodeHeartbeatFrame(123456789n));

            const relayed = posted.find(p => p.channel === 'clientMessage$');
            expect(relayed?.content.channel).toBe('colibri');
            expect(relayed?.content.command).toBe('latency');
            expect((relayed?.content.payload as Buffer).toString('utf8')).toBe('123456789');
        });

        it('ignores a heartbeat from a client that has not handshaked yet', () => {
            const { socket } = connect();
            posted = [];

            socket.emit('data', encodeHeartbeatFrame(1n));

            expect(posted.filter(p => p.channel === 'clientMessage$')).toHaveLength(0);
        });
    });

    describe('stop', () => {
        it('destroys live sockets and clears every index', () => {
            const connected = connect();
            const waiting = connect();
            connected.socket.emit('data', encodeHandshakeFrame('1', 'appA', 'a'));

            internals.stop();

            expect(connected.socket.destroyed).toBe(true);
            expect(waiting.socket.destroyed).toBe(true);
            expect(internals.clients.size).toBe(0);
            expect(internals.waitingClients.size).toBe(0);
            expect(internals.clientsByApp.size).toBe(0);
        });

        it('tolerates being stopped before it was ever started', () => {
            expect(() => internals.stop()).not.toThrow();
        });
    });
});
