import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type * as net from 'net';
import { TCPServerWorker, TcpServerOptions, WireNetworkMessage } from '../../src/server/modules/networking/tcp-server-worker.js';
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

    public keepAlive: [boolean, number] | undefined;
    public setKeepAlive(enable: boolean, initialDelay: number): this {
        this.keepAlive = [enable, initialDelay];
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
    tick(): void;
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

        it('refuses a handshake whose app ends in a colon instead of moving the colon into the name', () => {
            const { socket, id } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'app:', 'name'));

            expect(socket.ended).toBe(true);
            expect(internals.clients.has(id)).toBe(false);
            expect(internals.clientsByApp.has('app')).toBe(false);
            expect(posted.filter(p => p.channel === 'clientConnected$')).toHaveLength(0);
            expect(logs().some(l => l.includes('Malformed handshake frame'))).toBe(true);
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

    describe('inbound messages', () => {
        it('posts each payload to the main thread in a buffer of its own', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));

            socket.emit('data', Buffer.concat([
                encodeMessageFrame(wireMessage('chan', 'model::update', '{"id":"a"}')),
                encodeMessageFrame(wireMessage('chan', 'model::update', '{"id":"b"}')),
            ]));

            const payloads = posted.filter(p => p.channel === 'clientMessage$').map(p => p.content.payload as Buffer);
            expect(payloads.map(p => p.toString())).toEqual(['{"id":"a"}', '{"id":"b"}']);
            for (const payload of payloads) expect(payload.buffer.byteLength).toBe(payload.length);
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

    // colibri-unity counts a session as connected from the first frame it decodes. A heartbeat
    // sent before the handshake was checked made a client about to be refused fire OnConnected
    // first, and ProtocolMismatch a moment later.
    describe('heartbeats before the handshake', () => {
        const framesWrittenTo = function (socket: FakeSocket) {
            const reader = new FrameReader();
            return socket.written.flatMap(chunk => reader.append(chunk));
        };

        it('are not sent to a client that has not handshaked yet', () => {
            const { socket } = connect();

            internals.handleHeartbeat();
            internals.handleHeartbeat();

            expect(socket.written).toEqual([]);
        });

        it('start once the handshake is accepted', () => {
            const { socket } = connect();
            internals.handleHeartbeat();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));

            internals.handleHeartbeat();

            expect(framesWrittenTo(socket).map(f => f.type)).toEqual([FrameType.Heartbeat]);
        });

        it('never reach a refused client: the first frame it sees is the refusal', () => {
            const { socket } = connect();
            internals.handleHeartbeat();
            socket.emit('data', encodeHandshakeFrame('1', 'appA', 'old-client'));
            internals.handleHeartbeat();

            const frames = framesWrittenTo(socket);
            expect(frames).toHaveLength(1);
            expect(frames[0]?.type === FrameType.Message && frames[0].command).toBe('protocol::rejected');
        });
    });

    // The worker->main MessagePort queue used to grow without bound once the main thread fell
    // behind: every message a structured clone held in memory, seconds old by the time it was
    // handled, until the process ran out of memory - and nothing was logged on the way.
    describe('inbound backlog', () => {
        let backlog: Int32Array;

        const configure = function (options: Omit<TcpServerOptions, 'inboundBacklog'>): void {
            backlog = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            worker.configure({ ...options, inboundBacklog: backlog });
        };

        const handshaked = function (name = 'quest-1'): FakeSocket {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', name));
            posted = [];
            return socket;
        };

        const send = function (socket: FakeSocket, channel: string, command: string, payload = '{"id":"a"}'): void {
            socket.emit('data', encodeMessageFrame(wireMessage(channel, command, payload)));
        };

        // What TCPServerProxy does once it has dispatched everything.
        const caughtUp = function (): void {
            Atomics.store(backlog, 0, 0);
        };

        const relayed = (): string[] =>
            posted.filter(p => p.channel === 'clientMessage$').map(p => `${String(p.content.channel)} ${String(p.content.command)}`);
        const relayedUpdates = (): unknown[] =>
            posted
                .filter(p => p.channel === 'clientMessage$' && p.content.command === 'model::update')
                .map(p => JSON.parse((p.content.payload as Buffer).toString('utf8')) as unknown);
        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));

        it('counts every message posted to the main thread, heartbeat replies included', () => {
            configure({ inboundBacklogLimit: 100 });
            const socket = handshaked();

            send(socket, 'objects', 'model::update');
            send(socket, 'objects', 'model::request');
            socket.emit('data', encodeHeartbeatFrame(1n));

            expect(relayed()).toEqual(['objects model::update', 'objects model::request', 'colibri latency']);
            expect(Atomics.load(backlog, 0)).toBe(3);
        });

        // A model::update is a delta of the fields that changed: dropping one could lose a field
        // change for good, in every other client and in the store.
        it('holds model updates back while the main thread is at the limit, merged per object, and passes them on once it caught up', () => {
            configure({ inboundBacklogLimit: 2 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"a","x":1}');
            send(socket, 'objects', 'model::update', '{"id":"a","x":2}');

            send(socket, 'objects', 'model::update', '{"id":"a","isOn":true}');
            send(socket, 'objects', 'model::update', '{"id":"b","x":1}');
            send(socket, 'objects', 'model::update', '{"id":"a","x":3}');
            expect(relayed()).toHaveLength(2);
            expect(Atomics.load(backlog, 0)).toBe(2);

            caughtUp();
            internals.tick();

            expect(relayedUpdates()).toEqual([
                { id: 'a', x: 1 },
                { id: 'a', x: 2 },
                { id: 'a', isOn: true, x: 3 },
                { id: 'b', x: 1 },
            ]);
        });

        it('passes held updates on ahead of the next message once there is room', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"a","x":1}');
            send(socket, 'objects', 'model::update', '{"id":"b","x":1}');

            caughtUp();
            send(socket, 'objects', 'model::update', '{"id":"c","x":1}');

            expect(relayedUpdates()).toEqual([{ id: 'a', x: 1 }, { id: 'b', x: 1 }]);
            caughtUp();
            internals.tick();
            expect(relayedUpdates()).toEqual([{ id: 'a', x: 1 }, { id: 'b', x: 1 }, { id: 'c', x: 1 }]);
        });

        it('drops broadcasts while the main thread is at the limit', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update');

            send(socket, 'myChannel', 'broadcast::json', '{"x":1}');
            caughtUp();
            internals.tick();

            expect(relayed()).toEqual(['objects model::update']);
        });

        it('drops an update it could not merge: not a JSON object with an id', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 1 });
                const socket = handshaked();
                send(socket, 'objects', 'model::update');

                send(socket, 'objects', 'model::update', 'not json');
                send(socket, 'objects', 'model::update', '{"x":1}');
                caughtUp();
                vi.advanceTimersByTime(1000);
                internals.tick();

                expect(relayed()).toEqual(['objects model::update']);
                expect(warnings()[1]).toContain('dropped 2 message(s)');
            } finally {
                vi.useRealTimers();
            }
        });

        it('never limits a request, a delete, a log line, latency or anything on the colibri channel', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update');

            send(socket, 'objects', 'model::request');
            send(socket, 'objects', 'model::delete');
            send(socket, 'clients', 'client::request', '');
            send(socket, 'log', 'error', 'boom');
            send(socket, 'colibri', 'broadcast::json');
            socket.emit('data', encodeHeartbeatFrame(1n));

            expect(relayed()).toEqual([
                'objects model::update',
                'objects model::request',
                'objects model::delete',
                'clients client::request',
                'log error',
                'colibri broadcast::json',
                'colibri latency',
            ]);
        });

        // A delete overtaking a held update to the same object would have that update bring the
        // object back, in the store and in every other client.
        it('lets nothing overtake a held update: it goes before the client\'s next request or delete', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"other"}');
            send(socket, 'objects', 'model::update', '{"id":"cube","x":5}');

            send(socket, 'objects', 'model::delete', '{"id":"cube"}');

            expect(posted.filter(p => p.channel === 'clientMessage$').map(p => `${String(p.content.command)} ${(p.content.payload as Buffer).toString()}`)).toEqual([
                'model::update {"id":"other"}',
                'model::update {"id":"cube","x":5}',
                'model::delete {"id":"cube"}',
            ]);
        });

        it('passes on what a client held back before reporting it gone', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"a"}');
            send(socket, 'objects', 'model::update', '{"id":"last-state","x":9}');

            socket.emit('close');

            expect(posted.filter(p => p.channel !== 'log').map(p => p.channel)).toEqual([
                'clientMessage$',
                'clientMessage$',
                'clientDisconnected$',
            ]);
            expect(relayedUpdates()[1]).toEqual({ id: 'last-state', x: 9 });
        });

        // A held update is posted with the client's app at the time it goes. Left held across a
        // handshake into another app, it would reach the main thread as the new app's: stored in
        // the new app's model store and relayed to its clients, while the old app never got it.
        it('passes on what a client held back in its old app before it handshakes into another', () => {
            configure({ inboundBacklogLimit: 1 });
            const socket = handshaked();
            send(socket, 'objects', 'model::update', '{"id":"first"}');
            send(socket, 'objects', 'model::update', '{"id":"held","x":1}');

            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appB', 'quest-1'));
            caughtUp();
            internals.tick();

            expect(posted.filter(p => p.channel !== 'log').map(p => p.channel === 'clientMessage$'
                ? `${(p.content.origin as { app: string }).app} ${(p.content.payload as Buffer).toString()}`
                : `${p.channel} ${String(p.content.app)}`)).toEqual([
                'appA {"id":"first"}',
                'appA {"id":"held","x":1}',
                'clientConnected$ appB',
            ]);
        });

        it('shares out the room that frees up evenly between the clients holding updates', () => {
            configure({ inboundBacklogLimit: 2 });
            const first = handshaked('first');
            const second = handshaked('second');
            send(first, 'objects', 'model::update', '{"id":"f0"}');
            send(first, 'objects', 'model::update', '{"id":"f1"}');
            for (let i = 2; i < 5; i++) send(first, 'objects', 'model::update', `{"id":"f${i}"}`);
            for (let i = 0; i < 3; i++) send(second, 'objects', 'model::update', `{"id":"s${i}"}`);
            posted = [];

            caughtUp();
            internals.tick();

            expect(relayedUpdates()).toEqual([{ id: 'f2' }, { id: 's0' }]);
        });

        it('warns once when it starts holding back and sums up once it has stopped', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 1 });
                const socket = handshaked();
                send(socket, 'objects', 'model::update');
                send(socket, 'myChannel', 'broadcast::json', '{}');
                for (let i = 0; i < 50; i++) {
                    send(socket, 'objects', 'model::update', `{"id":"a","x":${i}}`);
                    vi.advanceTimersByTime(10);
                    internals.tick();
                }

                expect(warnings()).toHaveLength(1);
                expect(warnings()[0]).toContain('fallen 1 TCP messages behind');
                expect(warnings()[0]).toContain('TCP_INBOUND_BACKLOG_LIMIT');
                expect(warnings()[0]).toContain('held back and merged per object');

                // Nothing has been over the limit for 10 ms; the episode ends a second after it.
                caughtUp();
                vi.advanceTimersByTime(989);
                internals.tick();
                expect(warnings()).toHaveLength(1);
                // ...but what was held back went on as soon as there was room.
                expect(relayedUpdates()).toEqual([{ id: 'a' }, { id: 'a', x: 49 }]);

                vi.advanceTimersByTime(1);
                internals.tick();
                expect(warnings()).toHaveLength(2);
                expect(warnings()[1]).toContain('caught up');
                expect(warnings()[1]).toContain('held back 50 model::update(s), merged per object and dropped 1 message(s) over 0.5 s');

                internals.tick();
                expect(warnings()).toHaveLength(2);
            } finally {
                vi.useRealTimers();
            }
        });

        // A token taken for an update the backlog then held back, and another when it went on,
        // would put a client at a legitimate rate over its own limit whenever the server is behind.
        it('does not spend a client\'s rate limit on what the backlog holds back', () => {
            vi.useFakeTimers();
            try {
                configure({ inboundBacklogLimit: 2, rateLimit: { messagesPerSecond: 10, burst: 5 } });
                const socket = handshaked();
                send(socket, 'objects', 'model::update', '{"id":"first"}');
                send(socket, 'objects', 'model::update', '{"id":"second"}');

                // Held back by the backlog alone: three tokens are left for them afterwards.
                for (let i = 0; i < 20; i++) send(socket, 'objects', 'model::update', `{"id":"o${i}"}`);
                for (let i = 0; i < 3; i++) {
                    caughtUp();
                    internals.tick();
                }

                expect(relayed()).toHaveLength(5);
                expect(warnings().filter(w => w.includes('is sending more than'))).toEqual([]);
            } finally {
                vi.useRealTimers();
            }
        });

        it('never limits anything with the limit off', () => {
            configure({ inboundBacklogLimit: 0 });
            const socket = handshaked();

            for (let i = 0; i < 100; i++) send(socket, 'objects', 'model::update');

            expect(relayed()).toHaveLength(100);
            expect(warnings()).toEqual([]);
        });

        it('takes its settings from the start message', () => {
            const shared = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
            const start = vi.spyOn(worker, 'start').mockImplementation(() => undefined);
            internals.handleParentMessage({
                channel: 'm:start',
                content: { port: 1, host: '127.0.0.1', options: { inboundBacklog: shared, inboundBacklogLimit: 1 } },
            });
            expect(start).toHaveBeenCalledWith(1, '127.0.0.1');
            const socket = handshaked();

            send(socket, 'objects', 'model::update');
            send(socket, 'objects', 'model::update');

            expect(relayed()).toHaveLength(1);
            expect(Atomics.load(shared, 0)).toBe(1);
        });
    });

    // A backstop for one client's runaway send loop, which on its own could push the main thread
    // past the backlog limit and slow every other client down too.
    describe('per-client rate limit', () => {
        const handshaked = function (name: string): { socket: FakeSocket; id: string } {
            const client = connect();
            client.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', name));
            return client;
        };

        // `count` updates (or other commands), each to an object of its own, ids from `from` on.
        const burstOf = function (count: number, command = 'model::update', channel = 'objects', from = 0): Buffer {
            return Buffer.concat(Array.from({ length: count }, (_, i) => encodeMessageFrame(wireMessage(channel, command, `{"id":"${from + i}"}`))));
        };

        const relayedFrom = (id: string, command?: string): number =>
            posted.filter(p => p.channel === 'clientMessage$'
                && (p.content.origin as { id: string }).id === id
                && (command === undefined || p.content.command === command)).length;
        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));

        beforeEach(() => {
            vi.useFakeTimers();
            worker.configure({ rateLimit: { messagesPerSecond: 100, burst: 200 } });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('holds back a client\'s updates and drops its broadcasts past its burst, and warns once naming it', () => {
            const runaway = handshaked('runaway-quest');

            runaway.socket.emit('data', burstOf(150));
            runaway.socket.emit('data', burstOf(150, 'broadcast::json', 'myChannel'));
            runaway.socket.emit('data', burstOf(100, 'model::update', 'objects', 150));

            expect(relayedFrom(runaway.id, 'model::update')).toBe(150);
            expect(relayedFrom(runaway.id, 'broadcast::json')).toBe(50);
            expect(warnings()).toHaveLength(1);
            expect(warnings()[0]).toContain('Unity client \'runaway-quest\'');
            expect(warnings()[0]).toContain(runaway.id);
            expect(warnings()[0]).toContain('more than 100');
        });

        it('passes what it held back on at the client\'s sustained rate', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(250));
            expect(relayedFrom(runaway.id)).toBe(200);

            vi.advanceTimersByTime(100);
            internals.tick();
            expect(relayedFrom(runaway.id)).toBe(210);

            vi.advanceTimersByTime(400);
            internals.tick();
            expect(relayedFrom(runaway.id)).toBe(250);
        });

        it('never limits a request, a delete, a log line or a heartbeat reply - and lets none overtake a held update', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(300));
            const before = relayedFrom(runaway.id);

            runaway.socket.emit('data', Buffer.concat([
                burstOf(50, 'model::request'),
                burstOf(50, 'model::delete'),
                burstOf(50, 'info', 'log'),
                encodeHeartbeatFrame(1n),
            ]));

            // The 100 held updates first, then all 151 others.
            expect(relayedFrom(runaway.id) - before).toBe(251);
        });

        it('does not hold one client\'s loop against another', () => {
            const runaway = handshaked('runaway-quest');
            const neighbour = handshaked('neighbour');

            runaway.socket.emit('data', burstOf(500));
            neighbour.socket.emit('data', burstOf(100));

            expect(relayedFrom(neighbour.id)).toBe(100);
        });

        it('sums up the episode once the client has slowed down', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(250));

            vi.advanceTimersByTime(999);
            internals.tick();
            expect(warnings()).toHaveLength(1);

            vi.advanceTimersByTime(1);
            internals.tick();
            expect(warnings()).toHaveLength(2);
            expect(warnings()[1]).toContain('Unity client \'runaway-quest\'');
            expect(warnings()[1]).toContain('back under the message rate limit; held back 50 model::update(s)');
        });

        it('passes on what it held back, and sums up the episode, when the client disconnects over the limit', () => {
            const runaway = handshaked('runaway-quest');
            runaway.socket.emit('data', burstOf(250));

            runaway.socket.emit('close');

            expect(relayedFrom(runaway.id)).toBe(250);
            expect(warnings()[1]).toContain('disconnected while over the message rate limit; held back 50 model::update(s)');
        });

        it('limits nothing when turned off', () => {
            worker.configure({ rateLimit: { messagesPerSecond: 0, burst: 1 } });
            const client = handshaked('fast-but-allowed');

            client.socket.emit('data', burstOf(5000));

            expect(relayedFrom(client.id)).toBe(5000);
            expect(warnings()).toEqual([]);
        });

        it('defaults to 1000 a second with bursts of 2000', () => {
            worker.configure({});
            const client = handshaked('quest');

            client.socket.emit('data', burstOf(2500));
            expect(relayedFrom(client.id)).toBe(2000);

            vi.advanceTimersByTime(500);
            internals.tick();
            expect(relayedFrom(client.id)).toBe(2500);
        });
    });

    // A Quest that drops off the Wi-Fi sends no FIN. Its connection used to stay open - a
    // connected client, keeping its app's models alive - until the kernel gave up on it.
    describe('idle timeout', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const handshaked = function (name = 'quest-1'): { socket: FakeSocket; id: string } {
            const client = connect();
            client.socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', name));
            return client;
        };

        // The worker's 100 ms tick, for `millis`, with `each` run before every tick.
        const run = function (millis: number, each: () => void = () => undefined): void {
            for (let t = 0; t < millis; t += 100) {
                vi.advanceTimersByTime(100);
                each();
                internals.tick();
            }
        };

        const disconnected = (): string[] => posted.filter(p => p.channel === 'clientDisconnected$').map(p => String(p.content.id));
        const warnings = (): string[] =>
            posted.filter(p => p.channel === 'log' && p.content.level === LogLevel.Warn).map(p => String(p.content.msg));

        it('ends a handshaked client that has sent nothing for 10 s, as if it had disconnected', () => {
            const gone = handshaked('quest-gone');

            run(9_900);
            expect(disconnected()).toEqual([]);
            run(100);

            expect(disconnected()).toEqual([gone.id]);
            expect(gone.socket.destroyed).toBe(true);
            expect(internals.clients.has(gone.id)).toBe(false);
            expect(internals.clientsByApp.has('appA')).toBe(false);
            expect(warnings().filter(w => w.includes('has sent nothing for 10 s'))).toHaveLength(1);
            expect(warnings()[0]).toContain('quest-gone');

            // Its socket's own 'close' follows; that must not report it a second time.
            gone.socket.emit('close');
            expect(disconnected()).toEqual([gone.id]);
        });

        it('keeps a client that echoes its heartbeats', () => {
            const alive = handshaked('quest-alive');
            const gone = handshaked('quest-gone');

            run(30_000, () => alive.socket.emit('data', encodeHeartbeatFrame(1n)));

            expect(disconnected()).toEqual([gone.id]);
            expect(alive.socket.destroyed).toBe(false);
            expect(internals.clients.has(alive.id)).toBe(true);
        });

        it('counts any traffic, not only heartbeat replies', () => {
            const sender = handshaked();

            run(30_000, () => sender.socket.emit('data', encodeMessageFrame(wireMessage('objects', 'model::update', '{"id":"a"}'))));

            expect(disconnected()).toEqual([]);
        });

        it('ends a connection that never handshakes', () => {
            const silent = connect();

            run(10_000);

            expect(silent.socket.destroyed).toBe(true);
            expect(internals.waitingClients.has(silent.id)).toBe(false);
            expect(warnings()).toEqual([]);
        });

        it('takes another timeout from the start options, and 0 as never', () => {
            worker.configure({ idleTimeoutMillis: 3000 });
            const quick = handshaked();
            run(3000);
            expect(disconnected()).toEqual([quick.id]);

            worker.configure({ idleTimeoutMillis: 0 });
            const patient = handshaked();
            run(60_000);
            expect(patient.socket.destroyed).toBe(false);
        });

        // A worker thread that could not run for longer than the timeout has not read anything
        // either; its clients have to be given the chance to be heard before being judged.
        it('does not end clients on the tick right after the worker itself stalled', () => {
            const alive = handshaked('quest-alive');
            const gone = handshaked('quest-gone');
            run(1000);

            vi.advanceTimersByTime(15_000);
            internals.tick();
            expect(disconnected()).toEqual([]);

            // What the clients sent during the stall is read before the next tick.
            alive.socket.emit('data', encodeHeartbeatFrame(1n));
            run(100);

            expect(disconnected()).toEqual([gone.id]);
        });

        it('turns on TCP keepalive for every connection', () => {
            const { socket } = connect();

            expect(socket.keepAlive?.[0]).toBe(true);
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

        // Posted to the main thread ten times a second per client: a Buffer.from() this small is a
        // view into the 64 KiB Buffer pool, and structured clone copies the whole pool slab.
        it('posts the relayed timestamp in a buffer of its own', () => {
            const { socket } = connect();
            socket.emit('data', encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'a'));
            posted = [];

            socket.emit('data', encodeHeartbeatFrame(123456789n));

            const payload = posted.find(p => p.channel === 'clientMessage$')?.content.payload as Buffer;
            expect(payload.byteOffset).toBe(0);
            expect(payload.buffer.byteLength).toBe(payload.length);
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
