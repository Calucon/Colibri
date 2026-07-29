import { Observable, merge } from 'rxjs';
import { Payload, Service } from '../core/index.js';

export interface NetworkMessage {
    origin?: NetworkClient;
    channel: string;
    command: string;
    payload?: Payload;
}

export interface NetworkClient {
    id: string;
    app: string;
    name: string;
    version: string;
    metadata: Record<string, unknown>;
}

export abstract class NetworkServer {
    public abstract get currentClients(): ReadonlyArray<NetworkClient>;
    public abstract get messages$(): Observable<NetworkMessage>;
    public abstract get clientConnected$(): Observable<NetworkClient>;
    public abstract get clientDisconnected$(): Observable<NetworkClient>;
    public abstract broadcast(message: NetworkMessage, clients: ReadonlyArray<NetworkClient>): void;

    // Optional fast path for "broadcast to every client of one app": transports that can
    // group clients server-side (Socket.IO rooms) encode the packet once for the whole
    // group instead of once per recipient. Transports without such a grouping simply don't
    // implement this, and ConnectionPool falls back to the per-client broadcast() above.
    public broadcastToApp?(message: NetworkMessage, app: string, exceptClientId?: string): void;
}

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    private readonly servers: NetworkServer[];

    public get messages$(): Observable<NetworkMessage> {
        return merge(...this.servers.map(c => c.messages$));
    }

    public get clientConnected$(): Observable<NetworkClient> {
        return merge(...this.servers.map(c => c.clientConnected$));
    }

    public get clientDisconnected$(): Observable<NetworkClient> {
        return merge(...this.servers.map(c => c.clientDisconnected$));
    }

    public get currentClients(): NetworkClient[] {
        return this.servers.flatMap(c => c.currentClients);
    }

    public constructor(...servers: NetworkServer[]) {
        super();
        this.servers = servers;
    }


    public broadcast(message: NetworkMessage, app = message.origin?.app): void {
        for (const connection of this.servers) {
            if (app && connection.broadcastToApp) {
                connection.broadcastToApp(message, app, message.origin?.id);
                continue;
            }

            let clients = connection.currentClients;
            if (app) {
                clients = clients.filter(client => client.app === app && client.id !== message.origin?.id);
            }

            connection.broadcast(message, clients);
        }
    }

    public emit(message: NetworkMessage, client: NetworkClient): void {
        for (const connection of this.servers) {
            if (connection.currentClients.find(c => c.id === client.id)) {
                connection.broadcast(message, [ client ]);
            }
        }
    }
}