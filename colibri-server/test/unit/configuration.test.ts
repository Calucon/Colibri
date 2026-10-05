import { describe, it, expect, afterEach, vi } from 'vitest';
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
});
