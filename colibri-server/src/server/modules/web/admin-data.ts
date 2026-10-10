import { filter } from 'rxjs';

import { CertificateInfo, Payload, Service } from '../core/index.js';
import { DataStore, NetworkMessage } from '../command-hooks/index.js';
import { RateLimit, TokenBucket } from '../networking/inbound-limits.js';
import { SocketIoClient, SocketIOServer } from '../networking/socket-io-server.js';
import { TCPServerProxy } from '../networking/tcp-server-proxy.js';
import { ClientActivity } from '../networking/client-activity.js';
import {
    ADMIN_APP,
    ModelQuery,
    ModelsQuery,
    ServerSettings,
    VoiceStatus,
    clientsSnapshot,
    modelSnapshot,
    modelsSnapshot,
    parseModelQuery,
    parseModelsQuery,
    serverSnapshot,
} from './admin-topics.js';
import { ModelMeasures } from './model-measures.js';

// The channel the admin UI's pages ask for read-only server data on, and get it on. See
// docs/protocol.md, Admin UI channel.
export const ADMIN_CHANNEL = 'colibri::admin';

// How often a subscribed topic is sent again.
export const ADMIN_REFRESH_MILLIS = 1000;

// How many request and subscribe messages one page may send: far more than any page clicking
// through its views does. One past it is ignored. A snapshot can cost a pass over the whole model
// store, so this keeps a script in a loop from having the server do that without end.
export const ADMIN_REQUEST_LIMIT: RateLimit = { messagesPerSecond: 10, burst: 20 };

export const ADMIN_TOPICS = ['server', 'clients', 'models', 'model'] as const;
export type AdminTopic = typeof ADMIN_TOPICS[number];

const isTopic = function (value: unknown): value is AdminTopic {
    return typeof value === 'string' && (ADMIN_TOPICS as readonly string[]).includes(value);
};

// What AdminData reads. All of it read only: nothing in here is ever called to change anything.
export interface AdminSources {
    store: DataStore;
    socketio: SocketIOServer;
    tcp: TCPServerProxy;
    version: string;
    // Date.now() of the start.
    startedAt: number;
    settings: ServerSettings;
    tls?: { readonly info: CertificateInfo };
    voice?: { readonly status: VoiceStatus };
    restStore?: { counts(): { apps: number; keys: number } };
}

// What one page asked for: a topic, with its query for the two that take one.
type Query =
    | { topic: 'server' | 'clients' }
    | { topic: 'models'; models: ModelsQuery }
    | { topic: 'model'; model: ModelQuery };

interface Subscription {
    query: Query;
    // Equal for two pages asking for the same thing, which then share one snapshot.
    key: string;
    // The request number of the request or subscribe, echoed in every snapshot it is sent.
    request: number | null;
}

const parseQuery = function (topic: AdminTopic, body: unknown): Query {
    switch (topic) {
        case 'models':
            return { topic, models: parseModelsQuery(body) };
        case 'model':
            return { topic, model: parseModelQuery(body) };
        default:
            return { topic };
    }
};

interface Due {
    page: AdminPage;
    subscription: Subscription;
}

interface AdminPage {
    client: SocketIoClient;
    requests: TokenBucket;
    subscriptions: Map<AdminTopic, Subscription>;
}

/**
 * Answers the admin UI's pages with read-only snapshots of the server: its settings and counts, the
 * connected clients and their traffic, and the synchronized models. A page asks for a topic once
 * ('request') or for as long as it shows it ('subscribe', until 'unsubscribe' or it disconnects);
 * a subscribed topic is sent again every ADMIN_REFRESH_MILLIS. Nothing is computed, and nothing
 * asked of the TCP worker, while no page has subscribed. Only clients of the app 'colibri' are
 * answered.
 *
 * Read only by design: Colibri has no authentication, so whatever a page can do through this
 * channel, anyone who can reach the server can do.
 */
export class AdminData extends Service {
    public get serviceName(): string { return 'AdminData'; }
    public get groupName(): string { return 'web'; }

    private readonly pages = new Map<string, AdminPage>();
    // One for every snapshot and page: what it measures a second is bounded for all of them.
    private readonly measures = new ModelMeasures();
    private refreshTimer: NodeJS.Timeout | undefined;
    // Set while a refresh waits for the TCP worker, so that a slow answer does not stack them up.
    private refreshing = false;

    public constructor(private readonly sources: AdminSources) {
        super();
    }

    public override async init(): Promise<void> {
        super.init();

        this.sources.socketio.messages$
            .pipe(filter(msg => msg.channel === ADMIN_CHANNEL))
            .subscribe(msg => {
                // Nothing a client sends may escape from here: RxJS rethrows it asynchronously,
                // where it is an uncaught exception and main.ts shuts the server down.
                try {
                    this.handleMessage(msg);
                } catch (err) {
                    this.logError(`Ignoring ${ADMIN_CHANNEL} '${msg.command}' from client ${msg.origin?.id}: ${errorMessage(err)}`, false);
                }
            });

        this.sources.socketio.clientDisconnected$.subscribe(client => this.forgetPage(client.id));
    }

    public stop(): void {
        clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
        this.pages.clear();
    }

    // How many topics the pages have subscribed to, all together.
    public get subscriptionCount(): number {
        let count = 0;
        for (const page of this.pages.values()) count += page.subscriptions.size;
        return count;
    }

    private handleMessage(msg: NetworkMessage): void {
        const client = msg.origin && this.sources.socketio.getClient(msg.origin.id);
        if (!client || client.app !== ADMIN_APP) return;

        const body = msg.payload?.asValue();
        const fields = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
        const topic = fields.topic;

        // Without a topic: every topic, for a page that is going away.
        if (msg.command === 'unsubscribe') {
            const subscriptions = this.pages.get(client.id)?.subscriptions;
            if (topic === undefined) subscriptions?.clear();
            else if (isTopic(topic)) subscriptions?.delete(topic);
            this.updateRefreshTimer();
            return;
        }
        if (msg.command !== 'request' && msg.command !== 'subscribe') return;
        if (!isTopic(topic)) {
            this.logDebug(`Ignoring ${ADMIN_CHANNEL} '${msg.command}' from admin page ${client.id}: unknown topic`);
            return;
        }

        const page = this.pageOf(client);
        if (!page.requests.take(performance.now())) return;

        const query = parseQuery(topic, body);
        const subscription: Subscription = {
            query,
            key: JSON.stringify(query),
            request: typeof fields.request === 'number' && Number.isFinite(fields.request) ? fields.request : null,
        };
        if (msg.command === 'subscribe') {
            // One subscription per topic and page: a new one replaces the query.
            page.subscriptions.set(topic, subscription);
            this.updateRefreshTimer();
        }
        void this.send([ { page, subscription } ]);
    }

    private pageOf(client: SocketIoClient): AdminPage {
        let page = this.pages.get(client.id);
        if (!page) {
            page = { client, requests: new TokenBucket(ADMIN_REQUEST_LIMIT, performance.now()), subscriptions: new Map() };
            this.pages.set(client.id, page);
        }
        return page;
    }

    private forgetPage(id: string): void {
        if (this.pages.delete(id)) this.updateRefreshTimer();
    }

    // Runs only while some page has subscribed to something.
    private updateRefreshTimer(): void {
        const needed = this.subscriptionCount > 0;
        if (needed && !this.refreshTimer) {
            this.refreshTimer = setInterval(() => void this.refresh(), ADMIN_REFRESH_MILLIS);
            // Never the reason the process stays alive.
            this.refreshTimer.unref();
        } else if (!needed && this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private async refresh(): Promise<void> {
        if (this.refreshing) return;

        const due: Due[] = [];
        for (const page of this.pages.values()) {
            for (const subscription of page.subscriptions.values()) due.push({ page, subscription });
        }
        if (due.length === 0) return;

        this.refreshing = true;
        try {
            await this.send(due);
        } finally {
            this.refreshing = false;
        }
    }

    // Builds each snapshot once for all the pages that asked for the same thing, and sends it to
    // those still connected. Never rejects: its callers do not wait for it.
    private async send(due: Due[]): Promise<void> {
        try {
            const tcpActivity = due.some(item => item.subscription.query.topic === 'clients')
                ? await this.sources.tcp.clientActivity()
                : undefined;

            const built = new Map<string, object>();
            for (const { page, subscription } of due) {
                // Gone while the TCP worker was asked.
                if (this.pages.get(page.client.id) !== page) continue;

                let snapshot = built.get(subscription.key);
                if (snapshot === undefined) {
                    snapshot = this.build(subscription.query, tcpActivity);
                    built.set(subscription.key, snapshot);
                }

                this.sources.socketio.broadcast({
                    channel: ADMIN_CHANNEL,
                    command: subscription.query.topic,
                    payload: Payload.fromValue({ request: subscription.request, ...snapshot }),
                }, [ page.client ]);
            }
        } catch (err) {
            this.logError(`Could not send the admin UI its data: ${errorMessage(err)}`, false);
        }
    }

    private build(query: Query, tcpActivity: ReadonlyMap<string, ClientActivity> | undefined): object {
        const { sources } = this;
        switch (query.topic) {
            case 'server':
                return serverSnapshot({
                    version: sources.version,
                    startedAt: sources.startedAt,
                    settings: sources.settings,
                    tls: sources.tls?.info,
                    voice: sources.voice?.status,
                    store: sources.store,
                    restStore: sources.restStore?.counts(),
                    tcpClients: sources.tcp.currentClients,
                    webClients: sources.socketio.currentClients,
                });

            case 'clients':
                return clientsSnapshot({
                    tcpClients: sources.tcp.currentClients,
                    tcpActivity: tcpActivity ?? new Map(),
                    webClients: sources.socketio.currentClients,
                    webActivity: client => sources.socketio.activityOf(client),
                });

            case 'models':
                return modelsSnapshot(sources.store, query.models, this.measures);

            case 'model':
                return modelSnapshot(sources.store, query.model, this.measures);
        }
    }
}

const errorMessage = function (err: unknown): string {
    return err instanceof Error ? err.message : String(err);
};
