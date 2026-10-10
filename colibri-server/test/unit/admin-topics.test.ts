import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';
import { RingBuffer } from '../../src/server/modules/core/ring-buffer.js';
import { CertificateInfo } from '../../src/server/modules/core/tls-files.js';
import { readServerVersion } from '../../src/server/modules/core/server-version.js';
import { ClientActivity } from '../../src/server/modules/networking/client-activity.js';
import { PROTOCOL_VERSION } from '../../src/server/modules/networking/protocol.js';
import { SocketIoClient } from '../../src/server/modules/networking/socket-io-server.js';
import { TcpNetworkClient } from '../../src/server/modules/networking/tcp-server-proxy.js';
import {
    DEFAULT_MODELS_LIMIT,
    MAX_CHANNELS,
    MAX_CLIENT_ROWS,
    MAX_DELETED,
    MAX_FILTER_LENGTH,
    MAX_MODELS_LIMIT,
    MAX_MODEL_JSON_LENGTH,
    MAX_NAME_LENGTH,
    MODEL_SIZE_BUDGET_BYTES,
    ServerSources,
    clientsSnapshot,
    modelSnapshot,
    modelsSnapshot,
    parseModelQuery,
    parseModelsQuery,
    recentLatency,
    serverSnapshot,
} from '../../src/server/modules/web/admin-topics.js';

const query = (fields: Record<string, unknown> = {}) => parseModelsQuery(fields);

// Everything the store holds, as a snapshot can see it: models, their update times and the
// tombstones, expired ones included. The admin UI's snapshots must leave all of it as it was.
const storeState = function (store: DataStore): string {
    const channels = Array.from(store.channels(), ({ app, channel, models }) => [
        app,
        channel,
        Array.from(models, ([id, entry]) => [id, JSON.stringify(entry.model), entry.updatedAt]),
    ]);
    const tombstones = store.tombstoneApps().map(app => [app, store.tombstoneCount(app)]);
    return JSON.stringify({ channels, tombstones });
};

describe('admin UI topics', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('the model list query', () => {
        it('takes each field only with the expected type, and clamps the page', () => {
            expect(parseModelsQuery(undefined)).toEqual({ app: '', channel: '', filter: '', offset: 0, limit: DEFAULT_MODELS_LIMIT });
            expect(parseModelsQuery({ app: 1, channel: null, filter: ['x'], offset: 'a', limit: {} }))
                .toEqual({ app: '', channel: '', filter: '', offset: 0, limit: DEFAULT_MODELS_LIMIT });
            expect(parseModelsQuery({ offset: -5, limit: 1e9 })).toMatchObject({ offset: 0, limit: MAX_MODELS_LIMIT });
            expect(parseModelsQuery({ offset: 2.7, limit: 0 })).toMatchObject({ offset: 2, limit: 1 });
            expect(parseModelsQuery({ filter: 'f'.repeat(MAX_FILTER_LENGTH + 10) }).filter).toHaveLength(MAX_FILTER_LENGTH);
            expect(parseModelQuery({ app: 'a', channel: 'c', id: 7 })).toEqual({ app: 'a', channel: 'c', id: '' });
        });
    });

    describe('the model list', () => {
        let store: DataStore;

        beforeEach(() => {
            store = new DataStore();
            store.updateModel('app1', 'cubes', { id: 'cube-1', x: 1, y: 2 });
            vi.advanceTimersByTime(1000);
            store.updateModel('app1', 'cubes', { id: 'cube-2', x: 1 });
            store.updateModel('app1', 'Spheres', { id: 'sphere-1' });
            store.updateModel('app2', 'cubes', { id: 'cube-1', color: 'red' });
        });

        it('lists the models in store order with their fields, size and update time', () => {
            const snapshot = modelsSnapshot(store, query());

            expect(snapshot.total).toBe(4);
            expect(snapshot.models).toEqual([
                { app: 'app1', channel: 'cubes', id: 'cube-1', fields: 2, bytes: '{"id":"cube-1","x":1,"y":2}'.length, updatedAt: 1_700_000_000_000 },
                { app: 'app1', channel: 'cubes', id: 'cube-2', fields: 1, bytes: '{"id":"cube-2","x":1}'.length, updatedAt: 1_700_000_001_000 },
                { app: 'app1', channel: 'Spheres', id: 'sphere-1', fields: 0, bytes: '{"id":"sphere-1"}'.length, updatedAt: 1_700_000_001_000 },
                { app: 'app2', channel: 'cubes', id: 'cube-1', fields: 1, bytes: '{"id":"cube-1","color":"red"}'.length, updatedAt: 1_700_000_001_000 },
            ]);
            expect(snapshot.channels).toEqual([
                { app: 'app1', channel: 'cubes', models: 2, deleted: 0 },
                { app: 'app1', channel: 'Spheres', models: 1, deleted: 0 },
                { app: 'app2', channel: 'cubes', models: 1, deleted: 0 },
            ]);
            expect(snapshot.at).toBe(Date.now());
        });

        it('narrows to an app and a channel', () => {
            expect(modelsSnapshot(store, query({ app: 'app1' })).models.map(m => m.id)).toEqual(['cube-1', 'cube-2', 'sphere-1']);
            expect(modelsSnapshot(store, query({ app: 'app1', channel: 'cubes' })).models.map(m => m.id)).toEqual(['cube-1', 'cube-2']);
            expect(modelsSnapshot(store, query({ channel: 'cubes' })).models.map(m => `${m.app}/${m.id}`))
                .toEqual(['app1/cube-1', 'app1/cube-2', 'app2/cube-1']);
            // The overview always covers everything, for choosing an app and channel.
            expect(modelsSnapshot(store, query({ app: 'app2' })).channels).toHaveLength(3);
        });

        it('filters by part of the id or the channel, in any case', () => {
            expect(modelsSnapshot(store, query({ filter: 'CUBE-2' })).models.map(m => m.id)).toEqual(['cube-2']);
            expect(modelsSnapshot(store, query({ filter: 'spheres' })).models.map(m => m.id)).toEqual(['sphere-1']);
            const none = modelsSnapshot(store, query({ filter: 'nothing' }));
            expect(none.models).toEqual([]);
            expect(none.total).toBe(0);
        });

        it('pages through the matches', () => {
            const page = modelsSnapshot(store, query({ offset: 1, limit: 2 }));
            expect(page.models.map(m => `${m.app}/${m.id}`)).toEqual(['app1/cube-2', 'app1/sphere-1']);
            expect(page.total).toBe(4);
            expect(page.query).toMatchObject({ offset: 1, limit: 2 });
        });

        it('lists recently deleted ids, newest first, with when they were deleted', () => {
            store.tombstoneMillis = 60_000;
            store.removeModel('app1', 'cubes', 'cube-2');
            vi.advanceTimersByTime(5000);
            store.removeModel('app2', 'cubes', 'cube-1');
            store.removeModel('app3', 'gone', 'g');

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.deleted).toEqual([
                { app: 'app2', channel: 'cubes', id: 'cube-1', deletedAt: Date.now() },
                { app: 'app3', channel: 'gone', id: 'g', deletedAt: Date.now() },
                { app: 'app1', channel: 'cubes', id: 'cube-2', deletedAt: Date.now() - 5000 },
            ].sort((a, b) => b.deletedAt - a.deletedAt || 0));
            expect(snapshot.deletedTotal).toBe(3);
            expect(snapshot.tombstoneSeconds).toBe(60);
            expect(snapshot.channels).toEqual([
                { app: 'app1', channel: 'cubes', models: 1, deleted: 1 },
                { app: 'app1', channel: 'Spheres', models: 1, deleted: 0 },
                // Empty now, but with a tombstone.
                { app: 'app2', channel: 'cubes', models: 0, deleted: 1 },
                { app: 'app3', channel: 'gone', models: 0, deleted: 1 },
            ]);
            expect(modelsSnapshot(store, query({ app: 'app1' })).deleted.map(d => d.id)).toEqual(['cube-2']);
            expect(modelsSnapshot(store, query({ filter: 'G' })).deleted.map(d => d.id)).toEqual(['g']);
        });

        it('leaves expired tombstones out, without forgetting them', () => {
            store.tombstoneMillis = 1000;
            store.removeModel('app1', 'cubes', 'cube-2');
            vi.advanceTimersByTime(1000);

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.deleted).toEqual([]);
            expect(snapshot.deletedTotal).toBe(0);
            expect(store.tombstoneCount('app1')).toBe(1);
        });

        it('changes nothing in the store', () => {
            store.tombstoneMillis = 1000;
            store.removeModel('app1', 'cubes', 'cube-2');
            vi.advanceTimersByTime(1000);
            store.removeModel('app2', 'cubes', 'cube-1');
            const before = storeState(store);

            modelsSnapshot(store, query({ filter: 'c' }));
            modelsSnapshot(store, query({ app: 'app1', channel: 'cubes', offset: 1 }));
            modelSnapshot(store, { app: 'app1', channel: 'cubes', id: 'cube-1' });
            modelSnapshot(store, { app: 'app1', channel: 'cubes', id: 'cube-2' });

            expect(storeState(store)).toBe(before);
        });
    });

    describe('a large store', () => {
        it('holds at most a page of models and MAX_DELETED deleted ids, and counts the rest', () => {
            const store = new DataStore();
            for (let i = 0; i < 1000; i++) store.updateModel('app', `channel-${i % 10}`, { id: `m${i}` });
            for (let i = 0; i < MAX_DELETED + 50; i++) {
                store.removeModel(`app-${i % 3}`, 'deleted', `d${i}`);
                vi.advanceTimersByTime(1);
            }

            const snapshot = modelsSnapshot(store, query({ limit: 10_000 }));
            expect(snapshot.models).toHaveLength(MAX_MODELS_LIMIT);
            expect(snapshot.total).toBe(1000);
            expect(snapshot.deleted).toHaveLength(MAX_DELETED);
            expect(snapshot.deletedTotal).toBe(MAX_DELETED + 50);
            // The newest ones, across the apps.
            expect(snapshot.deleted.map(d => d.id)).toContain(`d${MAX_DELETED + 49}`);
            expect(snapshot.deleted.map(d => d.id)).not.toContain('d0');
        });

        it('lists at most MAX_CHANNELS channels', () => {
            const store = new DataStore();
            for (let i = 0; i < MAX_CHANNELS + 20; i++) store.updateModel('app', `channel-${i}`, { id: 'x' });

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.channels).toHaveLength(MAX_CHANNELS);
            expect(snapshot.channelsTotal).toBe(MAX_CHANNELS + 20);
        });

        it('cuts long names and says so', () => {
            const store = new DataStore();
            const long = 'n'.repeat(MAX_NAME_LENGTH + 100);
            store.updateModel('app', long, { id: long });

            const snapshot = modelsSnapshot(store, query());
            expect(snapshot.models[0]).toMatchObject({ channel: 'n'.repeat(MAX_NAME_LENGTH), id: 'n'.repeat(MAX_NAME_LENGTH), truncated: true });
            expect(snapshot.channels[0]).toMatchObject({ channel: 'n'.repeat(MAX_NAME_LENGTH), truncated: true });
        });

        it('measures at most MODEL_SIZE_BUDGET_BYTES of models afresh, leaving the rest\'s size out', () => {
            const store = new DataStore();
            const big = 'x'.repeat(MODEL_SIZE_BUDGET_BYTES / 2);
            for (let i = 0; i < 4; i++) store.updateModel('app', 'big', { id: `b${i}`, big });

            const first = modelsSnapshot(store, query());
            expect(first.models.map(m => m.bytes === null)).toEqual([false, false, true, true]);

            // Measured once, a size is reused until the model changes, so the next snapshot gets further.
            const second = modelsSnapshot(store, query());
            expect(second.models.map(m => m.bytes === null)).toEqual([false, false, false, false]);
        });
    });

    describe('one model', () => {
        it('is sent as indented JSON, with its size and update time', () => {
            const store = new DataStore();
            store.updateModel('app', 'cubes', { id: 'c', pos: { x: 1 } });

            const snapshot = modelSnapshot(store, { app: 'app', channel: 'cubes', id: 'c' });
            expect(snapshot).toEqual({
                at: Date.now(),
                app: 'app',
                channel: 'cubes',
                id: 'c',
                found: true,
                fields: 1,
                bytes: '{"id":"c","pos":{"x":1}}'.length,
                updatedAt: Date.now(),
                json: JSON.stringify({ id: 'c', pos: { x: 1 } }, null, 2),
                truncated: false,
            });
        });

        it('is cut at MAX_MODEL_JSON_LENGTH', () => {
            const store = new DataStore();
            store.updateModel('app', 'big', { id: 'b', text: 'x'.repeat(MAX_MODEL_JSON_LENGTH) });

            const snapshot = modelSnapshot(store, { app: 'app', channel: 'big', id: 'b' });
            expect(snapshot.json).toHaveLength(MAX_MODEL_JSON_LENGTH);
            expect(snapshot.truncated).toBe(true);
            expect(snapshot.bytes).toBeGreaterThan(MAX_MODEL_JSON_LENGTH);
        });

        it('not in the store is not found, with when it was deleted if it was', () => {
            const store = new DataStore();
            store.removeModel('app', 'cubes', 'gone');
            vi.advanceTimersByTime(2000);

            expect(modelSnapshot(store, { app: 'app', channel: 'cubes', id: 'gone' }))
                .toEqual({ at: Date.now(), app: 'app', channel: 'cubes', id: 'gone', found: false, deletedAt: Date.now() - 2000 });
            expect(modelSnapshot(store, { app: 'app', channel: 'cubes', id: 'never' }))
                .toEqual({ at: Date.now(), app: 'app', channel: 'cubes', id: 'never', found: false });
        });
    });

    describe('the client list', () => {
        const tcpClient = (id: string, app: string): TcpNetworkClient => ({
            id, app, name: `headset-${id}`, version: PROTOCOL_VERSION, metadata: {},
            address: '10.0.0.5', tls: true, connectedAt: 1_699_999_990_000,
        });
        const webClient = (id: string, app: string, secure = false): SocketIoClient => ({
            id, app, name: '192.168.1.20', version: PROTOCOL_VERSION, metadata: {},
            socket: { handshake: { secure, issued: 1_699_999_995_000 } } as never,
        });
        const activity: ClientActivity = { in: 72.04, out: 143.96, limit: 'rate', held: 3 };

        it('lists both transports with their details and traffic, but not the admin UI', () => {
            const snapshot = clientsSnapshot({
                tcpClients: [ tcpClient('t1', 'app') ],
                tcpActivity: new Map([[ 't1', activity ]]),
                webClients: [ webClient('w1', 'app', true), webClient('admin', 'colibri') ],
                webActivity: () => ({ in: null, out: 0, limit: null, held: 0 }),
            });

            expect(snapshot).toEqual({
                at: Date.now(),
                total: 2,
                adminPages: 1,
                clients: [
                    {
                        id: 't1', app: 'app', name: 'headset-t1', transport: 'tcp', version: PROTOCOL_VERSION, tls: true,
                        address: '10.0.0.5', connectedAt: 1_699_999_990_000, latency: null, in: 72, out: 144, limit: 'rate', held: 3,
                    },
                    {
                        id: 'w1', app: 'app', name: '192.168.1.20', transport: 'web', version: PROTOCOL_VERSION, tls: true,
                        address: '192.168.1.20', connectedAt: 1_699_999_995_000, latency: null, in: null, out: 0, limit: null, held: 0,
                    },
                ],
            });
        });

        it('has no activity for a TCP client the worker did not report', () => {
            const snapshot = clientsSnapshot({
                tcpClients: [ tcpClient('t1', 'app') ],
                tcpActivity: new Map(),
                webClients: [],
                webActivity: () => activity,
            });
            expect(snapshot.clients[0]).toMatchObject({ in: null, out: null, limit: null, held: 0 });
        });

        it('holds at most MAX_CLIENT_ROWS clients', () => {
            const tcpClients = Array.from({ length: MAX_CLIENT_ROWS + 5 }, (_, i) => tcpClient(`t${i}`, 'app'));
            const snapshot = clientsSnapshot({ tcpClients, tcpActivity: new Map(), webClients: [], webActivity: () => activity });
            expect(snapshot.clients).toHaveLength(MAX_CLIENT_ROWS);
            expect(snapshot.total).toBe(MAX_CLIENT_ROWS + 5);
        });

        it('takes the median latency of the last second', () => {
            const client = tcpClient('t1', 'app');
            const samples = new RingBuffer<[number, number]>(1000);
            const now = Date.now();
            samples.push([ now - 5000, 900 ]);
            for (const [ago, ms] of [ [ 900, 30 ], [ 500, 10 ], [ 300, 20 ], [ 100, 40 ] ]) samples.push([ now - ago!, ms! ]);
            client.metadata['latency'] = samples;

            expect(recentLatency(client, now)).toBe(25);
            expect(recentLatency(client, now + 10_000)).toBeNull();
            expect(recentLatency(tcpClient('t2', 'app'), now)).toBeNull();
        });
    });

    describe('the server info', () => {
        const info: CertificateInfo = {
            fingerprint256: 'AB:CD',
            names: 'DNS:colibri.example.org',
            issuer: 'CN=Example CA',
            validFrom: new Date(1_690_000_000_000),
            validTo: new Date(1_710_000_000_000),
            selfSigned: false,
        };

        const sources = (overrides: Partial<ServerSources> = {}): ServerSources => ({
            version: '2.0.0',
            startedAt: Date.now() - 90_500,
            settings: { TCP_PORT: 9012, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true },
            tls: undefined,
            voice: { listening: true, recording: false, samplingRate: 48000, clients: 2 },
            store: new DataStore(),
            restStore: { apps: 2, keys: 5 },
            tcpClients: [],
            webClients: [],
            ...overrides,
        });

        it('says which version runs, since when, and with which settings', () => {
            const snapshot = serverSnapshot(sources());
            expect(snapshot).toMatchObject({
                at: Date.now(),
                version: '2.0.0',
                protocolVersion: PROTOCOL_VERSION,
                node: process.version,
                startedAt: Date.now() - 90_500,
                uptime: 91,
                settings: { TCP_PORT: 9012, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true },
                tls: null,
                voice: { listening: true, recording: false, samplingRate: 48000, clients: 2 },
            });
        });

        it('describes the certificate, and nothing of its key or files', () => {
            const snapshot = serverSnapshot(sources({ tls: info }));
            expect(snapshot.tls).toEqual({
                names: 'DNS:colibri.example.org',
                issuer: 'CN=Example CA',
                selfSigned: false,
                validFrom: 1_690_000_000_000,
                validTo: 1_710_000_000_000,
                fingerprint256: 'AB:CD',
            });
            expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|\.pem/);
        });

        it('counts the clients, apps, models and store values', () => {
            const store = new DataStore();
            store.updateModel('app1', 'a', { id: '1' });
            store.updateModel('app1', 'b', { id: '2' });
            store.updateModel('app2', 'a', { id: '3' });
            store.removeModel('app2', 'a', '3');
            const web = (id: string, app: string) => ({ id, app } as SocketIoClient);
            const tcp = (id: string, app: string) => ({ id, app } as TcpNetworkClient);

            const snapshot = serverSnapshot(sources({
                store,
                tcpClients: [ tcp('t1', 'app1'), tcp('t2', 'app3') ],
                webClients: [ web('w1', 'app1'), web('a1', 'colibri'), web('a2', 'colibri') ],
            }));
            expect(snapshot.counts).toEqual({
                tcpClients: 2,
                webClients: 1,
                adminPages: 2,
                apps: 2,
                models: 2,
                modelApps: 1,
                modelChannels: 2,
                deletedModels: 1,
                storeApps: 2,
                storeKeys: 5,
            });
        });
    });
});

describe('readServerVersion', () => {
    it('reads the version from package.json, and says unknown without one', () => {
        expect(readServerVersion(fileURLToPath(new URL('../../package.json', import.meta.url)))).toMatch(/^\d+\.\d+\.\d+/);
        expect(readServerVersion('/nonexistent/package.json')).toBe('unknown');
    });
});
