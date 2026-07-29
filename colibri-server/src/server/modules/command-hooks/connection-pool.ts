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

export type MessageHandler = (message: NetworkMessage) => void;

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    private readonly servers: NetworkServer[];
    // Maintained from clientConnected$/clientDisconnected$ so emit() can find a client's
    // owning server in O(1) instead of an O(servers * clients) scan-and-find.
    private readonly serverByClientId = new Map<string, NetworkServer>();

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
            connection.clientConnected$.subscribe(client => this.serverByClientId.set(client.id, connection));
            connection.clientDisconnected$.subscribe(client => this.serverByClientId.delete(client.id));
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

            let clients = connection.currentClients;
            if (app) {
                clients = clients.filter(client => client.app === app && client.id !== message.origin?.id);
            }

            connection.broadcast(message, clients);
        }
    }

    public emit(message: NetworkMessage, client: NetworkClient): void {
        this.serverByClientId.get(client.id)?.broadcast(message, [ client ]);
    }
}