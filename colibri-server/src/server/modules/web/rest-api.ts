import { Service } from '../core/index.js';
import { WebServer } from './web-server.js';
import { Router } from 'express';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import * as path from 'path';

const STORE_FILENAME = 'store.json';
const SAVE_DEBOUNCE_MILLIS = 250;

// App name -> value name -> value, both names straight from the URL. Maps rather than plain
// objects: `this.data[req.params.app]` resolved any name that is also an Object.prototype
// member to that member, so DELETE /api/store/constructor/keys deleted Object.keys from the
// whole process (every later request answered 500 until a restart) and
// PUT /api/store/__proto__/x wrote onto Object.prototype. A Map has no inherited keys, so
// '__proto__', 'constructor' and the like are ordinary names.
type StoreData = Map<string, Map<string, unknown>>;

export class RestAPI extends Service {
    public serviceName = 'RestAPI';
    public groupName = 'web';

    private data: StoreData = new Map();
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
                const keys = Array.from(this.data.keys());
                res.status(200).json(keys);
            })
            .get('/:app', (req, res) => {
                const app = this.data.get(req.params.app);
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    // Return all available values of the app
                    const keys = Array.from(app.keys());
                    res.status(200).json(keys);
                }
            })
            .get('/:app/:value', (req, res) => {
                const app = this.data.get(req.params.app);
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    const value = app.get(req.params.value);
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
                let app = this.data.get(req.params.app);
                if (!app) {
                    app = new Map();
                    this.data.set(req.params.app, app);
                    statusCode = 201;
                } else if (!app.has(req.params.value)) {
                    statusCode = 201;
                }
                // Set data to the corresponding value
                app.set(req.params.value, req.body);
                // Return successful result with the sended data
                res.status(statusCode).json({ result: 'Value with name ' + req.params.value + ' saved successfully', data: req.body });
                // Save data in data store file
                this.scheduleSave();
            })
            .delete('/:app', (req, res) => {
                const app = this.data.get(req.params.app);
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    // Delete the app
                    this.data.delete(req.params.app);
                    // Return successful result
                    res.status(200).json({ result: 'App with name ' + req.params.app + ' deleted successfully' });
                    // Save data in data store file
                    this.scheduleSave();
                }
            })
            .delete('/:app/:value', (req, res) => {
                const app = this.data.get(req.params.app);
                // If app not exist return an error
                if (!app) {
                    res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
                } else {
                    const value = app.get(req.params.value);
                    // If value not exist return an error
                    if (value === undefined) {
                        res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
                    } else {
                        // Delete the value
                        app.delete(req.params.value);
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

    // store.json is an object of objects. A store file that parses to null, an array, or a
    // scalar (hand-edited, truncated by an older version, restored from the wrong place) is
    // ignored instead of becoming a store the routes can't serve. JSON.parse defines every
    // key as an own property, '__proto__' included, so Object.entries sees all of them.
    private parseStore(raw: string): StoreData {
        const parsed: unknown = JSON.parse(raw);
        const store: StoreData = new Map();
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this.logError(`Ignoring ${STORE_FILENAME}: expected a JSON object at the top level`, false);
            return store;
        }

        for (const [app, values] of Object.entries(parsed)) {
            if (values === null || typeof values !== 'object' || Array.isArray(values)) {
                this.logError(`Ignoring app '${app}' in ${STORE_FILENAME}: expected an object of values`, false);
                continue;
            }
            store.set(app, new Map(Object.entries(values)));
        }
        return store;
    }

    // The inverse of parseStore, in the `{ app: { value: ... } }` shape store.json has always
    // had. Object.fromEntries defines own properties (it never runs the __proto__ setter), so
    // even a name like '__proto__' is written out as an ordinary key.
    private serializeStore(): string {
        return JSON.stringify(Object.fromEntries(
            Array.from(this.data, ([app, values]) => [app, Object.fromEntries(values)])
        ));
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
            await writeFile(this.storeTempFilePath, this.serializeStore(), 'utf8');
            await rename(this.storeTempFilePath, this.storeFilePath);
        } catch (err) {
            this.logError(err instanceof Error ? err.message : String(err), false);
        }
    }
}
