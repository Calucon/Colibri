import * as http from 'http';
import * as path from 'path';
import express from 'express';
import cors from 'cors';

import { Service } from '../core/index.js';
import { MAX_FRAME_LENGTH } from '../networking/protocol.js';

export class WebServer extends Service {
    public get serviceName(): string {
        return 'WebServer';
    }
    public get groupName(): string {
        return 'web';
    }

    private app: express.Application;
    private server!: http.Server;
    private isRunning = false;

    public constructor(
        private hostname: string,
        private webPort: number,
        private webRoot: string,
        private baseUrl: string
    ) {
        super();

        // Nothing is listening yet: start() logs 'Web server listening on ...' once listen()
        // has succeeded, and the console sink prints that line too.
        this.app = express();
        this.app.set('port', this.webPort);

        // enable CORS - first, so that every response carries the headers, including the
        // errors of the body parsers below: a browser hides a cross-origin response without
        // them, and a web client saw a bare network error instead of the 413 or 400.
        this.app.use(cors());

        // handle POST data
        this.app.use(express.urlencoded({ extended: false }));
        // Any JSON value, not just an object or array: both clients send a bare value as its
        // JSON text (Unity's Store.Put(name, 42) sends `42`, web's setRestObject(key, 'text')
        // sends `"text"`), and the store hands it back the same way. The defaults (strict,
        // 100 kB) answered those with 400 and anything larger with 413, though the same data
        // fits through the TCP transport - hence its frame limit here too.
        this.app.use(express.json({ strict: false, limit: MAX_FRAME_LENGTH }));

        // set up default routes
        this.app.use(this.baseUrl, express.static(path.join(this.webRoot)));
    }

    public start(): http.Server {
        // SPA fallback, added last: the Angular router owns every path that isn't a static
        // asset or an API route (e.g. /log, /statistics), so this fires on every normal page
        // load/refresh, not just on genuine 404s - it must not log, or the log viewer fills up
        // with a spurious entry every time someone opens the very page that's watching it.
        this.app.use(this.baseUrl, (req, res) => {
            res.sendFile(path.join(this.webRoot, 'index.html'));
        });

        // Last, so it handles the errors of every route and middleware above. Express's
        // default handler writes the stack trace, absolute paths into this install included,
        // into the response whenever NODE_ENV isn't "production" - and the Docker image
        // doesn't set it.
        this.app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
            this.handleError(err, req, res, next);
        });

        // lock server so no more route changes are allowed
        this.isRunning = true;

        // start server
        this.server = http.createServer(this.app);
        this.server.listen(this.webPort, this.hostname, () => {
            this.logInfo(
                `Web server listening on ${this.hostname}:${this.webPort}`
            );
        });

        return this.server;
    }

    public stop(): void {
        if (this.isRunning) {
            this.server.close();
            this.isRunning = false;
        }
    }

    private handleError(err: unknown, req: express.Request, res: express.Response, next: express.NextFunction): void {
        // Too late to answer with anything else; express's own handler closes the connection.
        if (res.headersSent) {
            next(err);
            return;
        }

        // Client errors carry a 4xx status: malformed JSON (400) and a body over the limit
        // (413) from body-parser, a missing file (404) from send, an undecodable URL (400)
        // from the router. http-errors' `expose` marks the ones whose message is meant for
        // the client; send's file errors, which name the path on disk, are not, and neither
        // is the router's URIError, so those get the plain status text.
        const { status, statusCode, expose, message } = (err ?? {}) as { status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
        const clientStatus = status ?? statusCode;
        if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
            this.logWarning(`${req.method} ${req.originalUrl} answered ${clientStatus}: ${typeof message === 'string' ? message : String(err)}`);
            res.status(clientStatus).json({
                error: expose === true && typeof message === 'string' ? message : (http.STATUS_CODES[clientStatus] ?? 'Bad request')
            });
            return;
        }

        this.logError(`${req.method} ${req.originalUrl} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, false);
        res.status(500).json({ error: 'Internal server error' });
    }

    public addRoute(
        url: string,
        requestHandler: express.RequestHandler | express.Router
    ): void {
        if (this.isRunning) {
            this.logError(`Could not add route ${url}: Server already running`, false);
        } else {
            this.app.use(url, requestHandler);
        }
    }

    public addApi(
        url: string,
        requestHandler: express.RequestHandler | express.Router
    ): void {
        this.addRoute(
            path.join('/api/', url).replace(/\\/g, '/'),
            requestHandler
        );
    }
}
