import { ServerSnapshot } from '../../services';
import { Fact, serverSections } from './server.component';

const DAY = 24 * 60 * 60 * 1000;

const snapshot = (overrides: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
    request: 1,
    at: 100 * DAY,
    version: '2.0.0',
    protocolVersion: '2',
    node: 'v24.21.0',
    startedAt: 100 * DAY - 3_725_000,
    uptime: 3725,
    settings: {
        WEBSERVER_HOST: '0.0.0.0', WEBSERVER_PORT: 9011, BASE_URL: '', TCP_HOST: '0.0.0.0', TCP_PORT: 9012,
        VOICE_HOST: '0.0.0.0', VOICE_PORT: 9013, VOICE_SAMPLING_RATE: 48000, VOICE_RECORDING: false,
        TCP_IDLE_TIMEOUT_SECONDS: 10, TCP_INBOUND_BACKLOG_LIMIT: 2000, CLIENT_MESSAGE_RATE_LIMIT: 1000,
        CLIENT_MESSAGE_RATE_BURST: 2000, APP_CLIENT_WARNING_THRESHOLD: 8, MODEL_TOMBSTONE_SECONDS: 600,
        TRUSTED_PROXIES: [], TCP_PROXY_PROTOCOL: false
    },
    tls: null,
    voice: { listening: true, recording: false, samplingRate: 48000, clients: 0 },
    counts: {
        tcpClients: 3, webClients: 2, adminPages: 1, apps: 2, models: 1234, modelApps: 2, modelChannels: 3,
        deletedModels: 4, storeApps: 1, storeKeys: 7
    },
    ...overrides
});

const fact = (s: ServerSnapshot, section: string, label: string): Fact | undefined =>
    serverSections(s, time => new Date(time).toISOString()).find(x => x.id === section)?.facts.find(f => f.label === label);

describe('serverSections', () => {
    it('shows the versions, the uptime and the counts', () => {
        const s = snapshot();
        expect(fact(s, 'server', 'Uptime')?.value).toBe('1 h 2 min');
        expect(fact(s, 'counts', 'Synced models')).toEqual(expect.objectContaining({ value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' }));
        expect(fact(s, 'counts', 'REST store')).toEqual(expect.objectContaining({ value: '7 values', note: 'in 1 app' }));
    });

    it('says which limits are off, and which variable sets each', () => {
        const s = snapshot();
        s.settings = { ...s.settings, CLIENT_MESSAGE_RATE_LIMIT: 0, TCP_IDLE_TIMEOUT_SECONDS: 0 };

        expect(fact(s, 'limits', 'Messages per client')).toEqual(expect.objectContaining({ value: 'Off', variable: 'CLIENT_MESSAGE_RATE_LIMIT' }));
        expect(fact(s, 'limits', 'Burst')?.value).toBe('Off');
        expect(fact(s, 'limits', 'TCP idle timeout')?.value).toBe('Off');
        expect(fact(s, 'limits', 'TCP inbound backlog')?.value).toBe('2,000 messages');
        expect(fact(s, 'network', 'Trusted proxies')?.value).toBe('None');
        expect(fact(s, 'network', 'TLS')?.value).toBe('Off');
    });

    it('describes the certificate, never more, and warns before it expires', () => {
        const tls = { names: 'colibri.example.org', issuer: 'Example CA', selfSigned: false, validFrom: 0, validTo: 110 * DAY, fingerprint256: 'AB:CD' };
        const s = snapshot({ tls });

        expect(serverSections(s, String).find(x => x.id === 'certificate')?.facts.map(f => f.label))
            .toEqual([ 'Names', 'Issuer', 'Valid from', 'Valid until', 'SHA-256 fingerprint' ]);
        expect(fact(s, 'certificate', 'Valid until')).toEqual(expect.objectContaining({ tone: 'warn', note: 'expires in 10 days' }));
        expect(fact(snapshot({ tls: { ...tls, validTo: 99 * DAY } }), 'certificate', 'Valid until')).toEqual(expect.objectContaining({ tone: 'err', note: 'expired' }));
        expect(fact(snapshot({ tls: { ...tls, validTo: 200 * DAY } }), 'certificate', 'Valid until')?.tone).toBeUndefined();
        expect(fact(s, 'network', 'Web')?.note).toBe('HTTPS and WSS');
    });

    it('lists settings it does not know under Other settings', () => {
        const s = snapshot();
        s.settings = { ...s.settings, NEW_SETTING: 'x' };
        expect(fact(s, 'other', 'NEW_SETTING')?.value).toBe('x');
        expect(serverSections(snapshot(), String).some(x => x.id === 'other')).toBe(false);
    });
});
