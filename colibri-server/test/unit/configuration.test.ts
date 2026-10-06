import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

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

        // A bucket that can never hold a token would drop every update.
        it('refuse a burst of 0', async () => {
            await expect(loadConfig({ CLIENT_MESSAGE_RATE_BURST: '0' })).rejects.toThrow('CLIENT_MESSAGE_RATE_BURST');
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
