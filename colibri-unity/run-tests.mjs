#!/usr/bin/env node
/**
 * Runs colibri-unity's whole test suite: the EditMode unit tests, and the PlayMode end-to-end
 * tests against a real colibri-server.
 *
 *   node colibri-unity/run-tests.mjs                 both suites
 *   node colibri-unity/run-tests.mjs --editmode      unit tests only, no server needed
 *   node colibri-unity/run-tests.mjs --playmode      end-to-end only
 *
 * Environment (the same contract colibri-web's e2e suite uses):
 *   COLIBRI_E2E_SERVER     host of a server to use instead of starting one. Setting this means
 *                          the script never starts or stops anything.
 *   COLIBRI_E2E_PORT       web/Socket.IO port, default 9011
 *   COLIBRI_E2E_TCP_PORT   binary v3 port, default 9012
 *   COLIBRI_E2E_NO_BUILD   skip `docker compose --build`
 *   UNITY_PATH             Unity executable to use, if it is not where Unity Hub puts it
 *
 * A server already listening on the TCP port is used as it stands, whether or not the
 * environment says so - taking someone's running server down at the end of a test run would be a
 * poor way to repay them for it.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const SERVER_DIR = path.resolve(__dirname, '../colibri-server');
const RESULTS_DIR = path.join(PROJECT_DIR, 'TestResults');

const HOST = process.env.COLIBRI_E2E_SERVER ?? '127.0.0.1';
const TCP_PORT = Number(process.env.COLIBRI_E2E_TCP_PORT ?? 9012);

const platforms = [];
if (process.argv.includes('--editmode')) platforms.push('EditMode');
if (process.argv.includes('--playmode')) platforms.push('PlayMode');
if (platforms.length === 0) platforms.push('EditMode', 'PlayMode');


/*
 *  The server
 */

const isListening = (host, port, timeoutMs = 1000) =>
    new Promise(resolve => {
        const socket = net.connect(port, host);
        const done = result => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });

const waitForPort = async (host, port, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await isListening(host, port)) return;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${host}:${port}`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
};

const startServer = async () => {
    if (await isListening(HOST, TCP_PORT)) {
        console.log(`Using the colibri-server already listening on ${HOST}:${TCP_PORT}.`);
        return async () => {};
    }

    if (process.env.COLIBRI_E2E_SERVER) {
        // An external server was named but is not up. Starting a local one would silently test
        // something other than what was asked for.
        throw new Error(
            `COLIBRI_E2E_SERVER is set to "${HOST}" but nothing is listening on port ${TCP_PORT}.`
        );
    }

    const args = ['compose', 'up', '-d'];
    if (!process.env.COLIBRI_E2E_NO_BUILD) args.push('--build');

    console.log(`Starting colibri-server (docker ${args.join(' ')})...`);
    try {
        await execFileAsync('docker', args, { cwd: SERVER_DIR });
    } catch (error) {
        throw new Error(
            `Could not start colibri-server with Docker: ${error.message}\n` +
                'Start a server another way and point the suite at it with COLIBRI_E2E_SERVER=127.0.0.1.'
        );
    }

    await waitForPort(HOST, TCP_PORT, 180_000);
    console.log(`colibri-server is up on ${HOST}:${TCP_PORT}.`);

    return async () => {
        console.log('Stopping colibri-server...');
        await execFileAsync('docker', ['compose', 'down'], { cwd: SERVER_DIR }).catch(() => {});
    };
};


/*
 *  The Editor
 */

const editorExecutable = version => {
    const hub = {
        win32: path.join('C:', 'Program Files', 'Unity', 'Hub', 'Editor'),
        darwin: '/Applications/Unity/Hub/Editor',
        linux: path.join(os.homedir(), 'Unity', 'Hub', 'Editor'),
    }[process.platform];

    if (!hub) return null;

    const relative = {
        win32: path.join('Editor', 'Unity.exe'),
        darwin: path.join('Unity.app', 'Contents', 'MacOS', 'Unity'),
        linux: path.join('Editor', 'Unity'),
    }[process.platform];

    const candidate = path.join(hub, version, relative);
    return existsSync(candidate) ? candidate : null;
};

const projectEditorVersion = () => {
    const file = path.join(PROJECT_DIR, 'ProjectSettings', 'ProjectVersion.txt');
    const match = readFileSync(file, 'utf8').match(/m_EditorVersion:\s*(\S+)/);
    if (!match) throw new Error(`Cannot read the editor version from ${file}`);
    return match[1];
};

const findUnity = () => {
    if (process.env.UNITY_PATH) {
        if (!existsSync(process.env.UNITY_PATH)) {
            throw new Error(`UNITY_PATH points at ${process.env.UNITY_PATH}, which does not exist`);
        }
        return process.env.UNITY_PATH;
    }

    const version = projectEditorVersion();
    const exact = editorExecutable(version);
    if (exact) return exact;

    // Deliberately not falling back to whatever else is installed: opening the project with a
    // different editor upgrades it in place, which shows up as an unrelated diff in
    // ProjectVersion.txt, the package manifest and half of ProjectSettings.
    throw new Error(
        `Unity ${version} is not installed where Unity Hub puts it.\n` +
            `Install ${version} from Unity Hub, or set UNITY_PATH to the editor to use - note that a ` +
            'different version will upgrade the project in place.'
    );
};

const runUnity = (unity, platform) =>
    new Promise(resolve => {
        const results = path.join(RESULTS_DIR, `${platform}.xml`);
        const args = [
            '-batchmode',
            '-nographics',
            '-projectPath',
            PROJECT_DIR,
            '-runTests',
            '-testPlatform',
            platform,
            '-testResults',
            results,
            '-logFile',
            path.join(RESULTS_DIR, `${platform}.log`),
        ];

        console.log(`\nRunning ${platform} tests...`);
        const child = spawn(unity, args, { stdio: 'inherit' });
        child.once('close', code => resolve({ platform, code, results }));
    });


/*
 *  Results
 */

const attribute = (xml, name) => {
    const match = xml.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? match[1] : null;
};

const summarize = (platform, resultsFile) => {
    if (!existsSync(resultsFile)) {
        console.log(`\n${platform}: no results were written - see ${path.join(RESULTS_DIR, `${platform}.log`)}`);
        return { platform, ok: false, total: 0, passed: 0, failed: 0, skipped: 0 };
    }

    const xml = readFileSync(resultsFile, 'utf8');
    const header = xml.slice(0, xml.indexOf('>', xml.indexOf('<test-run')) + 1);

    const total = Number(attribute(header, 'total') ?? 0);
    const passed = Number(attribute(header, 'passed') ?? 0);
    const failed = Number(attribute(header, 'failed') ?? 0);
    const skipped = Number(attribute(header, 'skipped') ?? 0);

    console.log(`\n${platform}: ${passed} passed, ${failed} failed, ${skipped} skipped (${total} total)`);

    if (failed > 0) {
        for (const match of xml.matchAll(/<test-case\b[^>]*\bresult="Failed"[^>]*>([\s\S]*?)<\/test-case>/g)) {
            const name = attribute(match[0].slice(0, match[0].indexOf('>')), 'fullname');
            const message = match[1].match(/<message>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/message>/);
            console.log(`  FAILED  ${name}`);
            if (message) console.log(`          ${message[1].trim().split('\n')[0]}`);
        }
    }

    // Everything skipping means the suite could not run, which is not the same as passing.
    if (skipped > 0 && passed === 0 && total > 0) {
        console.log('  Every test was skipped - is colibri-server reachable?');
        return { platform, ok: false, total, passed, failed, skipped };
    }

    return { platform, ok: failed === 0 && total > 0, total, passed, failed, skipped };
};


/*
 *  Main
 */

const main = async () => {
    mkdirSync(RESULTS_DIR, { recursive: true });

    const unity = findUnity();
    console.log(`Unity: ${unity}`);

    const needsServer = platforms.includes('PlayMode');
    const stopServer = needsServer ? await startServer() : async () => {};

    const summaries = [];
    try {
        for (const platform of platforms) {
            const run = await runUnity(unity, platform);
            summaries.push(summarize(platform, run.results));
        }
    } finally {
        await stopServer();
    }

    const ok = summaries.every(summary => summary.ok);
    console.log(ok ? '\nAll suites passed.' : '\nSuite failed.');
    process.exit(ok ? 0 : 1);
};

main().catch(error => {
    console.error(`\n${error.message}`);
    process.exit(1);
});
