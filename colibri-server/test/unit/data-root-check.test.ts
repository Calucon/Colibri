import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataRootCheck } from '../../src/server/modules/core/data-root-check.js';
import { PRINTED_TO_CONSOLE } from '../../src/server/modules/core/console-log.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';
import { Service } from '../../src/server/modules/core/service.js';

// Permission bits do not stop root, so the unwritable-directory case cannot be set up as root.
const isRoot = process.getuid?.() === 0;
const isWindows = process.platform === 'win32';

let tmp: string;

beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'colibri-data-root-'));
});

afterEach(async () => {
    await chmod(tmp, 0o700).catch(() => undefined);
    for (const entry of await readdir(tmp).catch(() => [])) {
        await chmod(path.join(tmp, entry), 0o700).catch(() => undefined);
    }
    await rm(tmp, { recursive: true, force: true });
});

const run = async function (dir: string): Promise<{ ok: boolean; printed: string[]; logged: LogMessage[] }> {
    const printed: string[] = [];
    const logged: LogMessage[] = [];
    const subscription = Service.output$.subscribe(msg => {
        if (msg.origin === 'DataRoot') logged.push(msg);
    });
    try {
        const ok = await new DataRootCheck(dir, text => printed.push(text)).check();
        return { ok, printed, logged };
    } finally {
        subscription.unsubscribe();
    }
};

describe('DataRootCheck', () => {
    it('stays quiet about a writable directory, and leaves nothing behind in it', async () => {
        const result = await run(tmp);

        expect(result).toEqual({ ok: true, printed: [], logged: [] });
        expect(await readdir(tmp)).toEqual([]);
    });

    it('creates a missing directory, as the store would on its first save', async () => {
        const result = await run(path.join(tmp, 'data', 'nested'));

        expect(result.ok).toBe(true);
        expect(await readdir(path.join(tmp, 'data'))).toEqual([ 'nested' ]);
    });

    // What a PUT would otherwise find out only when its debounced save failed - after it had
    // already answered 201.
    it.skipIf(isRoot || isWindows)('says loudly that a directory it cannot write is not writable, and how to fix it', async () => {
        const dir = path.join(tmp, 'root-owned');
        await mkdir(dir, { mode: 0o555 });

        const { ok, printed, logged } = await run(dir);
        const uid = process.getuid!();
        const gid = process.getgid!();

        expect(ok).toBe(false);
        expect(printed).toHaveLength(1);
        const banner = printed[0]!;
        expect(banner).toContain(`DATA_ROOT is not writable: ${dir}`);
        expect(banner).toContain('EACCES');
        expect(banner).toContain(`runs as uid ${uid}`);
        expect(banner).toContain(`chown -R ${uid}:${gid} ${dir}`);
        expect(banner).toContain('named volume');

        // Once more for the admin UI, marked so the console sink does not print it twice.
        expect(logged).toHaveLength(1);
        expect(logged[0]!.level).toBe(LogLevel.Error);
        expect(logged[0]!.message).toContain(`DATA_ROOT is not writable: ${dir}`);
        expect(logged[0]!.metadata[PRINTED_TO_CONSOLE]).toBe(true);
    });

    it('reports a path it cannot use as a directory at all', async () => {
        const file = path.join(tmp, 'store.json');
        await writeFile(file, '{}');

        const { ok, printed } = await run(file);

        expect(ok).toBe(false);
        expect(printed[0]).toContain(`DATA_ROOT is not writable: ${file}`);
    });

    it('names no uid where there is none to name', () => {
        const text = DataRootCheck.describe('C:\\colibri\\data', new Error('EPERM: operation not permitted'), undefined, undefined);

        expect(text).toContain('DATA_ROOT is not writable: C:\\colibri\\data');
        expect(text).not.toContain('chown');
        expect(text).not.toContain('uid');
    });
});
