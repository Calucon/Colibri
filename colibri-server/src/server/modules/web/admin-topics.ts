// What the admin UI's pages read from the server, one snapshot per topic; see AdminData for how they
// are asked for and sent. Every snapshot is read only and bounded in size: a page of models, not the
// store; a model's JSON up to a limit; names cut to a length. None of these functions changes the
// state it reads.
import { CertificateInfo, RingBuffer } from '../core/index.js';
import { DataStore, ModelEntry, NetworkClient, Tombstone } from '../command-hooks/index.js';
import { ClientActivity, LoadLimit } from '../networking/client-activity.js';
import { PROTOCOL_VERSION } from '../networking/protocol.js';
import { SocketIoClient } from '../networking/socket-io-server.js';
import { TcpNetworkClient } from '../networking/tcp-server-proxy.js';

// The app the admin UI joins.
export const ADMIN_APP = 'colibri';

// How much of an app, channel, model id or client name a snapshot carries. A longer one is cut, and
// its row says so. Ids and channels are that short in practice; this only bounds what an odd client
// can make a snapshot carry.
export const MAX_NAME_LENGTH = 512;

// Models a page of the model list holds by default, and at most.
export const DEFAULT_MODELS_LIMIT = 50;
export const MAX_MODELS_LIMIT = 200;
// Channels the model list's overview lists at most, and recently deleted ids.
export const MAX_CHANNELS = 500;
export const MAX_DELETED = 100;
// How long a model list filter may be.
export const MAX_FILTER_LENGTH = 200;
// How many bytes of models a model list measures afresh at most (see DataStore.modelBytes); the
// size of any model beyond that is left out (null) until a later snapshot gets to it.
export const MODEL_SIZE_BUDGET_BYTES = 8 * 1024 * 1024;
// How much of a model's formatted JSON the model topic carries.
export const MAX_MODEL_JSON_LENGTH = 512 * 1024;
// Clients the client list holds at most.
export const MAX_CLIENT_ROWS = 1000;

// How far back a client's latency samples count towards its latency.
const LATENCY_WINDOW_MILLIS = 1000;

// The text, cut to MAX_NAME_LENGTH.
const clip = function (text: string): string {
    return text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH) : text;
};

const isLong = function (text: string): boolean {
    return text.length > MAX_NAME_LENGTH;
};

const fieldsOf = function (body: unknown): Record<string, unknown> {
    return (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
};

const stringField = function (fields: Record<string, unknown>, name: string): string {
    const value = fields[name];
    return typeof value === 'string' ? value : '';
};

const integerField = function (fields: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = fields[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
};

// One decimal: a rate or a latency, without the noise of the last digits.
const round1 = function (value: number | null): number | null {
    return value === null ? null : Math.round(value * 10) / 10;
};

// Date.now() of an instant on the performance.now() clock.
const wallClock = function (performanceMillis: number, now: number, performanceNow: number): number {
    return Math.round(now - (performanceNow - performanceMillis));
};

/**
 * Models
 */

export interface ModelsQuery {
    // Exact app and channel; '' for every one.
    app: string;
    channel: string;
    // Part of a model's id or channel, in any case; '' for every model.
    filter: string;
    offset: number;
    limit: number;
}

export const parseModelsQuery = function (body: unknown): ModelsQuery {
    const fields = fieldsOf(body);
    return {
        app: stringField(fields, 'app'),
        channel: stringField(fields, 'channel'),
        filter: stringField(fields, 'filter').slice(0, MAX_FILTER_LENGTH),
        offset: integerField(fields, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
        limit: integerField(fields, 'limit', DEFAULT_MODELS_LIMIT, 1, MAX_MODELS_LIMIT),
    };
};

export interface ChannelSummary {
    app: string;
    channel: string;
    models: number;
    // Ids deleted within MODEL_TOMBSTONE_SECONDS.
    deleted: number;
    // The app or channel name was cut to MAX_NAME_LENGTH.
    truncated?: true;
}

export interface ModelRow {
    app: string;
    channel: string;
    id: string;
    // Top-level fields besides the id.
    fields: number;
    // Compact JSON size; null if this snapshot had no budget left to measure it.
    bytes: number | null;
    // Date.now() of its latest update.
    updatedAt: number;
    // The app, channel or id was cut to MAX_NAME_LENGTH, so the model topic cannot find it.
    truncated?: true;
}

export interface DeletedRow {
    app: string;
    channel: string;
    id: string;
    // Date.now() of the delete.
    deletedAt: number;
    truncated?: true;
}

export interface ModelsSnapshot {
    at: number;
    query: ModelsQuery;
    // Every app and channel holding models or tombstones, in the order they were first written to,
    // the first MAX_CHANNELS of channelsTotal.
    channels: ChannelSummary[];
    channelsTotal: number;
    // The models matching the query from `offset` on, at most `limit`, in store order: by app and
    // channel as above, then in the order the models were created. `total` match the query.
    models: ModelRow[];
    total: number;
    // The ids matching the query deleted within tombstoneSeconds, the newest first, at most
    // MAX_DELETED of deletedTotal.
    deleted: DeletedRow[];
    deletedTotal: number;
    tombstoneSeconds: number;
}

const truncatedFlag = function (...names: string[]): { truncated?: true } {
    return names.some(isLong) ? { truncated: true } : {};
};

export const modelsSnapshot = function (store: DataStore, query: ModelsQuery): ModelsSnapshot {
    const now = Date.now();
    const performanceNow = performance.now();
    const filter = query.filter.toLowerCase();
    const matchesName = (name: string) => filter === '' || name.toLowerCase().includes(filter);
    const inScope = (app: string, channel: string) =>
        (query.app === '' || app === query.app) && (query.channel === '' || channel === query.channel);

    // The overview: model counts, then tombstone counts, per app and channel.
    const summaries = new Map<string, ChannelSummary>();
    const summaryOf = (app: string, channel: string): ChannelSummary => {
        const key = `${app}\u0000${channel}`;
        let summary = summaries.get(key);
        if (!summary) {
            summary = { app: clip(app), channel: clip(channel), models: 0, deleted: 0, ...truncatedFlag(app, channel) };
            summaries.set(key, summary);
        }
        return summary;
    };

    const models: ModelRow[] = [];
    let total = 0;
    let sizeBudget = MODEL_SIZE_BUDGET_BYTES;
    for (const { app, channel, models: entries } of store.channels()) {
        if (entries.size > 0) summaryOf(app, channel).models = entries.size;
        if (!inScope(app, channel)) continue;

        const channelMatches = matchesName(channel);
        for (const [id, entry] of entries) {
            if (!channelMatches && !matchesName(id)) continue;
            total += 1;
            if (total <= query.offset || models.length >= query.limit) continue;

            let bytes: number | null = null;
            if (entry.bytes !== undefined) {
                bytes = entry.bytes;
            } else if (sizeBudget > 0) {
                bytes = store.modelBytes(entry);
                sizeBudget -= bytes;
            }
            models.push({
                app: clip(app),
                channel: clip(channel),
                id: clip(id),
                fields: fieldCount(entry),
                bytes,
                updatedAt: entry.updatedAt,
                ...truncatedFlag(app, channel, id),
            });
        }
    }

    // Each app's come oldest first: its newest MAX_DELETED are candidates for the newest overall.
    const candidates: [string, Readonly<Tombstone>][] = [];
    let deletedTotal = 0;
    for (const app of store.tombstoneApps()) {
        let newest: [string, Readonly<Tombstone>][] = [];
        for (const tombstone of store.liveTombstones(app)) {
            summaryOf(app, tombstone.channel).deleted += 1;
            if (!inScope(app, tombstone.channel)) continue;
            if (!matchesName(tombstone.channel) && !matchesName(tombstone.id)) continue;

            deletedTotal += 1;
            newest.push([app, tombstone]);
            if (newest.length > 2 * MAX_DELETED) newest = newest.slice(-MAX_DELETED);
        }
        // Newest first, which a sort keeps for ids deleted in the same millisecond.
        candidates.push(...newest.slice(-MAX_DELETED).reverse());
    }
    const deleted: DeletedRow[] = candidates
        .sort((a, b) => b[1].deletedAt - a[1].deletedAt)
        .slice(0, MAX_DELETED)
        .map(([app, tombstone]) => ({
            app: clip(app),
            channel: clip(tombstone.channel),
            id: clip(tombstone.id),
            deletedAt: wallClock(tombstone.deletedAt, now, performanceNow),
            ...truncatedFlag(app, tombstone.channel, tombstone.id),
        }));

    const channels = Array.from(summaries.values()).filter(summary => summary.models > 0 || summary.deleted > 0);
    return {
        at: now,
        query,
        channels: channels.slice(0, MAX_CHANNELS),
        channelsTotal: channels.length,
        models,
        total,
        deleted,
        deletedTotal,
        tombstoneSeconds: store.tombstoneMillis / 1000,
    };
};

const fieldCount = function (entry: Readonly<ModelEntry>): number {
    let count = 0;
    for (const key in entry.model) {
        if (key !== 'id' && Object.hasOwn(entry.model, key)) count += 1;
    }
    return count;
};

export interface ModelQuery {
    app: string;
    channel: string;
    id: string;
}

export const parseModelQuery = function (body: unknown): ModelQuery {
    const fields = fieldsOf(body);
    return { app: stringField(fields, 'app'), channel: stringField(fields, 'channel'), id: stringField(fields, 'id') };
};

export interface ModelSnapshot {
    at: number;
    app: string;
    channel: string;
    id: string;
    // Whether the store holds the model. If not, deletedAt says when it was deleted, if that was
    // within the tombstone time.
    found: boolean;
    deletedAt?: number;
    fields?: number;
    bytes?: number;
    updatedAt?: number;
    // The value as JSON indented by two spaces, cut to MAX_MODEL_JSON_LENGTH characters.
    json?: string;
    truncated?: boolean;
}

export const modelSnapshot = function (store: DataStore, query: ModelQuery): ModelSnapshot {
    const now = Date.now();
    const head = { at: now, app: clip(query.app), channel: clip(query.channel), id: clip(query.id) };
    const entry = store.getEntry(query.app, query.channel, query.id);
    if (!entry) {
        const tombstone = store.liveDeletion(query.app, query.channel, query.id);
        return tombstone
            ? { ...head, found: false, deletedAt: wallClock(tombstone.deletedAt, now, performance.now()) }
            : { ...head, found: false };
    }

    const json = JSON.stringify(entry.model, null, 2);
    const truncated = json.length > MAX_MODEL_JSON_LENGTH;
    return {
        ...head,
        found: true,
        fields: fieldCount(entry),
        bytes: store.modelBytes(entry),
        updatedAt: entry.updatedAt,
        json: truncated ? json.slice(0, MAX_MODEL_JSON_LENGTH) : json,
        truncated,
    };
};

/**
 * Clients
 */

export interface ClientRow {
    id: string;
    app: string;
    name: string;
    transport: 'tcp' | 'web';
    // The protocol version it announced.
    version: string;
    // Whether its connection to this server is encrypted. Behind a proxy that ends TLS, that is
    // the proxy's connection.
    tls: boolean;
    // Its own address, behind a trusted proxy the one the proxy named.
    address: string;
    // Date.now() of its connection.
    connectedAt: number;
    // Median round trip over the last second, in ms.
    latency: number | null;
    // See ClientActivity; null for a TCP client the worker did not report on this time.
    in: number | null;
    out: number | null;
    limit: LoadLimit | null;
    held: number;
    truncated?: true;
}

export interface ClientsSnapshot {
    at: number;
    // Every client but the admin UI's own pages, the first MAX_CLIENT_ROWS of total.
    clients: ClientRow[];
    total: number;
    adminPages: number;
}

// What the client list needs of the two transports.
export interface ClientSources {
    tcpClients: ReadonlyArray<TcpNetworkClient>;
    tcpActivity: ReadonlyMap<string, ClientActivity>;
    webClients: ReadonlyArray<SocketIoClient>;
    webActivity(client: SocketIoClient): ClientActivity;
}

// The median of the client's latency samples (see MeasureLatency) from the last second.
export const recentLatency = function (client: NetworkClient, now: number): number | null {
    const samples = client.metadata['latency'];
    if (!(samples instanceof RingBuffer)) return null;

    const recent: number[] = [];
    for (let i = samples.length - 1; i >= 0; i--) {
        const sample = samples.at(i) as [number, number] | undefined;
        if (!sample || sample[0] < now - LATENCY_WINDOW_MILLIS) break;
        recent.push(sample[1]);
    }
    if (recent.length === 0) return null;

    recent.sort((a, b) => a - b);
    const middle = recent.length >> 1;
    return recent.length % 2 === 1 ? recent[middle]! : (recent[middle - 1]! + recent[middle]!) / 2;
};

const NO_ACTIVITY: ClientActivity = { in: null, out: null, limit: null, held: 0 };

export const clientsSnapshot = function (sources: ClientSources): ClientsSnapshot {
    const now = Date.now();
    const rows: ClientRow[] = [];
    let total = 0;
    let adminPages = 0;

    const add = (client: NetworkClient, row: Omit<ClientRow, 'id' | 'app' | 'name' | 'version' | 'latency'>) => {
        total += 1;
        if (rows.length >= MAX_CLIENT_ROWS) return;
        rows.push({
            id: client.id,
            app: clip(client.app),
            name: clip(client.name),
            version: clip(client.version),
            latency: round1(recentLatency(client, now)),
            ...row,
            address: clip(row.address),
            ...truncatedFlag(client.app, client.name, client.version, row.address),
        });
    };
    const activityRow = (activity: ClientActivity) => ({
        in: round1(activity.in),
        out: round1(activity.out),
        limit: activity.limit,
        held: activity.held,
    });

    for (const client of sources.tcpClients) {
        add(client, {
            transport: 'tcp',
            tls: client.tls,
            address: client.address,
            connectedAt: client.connectedAt,
            ...activityRow(sources.tcpActivity.get(client.id) ?? NO_ACTIVITY),
        });
    }
    for (const client of sources.webClients) {
        if (client.app === ADMIN_APP) {
            adminPages += 1;
            continue;
        }
        add(client, {
            transport: 'web',
            tls: client.socket.handshake.secure,
            address: client.name,
            connectedAt: client.socket.handshake.issued,
            ...activityRow(sources.webActivity(client)),
        });
    }

    return { at: now, clients: rows, total, adminPages };
};

/**
 * Server
 */

// The settings in effect, by the names of the variables that set them. TLS_CERT and TLS_KEY are
// left out: `tls` says what they hold, never where they are or what is in them.
export type ServerSettings = Record<string, string | number | boolean | string[]>;

export interface VoiceStatus {
    listening: boolean;
    recording: boolean;
    samplingRate: number;
    clients: number;
}

export interface ServerSources {
    version: string;
    // Date.now() of the start.
    startedAt: number;
    settings: ServerSettings;
    // The certificate served now, if TLS is on.
    tls: CertificateInfo | undefined;
    voice: VoiceStatus | undefined;
    store: DataStore;
    restStore: { apps: number; keys: number } | undefined;
    tcpClients: ReadonlyArray<NetworkClient>;
    webClients: ReadonlyArray<SocketIoClient>;
}

export interface ServerSnapshot {
    at: number;
    version: string;
    protocolVersion: string;
    node: string;
    startedAt: number;
    // Seconds.
    uptime: number;
    settings: ServerSettings;
    // The certificate's names (its subject alternative names, or its subject), issuer and validity.
    tls: { names: string; issuer: string; selfSigned: boolean; validFrom: number; validTo: number; fingerprint256: string } | null;
    voice: VoiceStatus | null;
    counts: {
        tcpClients: number;
        webClients: number;
        adminPages: number;
        // Apps with at least one client.
        apps: number;
        // The synchronized models the server holds, in how many apps and channels, and the ids
        // deleted within the tombstone time.
        models: number;
        modelApps: number;
        modelChannels: number;
        deletedModels: number;
        // The REST store's apps and values.
        storeApps: number;
        storeKeys: number;
    };
}

export const serverSnapshot = function (sources: ServerSources): ServerSnapshot {
    const now = Date.now();
    const { store } = sources;

    let models = 0;
    let modelChannels = 0;
    const modelApps = new Set<string>();
    for (const { app, models: entries } of store.channels()) {
        if (entries.size === 0) continue;
        models += entries.size;
        modelChannels += 1;
        modelApps.add(app);
    }
    let deletedModels = 0;
    for (const app of store.tombstoneApps()) {
        const tombstones = store.liveTombstones(app);
        while (!tombstones.next().done) deletedModels += 1;
    }

    const apps = new Set<string>(sources.tcpClients.map(client => client.app));
    let webClients = 0;
    let adminPages = 0;
    for (const client of sources.webClients) {
        if (client.app === ADMIN_APP) {
            adminPages += 1;
        } else {
            webClients += 1;
            apps.add(client.app);
        }
    }

    const tls = sources.tls;
    return {
        at: now,
        version: sources.version,
        protocolVersion: PROTOCOL_VERSION,
        node: process.version,
        startedAt: sources.startedAt,
        uptime: Math.max(0, Math.round((now - sources.startedAt) / 1000)),
        settings: sources.settings,
        tls: tls
            ? {
                names: tls.names,
                issuer: tls.issuer,
                selfSigned: tls.selfSigned,
                validFrom: tls.validFrom.getTime(),
                validTo: tls.validTo.getTime(),
                fingerprint256: tls.fingerprint256,
            }
            : null,
        voice: sources.voice ?? null,
        counts: {
            tcpClients: sources.tcpClients.length,
            webClients,
            adminPages,
            apps: apps.size,
            models,
            modelApps: modelApps.size,
            modelChannels,
            deletedModels,
            storeApps: sources.restStore?.apps ?? 0,
            storeKeys: sources.restStore?.keys ?? 0,
        },
    };
};
