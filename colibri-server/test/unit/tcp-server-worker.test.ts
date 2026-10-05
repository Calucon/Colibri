import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as net from 'net';
import { TCPServerWorker, WireNetworkMessage } from '../../src/server/modules/networking/tcp-server-worker.js';
import { FrameReader, FrameType, PROTOCOL_VERSION, encodeHandshakeFrame, encodeHeartbeatFrame, encodeMessageFrame } from '../../src/server/modules/networking/protocol.js';
import { LogLevel } from '../../src/server/modules/core/log-message.js';

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
    // Writes attempted after end() or destroy(), which a real socket fails.
    public readonly writtenAfterEnd: Buffer[] = [];
    public destroyed = false;
    public ended = false;
    public remoteAddress = '127.0.0.1';

    public get writableEnded(): boolean {
        return this.ended;
    }

    public setNoDelay(): this {
        return this;
    }

    // Modelled on what a real net.Socket does with a write after end(): the write fails, the
    // socket emits 'error' and destroys itself - which is how a heartbeat to a refused client
    // used to log twice and could cut off the refusal frame still being flushed.
    public write(data: Buffer, callback?: (err?: Error) => void): boolean {
        if (this.ended || this.destroyed) {
            const err = new Error('write after end');
            this.writtenAfterEnd.push(data);
            callback?.(err);
            this.emit('error', err);
            this.destroy();
            return false;
        }

        this.written.push(data);
        callback?.();
        return true;
    }

    // end(data) is how the worker sends a protocol rejection: the frame and the FIN are
    // queued together so the refusal cannot be lost to a close racing the write callback.
    public end(data?: Buffer): this {
        if (data) this.written.push(data);
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
    handleHeartbeat(): void;
    postMessage(channel: string, content: Record<string, unknown>): void;
    clients: Map<string, { id: string; app: string; socket: net.Socket }>;
    waitingClients: Map<string, { id: string; socket: net.Socket }>;
    clientsByApp: Map<string, Set<{ id: string }>>;
    v1WarnedAt: Map<string, number>;
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

    const connect = function (remoteAddress = '127.0.0.1'): { socket: FakeSocket; id: string } {
        const socket = new FakeSocket();
        socket.remoteAddress = remoteAddress;
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
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));

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
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appB', 'client-a'));

            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(Array.from(internals.clientsByApp.get('appB') ?? []).map(c => c.id)).toEqual([id]);
        });

        it('drops the client from every index on disconnect', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));
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

    describe('protocol version check', () => {
        // Decodes whatever the worker wrote back, so the assertions are about the bytes a
        // real client would receive rather than about an internal call.
        const framesWrittenTo = function (socket: FakeSocket) {
            const reader = new FrameReader();
            return socket.written.flatMap(chunk => reader.append(chunk));
        };

        it('refuses a client announcing a different protocol version', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

            expect(socket.ended).toBe(true);
            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
            // A refused client must never look connected to anything downstream - the admin
            // UI would otherwise list a client that is already gone.
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(0);
            expect(logs().some(l => l.includes('old-client') && l.includes(`v${PROTOCOL_VERSION}`))).toBe(true);
        });

        it('tells the refused client why, on the colibri channel', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

            const frame = framesWrittenTo(socket).find(
                f => f.type === FrameType.Message && f.command === 'protocol::rejected'
            );
            expect(frame).toBeDefined();
            if (frame?.type !== FrameType.Message) throw new Error('expected a message frame');

            expect(frame.channel).toBe('colibri');
            expect(JSON.parse(frame.payload.toString('utf8'))).toMatchObject({
                serverVersion: PROTOCOL_VERSION,
                clientVersion: '1',
            });
        });

        it('accepts a client announcing the supported version', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'current-client'));

            expect(socket.ended).toBe(false);
            expect(internals.clients.has(id)).toBe(true);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(1);
        });

        it('ignores messages from a client refused for its version', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            posted.length = 0;

            socket.emit('data', encodeMessageFrame(wireMessage('chan', 'broadcast::json', '{}')));

            expect(posted.filter(p => p.channel === 'clientMessage$')).toHaveLength(0);
        });
    });

    // A refused or cut-off client used to stay in waitingClients/clients until its 'close'
    // event, so the next 100ms heartbeat wrote to the ended socket: a "Failed to send" warning,
    // a "write after end" error, and a destroy racing the refusal frame still being flushed.
    describe('a connection this server ends', () => {
        const badLength = function (): Buffer {
            const bad = Buffer.alloc(5);
            bad.writeUInt32LE(1, 0);
            bad.writeUInt8(0xff, 4); // unknown frame type
            return bad;
        };

        const writeErrors = (): string[] =>
            logs().filter(l => l.includes('write after end') || l.includes('Failed to send'));

        it('is no longer heartbeated after a protocol refusal', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            const writtenBeforeHeartbeat = socket.written.length;

            internals.handleHeartbeat();

            expect(socket.writtenAfterEnd).toHaveLength(0);
            expect(socket.written).toHaveLength(writtenBeforeHeartbeat);
            expect(socket.destroyed).toBe(false);
            expect(writeErrors()).toEqual([]);
        });

        it('is no longer heartbeated after a framing error', () => {
            const { socket } = connect();
            socket.emit('data', badLength());

            internals.handleHeartbeat();

            expect(socket.ended).toBe(true);
            expect(socket.writtenAfterEnd).toHaveLength(0);
            expect(writeErrors()).toEqual([]);
        });

        it('leaves the refusal frame as the last thing written before the FIN', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            internals.handleHeartbeat();

            const reader = new FrameReader();
            const frames = socket.written.flatMap(chunk => reader.append(chunk));
            const last = frames[frames.length - 1];
            expect(last?.type === FrameType.Message && last.command).toBe('protocol::rejected');
            expect(socket.ended).toBe(true);
        });

        it('drops a refused client from every index immediately, not on close', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

            expect(internals.waitingClients.has(id)).toBe(false);
            expect(internals.clients.has(id)).toBe(false);
        });

        it('drops a connected client that sends a bad frame and reports it gone once', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));

            socket.emit('data', badLength());

            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(posted.filter(p => p.channel === 'clientDisconnected$')).toHaveLength(1);

            socket.emit('close');
            expect(posted.filter(p => p.channel === 'clientDisconnected$')).toHaveLength(1);
        });

        it('ignores frames queued behind a refused handshake in the same chunk', () => {
            const { socket } = connect();
            socket.emit('data', Buffer.concat([
                encodeHandshakeFrame('1', 'appA', 'old-client'),
                encodeMessageFrame(wireMessage('chan', 'broadcast::json', '{}')),
                encodeHeartbeatFrame(1n),
            ]));

            expect(posted.filter(p => p.channel === 'clientMessage$')).toHaveLength(0);
            expect(logs().filter(l => l.includes('without app'))).toEqual([]);
        });

        it('ignores anything the peer sends after being refused', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            posted.length = 0;

            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'old-client'));
            socket.emit('data', encodeMessageFrame(wireMessage('chan', 'broadcast::json', '{}')));

            expect(posted.filter(p => p.channel === 'clientConnected$' || p.channel === 'clientMessage$')).toHaveLength(0);
            expect(logs().filter(l => l.includes('without app'))).toEqual([]);
        });

        // With allowHalfOpen off, a peer's FIN ends our side too, a little before 'close'.
        it('skips a socket whose writable side has already ended', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));
            socket.ended = true;

            internals.handleHeartbeat();
            internals.handleParentMessage({
                channel: 'm:broadcastToApp',
                content: { msg: wireMessage('c', 'model::update'), app: 'appA' },
            });

            expect(socket.writtenAfterEnd).toHaveLength(0);
            expect(writeErrors()).toEqual([]);
        });

        it('destroys the socket if the peer never closes its side', () => {
            vi.useFakeTimers();
            try {
                const { socket } = connect();
                socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));

                vi.advanceTimersByTime(4999);
                expect(socket.destroyed).toBe(false);
                vi.advanceTimersByTime(1);
                expect(socket.destroyed).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('leaves a socket alone once the peer has closed it', () => {
            vi.useFakeTimers();
            try {
                const { socket } = connect();
                socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
                socket.emit('close');

                vi.advanceTimersByTime(10_000);
                expect(socket.destroyed).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // A real colibri-unity 1.x client used to produce nothing but an anonymous "Invalid frame
    // from client <uuid> ... Invalid frame length: 1744830464", once a second, forever.
    describe('a Colibri 1.x client', () => {
        // Byte for byte what colibri-unity 1.x's WebServerConnection.SendHandshake writes.
        const v1Handshake = Buffer.from('\0\0\0h\0' + '1::app::host\0', 'utf8');

        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));
        const v1Warnings = (): string[] => warnings().filter(w => w.includes('Colibri 1.x'));

        it('is named as one, with its address, the version spoken here and the fix', () => {
            const { socket } = connect('10.0.0.17');
            socket.emit('data', v1Handshake);

            expect(socket.ended).toBe(true);
            const [warning] = v1Warnings();
            expect(warning).toContain('10.0.0.17');
            expect(warning).toContain(`v${PROTOCOL_VERSION}`);
            expect(warning).toContain('Unity package');
            expect(logs().filter(l => l.includes('Invalid frame'))).toEqual([]);
        });

        it('is warned about at most once a minute per address', () => {
            vi.useFakeTimers();
            try {
                for (let i = 0; i < 30; i++) {
                    connect('10.0.0.17').socket.emit('data', v1Handshake);
                    vi.advanceTimersByTime(1000);
                }
                expect(v1Warnings()).toHaveLength(1);

                connect('10.0.0.18').socket.emit('data', v1Handshake);
                expect(v1Warnings()).toHaveLength(2);

                vi.advanceTimersByTime(30_000);
                connect('10.0.0.17').socket.emit('data', v1Handshake);
                expect(v1Warnings()).toHaveLength(3);
            } finally {
                vi.useRealTimers();
            }
        });

        it('keeps a bounded amount of memory per address', () => {
            for (let i = 0; i < 3000; i++) {
                connect(`10.${(i >> 8) & 0xff}.${i & 0xff}.1`).socket.emit('data', v1Handshake);
            }

            expect(v1Warnings()).toHaveLength(3000);
            expect(internals.v1WarnedAt.size).toBeLessThanOrEqual(1024);
        });

        it('still reports other garbage as an invalid frame', () => {
            const { socket } = connect();
            const bad = Buffer.alloc(5);
            bad.writeUInt32LE(0xffffffff, 0);
            socket.emit('data', bad);

            expect(socket.ended).toBe(true);
            expect(v1Warnings()).toEqual([]);
            expect(logs().some(l => l.includes('Invalid frame length: 4294967295'))).toBe(true);
        });
    });

    // Item 28: 'error' is always followed by the socket's own 'close', so without the
    // disconnected flag both paths would report the same client as gone.
    describe('disconnect deduplication', () => {
        it('reports clientDisconnected$ once when an error is followed by close', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'client-a'));

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
            a.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            b.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'b'));
            other.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appB', 'o'));

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
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
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
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
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
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
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
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
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
            connected.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));

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
