import { TCP_SERVER_WORKER, WireNetworkMessage } from './tcp-server-worker.js';
import { Payload, WorkerServiceProxy } from '../core/index.js';
import { Observable, Subject } from 'rxjs';
import { NetworkClient, NetworkMessage, NetworkServer } from '../command-hooks/index.js';

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

export class TCPServerProxy
    extends WorkerServiceProxy
    implements NetworkServer {
    public serviceName = 'UnityServer';
    public groupName = 'unity';

    private readonly clients = new Map<string, NetworkClient>();
    private clientStream = new Subject<ReadonlyArray<NetworkClient>>();
    private clientAddedStream = new Subject<NetworkClient>();
    private clientRemovedStream = new Subject<NetworkClient>();

    private messageStream = new Subject<NetworkMessage>();

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
        this.initWorker(TCP_SERVER_WORKER);

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
                        payload: Payload.fromString(toBuffer(wireMessage.payload).toString('utf8')),
                        origin: wireMessage.origin ? this.clients.get(wireMessage.origin.id) : undefined,
                    });
                    break;
                }
            }
        });
    }

    public start(port: number, host: string): void {
        this.postMessage('m:start', { port: port, host: host });
        this.clientStream.next(this.currentClients);
    }

    public stop(): void {
        this.postMessage('m:stop');
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
        this.postMessage('m:broadcastToApp', {
            msg: this.toWireMessage(msg),
            app,
            exclude: exceptClientId,
        });
    }

    private toWireMessage(msg: NetworkMessage): { channel: string; command: string; payload: Buffer } {
        return {
            channel: msg.channel,
            command: msg.command,
            payload: Buffer.from(msg.payload?.asString() ?? '', 'utf8'),
        };
    }

    private onClientConnected(client: NetworkClient): void {
        this.clients.set(client.id, client);

        this.clientAddedStream.next(client);
        this.clientStream.next(this.currentClients);
    }

    private onClientDisconnected(id: string): void {
        const client = this.clients.get(id);
        this.clients.delete(id);

        if (client) {
            this.clientRemovedStream.next(client);
        }
        this.clientStream.next(this.currentClients);
    }

    private onClientMessage(msg: NetworkMessage): void {
        this.messageStream.next(msg);
    }
}
