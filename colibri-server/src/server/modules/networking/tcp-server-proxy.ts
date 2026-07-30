import { TCP_SERVER_WORKER, TCP_SERVER_WORKER_ROLE, WireNetworkMessage } from './tcp-server-worker.js';
import { Payload, WorkerServiceProxy } from '../core/index.js';
import { Observable, Subject } from 'rxjs';
import { NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks/index.js';

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

// Bounded so a worker that dies immediately on start (a port already in use, say) reports
// the problem instead of respawning forever. Reset once a client actually connects, which
// is proof the restarted transport works.
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MILLIS = 1000;

export class TCPServerProxy
    extends WorkerServiceProxy
    implements NetworkServer {
    public serviceName = 'UnityServer';
    public groupName = 'unity';

    private readonly clients = new Map<string, NetworkClient>();
    // Mirrors the worker's own clientsByApp index on this side of the postMessage
    // boundary, purely so broadcastToApp can answer "is there any TCP client in this app?"
    // without paying asBytes() and a structured clone to find out the answer is no.
    private readonly clientIdsByApp = new Map<string, Set<string>>();
    private clientStream = new Subject<ReadonlyArray<NetworkClient>>();
    private clientAddedStream = new Subject<NetworkClient>();
    private clientRemovedStream = new Subject<NetworkClient>();

    private messageStream = new Subject<NetworkMessage>();

    private startOptions: { port: number; host: string } | undefined;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | undefined;

    public get clients$(): Observable<ReadonlyArray<NetworkClient>> {
        return this.clientStream.asObservable();
    }
    public get currentClients(): ReadonlyArray<NetworkClient> {
        return Array.from(this.clients.values());
    }
    public get clientConnected$(): Observable<NetworkClient> {
        return this.clientAddedStream.asObservable();
    }
    public get clientDisconnected$(): Observable<NetworkClient> {
        return this.clientRemovedStream.asObservable();
    }
    public get messages$(): Observable<NetworkMessage> {
        return this.messageStream.asObservable();
    }

    public constructor() {
        super();
        this.initWorker(TCP_SERVER_WORKER, { role: TCP_SERVER_WORKER_ROLE });

        this.workerMessages$.subscribe((msg) => {
            switch (msg.channel) {
                case 'clientConnected$':
                    this.onClientConnected({
                        id: msg.content.id as string,
                        app: msg.content.app as string,
                        name: msg.content.name as string,
                        version: msg.content.version as string,
                        metadata: {},
                    });
                    break;

                case 'clientDisconnected$':
                    this.onClientDisconnected(msg.content.id as string);
                    break;

                case 'clientMessage$': {
                    const wireMessage = msg.content as unknown as WireNetworkMessage;
                    this.onClientMessage({
                        channel: wireMessage.channel,
                        command: wireMessage.command,
                        payload: Payload.fromBytes(toBuffer(wireMessage.payload)),
                        origin: wireMessage.origin ? this.clients.get(wireMessage.origin.id) : undefined,
                    });
                    break;
                }
            }
        });
    }

    public start(port: number, host: string): void {
        this.startOptions = { port, host };
        this.postMessage('m:start', { port: port, host: host });
        this.clientStream.next(this.currentClients);
    }

    public async stop(): Promise<void> {
        // Cleared first so a worker exit triggered by the terminate below isn't mistaken
        // for a crash and restarted underneath the shutdown.
        this.startOptions = undefined;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }

        this.postMessage('m:stop');
        await this.terminateWorker();
    }

    // The TCP transport is the whole reason this process exists for Unity clients, so a
    // worker that dies must not leave a half-alive server: HTTP and Socket.IO would keep
    // answering normally while every TCP client is gone and every postMessage to the dead
    // thread is silently discarded.
    protected override onWorkerExited(): void {
        // The thread took every connection with it. Report the disconnects so nothing
        // downstream (ModelSynchronization, the admin UI client list) keeps a stale client.
        for (const client of Array.from(this.clients.values())) {
            this.clients.delete(client.id);
            this.removeFromAppIndex(client);
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.currentClients);

        // No startOptions means we were never started, or are being shut down on purpose.
        const options = this.startOptions;
        if (!options) return;

        if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
            this.logError(
                `TCP server worker exited ${this.restartAttempts} times; not restarting again`,
                false
            );
            return;
        }

        this.restartAttempts += 1;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.logWarning(`Restarting the TCP server worker (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
            if (this.restartWorker()) {
                this.postMessage('m:start', { port: options.port, host: options.host });
            }
        }, RESTART_DELAY_MILLIS);
    }

    public broadcast(
        msg: NetworkMessage,
        clients: ReadonlyArray<NetworkClient> = this.currentClients
    ): void {
        this.postMessage('m:broadcast', {
            msg: this.toWireMessage(msg),
            clients: clients.map((c) => c.id),
        });
    }

    // Fast path for "broadcast to every client of one app": rather than shipping a
    // per-client id array across the worker boundary (structured-clone cost scales with
    // client count), the worker resolves recipients from its own per-app index.
    public broadcastToApp(msg: NetworkMessage, app: string, exceptClientId?: string): void {
        // A web-only deployment (or any app whose clients are all web clients, which
        // always includes 'colibri') would otherwise pay a full JSON.stringify plus a
        // structured clone into the worker on every broadcast, only for the worker to
        // resolve an empty recipient set and return.
        if (!this.hasRecipients(app, exceptClientId)) return;

        this.postMessage('m:broadcastToApp', {
            msg: this.toWireMessage(msg),
            app,
            exclude: exceptClientId,
        });
    }

    public hasRecipients(app: string, exceptClientId?: string): boolean {
        const ids = this.clientIdsByApp.get(app);
        if (!ids || ids.size === 0) return false;
        if (exceptClientId !== undefined && ids.size === 1 && ids.has(exceptClientId)) return false;
        return true;
    }

    private toWireMessage(msg: NetworkMessage): { channel: string; command: string; payload: Buffer } {
        return {
            channel: msg.channel,
            command: msg.command,
            payload: msg.payload?.asBytes() ?? Buffer.alloc(0),
        };
    }

    private onClientConnected(client: NetworkClient): void {
        // A client completing a handshake proves the (possibly restarted) worker is
        // healthy, so the restart budget starts over from here.
        this.restartAttempts = 0;
        this.clients.set(client.id, client);
        this.addToAppIndex(client);

        this.clientAddedStream.next(client);
        this.clientStream.next(this.currentClients);
    }

    private onClientDisconnected(id: string): void {
        const client = this.clients.get(id);
        this.clients.delete(id);

        if (client) {
            this.removeFromAppIndex(client);
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.currentClients);
    }

    private addToAppIndex(client: NetworkClient): void {
        let ids = this.clientIdsByApp.get(client.app);
        if (!ids) {
            ids = new Set();
            this.clientIdsByApp.set(client.app, ids);
        }
        ids.add(client.id);
    }

    private removeFromAppIndex(client: NetworkClient): void {
        const ids = this.clientIdsByApp.get(client.app);
        if (!ids) return;

        ids.delete(client.id);
        if (ids.size === 0) {
            this.clientIdsByApp.delete(client.app);
        }
    }

    private onClientMessage(msg: NetworkMessage): void {
        this.messageStream.next(msg);
    }
}
