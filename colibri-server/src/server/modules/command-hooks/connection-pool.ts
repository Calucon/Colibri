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

// Past this many clients in one app, the pool warns that the app may be shared by accident. A lab
// group is a handful of devices plus a browser or two; a class whose groups all kept the same App
// Name (a sample's default, say) ends up as one app of dozens of clients instead.
export const DEFAULT_APP_CLIENT_WARNING_THRESHOLD = 8;

// The app the admin UI joins. However many are open, they are not an application's clients.
const ADMIN_APP = 'colibri';

export class ConnectionPool extends Service {
    public serviceName = 'ConnectionPool';
    public groupName = 'colibri';

    // See DEFAULT_APP_CLIENT_WARNING_THRESHOLD; 0 turns the warning off.
    public appClientWarningThreshold = DEFAULT_APP_CLIENT_WARNING_THRESHOLD;
    // Apps warned about since they last had appClientWarningThreshold clients or fewer, so the
    // warning is given once each time an app grows past the threshold, not once per client.
    private readonly appsOverThreshold = new Set<string>();

    private readonly servers: NetworkServer[];
    // Maintained from clientConnected$/clientDisconnected$ so emit() can find a client's
    // owning server in O(1) instead of an O(servers * clients) scan-and-find.
    private readonly serverByClientId = new Map<string, NetworkServer>();
    // Same source, keyed by app: the broadcast() fallback for a transport without
    // broadcastToApp resolves its recipients from here instead of scanning that
    // transport's entire client list per broadcast.
    private readonly clientsByApp = new Map<string, Set<NetworkClient>>();
    // The client object each id was last reported connected as. A transport may report the
    // same id connected again in another app (a TCP re-handshake); the object it replaces has
    // to leave its app's Set, which only this lookup can find.
    private readonly clientById = new Map<string, NetworkClient>();

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
                const previous = this.clientById.get(client.id);
                if (previous) {
                    this.removeFromAppIndex(previous);
                }
                this.clientById.set(client.id, client);
                this.serverByClientId.set(client.id, connection);
                this.addToAppIndex(client);
            });
            connection.clientDisconnected$.subscribe(client => {
                this.clientById.delete(client.id);
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
            for (const handler of handlers) this.runHandler(handler, message);
        }
        for (const handler of this.wildcardHandlers) this.runHandler(handler, message);
    }

    // Every handler runs on input straight off the network, and a synchronous throw out of the
    // merge() subscription above is not contained: RxJS rethrows it asynchronously, it reaches
    // the process-wide uncaughtException handler, and that shuts the whole server down. Caught
    // here, one handler failing on one malformed message costs exactly that - the other handlers
    // still see the message, and the next message is dispatched as normal. The payload is left
    // out of the log line on purpose: it can be megabytes.
    private runHandler(handler: MessageHandler, message: NetworkMessage): void {
        try {
            handler(message);
        } catch (err) {
            const origin = message.origin ? `client ${message.origin.id} ('${message.origin.name}', app '${message.origin.app}')` : 'an unknown client';
            this.logError(
                `Dropped a message (${message.channel} / ${message.command}) from ${origin}: a handler threw ` +
                    (err instanceof Error ? (err.stack ?? err.message) : String(err)),
                false
            );
        }
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
        this.checkAppSize(client.app, clients.size);
    }

    private removeFromAppIndex(client: NetworkClient): void {
        const clients = this.clientsByApp.get(client.app);
        if (!clients) return;

        clients.delete(client);
        if (clients.size <= this.appClientWarningThreshold) {
            this.appsOverThreshold.delete(client.app);
        }
        if (clients.size === 0) {
            this.clientsByApp.delete(client.app);
        }
    }

    // Every message in an app is relayed to each of its other clients, so the server's work grows
    // with the square of an app's size: 60 clients in one app at only 3 objects x 30 Hz took the
    // class load test's server to seconds of latency, where the same clients in groups of four
    // were no trouble at all. Nothing else would tell anyone why - every client is connected and
    // nothing is refused - so this is said in the log, counted across both transports.
    private checkAppSize(app: string, size: number): void {
        if (this.appClientWarningThreshold <= 0 || size <= this.appClientWarningThreshold) return;
        if (app === ADMIN_APP || this.appsOverThreshold.has(app)) return;

        this.appsOverThreshold.add(app);
        this.logWarning(
            `App '${app}' now has ${size} clients, more than ${this.appClientWarningThreshold} (APP_CLIENT_WARNING_THRESHOLD). ` +
                'Every message is relayed to every other client of the same app, so the server\'s work grows with the square of ' +
                'an app\'s size. If separate groups are sharing this app by accident - e.g. all kept the same default App Name - ' +
                'give each group an app name of its own.'
        );
    }
}