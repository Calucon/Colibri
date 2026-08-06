import { Subject } from 'rxjs';
import { Socket, connect } from 'socket.io-client';
import { ColibriError, ProtocolMismatchError } from './ColibriError';

/**
 * The wire protocol this client speaks, announced in the Socket.IO handshake query. Must
 * match `PROTOCOL_VERSION` in the server's `src/server/modules/networking/protocol.ts`; a
 * server speaking anything else refuses the connection rather than downgrading.
 */
export const PROTOCOL_VERSION = '2';

const COLIBRI_CHANNEL = 'colibri';
const PROTOCOL_REJECTED_COMMAND = 'protocol::rejected';

interface ProtocolRejection {
    reason?: string;
    serverVersion?: string;
    clientVersion?: string;
}

// `window` is declared globally as non-optional by the "dom" lib, but colibri-web
// also runs under plain Node (samples, e2e); shadow it here so the type reflects
// that it's genuinely absent outside a browser.
declare const window: Window | undefined;

export interface Message {
    channel: string;
    command: string;
    payload: unknown;
}

export class Colibri {
    private static instance: Colibri | null = null;

    private readonly socket: Socket;
    private readonly messageSubject = new Subject<Message>();
    public readonly messages = this.messageSubject.asObservable();
    private readonly protocolMismatchSubject = new Subject<ProtocolMismatchError>();
    /**
     * Emits once if the server refuses this client over a protocol version mismatch. The
     * connection is dead at that point and will not be retried, so this is the only
     * notification an application gets; without subscribing, the error is still logged.
     */
    public readonly protocolMismatch = this.protocolMismatchSubject.asObservable();
    public readonly uri: string;
    public readonly uriRestApi: string;

    public constructor(
        public readonly app: string,
        public readonly server: string = window?.location.hostname ?? '',
        public readonly port: number = 9011
    ) {
        if (server.trim().length <= 0) {
            throw new ColibriError('Server Address missing or empty!');
        }

        if (port < 1 || port > 65535) {
            throw new ColibriError('Port out of allowed range (0 - 65535)');
        }

        this.uri = `${server}:${port}`;
        if (!new RegExp('wss?://', 'i').test(this.uri)) {
            this.uri = `ws://${this.uri}`;
        }
        // replace ws(s) with http(s) for the REST API
        this.uriRestApi = `${this.uri.replace(/^ws/i, 'http')}/api/store/${app}/`;

        // there is already an instance running
        if (Colibri.instance) throw new ColibriError('A Colibri instance already exists!');
        else Colibri.instance = this;

        this.socket = connect(this.uri, {
            query: { app, version: PROTOCOL_VERSION },
            transports: ['websocket']
        });
        this.socket.on('connect', this.onSocketConnect.bind(this));
        this.socket.onAny(this.onSocketAny.bind(this));

        // latency statistics
        this.registerChannel('colibri', msg => {
            if (msg.command === 'latency') {
                SendMessage('colibri', 'latency', msg.payload);
            }
        });
    }

    private onSocketConnect() {
        console.debug(`Connected to colibri server on ${this.server}`);
    }

    private onSocketAny(channel: string, msg: unknown) {
        const { command, payload } = msg as Pick<Message, 'command' | 'payload'>;

        if (channel === COLIBRI_CHANNEL && command === PROTOCOL_REJECTED_COMMAND) {
            this.onProtocolRejected(payload as ProtocolRejection | undefined);
            return;
        }

        this.messageSubject.next({ channel, command, payload });
    }

    // Kept off `messages` deliberately: this is Colibri's own plumbing, and surfacing it as
    // an ordinary message would leave every application to recognize it for itself.
    // Typed optional on purpose: the rejection comes off the wire, so a server that sends a
    // bare `protocol::rejected` with no body must still produce a usable error rather than a
    // TypeError that hides the real problem.
    private onProtocolRejected(rejection: ProtocolRejection | undefined) {
        // A mismatch cannot resolve itself, so retrying only produces a reconnect loop that
        // buries the one log line explaining what is wrong.
        this.socket.io.reconnection(false);
        this.socket.disconnect();

        const serverVersion = rejection?.serverVersion ?? 'unknown';
        const error = new ProtocolMismatchError(
            rejection?.reason ??
                `Server refused the connection: it speaks protocol v${serverVersion}, this client speaks v${PROTOCOL_VERSION}.`,
            serverVersion,
            rejection?.clientVersion ?? PROTOCOL_VERSION
        );

        console.error(
            `Colibri: ${error.message} Update colibri-web and colibri-server to matching versions. Not reconnecting.`
        );
        this.protocolMismatchSubject.next(error);
    }

    /**
     * Returns the existing Colibri instance or null if there's none yet
     * @param warnIfNotInitialized true => print Log message if Colibri has not been initialized yet
     * @returns
     */
    public static getInstance(warnIfNotInitialized: boolean = true): Colibri | null {
        if (warnIfNotInitialized && !Colibri.instance) {
            console.warn('Colibri not initialized yet! (Instance is null)');
        }
        return Colibri.instance;
    }

    /**
     * Sends a single message in the given `channel`.
     * @param channel message channel
     * @param command message command
     * @param payload message payload
     */
    public sendMessage(channel: string, command: string, payload: unknown = {}) {
        this.socket.emit(channel, {
            command,
            payload
        });
    }

    // #region Socket Events
    /**
     * Adds a `handler` function listening for messages in `channel`.
     * @param channel message channel
     * @param handler handler to be executed when a message is received
     */
    public registerChannel(channel: string, handler: (payload: Message) => void) {
        this.socket.on(channel, handler);
    }

    /**
     * Removes the `handler` function listening for messages in `channel`.
     * @param channel message channel
     * @param handler handler to be executed when a message is received
     */
    public unregisterChannel(channel: string, handler: (payload: Message) => void) {
        this.socket.off(channel, handler);
    }

    /**
     * Adds a one-time `handler` function listening for the next message in `channel`.
     * @param channel message channel
     * @param handler handler to be executed when a message is received
     */
    public registerOnce(channel: string, handler: (payload: Message) => void) {
        this.socket.once(channel, handler);
    }
    // #endregion

    // #region Rest API
    /**
     * Returns the REST API Endpoint for a given `key` or null of the key is empty.
     * @param key REST API storage key
     * @returns
     */
    public getRestUri(key: string): string | null {
        key = key.trim();
        while (key.startsWith('/')) key = key.substring(1);
        return key.length === 0 ? null : this.uriRestApi + key;
    }

    /**
     * Queries an object from the REST API identified by `key`.
     * @param key REST API storage key
     * @returns JSON object with data or null if object does not exist or any other error occurs
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public async getRestObject(key: string): Promise<any> {
        const uri = this.getRestUri(key);
        if (!uri) return null;

        const response = await fetch(uri, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (response.status >= 400) return null;
        else return response.json();
    }

    /**
     * Sets or updates an object in the REST API identified by `key`.
     * @param key REST API storage key
     * @param data JSON data to write
     * @returns true if data was written to REST API
     */
    public async setRestObject(key: string, data: unknown): Promise<boolean> {
        const uri = this.getRestUri(key);
        if (!uri) return false;

        const response = await fetch(uri, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        return response.status >= 200 && response.status < 300;
    }
    // #endregion
}

/////////////////////////////////////
///     Wrapper Functions
// (also for backward compatibility)
/////////////////////////////////////

/**
 * @see {@link Colibri.sendMessage `Colibri.sendMessage()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const SendMessage = (channel: string, command: string, payload: unknown = {}) =>
    Colibri.getInstance()?.sendMessage(channel, command, payload);

/**
 * @see {@link Colibri.registerChannel `Colibri.registerChannel()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const RegisterChannel = (channel: string, handler: (payload: Message) => void) =>
    Colibri.getInstance()?.registerChannel(channel, handler);

/**
 * @see {@link Colibri.unregisterChannel `Colibri.unregisterChannel()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const UnregisterChannel = (channel: string, handler: (payload: Message) => void) =>
    Colibri.getInstance()?.unregisterChannel(channel, handler);

/**
 * @see {@link Colibri.registerOnce `Colibri.registerOnce()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const RegisterOnce = (channel: string, handler: (payload: Message) => void) =>
    Colibri.getInstance()?.registerOnce(channel, handler);

/**
 * @see {@link Colibri.getRestObject `Colibri.getRestObject()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const GetRestApi = (key: string) => Colibri.getInstance()?.getRestObject(key);

/**
 * @see {@link Colibri.setRestObject `Colibri.setRestObject()`}
 * @returns undefined if {@link Colibri `Colibri`} has not been initialized yet
 */
export const PutRestApi = (key: string, data: unknown) => Colibri.getInstance()?.setRestObject(key, data);
