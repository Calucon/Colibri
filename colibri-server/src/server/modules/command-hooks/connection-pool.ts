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
    //
    // Implementations must early-out on an app with no recipient *before* touching
    // message.payload - resolving a payload across transports costs a JSON parse or
    // stringify, and every client connect/disconnect broadcasts to app 'colibri', which
    // in practice has clients on exactly one of the two transports.
    public broadcastToApp?(message: NetworkMessage, app: string, exceptClientId?: string): void;
}

export type MessageHandler = (message: NetworkMessage) => void;

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    private readonly servers: NetworkServer[];
    // Maintained from clientConnected$/clientDisconnected$ so emit() can find a client's
    // owning server in O(1) instead of an O(servers * clients) scan-and-find.
    private readonly serverByClientId = new Map<string, NetworkServer>();
    // Same source, keyed by app: the broadcast() fallback for a transport without
    // broadcastToApp resolves its recipients from here instead of scanning that
    // transport's entire client list per broadcast.
    private readonly clientsByApp = new Map<string, Set<NetworkClient>>();

    // Every command-hook used to subscribe to the `messages$` getter below independently,
    // each rebuilding its own merge() of every transport's messages$ - N subscribers meant
    // N independent merge/filter chains evaluated per message. Now there is exactly one
    // merge() subscription (in the constructor), dispatching into these handler lists:
    // handlersByCommand gives hooks that only care about an exact command O(1) routing,
    // and wildcardHandlers covers the few that need a channel filter or command prefix.
    private readonly handlersByCommand = new Map<string, MessageHandler[]>();
    private readonly wildcardHandlers: MessageHandler[] = [];

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

        for (const connection of servers) {
            connection.clientConnected$.subscribe(client => {
                this.serverByClientId.set(client.id, connection);
                this.addToAppIndex(client);
            });
            connection.clientDisconnected$.subscribe(client => {
                this.serverByClientId.delete(client.id);
                this.removeFromAppIndex(client);
            });
        }

        merge(...servers.map(c => c.messages$)).subscribe(message => this.dispatch(message));
    }

    // Exact-command dispatch, e.g. ModelSynchronization's 'model::update' handler - the
    // busiest message in an object-sync server.
    public onCommand(command: string, handler: MessageHandler): void {
        let handlers = this.handlersByCommand.get(command);
        if (!handlers) {
            handlers = [];
            this.handlersByCommand.set(command, handlers);
        }
        handlers.push(handler);
    }

    // For subscribers whose filter isn't a single exact command (a channel check, or a
    // command prefix like 'broadcast::*') - still one shared dispatch loop, just without
    // the further command-indexed lookup.
    public onMessage(predicate: (message: NetworkMessage) => boolean, handler: MessageHandler): void {
        this.wildcardHandlers.push(message => {
            if (predicate(message)) handler(message);
        });
    }

    private dispatch(message: NetworkMessage): void {
        const handlers = this.handlersByCommand.get(message.command);
        if (handlers) {
            for (const handler of handlers) handler(message);
        }
        for (const handler of this.wildcardHandlers) handler(message);
    }


    public broadcast(message: NetworkMessage, app = message.origin?.app): void {
        for (const connection of this.servers) {
            if (app && connection.broadcastToApp) {
                connection.broadcastToApp(message, app, message.origin?.id);
                continue;
            }

            if (!app) {
                connection.broadcast(message, connection.currentClients);
                continue;
            }

            const clients = this.clientsForApp(app, connection, message.origin?.id);
            // Skipping the call rather than passing an empty list matters: a transport's
            // broadcast() may serialize the payload (or ship it across a worker boundary)
            // before it ever looks at the recipient list.
            if (clients.length === 0) continue;

            connection.broadcast(message, clients);
        }
    }

    public emit(message: NetworkMessage, client: NetworkClient): void {
        this.serverByClientId.get(client.id)?.broadcast(message, [ client ]);
    }

    private clientsForApp(app: string, connection: NetworkServer, excludeClientId?: string): NetworkClient[] {
        const candidates = this.clientsByApp.get(app);
        if (!candidates) return [];

        const clients: NetworkClient[] = [];
        for (const client of candidates) {
            if (client.id === excludeClientId) continue;
            if (this.serverByClientId.get(client.id) !== connection) continue;
            clients.push(client);
        }
        return clients;
    }

    private addToAppIndex(client: NetworkClient): void {
        let clients = this.clientsByApp.get(client.app);
        if (!clients) {
            clients = new Set();
            this.clientsByApp.set(client.app, clients);
        }
        clients.add(client);
    }

    private removeFromAppIndex(client: NetworkClient): void {
        const clients = this.clientsByApp.get(client.app);
        if (!clients) return;

        clients.delete(client);
        if (clients.size === 0) {
            this.clientsByApp.delete(client.app);
        }
    }
}