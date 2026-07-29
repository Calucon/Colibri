import * as net from 'net';
import { WorkerService } from '../core/index.js';
import * as threads from 'worker_threads';
import * as flatbuffers from 'flatbuffers';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { Message } from './message.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);
const maxBufferSize = 1024 * 1024 * 5;

// The worker thread only ever deals in wire-string payloads (from the flatbuffer, or
// destined for one) - the Payload memoization abstraction lives at the ConnectionPool
// layer on the main thread, on the other side of the postMessage boundary.
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
    payload: string;
}

// v1 wire format: \0\0\0(ascii packet length)\0(flatbuffer-encoded Message)
// Extracted from TCPServerWorker.broadcast so it can be exercised by bench/framing.bench.ts
// without a real socket/worker; behavior is unchanged.
export const encodeV1Packet = function (msg: WireNetworkMessage): Uint8Array {
    const builder = new flatbuffers.Builder(1024);
    const channel = builder.createString(msg.channel);
    const command = builder.createString(msg.command);
    // TODO: replace this with dictionary to avoid JSON serialization
    //       see: https://flatbuffers.dev/flatbuffers_guide_use_c-sharp.html#autotoc_md93
    const payload = builder.createString(msg.payload);

    Message.startMessage(builder);
    Message.addChannel(builder, channel);
    Message.addCommand(builder, command);
    Message.addPayload(builder, payload);
    const message = Message.endMessage(builder);
    builder.finish(message);

    const msgBytes = builder.asUint8Array();
    // FIXME: we don't want to deal with big/little endian, so we just use utf8 encoding for packet length
    const packetHeader = new TextEncoder().encode(
        `\0\0\0${msgBytes.length.toString()}\0`
    );

    // TODO:  could probably be more efficient!
    const mergedPacket = new Uint8Array(
        packetHeader.length + msgBytes.length
    );
    mergedPacket.set(packetHeader);
    mergedPacket.set(msgBytes, packetHeader.length);
    return mergedPacket;
};

interface TcpClient {
    id: string;
    socket: net.Socket;
    leftOverBuffer: Buffer;
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

        const mergedPacket = encodeV1Packet(msg);

        for (const client of clients) {
            // message format:
            // \0\0\0(PacketHeader)\0(ActualMessage)
            const tcpClient = client;
            tcpClient.socket.write(mergedPacket, (err) => {
                if (err) {
                    this.logWarning(
                        `Failed to send message to client ${client.id}: ${err.message} `
                    );
                }
            });
        }
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
            leftOverBuffer: Buffer.alloc(0),
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
        let buffer = Buffer.concat([client.leftOverBuffer, data]);
        const msgs: WireNetworkMessage[] = [];

        const PACKET_HEADER_START = '\0\0\0';

        while (buffer.length > 0) {
            if (buffer.length <= PACKET_HEADER_START.length) {
                // incomplete packet, store leftovers
                client.leftOverBuffer = buffer;
                break;
            }

            if (buffer.subarray(0, 3).toString() !== PACKET_HEADER_START) {
                // invalid packet?!
                this.logError(
                    `Invalid packet received from client ${client.id}, discarding buffer`,
                    false
                );
                client.leftOverBuffer = Buffer.alloc(0);
                break;
            }

            const headerStart = 0;
            const headerEnd = buffer.indexOf('\0', headerStart + 4);

            if (headerEnd < 0) {
                // incomplete packet, store leftovers
                client.leftOverBuffer = buffer;
                break;
            }

            const packetLengthBuffer = buffer.subarray(
                headerStart + 3,
                headerEnd
            );
            // FIXME: we don't want to deal with big/little endian, so we just use utf8 encoding for packet length
            //        also the header might contain more than just the packet length, so we need to parse it
            const header = packetLengthBuffer.toString('utf8');
            let packetLength: number;

            if (header === 'h') {
                // handshake
                const packetEnd = buffer.indexOf('\0', headerEnd + 1);

                if (packetEnd < 0) {
                    // incomplete packet, store leftovers
                    client.leftOverBuffer = buffer;
                    break;
                }

                packetLength = packetEnd - headerEnd;
                const packet = buffer
                    .subarray(headerEnd, packetEnd)
                    .toString()
                    .replace(/\0/g, '');
                try {
                    const [version, app, name] = packet.split('::');
                    if (version === undefined || app === undefined || name === undefined) {
                        throw new Error(`Malformed handshake packet: "${packet}"`);
                    }
                    this.assignApp(client, app, name, version);
                } catch (err) {
                    this.logError(
                        `Invalid handshake packet received from client ${client.id}`,
                        false
                    );
                    if (err instanceof Error)
                        this.logError(err.stack || '', false);
                    else console.error(err);
                }
            } else {
                // Packet with payload (normal message)
                packetLength = Number(header);
                if (!Number.isFinite(packetLength)) {
                    this.logError(
                        `Invalid header received from client ${client.id}, discarding buffer`,
                        false
                    );
                    this.logDebug(`Header: ${header}`);
                    client.leftOverBuffer = Buffer.alloc(0);
                    break;
                }

                const packetEnd = headerEnd + 1 + packetLength;

                if (packetEnd > buffer.length) {
                    // incomplete packet, store leftovers
                    client.leftOverBuffer = buffer;
                    break;
                }

                const packet = buffer.subarray(headerEnd + 1, packetEnd);
                const packetBuffer = new flatbuffers.ByteBuffer(packet);
                const message = Message.getRootAsMessage(packetBuffer);

                try {
                    msgs.push({
                        channel: message.channel() || '',
                        command: message.command() || '',
                        payload: message.payload() || '',
                        origin: {
                            id: client.id,
                            app: client.app,
                            name: client.name,
                            version: client.version,
                            metadata: {},
                        },
                    });
                } catch (err) {
                    if (err instanceof Error)
                        this.logError(err.stack || '', false);
                    else console.error(err);
                }
            }

            // if there are multiple packets in the buffer, begin anew
            buffer = buffer.subarray(headerEnd + 1 + packetLength);
        }

        // clear leftover buffers once we're finished
        if (buffer.length === 0) {
            client.leftOverBuffer = Buffer.alloc(0);
        }

        // try to somewhat mitigate spamming clients
        if (client.leftOverBuffer.length > maxBufferSize) {
            this.logWarning(
                `Client ${client.id} exceeds max buffer size (${maxBufferSize} bytes), discarding buffer and terminating connection`
            );
            client.socket.end();
        }

        // pass on actual messages
        for (const msg of msgs) {
            if (client.app) {
                this.postMessage(
                    'clientMessage$',
                    msg as unknown as { [key: string]: unknown }
                );
            } else {
                this.logError(
                    `Ignoring message (${msg.channel} / ${msg.command}) from client ${client.id} without app`,
                    false
                );
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
        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            client.socket.write('\0\0\0h\0');
        }

    }
}

if (!threads.isMainThread) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
