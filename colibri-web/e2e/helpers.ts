import { firstValueFrom } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';
import { Colibri, type Message } from '../src/Colibri';

export const HOST = process.env.COLIBRI_E2E_SERVER ?? '127.0.0.1';
export const PORT = Number(process.env.COLIBRI_E2E_PORT ?? 9011);

let uniqueCounter = 0;

/**
 * Monotonic, per-process-unique app/key name
 * so parallel test runs never collide server-side state.
 */
export function uniqueApp(prefix: string): string {
    uniqueCounter += 1;
    return `${prefix}-${Date.now()}-${uniqueCounter}`;
}

function resetSingleton(): void {
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
}

function rawSocket(client: Colibri) {
    return (
        client as unknown as {
            socket: {
                connected: boolean;
                disconnect(): void;
                on(event: string, cb: () => void): void;
                once(event: string, cb: () => void): void;
                io: { engine: { close(): void } };
            };
        }
    ).socket;
}

function closeSocket(client: Colibri): void {
    rawSocket(client).disconnect();
}

/**
 * Resolves once `client`'s underlying socket has completed its handshake.
 * Broadcast/model-sync relay is fire-and-forget with no replay for a client
 * that connects late, so every propagation test must await this for both
 * sides before sending the message under test — otherwise the message can
 * reach the server before the recipient has finished connecting and is lost
 * for good.
 */
function waitForConnect(client: Colibri): Promise<void> {
    const socket = rawSocket(client);
    if (socket.connected) return Promise.resolve();
    return new Promise(resolve => {
        socket.once('connect', resolve);
    });
}

/**
 * Cuts `client`'s connection the way a network drop does: underneath Socket.IO rather than through
 * disconnect(), so Socket.IO treats it as lost and reconnects by itself after its usual backoff
 * (0.5-1.5s by default). Resolves once the client has noticed it is disconnected.
 */
export function dropConnection(client: Colibri): Promise<void> {
    const socket = rawSocket(client);
    return new Promise(resolve => {
        socket.once('disconnect', resolve);
        socket.io.engine.close();
    });
}

export function isConnected(client: Colibri): boolean {
    return rawSocket(client).connected;
}

/** Resolves once `client` has failed `count` connection attempts. */
export function connectErrors(client: Colibri, count: number): Promise<void> {
    const socket = rawSocket(client);
    let seen = 0;
    return new Promise(resolve => {
        socket.on('connect_error', () => {
            seen += 1;
            if (seen === count) resolve();
        });
    });
}

const activeClients: Colibri[] = [];

/**
 * Creates a client for `server` and `port` without waiting for it to connect - for an address
 * that is not expected to answer. Disconnected by {@link disconnectAll} like any other.
 */
export function createUnconnectedClient(app: string, server: string, port: number): Colibri {
    resetSingleton();
    const client = new Colibri(app, server, port);
    activeClients.push(client);
    return client;
}

/** Creates a standalone client against the real server, becoming the current singleton. */
export async function createClient(app: string): Promise<Colibri> {
    return connectNew(() => new Colibri(app, HOST, PORT));
}

/**
 * Like {@link createClient}, but connecting to `server` exactly as given, with no port argument -
 * for the address forms a user would paste, which must name this server (and its port) by
 * themselves.
 */
export async function createClientWithAddress(app: string, server: string): Promise<Colibri> {
    return connectNew(() => new Colibri(app, server));
}

async function connectNew(construct: () => Colibri): Promise<Colibri> {
    resetSingleton();
    const client = construct();
    activeClients.push(client);
    await waitForConnect(client);
    return client;
}

/**
 * Creates a raw peer client (constructed first, never the singleton) plus a
 * singleton client (constructed last) on the *same* app — broadcast/model-sync
 * relay is scoped per-app server-side, so the two must share one to talk to
 * each other at all — for exercising the high-level API
 * (Sync/RegisterModelSync/RemoteLogger) which only ever talks through
 * Colibri.getInstance().
 */
export async function createSingletonWithPeer(app: string): Promise<{
    singleton: Colibri;
    peer: Colibri;
}> {
    resetSingleton();
    const peer = new Colibri(app, HOST, PORT);
    activeClients.push(peer);
    await waitForConnect(peer);

    resetSingleton();
    const singleton = new Colibri(app, HOST, PORT);
    activeClients.push(singleton);
    await waitForConnect(singleton);

    return { singleton, peer };
}

/** Disconnects and forgets every client created via this module, and clears the singleton. */
export function disconnectAll(): void {
    let client: Colibri | undefined;
    while ((client = activeClients.pop()) !== undefined) {
        closeSocket(client);
    }
    resetSingleton();
}

/**
 * Resolves with the first inbound message on `channel` (optionally filtered
 * by `command`), or rejects if none arrives within `timeoutMs`.
 */
export function nextMessage(
    client: Colibri,
    match: { channel: string; command?: string },
    timeoutMs = 8000
): Promise<Message> {
    return firstValueFrom(
        client.messages.pipe(
            filter(
                msg => msg.channel === match.channel && (match.command === undefined || msg.command === match.command)
            ),
            timeout(timeoutMs)
        )
    );
}
