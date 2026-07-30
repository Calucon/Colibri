import { Service } from '../core/index.js';
import { WebServer } from './web-server.js';
import { Router } from 'express';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import * as path from 'path';

const STORE_FILENAME = 'store.json';
const SAVE_DEBOUNCE_MILLIS = 250;

export class RestAPI extends Service {
    public serviceName = 'RestAPI';
    public groupName = 'web';

    private data: { [key: string]: { [key: string]: unknown } } = {};
    private readonly storeFilePath: string;
    private readonly storeTempFilePath: string;

    private saveTimeout: NodeJS.Timeout | undefined;
    private savePromise: Promise<void> = Promise.resolve();

    public constructor(dataPath: string, webserver: WebServer) {
        super();

        this.storeFilePath = path.join(dataPath, STORE_FILENAME);
        this.storeTempFilePath = `${this.storeFilePath}.tmp`;

        webserver.addApi('/store', Router()
            .get('/', (req, res) => {
                // Return all available apps
                const keys = Object.keys(this.data);
                res.status(200).json(keys);
            })
            .get('/:app', (req, res) => {
                const app = this.data[req.params.app];
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    // Return all available values of the app
                    const keys = Object.keys(app);
                    res.status(200).json(keys);
                }
            })
            .get('/:app/:value', (req, res) => {
                const app = this.data[req.params.app];
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    const value = app[req.params.value];
                    // If value not exist return an error
                    if (value === undefined) {
                        res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
                    } else {
                        // Return data of value
                        res.status(200).json(value);
                    }
                }
            })
            .put('/:app/:value', (req, res) => {
                let statusCode = 200;
                // If app name not exist create app name
                let app = this.data[req.params.app];
                if (!app) {
                    app = this.data[req.params.app] = {};
                    statusCode = 201;
                } else if (!app[req.params.value]) {
                    statusCode = 201;
                }
                // Set data to the corresponding value
                app[req.params.value] = req.body;
                // Return successful result with the sended data
                res.status(statusCode).json({ result: 'Value with name ' + req.params.value + ' saved successfully', data: app[req.params.value] });
                // Save data in data store file
                this.scheduleSave();
            })
            .delete('/:app', (req, res) => {
                const app = this.data[req.params.app];
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    // Delete the app
                    delete this.data[req.params.app];
                    // Return successful result
                    res.status(200).json({ result: 'App with name ' + req.params.app + ' deleted successfully' });
                    // Save data in data store file
                    this.scheduleSave();
                }
            })
            .delete('/:app/:value', (req, res) => {
                const app = this.data[req.params.app];
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    const value = app[req.params.value];
                    // If value not exist return an error
                    if (value === undefined) {
                        res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
                    } else {
                        // Delete the value
                        delete app[req.params.value];
                        // Return successful result
                        res.status(200).json({ result: 'Value with name ' + req.params.value + ' deleted successfully' });
                        // Save data in data store file
                        this.scheduleSave();
                    }
                }
            }));
    }

    // Runs before the web server starts serving requests, so a request can never observe
    // the empty default `data` instead of what was actually persisted.
    public override async init(): Promise<void> {
        try {
            const raw = await readFile(this.storeFilePath, 'utf8');
            this.data = this.parseStore(raw);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logError(err instanceof Error ? err.message : String(err), false);
            }
        }
    }

    // The routes below assume `data` is an object of objects. A store file that parses to
    // null, an array, or a scalar (hand-edited, truncated by an older version, restored
    // from the wrong place) would otherwise make every GET throw instead of 404.
    private parseStore(raw: string): { [key: string]: { [key: string]: unknown } } {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this.logError(`Ignoring ${STORE_FILENAME}: expected a JSON object at the top level`, false);
            return {};
        }

        const store: { [key: string]: { [key: string]: unknown } } = {};
        for (const [app, values] of Object.entries(parsed)) {
            if (values === null || typeof values !== 'object' || Array.isArray(values)) {
                this.logError(`Ignoring app '${app}' in ${STORE_FILENAME}: expected an object of values`, false);
                continue;
            }
            store[app] = values as { [key: string]: unknown };
        }
        return store;
    }

    // Cancels any pending debounce and writes the current data immediately - used at
    // shutdown so the last update before the process exits isn't lost to an unflushed timer.
    public async flush(): Promise<void> {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = undefined;
        }
        await this.savePromise;
        this.savePromise = this.writeStoreFile();
        await this.savePromise;
    }

    // A burst of PUT/DELETE calls (e.g. many models saved in a loop) coalesces into a
    // single write instead of one fs write per request.
    private scheduleSave(): void {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = undefined;
            // Chained onto whatever write is still in flight rather than started alongside
            // it: two concurrent writeStoreFile() calls share one store.json.tmp, and
            // interleaved writes followed by two renames can publish a partial file -
            // defeating the whole point of the temp-file-then-rename swap.
            this.savePromise = this.savePromise.then(() => this.writeStoreFile());
        }, SAVE_DEBOUNCE_MILLIS);
    }

    // Write to a temp file, then rename over the real one - a crash mid-write can never
    // truncate store.json, since the rename only ever swaps in a fully-written file.
    private async writeStoreFile(): Promise<void> {
        try {
            await mkdir(path.dirname(this.storeFilePath), { recursive: true });
            await writeFile(this.storeTempFilePath, JSON.stringify(this.data), 'utf8');
            await rename(this.storeTempFilePath, this.storeFilePath);
        } catch (err) {
            this.logError(err instanceof Error ? err.message : String(err), false);
        }
    }
}
