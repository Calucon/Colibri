import * as net from 'net';
import { WorkerMessage, WorkerService } from '../core/index.js';
import * as threads from 'worker_threads';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
    COLIBRI_CHANNEL,
    FrameError,
    FrameReader,
    FrameType,
    MAX_FRAME_LENGTH,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    encodeHeartbeatFrame,
    encodeMessageFrame,
    protocolRejection,
} from './protocol.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);

// Passed as workerData by TCPServerProxy and checked by the bootstrap at the bottom of this
// file. `!threads.isMainThread` alone was not enough of a guard: any test runner that
// executes its suites inside worker threads (vitest's default pool does) would construct a
// second TCPServerWorker on import and have it subscribe to *that* thread's message
// channel, which is the runner's own RPC.
export const TCP_SERVER_WORKER_ROLE = 'colibri-tcp-server';
const maxBufferSize = MAX_FRAME_LENGTH;

// For a last-write-wins synchronization server, a client whose socket write buffer is
// already this full is not keeping up - queuing yet another update behind it only grows
// process memory without bound (the old `socket.write()`'s return value was ignored
// entirely). Dropping a stale update for a slow client is the correct behaviour here.
const highWaterMark = 1024 * 1024;

// The worker thread only ever deals in raw payload bytes (straight off the wire, or
// destined for it) - the Payload memoization abstraction lives at the ConnectionPool
// layer on the main thread, on the other side of the postMessage boundary. Keeping the
// payload as a Buffer here means a byte-verbatim TCP->TCP relay never pays a utf8
// transcode; only a hook that actually inspects the payload (on the main thread) pays
// for decoding it.
export interface WireNetworkMessage {
    origin?: {
        id: string;
        app: string;
        name: string;
        version: string;
        metadata: Record<string, unknown>;
    };
    channel: string;
    command: string;
    payload: Buffer;
}

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

interface TcpClient {
    id: string;
    socket: net.Socket;
    reader: FrameReader;
    address: string;
    app: string;
    version: string;
    name: string;
    // Guards handleSocketDisconnect against running twice for the same client - a socket
    // error is always followed by its own 'close' event, so without this both paths would
    // post a duplicate clientDisconnected$.
    disconnected: boolean;
    // Set while writes to this client are being dropped for backpressure. Only the
    // transitions in and out of that state are logged: a stalled client drops at least ten
    // heartbeats a second, and each dropped-packet warning is postMessage'd to the main
    // thread and re-broadcast to every admin UI, which WebLog can't dedupe because the
    // byte count is interpolated into the message.
    dropping: boolean;
    droppedSinceWarning: number;
}

export class TCPServerWorker extends WorkerService {
    private server: net.Server | undefined;

    // waiting for client to specify app name
    private readonly waitingClients = new Map<string, TcpClient>();
    // properly connected clients
    private readonly clients = new Map<string, TcpClient>();
    // clients grouped by app, so broadcast() can resolve recipients without scanning
    // every connected client
    private readonly clientsByApp = new Map<string, Set<TcpClient>>();

    private heartbeatInterval: NodeJS.Timeout | undefined;

    public constructor() {
        super(true);

        // Anything thrown out of this subscriber escapes into the worker's own
        // uncaughtException path and takes the whole thread - and with it the entire TCP
        // transport - down, while HTTP and Socket.IO keep serving as if nothing happened.
        // One bad message must never cost more than that message.
        this.parentMessages$.subscribe((msg) => {
            try {
                this.handleParentMessage(msg);
            } catch (err) {
                this.logError(
                    `Error handling '${msg.channel}' from the main thread: ${err instanceof Error ? err.message : String(err)}`,
                    false
                );
            }
        });
    }

    private handleParentMessage(msg: WorkerMessage): void {
        switch (msg.channel) {
            case 'm:start':
                this.start(
                    msg.content.port as number,
                    msg.content.host as string
                );
                break;

            case 'm:stop':
                this.stop();
                break;

            case 'm:broadcast': {
                const ids = msg.content.clients as string[];
                const clients = ids
                    .map((id) => this.clients.get(id))
                    .filter((c): c is TcpClient => !!c);

                this.broadcast(msg.content.msg as WireNetworkMessage, clients);
                break;
            }

            case 'm:broadcastToApp': {
                const app = msg.content.app as string;
                const exclude = msg.content.exclude as string | undefined;
                const clients = Array.from(this.clientsByApp.get(app) ?? [])
                    .filter((c) => c.id !== exclude);

                this.broadcast(msg.content.msg as WireNetworkMessage, clients);
                break;
            }
        }
    }

    public start(port: number, host: string): void {
        this.server = net.createServer((socket) =>
            this.handleConnection(socket)
        );
        this.server.listen(port, host);

        this.logInfo(`Starting Colibri TCP server on ${host}:${port}`);
        this.heartbeatInterval = setInterval(() => this.handleHeartbeat(), 100);
    }

    // Tolerates being called before start() (an 'm:stop' racing startup) and destroys live
    // sockets rather than leaving them to the terminate() that usually follows - so a stop
    // without a terminate, or a restart in the same thread, doesn't leak connections or
    // leave stale entries in the client indexes.
    public stop(): void {
        clearInterval(this.heartbeatInterval);
        this.server?.close();

        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            client.socket.destroy();
        }
        this.clients.clear();
        this.waitingClients.clear();
        this.clientsByApp.clear();
    }

    public broadcast(
        msg: WireNetworkMessage,
        clients: ReadonlyArray<TcpClient>
    ): void {
        if (clients.length === 0) {
            return;
        }

        let packet: Buffer;
        try {
            packet = encodeMessageFrame({
                channel: msg.channel,
                command: msg.command,
                payload: toBuffer(msg.payload),
            }, maxBufferSize);
        } catch (err) {
            // An unrepresentable frame (channel/command over 64 KiB, or a body over
            // maxBufferSize) is dropped as a single bad message. Emitting it anyway would
            // produce a frame this server's own FrameReader would reject.
            this.logError(
                `Dropping unencodable message (${msg.channel} / ${msg.command}): ${err instanceof Error ? err.message : String(err)}`,
                false
            );
            return;
        }

        for (const client of clients) {
            this.writeToClient(client, packet);
        }
    }

    private writeToClient(client: TcpClient, packet: Buffer): void {
        if (client.socket.writableLength > highWaterMark) {
            client.droppedSinceWarning += 1;
            if (!client.dropping) {
                client.dropping = true;
                this.logWarning(
                    `Dropping messages to client ${client.id}: writable buffer exceeds high-water mark (${client.socket.writableLength} bytes)`
                );
            }
            return;
        }

        if (client.dropping) {
            client.dropping = false;
            this.logWarning(
                `Client ${client.id} caught up; dropped ${client.droppedSinceWarning} message(s) while backed up`
            );
            client.droppedSinceWarning = 0;
        }

        client.socket.write(packet, (err) => {
            if (err) {
                this.logWarning(
                    `Failed to send message to client ${client.id}: ${err.message} `
                );
            }
        });
    }

    private handleConnection(socket: net.Socket): void {
        const id = randomUUID();
        this.logDebug(
            `New client (${id}) connected from ${socket.remoteAddress}, waiting for app name`
        );
        socket.setNoDelay(true);

        const tcpClient: TcpClient = {
            id,
            socket,
            reader: new FrameReader(maxBufferSize),
            address: socket.remoteAddress || 'UNDEFINED',
            app: '',
            name: '',
            version: '0',
            disconnected: false,
            dropping: false,
            droppedSinceWarning: 0,
        };
        this.waitingClients.set(tcpClient.id, tcpClient);

        socket.on('data', (data) => {
            this.handleSocketData(tcpClient, data);
        });

        socket.on('error', (error) => {
            this.handleSocketError(tcpClient, error);
        });

        // 'close' always fires exactly once, whether the socket ended gracefully, errored,
        // or was destroyed outright - unlike 'end', which never fires on an abrupt
        // disconnect (e.g. a client that vanishes without sending FIN), which used to leak
        // that client in `clients`/`clientsByApp` forever.
        socket.on('close', () => {
            this.handleSocketDisconnect(tcpClient);
        });
    }

    private handleSocketData(client: TcpClient, data: Buffer): void {
        let frames;
        try {
            frames = client.reader.append(data);
        } catch (err) {
            const reason = err instanceof FrameError ? err.message : String(err);
            this.logError(
                `Invalid frame from client ${client.id}, discarding buffer and terminating connection: ${reason}`,
                false
            );
            client.reader.reset();
            client.socket.end();
            return;
        }

        for (const frame of frames) {
            switch (frame.type) {
                case FrameType.Handshake:
                    try {
                        this.assignApp(client, frame.app, frame.name, frame.version);
                    } catch (err) {
                        this.logError(
                            `Invalid handshake packet received from client ${client.id}`,
                            false
                        );
                        if (err instanceof Error) this.logError(err.stack || '', false);
                        else console.error(err);
                    }
                    break;

                case FrameType.Heartbeat:
                    this.handlePong(client, frame.pingTimestamp);
                    break;

                case FrameType.Message:
                    if (client.app) {
                        this.postMessage('clientMessage$', {
                            channel: frame.channel,
                            command: frame.command,
                            payload: frame.payload,
                            origin: {
                                id: client.id,
                                app: client.app,
                                name: client.name,
                                version: client.version,
                                metadata: {},
                            },
                        });
                    } else {
                        this.logError(
                            `Ignoring message (${frame.channel} / ${frame.command}) from client ${client.id} without app`,
                            false
                        );
                    }
                    break;
            }
        }
    }

    private assignApp(client: TcpClient, app: string, name: string, version: string): void {
        // Refuse before the client is indexed, so a mismatched client never reaches an app's
        // broadcast set, never posts clientConnected$, and never shows up in the admin UI as
        // a half-connected ghost.
        if (version !== PROTOCOL_VERSION) {
            this.rejectProtocolVersion(client, name, version);
            return;
        }

        // A second handshake frame with a different app would otherwise leave the client in
        // its previous app's Set forever - removeFromAppIndex only ever looks at the
        // client's *current* app - so a disconnected socket would keep receiving
        // writeToClient calls for the app it first announced.
        if (client.app) {
            this.removeFromAppIndex(client);
        }

        client.app = app;
        client.name = name;
        client.version = version;
        this.logDebug(
            `Setting app of new colibri client '${name}' (${client.id}, v${version}) to "${app}"`,
            {
                clientApp: client.app,
                clientName: client.name,
                clientId: client.id,
            }
        );
        this.waitingClients.delete(client.id);
        this.clients.set(client.id, client);
        this.addToAppIndex(client);
        this.postMessage('clientConnected$', { id: client.id, app, name, version });
    }

    // Tells the client why it was refused and closes the connection. This is best-effort by
    // nature: it only reaches a client whose *framing* this server still speaks. A genuine
    // v1 client cannot decode the frame at all, so for that case the log line below - naming
    // both versions and the peer - is the whole diagnostic, and it is the one an integrator
    // will actually look at.
    //
    // end(packet) rather than write-then-end: it queues the rejection and the FIN together,
    // so the frame cannot be lost to a close that races the write callback.
    private rejectProtocolVersion(client: TcpClient, name: string, version: string): void {
        const rejection = protocolRejection(version);
        this.logError(
            `Refusing client '${name}' (${client.id}, ${client.address}): ${rejection.reason}`,
            false
        );

        try {
            client.socket.end(encodeMessageFrame({
                channel: COLIBRI_CHANNEL,
                command: PROTOCOL_REJECTED_COMMAND,
                payload: Buffer.from(JSON.stringify(rejection), 'utf8'),
            }, maxBufferSize));
        } catch {
            // Nothing useful to say if even the refusal cannot be encoded or written - the
            // socket is going away either way.
            client.socket.end();
        }
    }

    // A client echoes a server-sent heartbeat frame's timestamp back verbatim; relay it
    // into the normal clientMessage$ pipeline as a 'colibri'/'latency' message so
    // MeasureLatency's existing round-trip math (unchanged) handles it exactly as it
    // would a message-level ping reply. hrtime is a system-wide monotonic clock, so a
    // timestamp this worker generated remains valid to diff against once it reaches the
    // main thread. The difference from before is purely in what it cost to get here: one
    // fixed 13-byte frame each way instead of a full channel/command/payload message.
    private handlePong(client: TcpClient, pingTimestamp: bigint): void {
        if (!client.app) return;

        this.postMessage('clientMessage$', {
            channel: 'colibri',
            command: 'latency',
            payload: Buffer.from(pingTimestamp.toString(), 'utf8'),
            origin: {
                id: client.id,
                app: client.app,
                name: client.name,
                version: client.version,
                metadata: {},
            },
        });
    }

    private handleSocketError(client: TcpClient, error: Error): void {
        // ignore ECONNRESET errors, as they are caused by the client disconnecting
        if (error.message.indexOf('ECONNRESET') === -1) {
            this.logError(error.message, false);
        }

        // No need to call handleSocketDisconnect here - a socket's 'close' event always
        // fires directly after 'error', and that already handles cleanup.
    }

    private handleSocketDisconnect(client: TcpClient): void {
        if (client.disconnected) return;
        client.disconnected = true;

        this.logDebug(`Colibri client ${client.address} disconnected`, {
            clientApp: client.app,
            clientName: client.name,
            clientId: client.id,
        });
        this.clients.delete(client.id);
        this.waitingClients.delete(client.id);
        this.removeFromAppIndex(client);
        this.postMessage('clientDisconnected$', { id: client.id });
    }

    private addToAppIndex(client: TcpClient): void {
        let clients = this.clientsByApp.get(client.app);
        if (!clients) {
            clients = new Set();
            this.clientsByApp.set(client.app, clients);
        }
        clients.add(client);
    }

    private removeFromAppIndex(client: TcpClient): void {
        const clients = this.clientsByApp.get(client.app);
        if (!clients) return;

        clients.delete(client);
        if (clients.size === 0) {
            this.clientsByApp.delete(client.app);
        }
    }

    private handleHeartbeat(): void {
        const packet = encodeHeartbeatFrame(process.hrtime.bigint());
        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            this.writeToClient(client, packet);
        }
    }
}

if (!threads.isMainThread && (threads.workerData as { role?: string } | null)?.role === TCP_SERVER_WORKER_ROLE) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
