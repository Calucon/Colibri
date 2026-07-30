import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Router, Request, RequestHandler, Response } from 'express';
import { RestAPI } from '../../src/server/modules/web/rest-api.js';
import type { WebServer } from '../../src/server/modules/web/web-server.js';

const SAVE_DEBOUNCE_MILLIS = 250;

// Captures the router RestAPI registers, so the routes can be driven without binding a port.
class FakeWebServer {
    public router: Router | undefined;

    public addApi(url: string, handler: RequestHandler | Router): void {
        expect(url).toBe('/store');
        this.router = handler as Router;
    }

    public asWebServer(): WebServer {
        return this as unknown as WebServer;
    }
}

interface Result {
    status: number;
    body: unknown;
}

const call = function (router: Router, method: string, url: string, body?: unknown): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
        const req = { method, url, body, headers: {} } as unknown as Request;

        let status = 200;
        const res = {
            status(code: number) {
                status = code;
                return this;
            },
            json(payload: unknown) {
                resolve({ status, body: payload });
                return this;
            },
        } as unknown as Response;

        router(req, res, (err?: unknown) => {
            if (err) reject(err);
            else resolve({ status: 404, body: undefined });
        });
    });
};

describe('RestAPI', () => {
    let dataPath: string;
    let storePath: string;
    let webserver: FakeWebServer;
    let api: RestAPI;

    const put = (url: string, body: unknown) => call(webserver.router!, 'PUT', url, body);
    const get = (url: string) => call(webserver.router!, 'GET', url);
    const del = (url: string) => call(webserver.router!, 'DELETE', url);

    const readStore = async (): Promise<unknown> => JSON.parse(await readFile(storePath, 'utf8'));

    beforeEach(async () => {
        dataPath = await mkdtemp(path.join(tmpdir(), 'colibri-rest-api-'));
        storePath = path.join(dataPath, 'store.json');
        webserver = new FakeWebServer();
        api = new RestAPI(dataPath, webserver.asWebServer());
    });

    afterEach(async () => {
        vi.useRealTimers();
        await rm(dataPath, { recursive: true, force: true });
    });

    // Item 27: the store used to be read lazily, so a request arriving before the read
    // finished saw the empty default.
    describe('init', () => {
        it('loads a persisted store before any request is served', async () => {
            await writeFile(storePath, JSON.stringify({ appA: { key: 'value' } }), 'utf8');
            await api.init();

            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: 'value' });
        });

        it('starts empty when there is no store file', async () => {
            await api.init();
            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });

        it('ignores a store file that is not a JSON object', async () => {
            await writeFile(storePath, '[1,2,3]', 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });

        it('ignores individual apps whose value is not an object', async () => {
            await writeFile(storePath, JSON.stringify({ good: { k: 1 }, bad: 42 }), 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: ['good'] });
        });

        it('survives a corrupt store file', async () => {
            await writeFile(storePath, '{not json', 'utf8');
            await api.init();

            await expect(get('/')).resolves.toEqual({ status: 200, body: [] });
        });
    });

    describe('routes', () => {
        beforeEach(async () => {
            await api.init();
        });

        it('creates an app and value with 201, then returns them', async () => {
            await expect(put('/appA/key', { x: 1 })).resolves.toMatchObject({ status: 201 });
            await expect(put('/appA/key', { x: 2 })).resolves.toMatchObject({ status: 200 });

            await expect(get('/')).resolves.toEqual({ status: 200, body: ['appA'] });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: ['key'] });
            await expect(get('/appA/key')).resolves.toEqual({ status: 200, body: { x: 2 } });
        });

        it('404s for an unknown app or value', async () => {
            await expect(get('/nope')).resolves.toMatchObject({ status: 404 });
            await expect(get('/nope/key')).resolves.toMatchObject({ status: 404 });

            await put('/appA/key', 1);
            await expect(get('/appA/other')).resolves.toMatchObject({ status: 404 });
        });

        it('deletes a value and then the app', async () => {
            await put('/appA/one', 1);
            await put('/appA/two', 2);

            await expect(del('/appA/one')).resolves.toMatchObject({ status: 200 });
            await expect(get('/appA')).resolves.toEqual({ status: 200, body: ['two'] });

            await expect(del('/appA')).resolves.toMatchObject({ status: 200 });
            await expect(get('/appA')).resolves.toMatchObject({ status: 404 });
            await expect(del('/appA')).resolves.toMatchObject({ status: 404 });
        });
    });

    describe('persistence', () => {
        beforeEach(async () => {
            await api.init();
        });

        // Item 27: a burst of PUTs coalesces into one write instead of one per request.
        it('debounces a burst of writes into a single store file', async () => {
            const internals = api as unknown as { writeStoreFile(): Promise<void> };
            const write = vi.spyOn(internals, 'writeStoreFile');

            await put('/appA/one', 1);
            await put('/appA/two', 2);
            await put('/appA/three', 3);

            expect(write).not.toHaveBeenCalled();
            await expect(readFile(storePath, 'utf8')).rejects.toThrow();

            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 100));

            expect(write).toHaveBeenCalledTimes(1);
            await expect(readStore()).resolves.toEqual({ appA: { one: 1, two: 2, three: 3 } });
        });

        // Two writes must not overlap: they share one store.json.tmp, and interleaved
        // writes followed by two renames can publish a partial file.
        it('never leaves a temp file behind, even across back-to-back debounce windows', async () => {
            await put('/appA/one', 1);
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 50));
            await put('/appA/two', 2);
            await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MILLIS + 50));

            await api.flush();

            await expect(readStore()).resolves.toEqual({ appA: { one: 1, two: 2 } });
            await expect(readFile(`${storePath}.tmp`, 'utf8')).rejects.toThrow();
        });

        // Item 27: shutdown has to cancel the pending debounce and write immediately, or the
        // last update before the process exits is lost with the timer.
        it('flush() writes a pending update without waiting for the debounce', async () => {
            await put('/appA/key', 'value');
            await api.flush();

            await expect(readStore()).resolves.toEqual({ appA: { key: 'value' } });
        });

        it('round-trips through a fresh instance', async () => {
            await put('/appA/key', { nested: [1, 2] });
            await api.flush();

            const second = new FakeWebServer();
            const reloaded = new RestAPI(dataPath, second.asWebServer());
            await reloaded.init();

            await expect(call(second.router!, 'GET', '/appA/key')).resolves.toEqual({
                status: 200,
                body: { nested: [1, 2] },
            });
        });
    });
});
