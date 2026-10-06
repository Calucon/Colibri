import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { once } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
import { Subscription } from 'rxjs';
import { ConsoleLog, LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';
import { WebServer } from '../../src/server/modules/web/web-server.js';
import { RestAPI } from '../../src/server/modules/web/rest-api.js';
import { MAX_FRAME_LENGTH } from '../../src/server/modules/networking/protocol.js';

// Unlike rest-api.test.ts, which drives the router directly, these go through the real
// express app over HTTP - body parser, middleware order and error handling included.
describe('WebServer over HTTP', () => {
    let dataPath: string;
    let webRoot: string;
    let webServer: WebServer;
    let restApi: RestAPI;
    let httpServer: http.Server;
    let baseUrl: string;
    let logs: LogMessage[];
    let logSubscription: Subscription;

    beforeEach(async () => {
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));

        dataPath = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-data-'));
        webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-root-'));
        await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Colibri</title>', 'utf8');

        webServer = new WebServer('127.0.0.1', 0, webRoot, '');
        restApi = new RestAPI(dataPath, webServer);
        await restApi.init();
        // A route with a bug in it, for the error handling tests.
        webServer.addApi('/fails', () => {
            throw new Error(`secret detail in ${webRoot}`);
        });

        httpServer = webServer.start();
        await once(httpServer, 'listening');
        baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        const closed = once(httpServer, 'close');
        webServer.stop();
        httpServer.closeAllConnections();
        await closed;
        // A pending debounced save would otherwise recreate dataPath after it is removed.
        await restApi.flush();
        await rm(dataPath, { recursive: true, force: true });
        await rm(webRoot, { recursive: true, force: true });
    });

    const storeUrl = (app: string, name: string) => `${baseUrl}/api/store/${app}/${name}`;

    // Store.cs: UnityWebRequest.Put(url, JsonConvert.SerializeObject(value)) with
    // Content-Type and Accept set to application/json; Get hands the response text to
    // JsonConvert.DeserializeObject<T>. For these values Json.NET writes the same text as
    // JSON.stringify.
    const unityPut = (name: string, json: string) => fetch(storeUrl('UnityApp', name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: json,
    });
    const unityGet = async (name: string) => {
        const response = await fetch(storeUrl('UnityApp', name), { headers: { 'Accept': 'application/json' } });
        return { status: response.status, text: await response.text() };
    };

    // Colibri.ts: setRestObject PUTs JSON.stringify(data) as application/json, and
    // getRestObject returns response.json().
    const webPut = (key: string, data: unknown) => fetch(storeUrl('WebApp', key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const webGet = async (key: string) => {
        const response = await fetch(storeUrl('WebApp', key), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
        return { status: response.status, value: response.status >= 400 ? null : await response.json() as unknown };
    };

    const VALUES: [string, unknown][] = [
        [ 'an integer', 42 ],
        [ 'zero', 0 ],
        [ 'a float', 1.5 ],
        [ 'a string', 'text' ],
        [ 'an empty string', '' ],
        [ 'true', true ],
        [ 'false', false ],
        [ 'null', null ],
        [ 'an array', [ 1, 'two', { three: 3 } ] ],
        [ 'an object', { Id: 1234, Name: 'Charly Sharp', nested: { list: [ 1, 2 ] } } ],
    ];

    describe('stores any JSON value', () => {
        it.each(VALUES)('round-trips %s as Unity sends it', async (_, value) => {
            const json = JSON.stringify(value);

            const put = await unityPut('value', json);
            expect(put.status).toBe(201);
            expect(await put.json()).toMatchObject({ data: value });

            // Byte for byte the JSON text Unity sent, which is what JsonConvert parses.
            await expect(unityGet('value')).resolves.toEqual({ status: 200, text: json });
        });

        it.each(VALUES)('round-trips %s as the web client sends it', async (_, value) => {
            expect((await webPut('value', value)).status).toBe(201);
            await expect(webGet('value')).resolves.toEqual({ status: 200, value });

            // Overwriting an existing value, even a falsy one, is an update.
            expect((await webPut('value', value)).status).toBe(200);
            await expect(webGet('value')).resolves.toEqual({ status: 200, value });
        });
    });

    describe('body size', () => {
        // A JSON string literal whose encoded body is exactly `length` bytes.
        const jsonStringOfLength = (length: number) => JSON.stringify('x'.repeat(length - 2));

        it('accepts a body of exactly the TCP frame limit (5 MiB), and returns it unchanged', async () => {
            const json = jsonStringOfLength(MAX_FRAME_LENGTH);
            expect(Buffer.byteLength(json)).toBe(5 * 1024 * 1024);

            expect((await unityPut('large', json)).status).toBe(201);
            const got = await unityGet('large');
            expect(got.status).toBe(200);
            expect(got.text).toBe(json);
        });

        it('refuses a body over the limit with 413, and keeps serving', async () => {
            const response = await unityPut('huge', jsonStringOfLength(MAX_FRAME_LENGTH + 1));
            expect(response.status).toBe(413);

            await expect(unityGet('huge')).resolves.toMatchObject({ status: 404 });
            expect((await unityPut('small', '1')).status).toBe(201);
        });
    });

    // Express's default error handler wrote the stack trace, with absolute paths into the
    // install, into the response whenever NODE_ENV wasn't "production" - as in the image.
    describe('error responses', () => {
        const expectNoInternals = (text: string) => {
            expect(text).not.toMatch(/\n\s+at /);
            expect(text).not.toContain(webRoot);
            expect(text).not.toContain(process.cwd());
            expect(text).not.toContain('node_modules');
        };

        const read = async (response: Response) => {
            const text = await response.text();
            expect(response.headers.get('content-type')).toMatch(/^application\/json/);
            return { status: response.status, text, body: JSON.parse(text) as unknown };
        };

        it('answers an error thrown by a route with a generic JSON 500, and logs it', async () => {
            const { status, text, body } = await read(await fetch(`${baseUrl}/api/fails`));

            expect(status).toBe(500);
            expect(body).toEqual({ error: 'Internal server error' });
            expect(text).not.toContain('secret detail');
            expectNoInternals(text);

            const logged = logs.filter(l => l.origin === 'WebServer' && l.level === LogLevel.Error);
            expect(logged).toHaveLength(1);
            expect(logged[0]!.message).toContain('GET /api/fails');
            expect(logged[0]!.message).toContain('secret detail');
        });

        it('keeps the status of a client error, with only the message meant for the client', async () => {
            const malformed = await read(await fetch(storeUrl('UnityApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: '{not json',
            }));
            expect(malformed.status).toBe(400);
            expect(malformed.body).toEqual({ error: expect.stringMatching(/JSON/) });
            expectNoInternals(malformed.text);

            const tooLarge = await read(await fetch(storeUrl('UnityApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify('x'.repeat(MAX_FRAME_LENGTH)),
            }));
            expect(tooLarge.status).toBe(413);
            expect(tooLarge.body).toEqual({ error: 'request entity too large' });

            const undecodable = await read(await fetch(`${baseUrl}/api/store/%E0%A4%A/x`));
            expect(undecodable.status).toBe(400);
            expectNoInternals(undecodable.text);

            expect(logs.filter(l => l.origin === 'WebServer' && l.level === LogLevel.Warn)).toHaveLength(3);
        });

        // A browser only lets a web client read a cross-origin response that carries
        // Access-Control-Allow-Origin. Without it, setRestObject's fetch rejects with a bare
        // network error instead of resolving to false on the 413.
        it('carries the CORS headers, even for a body the parser refuses', async () => {
            const origin = 'http://student-laptop.local:5173';

            const tooLarge = await fetch(storeUrl('WebApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Origin': origin },
                body: JSON.stringify('x'.repeat(MAX_FRAME_LENGTH)),
            });
            expect(tooLarge.status).toBe(413);
            expect(tooLarge.headers.get('access-control-allow-origin')).toBe('*');

            const malformed = await fetch(storeUrl('WebApp', 'x'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Origin': origin },
                body: '{not json',
            });
            expect(malformed.status).toBe(400);
            expect(malformed.headers.get('access-control-allow-origin')).toBe('*');

            const failed = await fetch(`${baseUrl}/api/fails`, { headers: { 'Origin': origin } });
            expect(failed.status).toBe(500);
            expect(failed.headers.get('access-control-allow-origin')).toBe('*');
        });

        it('does not name the path on disk when the admin UI files are missing', async () => {
            await rm(path.join(webRoot, 'index.html'));

            const { status, text, body } = await read(await fetch(`${baseUrl}/log`));

            expect(status).toBe(404);
            expect(body).toEqual({ error: 'Not Found' });
            expectNoInternals(text);
        });
    });
});

describe('WebServer startup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The constructor used to console.log 'Web server listening on ...' before listen() had
    // even been called, and start() then logged the same line once it was true - which the
    // console sink prints as well. Every start printed it twice, the first time too early.
    it('says it is listening exactly once, and only once it is', async () => {
        const printed: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        // The sink main.ts attaches, writing here instead of to stdout/stderr.
        const sink = new ConsoleLog({ minLevel: LogLevel.Debug, broadcastTraffic: false }, {
            out: line => printed.push(line),
            err: line => printed.push(line),
        });
        const subscription = sink.attach(Service.output$);
        const listening = () => printed.filter(line => line.includes('Web server listening on'));

        const webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-startup-'));
        const webServer = new WebServer('127.0.0.1', 0, webRoot, '');
        try {
            expect(listening()).toEqual([]);

            const httpServer = webServer.start();
            await once(httpServer, 'listening');

            expect(listening()).toHaveLength(1);
            expect(listening()[0]).toMatch(/ INFO {2}\[web\/WebServer\] Web server listening on 127\.0\.0\.1:/);
        } finally {
            subscription.unsubscribe();
            webServer.stop();
            await rm(webRoot, { recursive: true, force: true });
        }
    });
});
