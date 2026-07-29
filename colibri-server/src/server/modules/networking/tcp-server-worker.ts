import * as net from 'net';
import { WorkerService } from '../core/index.js';
import * as threads from 'worker_threads';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { FrameError, FrameReader, FrameType, encodeHeartbeatFrame, encodeMessageFrame } from './protocol.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);
const maxBufferSize = 1024 * 1024 * 5;

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
}

export class TCPServerWorker extends WorkerService {
    private server!: net.Server;

    // waiting for client to specify app name
    private readonly waitingClients = new Map<string, TcpClient>();
    // properly connected clients
    private readonly clients = new Map<string, TcpClient>();
    // clients grouped by app, so broadcast() can resolve recipients without scanning
    // every connected client
    private readonly clientsByApp = new Map<string, Set<TcpClient>>();

    private heartbeatInterval!: NodeJS.Timeout;

    public constructor() {
        super(true);

        this.parentMessages$.subscribe((msg) => {
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
        });
    }

    public start(port: number, host: string): void {
        this.server = net.createServer((socket) =>
            this.handleConnection(socket)
        );
        this.server.listen(port, host);

        this.logInfo(`Starting Colibri TCP server on ${host}:${port}`);
        this.heartbeatInterval = setInterval(() => this.handleHeartbeat(), 100);
    }

    public stop(): void {
        this.server.close();
        clearInterval(this.heartbeatInterval);
    }

    public broadcast(
        msg: WireNetworkMessage,
        clients: ReadonlyArray<TcpClient>
    ): void {
        if (clients.length === 0) {
            return;
        }

        const packet = encodeMessageFrame({
            channel: msg.channel,
            command: msg.command,
            payload: toBuffer(msg.payload),
        });

        for (const client of clients) {
            this.writeToClient(client, packet);
        }
    }

    private writeToClient(client: TcpClient, packet: Buffer): void {
        if (client.socket.writableLength > highWaterMark) {
            this.logWarning(
                `Dropping message to client ${client.id}: writable buffer exceeds high-water mark (${client.socket.writableLength} bytes)`
            );
            return;
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
        };
        this.waitingClients.set(tcpClient.id, tcpClient);

        socket.on('data', (data) => {
            this.handleSocketData(tcpClient, data);
        });

        socket.on('error', (error) => {
            this.handleSocketError(tcpClient, error);
        });

        socket.on('end', () => {
            this.handleSocketDisconnect(tcpClient);
        });
    }

    private handleSocketData(client: TcpClient, data: Buffer): void {
        let frames;
        try {
            frames = Array.from(client.reader.append(data));
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

        this.handleSocketDisconnect(client);
    }

    private handleSocketDisconnect(client: TcpClient): void {
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

    private handleHeartbeat() {
        const packet = encodeHeartbeatFrame(process.hrtime.bigint());
        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            this.writeToClient(client, packet);
        }
    }
}

if (!threads.isMainThread) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
