import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { once } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
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

    beforeEach(async () => {
        dataPath = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-data-'));
        webRoot = await mkdtemp(path.join(tmpdir(), 'colibri-web-server-root-'));
        await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>Colibri</title>', 'utf8');

        webServer = new WebServer('127.0.0.1', 0, webRoot, '');
        restApi = new RestAPI(dataPath, webServer);
        await restApi.init();

        httpServer = webServer.start();
        await once(httpServer, 'listening');
        baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
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
});
