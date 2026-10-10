import { describe, it, expect, vi } from 'vitest';
import { collectBuildInfo } from '../../src/server/modules/core/build-info.js';

const COMMIT = '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6';
const NOW = new Date(1_700_000_000_000);

// git in a checkout at COMMIT, with `status` printing what is not committed.
const checkout = (status = '') => vi.fn((...args: string[]) => args[0] === 'rev-parse' ? `${COMMIT}\n` : status);

describe('the build info', () => {
    it('takes the commit from COLIBRI_COMMIT over git, as a Docker build passes it', () => {
        const git = checkout(' M src/server/main.ts\n');
        const { info, source } = collectBuildInfo({ COLIBRI_COMMIT: ` ${COMMIT.toUpperCase()} `, COLIBRI_COMMIT_DIRTY: 'true' }, git, NOW);

        expect(info).toEqual({ commit: COMMIT, dirty: true, builtAt: '2023-11-14T22:13:20.000Z' });
        expect(source).toBe('COLIBRI_COMMIT');
        expect(git).not.toHaveBeenCalled();
        expect(collectBuildInfo({ COLIBRI_COMMIT: COMMIT }, git, NOW).info.dirty).toBe(false);
    });

    it('asks git without COLIBRI_COMMIT, dirty with any change in colibri-server', () => {
        const clean = checkout();
        expect(collectBuildInfo({ COLIBRI_COMMIT: '' }, clean, NOW)).toEqual({ info: { commit: COMMIT, dirty: false, builtAt: NOW.toISOString() }, source: 'git' });
        expect(clean).toHaveBeenCalledWith('status', '--porcelain', '--', '.');

        expect(collectBuildInfo({}, checkout('?? src/server/fix.ts\n'), NOW).info).toEqual({ commit: COMMIT, dirty: true, builtAt: NOW.toISOString() });
    });

    it('builds on without git or a checkout, with the commit unknown', () => {
        const missing = () => {
            throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
        };
        const { info, source } = collectBuildInfo({}, missing, NOW);
        expect(info).toEqual({ commit: null, dirty: false, builtAt: NOW.toISOString() });
        expect(source).toMatch(/^nowhere/);

        // git that prints no hash, such as in a repository without a commit
        expect(collectBuildInfo({}, () => 'HEAD\n', NOW).info.commit).toBeNull();
    });

    it('takes no commit from a COLIBRI_COMMIT that is not a hash, and says so', () => {
        const git = checkout();
        const { info, source } = collectBuildInfo({ COLIBRI_COMMIT: 'my-fix', COLIBRI_COMMIT_DIRTY: 'true' }, git, NOW);
        expect(info).toEqual({ commit: null, dirty: false, builtAt: NOW.toISOString() });
        expect(source).toContain('not a commit hash');
        expect(git).not.toHaveBeenCalled();
    });
});
