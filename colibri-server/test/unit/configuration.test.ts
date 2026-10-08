import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TestCertificate, createTestCertificate, encryptTestKey } from '../tls-test-certificate.js';

// configuration.ts resolves its paths against its own directory: src/server here,
// dist/server in a build.
const CONFIG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server');

// Config is computed when the module is first evaluated, so each case evaluates it afresh.
const loadConfig = async (env: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(env)) {
        vi.stubEnv(name, value);
    }
    vi.resetModules();
    const { Config } = await import('../../src/server/configuration.js');
    return Config;
};

describe('Config', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    describe('DATA_ROOT and WEBSERVER_ROOT', () => {
        it('honour an absolute path as it is', async () => {
            const config = await loadConfig({ DATA_ROOT: '/var/lib/colibri', WEBSERVER_ROOT: '/srv/colibri-ui/' });

            expect(config.DATA_ROOT).toBe(path.resolve('/var/lib/colibri'));
            expect(config.WEBSERVER_ROOT).toBe(path.resolve('/srv/colibri-ui'));
        });

        it('resolve a relative path against the server directory, to the same place as before', async () => {
            const config = await loadConfig({ DATA_ROOT: '../../my-data', WEBSERVER_ROOT: 'public' });

            expect(config.DATA_ROOT).toBe(path.resolve(CONFIG_DIR, '../../my-data'));
            expect(config.WEBSERVER_ROOT).toBe(path.resolve(CONFIG_DIR, 'public'));
            // ...which is where path.join(__dirname, value) pointed, minus a trailing separator
            expect(path.relative(path.join(CONFIG_DIR, '../../my-data'), config.DATA_ROOT)).toBe('');
            expect(path.relative(path.join(CONFIG_DIR, 'public'), config.WEBSERVER_ROOT)).toBe('');
        });

        it('default to the data and ui directories next to the build', async () => {
            const config = await loadConfig({ DATA_ROOT: '', WEBSERVER_ROOT: '' });

            expect(config.DATA_ROOT).toBe(path.resolve(CONFIG_DIR, '../../data'));
            expect(config.WEBSERVER_ROOT).toBe(path.resolve(CONFIG_DIR, '../ui'));
        });
    });

    describe('inbound limits', () => {
        it('default to dropping past a backlog of 2000 TCP messages', async () => {
            const config = await loadConfig({ TCP_INBOUND_BACKLOG_LIMIT: undefined });

            expect(config.TCP_INBOUND_BACKLOG_LIMIT).toBe(2000);
        });

        it('take 0 to turn a limit off', async () => {
            const config = await loadConfig({ TCP_INBOUND_BACKLOG_LIMIT: '0' });

            expect(config.TCP_INBOUND_BACKLOG_LIMIT).toBe(0);
        });

        it.each(['-1', '1.5', 'lots'])('refuse to start with a limit of "%s"', async (raw) => {
            await expect(loadConfig({ TCP_INBOUND_BACKLOG_LIMIT: raw })).rejects.toThrow('TCP_INBOUND_BACKLOG_LIMIT');
        });

        it('default to 1000 messages a second per client, in bursts of up to 2000', async () => {
            const config = await loadConfig({ CLIENT_MESSAGE_RATE_LIMIT: undefined, CLIENT_MESSAGE_RATE_BURST: undefined });

            expect(config.CLIENT_MESSAGE_RATE_LIMIT).toBe(1000);
            expect(config.CLIENT_MESSAGE_RATE_BURST).toBe(2000);
        });

        it('take a rate limit of 0 to turn it off', async () => {
            const config = await loadConfig({ CLIENT_MESSAGE_RATE_LIMIT: '0', CLIENT_MESSAGE_RATE_BURST: '500' });

            expect(config.CLIENT_MESSAGE_RATE_LIMIT).toBe(0);
            expect(config.CLIENT_MESSAGE_RATE_BURST).toBe(500);
        });

        it('default to disconnecting a TCP client after 10 s of silence, and take 0 to never', async () => {
            expect((await loadConfig({ TCP_IDLE_TIMEOUT_SECONDS: undefined })).TCP_IDLE_TIMEOUT_SECONDS).toBe(10);
            expect((await loadConfig({ TCP_IDLE_TIMEOUT_SECONDS: '0' })).TCP_IDLE_TIMEOUT_SECONDS).toBe(0);
        });

        it('default to warning about an app of more than 8 clients, and take 0 to never warn', async () => {
            expect((await loadConfig({ APP_CLIENT_WARNING_THRESHOLD: undefined })).APP_CLIENT_WARNING_THRESHOLD).toBe(8);
            expect((await loadConfig({ APP_CLIENT_WARNING_THRESHOLD: '0' })).APP_CLIENT_WARNING_THRESHOLD).toBe(0);
        });

        // A bucket that can never hold a token would drop every update.
        it('refuse a burst of 0', async () => {
            await expect(loadConfig({ CLIENT_MESSAGE_RATE_BURST: '0' })).rejects.toThrow('CLIENT_MESSAGE_RATE_BURST');
        });
    });

    describe('MODEL_TOMBSTONE_SECONDS', () => {
        it('defaults to remembering a deleted model for 10 minutes, and takes 0 to not remember it', async () => {
            expect((await loadConfig({ MODEL_TOMBSTONE_SECONDS: undefined })).MODEL_TOMBSTONE_SECONDS).toBe(600);
            expect((await loadConfig({ MODEL_TOMBSTONE_SECONDS: '0' })).MODEL_TOMBSTONE_SECONDS).toBe(0);
            expect((await loadConfig({ MODEL_TOMBSTONE_SECONDS: '30' })).MODEL_TOMBSTONE_SECONDS).toBe(30);
        });

        it.each(['-1', '2.5', 'forever'])('refuses to start with "%s"', async (raw) => {
            await expect(loadConfig({ MODEL_TOMBSTONE_SECONDS: raw })).rejects.toThrow('MODEL_TOMBSTONE_SECONDS');
        });
    });

    describe('TLS_CERT and TLS_KEY', () => {
        let dir: string;
        let server: TestCertificate;
        let other: TestCertificate;
        // server and other have EC keys.
        let rsa: TestCertificate;

        beforeAll(async () => {
            dir = await mkdtemp(path.join(tmpdir(), 'colibri-config-tls-'));
            server = createTestCertificate(dir, 'server');
            other = createTestCertificate(dir, 'other');
            rsa = createTestCertificate(dir, 'rsa', { keyType: 'rsa' });
        });

        afterAll(async () => {
            await rm(dir, { recursive: true, force: true });
        });

        it('leave TLS off when neither is set, or both are empty', async () => {
            const unset = await loadConfig({ TLS_CERT: undefined, TLS_KEY: undefined });
            expect(unset.TLS_CERT).toBeUndefined();
            expect(unset.TLS_KEY).toBeUndefined();

            const empty = await loadConfig({ TLS_CERT: '', TLS_KEY: '' });
            expect(empty.TLS_CERT).toBeUndefined();
            expect(empty.TLS_KEY).toBeUndefined();
        });

        it('take a certificate and its key', async () => {
            const config = await loadConfig({ TLS_CERT: server.certPath, TLS_KEY: server.keyPath });

            expect(config.TLS_CERT).toBe(server.certPath);
            expect(config.TLS_KEY).toBe(server.keyPath);
        });

        it('take an RSA certificate and its key', async () => {
            const config = await loadConfig({ TLS_CERT: rsa.certPath, TLS_KEY: rsa.keyPath });

            expect(config.TLS_CERT).toBe(rsa.certPath);
            expect(config.TLS_KEY).toBe(rsa.keyPath);
        });

        it('resolve relative paths like DATA_ROOT\'s', async () => {
            const config = await loadConfig({
                TLS_CERT: path.relative(CONFIG_DIR, server.certPath),
                TLS_KEY: path.relative(CONFIG_DIR, server.keyPath),
            });

            expect(config.TLS_CERT).toBe(server.certPath);
            expect(config.TLS_KEY).toBe(server.keyPath);
        });

        it.each([
            [ 'TLS_CERT', 'TLS_KEY' ],
            [ 'TLS_KEY', 'TLS_CERT' ],
        ])('refuse to start with only %s set, naming %s', async (set, missing) => {
            const env = { TLS_CERT: undefined as string | undefined, TLS_KEY: undefined as string | undefined };
            env[set as 'TLS_CERT' | 'TLS_KEY'] = set === 'TLS_CERT' ? server.certPath : server.keyPath;

            await expect(loadConfig(env)).rejects.toThrow(`${set} is set, but ${missing} is not`);
        });

        it('refuse to start with a file that does not exist, naming it', async () => {
            const missing = path.join(dir, 'missing.pem');

            await expect(loadConfig({ TLS_CERT: missing, TLS_KEY: server.keyPath }))
                .rejects.toThrow(`Cannot read TLS_CERT (${missing})`);
        });

        it('refuse to start with a directory instead of a file', async () => {
            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: dir }))
                .rejects.toThrow('has to name the PEM file itself');
        });

        // root reads any file, so there is nothing to refuse when the tests run as root.
        it.skipIf(process.getuid?.() === 0)('refuse to start with a key the server cannot read, naming its uid', async () => {
            const locked = path.join(dir, 'locked');
            await mkdir(locked, { recursive: true });
            const keyPath = path.join(locked, 'server.key');
            await writeFile(keyPath, server.key);
            await chmod(keyPath, 0o000);
            try {
                await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: keyPath }))
                    .rejects.toThrow(new RegExp(`Cannot read TLS_KEY \\(${keyPath}\\).*runs as uid ${process.getuid?.()}`));
            } finally {
                await chmod(keyPath, 0o600);
            }
        });

        it('refuse to start with a key where the certificate belongs', async () => {
            await expect(loadConfig({ TLS_CERT: server.keyPath, TLS_KEY: server.keyPath }))
                .rejects.toThrow(`TLS_CERT (${server.keyPath}) holds no certificate the server can use`);
        });

        it('refuse to start with a certificate where the key belongs', async () => {
            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: server.certPath }))
                .rejects.toThrow(`TLS_KEY (${server.certPath}) holds no private key the server can use`);
        });

        it('refuse to start with the key of another certificate', async () => {
            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: other.keyPath }))
                .rejects.toThrow(`TLS_KEY (${other.keyPath}) is not the private key of the certificate in TLS_CERT (${server.certPath})`);
        });

        // OpenSSL itself takes these without a word, and then fails every handshake.
        it.each([
            [ 'an RSA certificate and an EC key', 'rsa', 'server' ],
            [ 'an EC certificate and an RSA key', 'server', 'rsa' ],
        ] as const)('refuse to start with %s', async (_what, certOf, keyOf) => {
            const certificates = { server, rsa };
            const { certPath } = certificates[certOf];
            const { keyPath } = certificates[keyOf];

            await expect(loadConfig({ TLS_CERT: certPath, TLS_KEY: keyPath }))
                .rejects.toThrow(`TLS_KEY (${keyPath}) is not the private key of the certificate in TLS_CERT (${certPath})`);
        });

        // Node would otherwise either fail with an OpenSSL decoder error or, on a terminal, ask for it.
        it.each([ 'pkcs8', 'traditional' ] as const)('refuse to start with a key protected by a passphrase (%s), and say so', async (format) => {
            const keyPath = encryptTestKey(dir, server, format);

            await expect(loadConfig({ TLS_CERT: server.certPath, TLS_KEY: keyPath }))
                .rejects.toThrow(`TLS_KEY (${keyPath}) is protected by a passphrase`);
        });
    });

    it('loads .env without printing dotenv\'s banner and tip', async () => {
        // dotenv reads .env from the working directory.
        const cwd = await mkdtemp(path.join(tmpdir(), 'colibri-config-'));
        try {
            await writeFile(path.join(cwd, '.env'), 'VOICE_SAMPLING_RATE=44100\n', 'utf8');
            vi.spyOn(process, 'cwd').mockReturnValue(cwd);
            const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

            const config = await loadConfig({ DOTENV_CONFIG_QUIET: undefined, VOICE_SAMPLING_RATE: undefined });

            expect(config.VOICE_SAMPLING_RATE).toBe(44100);
            const printed = log.mock.calls.map(args => args.map(String).join(' '));
            expect(printed.filter(line => /dotenv|injected env|tip:/i.test(line))).toEqual([]);
        } finally {
            // dotenv wrote the value into process.env itself, outside of stubEnv
            delete process.env.VOICE_SAMPLING_RATE;
            await rm(cwd, { recursive: true, force: true });
        }
    });
});
