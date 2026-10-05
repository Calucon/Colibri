/**
 * Runs the Docker image the ways it is actually deployed and checks that each one can save
 * data, survives a restart with that data intact, and stops cleanly.
 *
 * The runtime runs as the unprivileged `node` user (uid 1000), and a data directory that user
 * cannot write is the one failure nothing else here would notice: `PUT /api/store` still
 * answers 201, the server keeps everything in memory, and the EACCES that says otherwise used
 * to land only in the admin UI's in-memory log. Docker creates a missing bind-mount source as
 * root, and colibri-server 1.x ran as root, so both a first deployment and an upgrade hit it.
 *
 *   npm run test:docker
 *
 * Builds the image from this directory first, unless COLIBRI_DOCKER_IMAGE names one to use as
 * it is. Every container, volume and image it creates is named after COLIBRI_DOCKER_PREFIX
 * (default `colibri-image-check`) and removed again at the end. The web and TCP ports are
 * published on 127.0.0.1, on COLIBRI_DOCKER_PORT and the port after it when that is set, and
 * on ports Docker picks otherwise. Bind-mount sources go under COLIBRI_DOCKER_TMPDIR, or the
 * system temp directory.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, encodeHandshakeFrame } from '../src/server/modules/networking/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

const PREFIX = process.env.COLIBRI_DOCKER_PREFIX || 'colibri-image-check';
const BASE_PORT = process.env.COLIBRI_DOCKER_PORT ? Number(process.env.COLIBRI_DOCKER_PORT) : undefined;
const TMP_ROOT = process.env.COLIBRI_DOCKER_TMPDIR || os.tmpdir();
const DATA_DIR = '/srv/colibri/data';

interface Result { stdout: string; stderr: string; code: number }

const docker = function (args: string[]): Promise<Result> {
    return new Promise(resolve => {
        execFile('docker', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            resolve({ stdout, stderr, code });
        });
    });
};

const dockerOk = async function (args: string[]): Promise<string> {
    const result = await docker(args);
    if (result.code !== 0) {
        throw new Error(`docker ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`);
    }
    return result.stdout;
};

const sleep = (millis: number) => new Promise(resolve => setTimeout(resolve, millis));

const failures: string[] = [];
const check = function (label: string, ok: boolean, detail = ''): void {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(label);
};

const created = { containers: new Set<string>(), volumes: new Set<string>(), images: new Set<string>() };

// Runs a throwaway root container, for the setup a host would have: a root-owned directory,
// or the data a 1.x install left behind. Uses node from the image under test, so the check
// needs no second image.
const asRoot = async function (image: string, mount: string, script: string): Promise<void> {
    await dockerOk([ 'run', '--rm', '--user', '0:0', '-v', `${mount}:/x`, '--entrypoint', 'node', image, '-e', script ]);
};

const logsOf = async function (container: string): Promise<string> {
    const result = await docker([ 'logs', container ]);
    return result.stdout + result.stderr;
};

const waitHealthy = async function (container: string, timeoutMillis = 90_000): Promise<string> {
    const deadline = Date.now() + timeoutMillis;
    let status = '';
    while (Date.now() < deadline) {
        status = (await dockerOk([ 'inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', container ])).trim();
        if (status === 'running healthy' || status.startsWith('exited') || status.endsWith('unhealthy')) break;
        await sleep(1000);
    }
    return status;
};

const hostPort = async function (container: string, containerPort: number): Promise<number> {
    const out = await dockerOk([ 'port', container, `${containerPort}/tcp` ]);
    const port = Number(out.trim().split('\n')[0]?.split(':').pop());
    if (!Number.isInteger(port)) throw new Error(`No host port for ${container}:${containerPort}: ${out}`);
    return port;
};

const publish = function (offset: number, containerPort: number): string[] {
    return [ '-p', BASE_PORT ? `127.0.0.1:${BASE_PORT + offset}:${containerPort}` : `127.0.0.1::${containerPort}` ];
};

// Answers once the TCP worker sends anything back to a client that handshook - a published
// port alone proves nothing, since docker-proxy accepts the connection either way.
const tcpAnswers = function (port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), 5000);
        socket.on('connect', () => socket.write(encodeHandshakeFrame(PROTOCOL_VERSION, 'image-check', 'image-check')));
        socket.on('data', () => {
            clearTimeout(timer);
            done(true);
        });
        socket.on('error', () => {
            clearTimeout(timer);
            done(false);
        });
    });
};

const readStoreFile = async function (container: string): Promise<string> {
    const result = await docker([ 'exec', container, 'cat', `${DATA_DIR}/store.json` ]);
    return result.code === 0 ? result.stdout : '';
};

const serverUid = async function (container: string): Promise<string> {
    // PID 1 is the server itself: the entrypoint execs it, so `docker stop` signals node directly.
    const status = await dockerOk([ 'exec', container, 'cat', '/proc/1/status' ]);
    const cmdline = (await dockerOk([ 'exec', container, 'cat', '/proc/1/cmdline' ])).split('\0').join(' ').trim();
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1] ?? '?';
    return `${uid} ${cmdline}`;
};

// `docker logs` spans every run of the container, so the nth stop must find the nth line.
const stopCleanly = async function (container: string, nth: number): Promise<void> {
    await dockerOk([ 'stop', '-t', '15', container ]);
    const exitCode = (await dockerOk([ 'inspect', '-f', '{{.State.ExitCode}}', container ])).trim();
    const logs = await logsOf(container);
    const received = logs.split('Received SIGTERM, shutting down').length - 1;
    check('docker stop delivers SIGTERM to the server', received === nth, `${received} shutdown line(s)\n${logs.slice(-400)}`);
    check('exits with code 0', exitCode === '0', `exit code ${exitCode}`);
};

interface Deployment {
    name: string;
    // The -v argument; prepares whatever the host would already have.
    mount: (image: string) => Promise<string>;
    user?: string;
    // Seeded by mount(): an app/value that must be readable after startup.
    legacy?: { app: string; key: string; value: unknown };
    // Seeded by mount(): a symlink out of the data directory, whose target must stay root's.
    symlinkOut?: string;
    writable: boolean;
}

const runDeployment = async function (image: string, deployment: Deployment): Promise<void> {
    console.log(`\n${deployment.name}${deployment.user ? ` (--user ${deployment.user})` : ''}`);
    const container = `${PREFIX}-${deployment.name}`;
    await docker([ 'rm', '-f', container ]);

    const mount = await deployment.mount(image);
    const args = [ 'run', '-d', '--name', container, ...publish(0, 9011), ...publish(1, 9012), '-v', mount ];
    if (deployment.user) args.push('--user', deployment.user);
    args.push(image);
    created.containers.add(container);
    await dockerOk(args);

    const health = await waitHealthy(container);
    check('becomes healthy', health === 'running healthy', `${health}\n${(await logsOf(container)).slice(-1500)}`);
    if (health !== 'running healthy') return;

    const web = `http://127.0.0.1:${await hostPort(container, 9011)}`;

    const proc = await serverUid(container);
    check('server is PID 1 and runs as uid 1000', proc.startsWith('1000 node '), proc);

    if (deployment.symlinkOut) {
        const owner = (await dockerOk([ 'exec', container, 'stat', '-c', '%U', deployment.symlinkOut ])).trim();
        check('leaves the target of a symlink in the data directory alone', owner === 'root', `${deployment.symlinkOut} is owned by ${owner}`);
    }

    const index = await fetch(`${web}/`);
    check('serves the admin UI at /', index.status === 200 && (await index.text()).includes('<app-root'), `HTTP ${index.status}`);

    const handshake = await fetch(`${web}/socket.io/?EIO=4&transport=polling`);
    check('answers a Socket.IO handshake', handshake.status === 200 && (await handshake.text()).startsWith('0{'), `HTTP ${handshake.status}`);

    check('TCP server answers a handshake', await tcpAnswers(await hostPort(container, 9012)));

    const malformed = await fetch(`${web}/api/store/image-check/malformed`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{"unterminated',
    });
    const malformedBody = await malformed.text();
    check('answers malformed JSON without a stack trace', malformed.status === 400 && !malformedBody.includes('node_modules'), malformedBody.slice(0, 300));

    if (deployment.legacy) {
        const { app, key, value } = deployment.legacy;
        const res = await fetch(`${web}/api/store/${app}/${key}`);
        const body = res.status === 200 ? await res.json() : undefined;
        check('loads the store.json that was already there', JSON.stringify(body) === JSON.stringify(value), `HTTP ${res.status}`);
    }

    const value = { saved: deployment.name };
    const put = await fetch(`${web}/api/store/image-check/value`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
    });
    check('PUT /api/store answers 201', put.status === 201, `HTTP ${put.status}`);

    // Past the REST API's save debounce.
    let stored = '';
    for (let i = 0; i < 20 && !stored.includes(deployment.name); i++) {
        await sleep(250);
        stored = await readStoreFile(container);
    }

    const logs = await logsOf(container);
    if (deployment.writable) {
        check('writes store.json', stored.includes(deployment.name), stored || '(no store.json)');
        check('logs no permission error', !/EACCES|EPERM|not writable/.test(logs), logs.slice(-1500));
    } else {
        check('does not pretend to have written store.json', !stored.includes(deployment.name));
        check('says on stderr that DATA_ROOT is not writable, naming the path and the uid',
            logs.includes(`DATA_ROOT is not writable: ${DATA_DIR}`) && logs.includes('uid 1000') && logs.includes('chown -R 1000:1000'),
            logs.slice(-2500));
        check('reports the failed save in the log', /EACCES/.test(logs), logs.slice(-1500));
        const get = await fetch(`${web}/api/store/image-check/value`);
        check('keeps serving the value from memory', get.status === 200 && JSON.stringify(await get.json()) === JSON.stringify(value));
    }

    await stopCleanly(container, 1);

    if (!deployment.writable) return;

    // The same data directory, a second time: what a restart, an image upgrade or a crash
    // followed by `restart: unless-stopped` all come down to.
    await dockerOk([ 'start', container ]);
    const again = await waitHealthy(container);
    check('comes back healthy on the same data', again === 'running healthy', again);
    if (again !== 'running healthy') return;
    const restartedWeb = `http://127.0.0.1:${await hostPort(container, 9011)}`;
    const res = await fetch(`${restartedWeb}/api/store/image-check/value`);
    const body = res.status === 200 ? await res.json() : undefined;
    check('still has the value after a restart', JSON.stringify(body) === JSON.stringify(value), `HTTP ${res.status}`);
    await stopCleanly(container, 2);
};

const main = async function (): Promise<void> {
    let image = process.env.COLIBRI_DOCKER_IMAGE;
    if (!image) {
        image = `${PREFIX}-img:test`;
        console.log(`Building ${image} from ${SERVER_DIR} ...`);
        created.images.add(image);
        await dockerOk([ 'build', '-q', '-t', image, SERVER_DIR ]);
    }

    console.log(`\nimage ${image}`);
    const env = JSON.parse(await dockerOk([ 'image', 'inspect', '-f', '{{json .Config.Env}}', image ])) as string[];
    check('sets NODE_ENV=production', env.includes('NODE_ENV=production'), env.join(' '));
    const size = (await dockerOk([ 'image', 'inspect', '-f', '{{.Size}}', image ])).trim();
    console.log(`  size ${(Number(size) / 1e6).toFixed(1)} MB`);

    const tmp = await mkdtemp(path.join(TMP_ROOT, `${PREFIX}-`));
    const rootOwnedDir = async function (name: string, files: Record<string, string>, img: string, symlinkOut?: string): Promise<string> {
        const dir = path.join(tmp, name);
        // Docker creates the missing source as root, and the root container fills it in, so
        // the directory and everything in it is owned by root - exactly what a 1.x install left.
        const link = symlinkOut ? `fs.symlinkSync(${JSON.stringify(symlinkOut)}, '/x/link-out-of-data');` : '';
        await asRoot(img, dir, `const fs = require('fs'); for (const [f, c] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync('/x/' + f, c); ${link} fs.chmodSync('/x', 0o755);`);
        return `${dir}:${DATA_DIR}`;
    };
    const volume = async function (name: string): Promise<string> {
        const vol = `${PREFIX}-${name}`;
        await docker([ 'volume', 'rm', '-f', vol ]);
        created.volumes.add(vol);
        return `${vol}:${DATA_DIR}`;
    };

    const legacy = { app: 'legacy-app', key: 'greeting', value: 'stored by colibri 1.x' };
    const deployments: Deployment[] = [
        {
            name: 'bind-missing-dir',
            mount: async () => `${path.join(tmp, 'bind-missing-dir')}:${DATA_DIR}`,
            writable: true,
        },
        {
            name: 'bind-root-owned-1x',
            mount: img => rootOwnedDir('bind-root-owned-1x', { 'store.json': JSON.stringify({ [legacy.app]: { [legacy.key]: legacy.value } }) }, img, '/etc/shadow'),
            legacy,
            symlinkOut: '/etc/shadow',
            writable: true,
        },
        {
            name: 'named-volume',
            mount: () => volume('named-volume'),
            writable: true,
        },
        {
            name: 'user-1000-named-volume',
            mount: () => volume('user-1000-named-volume'),
            user: '1000:1000',
            writable: true,
        },
        {
            // Nothing can fix this one from inside: the container never has root. What it must
            // do is say so, loudly, and keep running.
            name: 'user-1000-root-owned-dir',
            mount: img => rootOwnedDir('user-1000-root-owned-dir', {}, img),
            user: '1000:1000',
            writable: false,
        },
    ];

    try {
        const only = process.argv.slice(2);
        for (const deployment of deployments) {
            if (only.length > 0 && !only.includes(deployment.name)) continue;
            try {
                await runDeployment(image, deployment);
            } catch (err) {
                check(`${deployment.name} ran to completion`, false, err instanceof Error ? err.message : String(err));
            }
        }
    } finally {
        for (const container of created.containers) await docker([ 'rm', '-f', '-v', container ]);
        for (const vol of created.volumes) await docker([ 'volume', 'rm', '-f', vol ]);
        // The bind-mount sources are root-owned by now (or node-owned, after the entrypoint),
        // so only a root container can remove what is inside them.
        await asRoot(image, tmp, 'for (const f of require("fs").readdirSync("/x")) require("fs").rmSync("/x/" + f, { recursive: true, force: true })').catch(() => undefined);
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        for (const img of created.images) await docker([ 'rmi', img ]);
    }

    console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
    process.exitCode = failures.length === 0 ? 0 : 1;
};

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
