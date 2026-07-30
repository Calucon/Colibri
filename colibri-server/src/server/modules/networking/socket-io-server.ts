import { Server as SocketIoServer, Socket as SocketIoSocket, Event as SocketIoEvent } from 'socket.io';
import { Server as HttpServer } from 'http';
import { Observable, Subject } from 'rxjs';

import { Payload, Service } from '../core/index.js';
import { NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks/index.js';

export interface SocketIoClient extends NetworkClient {
    socket: SocketIoSocket;
    version: string;
}

export class SocketIOServer extends Service implements NetworkServer {
    public readonly serviceName = 'SocketIO';
    public readonly groupName = 'networking';

    private ioServer!: SocketIoServer;

    private readonly clients: SocketIoClient[] = [];
    // Mirrors the Socket.IO room membership we join below, so broadcastToApp can answer
    // "does this app have any recipient at all?" without touching the adapter or the
    // payload. Ids rather than a plain count, so the very common "the only member of this
    // app is the client the message came from" case can early-out too.
    private readonly clientIdsByApp = new Map<string, Set<string>>();
    private readonly clientsById = new Map<string, SocketIoClient>();
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

    // Tolerates never having been started - a signal (or a crash) arriving while startup()
    // is still running must not throw here and skip the shutdown steps behind it.
    public stop(): void {
        if (!this.ioServer) return;

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

    // O(1) alternative to scanning currentClients, for hooks that hold a NetworkClient (or
    // just an id) and need the concrete client back to send to it.
    public getClient(id: string): SocketIoClient | undefined {
        return this.clientsById.get(id);
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
        // Checked before resolvePayload(), which for a TCP-origin payload is a full
        // JSON.parse: a TCP-only deployment would otherwise pay a parse plus an adapter
        // encode per model::update with no web client to receive any of it.
        if (!this.hasRecipients(app, exceptClientId)) return;

        const payload = this.resolvePayload(msg);
        const room = exceptClientId ? this.ioServer.to(app).except(exceptClientId) : this.ioServer.to(app);

        room.emit(msg.channel, {
            command: msg.command,
            payload
        });
    }

    public hasRecipients(app: string, exceptClientId?: string): boolean {
        const ids = this.clientIdsByApp.get(app);
        if (!ids || ids.size === 0) return false;
        if (exceptClientId !== undefined && ids.size === 1 && ids.has(exceptClientId)) return false;
        return true;
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
            this.logError('Websocket connection has no app specified; aborting connection', false);
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
        this.addToAppIndex(client);
        void socket.join(client.app);
        this.clientConnectedStream.next(client);
        this.clientStream.next(this.clients);

        socket.use(([channel, content]: SocketIoEvent, next) => {
            // An event emitted with no argument at all (`socket.emit('foo')`) leaves
            // `content` undefined; reading `.command` off it used to throw, and while
            // Socket.IO catches that synchronously it still drops the client.
            const body = (content ?? {}) as { command?: unknown; payload?: unknown };
            if (typeof body.command !== 'string') {
                this.logError(`Ignoring malformed event on channel '${channel}' from client ${client.id}: no command`, false);
                next();
                return;
            }

            const msg: NetworkMessage = {
                origin: client,
                channel: channel,
                command: body.command,
                payload: Payload.fromValue(body.payload)
            };
            this.messageStream.next(msg);
            next();
        });

        socket.on('error', error => {
            this.logError(JSON.stringify(error), false);
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
            this.removeFromAppIndex(rc);
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

    private addToAppIndex(client: SocketIoClient): void {
        this.clientsById.set(client.id, client);

        let ids = this.clientIdsByApp.get(client.app);
        if (!ids) {
            ids = new Set();
            this.clientIdsByApp.set(client.app, ids);
        }
        ids.add(client.id);
    }

    private removeFromAppIndex(client: SocketIoClient): void {
        this.clientsById.delete(client.id);

        const ids = this.clientIdsByApp.get(client.app);
        if (!ids) return;

        ids.delete(client.id);
        if (ids.size === 0) {
            this.clientIdsByApp.delete(client.app);
        }
    }
}
