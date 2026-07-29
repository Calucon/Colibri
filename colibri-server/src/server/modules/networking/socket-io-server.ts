import { Server as SocketIoServer, Socket as SocketIoSocket, Event as SocketIoEvent } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Observable, Subject } from 'rxjs';

import { Payload, Service } from '../core/index.js';
import { NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks/index.js';

interface SocketIoClient extends NetworkClient {
    socket: SocketIoSocket;
    version: string;
}

export class SocketIOServer extends Service implements NetworkServer {
    public readonly serviceName = 'SocketIO';
    public readonly groupName = 'networking';

    private ioServer!: SocketIoServer;

    private readonly clients: SocketIoClient[] = [];
    private readonly clientStream = new Subject<SocketIoClient[]>();
    private readonly clientConnectedStream = new Subject<SocketIoClient>();
    private readonly clientDisconnectedStream = new Subject<SocketIoClient>();
    private readonly messageStream = new Subject<NetworkMessage>();

    public start(server: HttpServer): void {
        this.ioServer = new SocketIoServer(server, {
            cors: {
                origin: '*'
            }
        });

        this.ioServer.on('connection', (socket) => {
            this.handleNewClient(socket);
        });

        this.logInfo('Successfully attached SocketIO to webserver');
        this.clientStream.next(this.clients);
    }

    public stop(): void {
        this.ioServer.close();
        this.logInfo('Stopped SocketIO server');
    }

    public get clients$(): Observable<SocketIoClient[]> {
        return this.clientStream.asObservable();
    }

    public get clientConnected$(): Observable<NetworkClient> {
        return this.clientConnectedStream.asObservable();
    }

    public get clientDisconnected$(): Observable<NetworkClient> {
        return this.clientDisconnectedStream.asObservable();
    }

    public get currentClients(): ReadonlyArray<SocketIoClient> {
        return this.clients;
    }

    public get messages$(): Observable<NetworkMessage> {
        return this.messageStream.asObservable();
    }


    public broadcast(msg: NetworkMessage, clients: ReadonlyArray<SocketIoClient>): void {
        const payload = this.resolvePayload(msg);

        for (const client of clients) {
            client.socket.emit(msg.channel, {
                command: msg.command,
                payload
            });
        }
    }

    // Every client of an app shares a Socket.IO room named after that app, so this
    // encodes the packet once for the whole room instead of once per recipient.
    public broadcastToApp(msg: NetworkMessage, app: string, exceptClientId?: string): void {
        const payload = this.resolvePayload(msg);
        const room = exceptClientId ? this.ioServer.to(app).except(exceptClientId) : this.ioServer.to(app);

        room.emit(msg.channel, {
            command: msg.command,
            payload
        });
    }

    private resolvePayload(msg: NetworkMessage): unknown {
        // Cross-transport (TCP-origin) payloads are only guaranteed to be a wire string;
        // fall back to the raw string if it doesn't happen to be valid JSON. Web-origin
        // payloads already have a resolved value here, so this costs nothing for the
        // common web-to-web relay case.
        try {
            return msg.payload?.asValue();
        } catch {
            return msg.payload?.asString();
        }
    }

    private handleNewClient(socket: SocketIoSocket): void {
        const client: SocketIoClient = {
            id: socket.id,
            app: socket.handshake.query.app as string,
            version: socket.handshake.query.version as string,
            name: socket.handshake.address as string,
            metadata: {},
            socket
        };

        if (!client.app) {
            this.logError('Websocket connection has no app specified; aborting connection');
            socket.disconnect();
            return;
        } else if (client.app !== 'colibri') { // ignore colibri web interface clients
            this.logDebug(`New client (${client.id}) connected from ${socket.handshake.address}, waiting for app name`);
            this.logDebug(`Setting app of new colibri client '${client.name}' (${client.id}, v${client.version}) to "${client.app}"`, {
                clientApp: client.app,
                clientName: client.name,
                clientId: client.id
            });
        }

        this.clients.push(client);
        void socket.join(client.app);
        this.clientConnectedStream.next(client);
        this.clientStream.next(this.clients);

        socket.use(([channel, content]: SocketIoEvent, next) => {
            const msg: NetworkMessage = {
                origin: client,
                channel: channel,
                command: content.command,
                payload: Payload.fromValue(content.payload)
            };
            this.messageStream.next(msg);
            next();
        });

        socket.on('error', error => {
            this.logError(JSON.stringify(error));
        });

        socket.on('disconnect', () => {
            this.handleSocketDisconnect(socket);
        });
    }

    private handleSocketDisconnect(socket: SocketIoSocket): void {
        const removedClients: SocketIoClient[] = [];
        for (let i = this.clients.length - 1; i >= 0; i--) {
            if (this.clients[i]?.socket === socket) {
                removedClients.push(...this.clients.splice(i, 1));
            }
        }
        this.clientStream.next(this.clients);

        for (const rc of removedClients) {
            if (rc.app !== 'colibri') { // ignore colibri web interface clients
                this.logDebug(`Colibri client '${rc.name}' (${rc.id}) disconnected`, {
                    clientApp: rc.app,
                    clientName: rc.name,
                    clientId: rc.id
                });
            }
            this.clientDisconnectedStream.next(rc);
        }
    }
}
