// Which source the server was built from: the git commit, for builds with their own changes. `npm run
// build` records it in dist/server/build-info.json (see write-build-info.ts), and the server reads it
// at startup.

// What the build info file holds.
export interface BuildInfoFile {
    // The full hash of the commit, or null if the build had no git information.
    commit: string | null;
    // Whether colibri-server had changes that were not committed.
    dirty: boolean;
    // When it was built, as an ISO 8601 time.
    builtAt: string;
}

// A SHA-1 hash, or a SHA-256 one, in full or cut short, as git prints them.
const COMMIT_HASH = /^[0-9a-f]{7,64}$/;

const commitOf = function (value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const hash = value.trim().toLowerCase();
    return COMMIT_HASH.test(hash) ? hash : null;
};

const isTrue = function (value: string | undefined): boolean {
    return [ 'true', '1', 'yes' ].includes(value?.trim().toLowerCase() ?? '');
};

// Runs git with these arguments in colibri-server and returns what it prints; throws if git is not
// installed, the directory is not a git checkout, or git fails.
export type Git = (...args: string[]) => string;

/**
 * What `npm run build` records. The commit comes from COLIBRI_COMMIT, and COLIBRI_COMMIT_DIRTY
 * ('true'), if set: a Docker build has no .git to ask, and passes them as build arguments. Else from
 * git, with any change in colibri-server not committed, untracked files included, making it dirty;
 * the other components of the repository are not part of the server. Else there is none. `source`
 * says which, for the build's output.
 */
export const collectBuildInfo = function (env: NodeJS.ProcessEnv, git: Git, now = new Date()): { info: BuildInfoFile; source: string } {
    const builtAt = now.toISOString();

    const fromEnv = env['COLIBRI_COMMIT']?.trim();
    if (fromEnv) {
        const commit = commitOf(fromEnv);
        return commit
            ? { info: { commit, dirty: isTrue(env['COLIBRI_COMMIT_DIRTY']), builtAt }, source: 'COLIBRI_COMMIT' }
            : { info: { commit: null, dirty: false, builtAt }, source: `COLIBRI_COMMIT, which is not a commit hash: '${fromEnv.slice(0, 80)}'` };
    }

    let commit: string | null = null;
    try {
        commit = commitOf(git('rev-parse', 'HEAD'));
    } catch {
        // no git, or no checkout: the build goes on without
    }
    if (!commit) return { info: { commit: null, dirty: false, builtAt }, source: 'nowhere: no COLIBRI_COMMIT, and no git checkout to ask' };

    let dirty = false;
    try {
        dirty = git('status', '--porcelain', '--', '.').trim() !== '';
    } catch {
        // the commit is known all the same
    }
    return { info: { commit, dirty, builtAt }, source: 'git' };
};
