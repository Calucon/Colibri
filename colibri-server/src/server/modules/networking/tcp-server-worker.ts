import * as net from 'net';
import { WorkerMessage, WorkerService } from '../core/index.js';
import * as threads from 'worker_threads';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
    COLIBRI_CHANNEL,
    FrameError,
    FrameReader,
    FrameType,
    MAX_FRAME_LENGTH,
    PROTOCOL_REJECTED_COMMAND,
    PROTOCOL_VERSION,
    V1FramingError,
    encodeHeartbeatFrame,
    encodeMessageFrame,
    ownBytes,
    protocolRejection,
} from './protocol.js';
import {
    DEFAULT_RATE_LIMIT,
    DropEpisode,
    InboundBacklog,
    InboundRateLimiter,
    RateLimit,
    describeEpisode,
    isDroppable,
    rateLimitEndWarning,
    rateLimitStartWarning,
} from './inbound-limits.js';

export const TCP_SERVER_WORKER = fileURLToPath(import.meta.url);

// Passed as workerData by TCPServerProxy and checked by the bootstrap at the bottom of this
// file. `!threads.isMainThread` alone was not enough of a guard: any test runner that
// executes its suites inside worker threads (vitest's default pool does) would construct a
// second TCPServerWorker on import and have it subscribe to *that* thread's message
// channel, which is the runner's own RPC.
export const TCP_SERVER_WORKER_ROLE = 'colibri-tcp-server';
const maxBufferSize = MAX_FRAME_LENGTH;

// For a last-write-wins synchronization server, a client whose socket write buffer is
// already this full is not keeping up - queuing yet another update behind it only grows
// process memory without bound (the old `socket.write()`'s return value was ignored
// entirely). Dropping a stale update for a slow client is the correct behaviour here.
const highWaterMark = 1024 * 1024;

// How long a socket this server has ended (a refusal, or a framing error) may stay half-open
// waiting for the peer's FIN before it is destroyed. Ending first rather than destroying is what
// lets the refusal frame reach the client; this bounds what a peer that never closes its side
// can hold on to.
const CLOSE_GRACE_MILLIS = 5000;

// A Colibri 1.x client reconnects about once a second for as long as its app runs, so the
// warning that names it is limited to once per remote address per this interval - often enough
// to be found in the log, rarely enough not to bury everything else in it.
const V1_WARNING_INTERVAL_MILLIS = 60_000;
// Bounds the memory behind that limit: past this many addresses the least recently warned-about
// is forgotten, which at worst means one extra warning for it.
const MAX_V1_WARNING_ADDRESSES = 1024;

// How many TCP messages may be waiting for the main thread before the worker starts dropping the
// droppable ones (see isDroppable). At the main thread's saturation point on a 4-core lab server
// (about 15k model::update/s) 2000 is roughly 130 ms of work: well clear of a normal burst, and
// short enough that what does get through is not seconds old.
export const DEFAULT_INBOUND_BACKLOG_LIMIT = 2000;

// How long a client may send nothing at all before it is taken for gone. A Quest that drops off
// the Wi-Fi sends no FIN, so without this its connection stayed open - a connected client, keeping
// its app's synchronized models alive - until the kernel gave up retransmitting to it, which takes
// many minutes. A live client is never anywhere near this quiet: colibri-unity echoes the 100 ms
// heartbeat from its receive thread, so even a main thread busy loading a scene keeps it talking.
export const DEFAULT_IDLE_TIMEOUT_MILLIS = 10_000;

// If the worker's own 100 ms tick comes this late, the thread itself was stalled (a long GC, a
// starved CPU) and could not have read anything in the meantime. Every client would look idle for
// that long, so the idle check is skipped for that one tick: by the next, whatever the clients sent
// during the stall has been read.
const TICK_STALL_MILLIS = 2000;

// When the kernel starts probing a socket with nothing in flight; see handleConnection.
const KEEPALIVE_INITIAL_DELAY_MILLIS = 5000;

// Settings the proxy sends along with 'm:start'; anything left out keeps its default.
export interface TcpServerOptions {
    // TCPServerProxy's backlog counter. Without it the backlog is neither counted nor limited.
    inboundBacklog?: Int32Array;
    // 0 turns the limit off.
    inboundBacklogLimit?: number;
    // Per client; see InboundRateLimiter.
    rateLimit?: RateLimit;
    // See DEFAULT_IDLE_TIMEOUT_MILLIS. 0 never times a client out.
    idleTimeoutMillis?: number;
}

// The worker thread only ever deals in raw payload bytes (straight off the wire, or
// destined for it) - the Payload memoization abstraction lives at the ConnectionPool
// layer on the main thread, on the other side of the postMessage boundary. Keeping the
// payload as a Buffer here means a byte-verbatim TCP->TCP relay never pays a utf8
// transcode; only a hook that actually inspects the payload (on the main thread) pays
// for decoding it.
export interface WireNetworkMessage {
    origin?: {
        id: string;
        app: string;
        name: string;
        version: string;
        metadata: Record<string, unknown>;
    };
    channel: string;
    command: string;
    payload: Buffer;
}

const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

interface TcpClient {
    id: string;
    socket: net.Socket;
    reader: FrameReader;
    address: string;
    app: string;
    version: string;
    name: string;
    // Guards handleSocketDisconnect against running twice for the same client - a socket
    // error is always followed by its own 'close' event, so without this both paths would
    // post a duplicate clientDisconnected$. Also set the moment this server ends a client
    // (closeClient), which is what stops it reading anything further from that socket.
    disconnected: boolean;
    // Destroys a socket closeClient ended if the peer never closes its side; see
    // CLOSE_GRACE_MILLIS.
    closeTimer: NodeJS.Timeout | undefined;
    // Set while writes to this client are being dropped for backpressure. Only the
    // transitions in and out of that state are logged: a stalled client drops at least ten
    // heartbeats a second, and each dropped-packet warning is postMessage'd to the main
    // thread and re-broadcast to every admin UI, which WebLog can't dedupe because the
    // byte count is interpolated into the message.
    dropping: boolean;
    droppedSinceWarning: number;
    // performance.now() of the last bytes received, or of the connection if none have been yet.
    lastInboundAt: number;
}

export class TCPServerWorker extends WorkerService {
    private server: net.Server | undefined;

    // waiting for client to specify app name
    private readonly waitingClients = new Map<string, TcpClient>();
    // properly connected clients
    private readonly clients = new Map<string, TcpClient>();
    // clients grouped by app, so broadcast() can resolve recipients without scanning
    // every connected client
    private readonly clientsByApp = new Map<string, Set<TcpClient>>();

    private heartbeatInterval: NodeJS.Timeout | undefined;

    private inboundBacklog = new InboundBacklog(undefined, DEFAULT_INBOUND_BACKLOG_LIMIT);
    // Logged once when the backlog first overflows and once when it has drained, however much is
    // dropped in between - not per message, which under overload would itself be thousands of
    // posts a second to the thread that is already behind.
    private readonly backlogEpisode = new DropEpisode();

    // The backstop for one runaway client, which on its own can push the main thread into the
    // backlog limit above and so cost every other client its updates too.
    private rateLimiter = this.createRateLimiter(DEFAULT_RATE_LIMIT);

    private idleTimeoutMillis = DEFAULT_IDLE_TIMEOUT_MILLIS;
    private lastTickAt: number | undefined;

    // Remote address -> when a Colibri 1.x client there was last warned about. Kept in
    // warning order (an address is re-inserted each time), so the oldest entry is always first.
    private readonly v1WarnedAt = new Map<string, number>();

    public constructor() {
        super(true);

        // Anything thrown out of this subscriber escapes into the worker's own
        // uncaughtException path and takes the whole thread - and with it the entire TCP
        // transport - down, while HTTP and Socket.IO keep serving as if nothing happened.
        // One bad message must never cost more than that message.
        this.parentMessages$.subscribe((msg) => {
            try {
                this.handleParentMessage(msg);
            } catch (err) {
                this.logError(
                    `Error handling '${msg.channel}' from the main thread: ${err instanceof Error ? err.message : String(err)}`,
                    false
                );
            }
        });
    }

    private handleParentMessage(msg: WorkerMessage): void {
        switch (msg.channel) {
            case 'm:start':
                this.configure((msg.content.options as TcpServerOptions | undefined) ?? {});
                this.start(
                    msg.content.port as number,
                    msg.content.host as string
                );
                break;

            case 'm:stop':
                this.stop();
                break;

            case 'm:broadcast': {
                const ids = msg.content.clients as string[];
                const clients = ids
                    .map((id) => this.clients.get(id))
                    .filter((c): c is TcpClient => !!c);

                this.broadcast(msg.content.msg as WireNetworkMessage, clients);
                break;
            }

            case 'm:broadcastToApp': {
                const app = msg.content.app as string;
                const exclude = msg.content.exclude as string | undefined;
                const clients = Array.from(this.clientsByApp.get(app) ?? [])
                    .filter((c) => c.id !== exclude);

                this.broadcast(msg.content.msg as WireNetworkMessage, clients);
                break;
            }
        }
    }

    public configure(options: TcpServerOptions): void {
        this.inboundBacklog = new InboundBacklog(
            options.inboundBacklog,
            options.inboundBacklogLimit ?? DEFAULT_INBOUND_BACKLOG_LIMIT
        );
        this.rateLimiter = this.createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT);
        this.idleTimeoutMillis = options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MILLIS;
    }

    private createRateLimiter(limit: RateLimit): InboundRateLimiter<TcpClient> {
        const describe = (client: TcpClient) => `Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address})`;
        return new InboundRateLimiter<TcpClient>(limit, {
            started: (client) => this.logWarning(rateLimitStartWarning(describe(client), limit)),
            ended: (client, summary, left) => this.logWarning(rateLimitEndWarning(describe(client), summary, left)),
        });
    }

    public start(port: number, host: string): void {
        this.server = net.createServer((socket) =>
            this.handleConnection(socket)
        );
        this.server.listen(port, host);

        this.logInfo(`Starting Colibri TCP server on ${host}:${port}`);
        this.heartbeatInterval = setInterval(() => this.tick(), 100);
    }

    private tick(): void {
        this.handleHeartbeat();

        const now = performance.now();
        this.rateLimiter.sweep(now);

        const backlogSummary = this.backlogEpisode.endIfQuiet(now);
        if (backlogSummary) {
            this.logWarning(
                `The main thread has caught up with TCP messages again; ${describeEpisode(backlogSummary)} while it was behind.`
            );
        }

        const stalled = this.lastTickAt !== undefined && now - this.lastTickAt > TICK_STALL_MILLIS;
        this.lastTickAt = now;
        if (!stalled) this.endIdleClients(now);
    }

    // Ends every client that has sent nothing for idleTimeoutMillis, exactly as if it had
    // disconnected: out of every index, clientDisconnected$ posted, and so its app's models
    // dropped once it was the app's last client. Destroyed rather than ended - a peer that is
    // gone will neither read what is still queued for it nor answer a FIN.
    //
    // A client still waiting for its handshake is held to the same limit, counted from when it
    // connected: a real client handshakes at once, and since nothing is sent to a waiting client
    // any more, nothing else would ever notice one that never does.
    private endIdleClients(now: number): void {
        if (this.idleTimeoutMillis <= 0) return;

        const idleSince = now - this.idleTimeoutMillis;
        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            if (client.lastInboundAt > idleSince) continue;

            const seconds = Math.round((now - client.lastInboundAt) / 1000);
            if (this.clients.has(client.id)) {
                this.logWarning(
                    `Unity client '${client.name}' (${client.id}, app '${client.app}', ${client.address}) has sent nothing for ` +
                        `${seconds} s (TCP_IDLE_TIMEOUT_SECONDS); disconnecting it as gone. A headset that left the Wi-Fi or ` +
                        'went to sleep without closing its connection looks like this.'
                );
            } else {
                this.logDebug(`Disconnecting client ${client.id} from ${client.address}: no handshake within ${seconds} s`);
            }

            this.handleSocketDisconnect(client);
            client.socket.destroy();
        }
    }

    // Tolerates being called before start() (an 'm:stop' racing startup) and destroys live
    // sockets rather than leaving them to the terminate() that usually follows - so a stop
    // without a terminate, or a restart in the same thread, doesn't leak connections or
    // leave stale entries in the client indexes.
    public stop(): void {
        clearInterval(this.heartbeatInterval);
        this.server?.close();

        for (const client of [...this.clients.values(), ...this.waitingClients.values()]) {
            client.socket.destroy();
        }
        this.clients.clear();
        this.waitingClients.clear();
        this.clientsByApp.clear();
    }

    public broadcast(
        msg: WireNetworkMessage,
        clients: ReadonlyArray<TcpClient>
    ): void {
        if (clients.length === 0) {
            return;
        }

        let packet: Buffer;
        try {
            packet = encodeMessageFrame({
                channel: msg.channel,
                command: msg.command,
                payload: toBuffer(msg.payload),
            }, maxBufferSize);
        } catch (err) {
            // An unrepresentable frame (channel/command over 64 KiB, or a body over
            // maxBufferSize) is dropped as a single bad message. Emitting it anyway would
            // produce a frame this server's own FrameReader would reject.
            this.logError(
                `Dropping unencodable message (${msg.channel} / ${msg.command}): ${err instanceof Error ? err.message : String(err)}`,
                false
            );
            return;
        }

        for (const client of clients) {
            this.writeToClient(client, packet);
        }
    }

    private writeToClient(client: TcpClient, packet: Buffer): void {
        // Writing after end() is an error that destroys the socket - logged twice, and able to
        // cut off a refusal frame that was still being flushed. A socket gets here ended
        // between the peer's FIN (which ends our side too) and its 'close' event.
        if (client.socket.writableEnded || client.socket.destroyed) {
            return;
        }

        if (client.socket.writableLength > highWaterMark) {
            client.droppedSinceWarning += 1;
            if (!client.dropping) {
                client.dropping = true;
                this.logWarning(
                    `Dropping messages to client ${client.id}: writable buffer exceeds high-water mark (${client.socket.writableLength} bytes)`
                );
            }
            return;
        }

        if (client.dropping) {
            client.dropping = false;
            this.logWarning(
                `Client ${client.id} caught up; dropped ${client.droppedSinceWarning} message(s) while backed up`
            );
            client.droppedSinceWarning = 0;
        }

        client.socket.write(packet, (err) => {
            if (err) {
                this.logWarning(
                    `Failed to send message to client ${client.id}: ${err.message} `
                );
            }
        });
    }

    private handleConnection(socket: net.Socket): void {
        const id = randomUUID();
        this.logDebug(
            `New client (${id}) connected from ${socket.remoteAddress}, waiting for app name`
        );
        socket.setNoDelay(true);
        // The kernel's own dead-peer detection, for a socket with nothing in flight - one waiting
        // for its handshake, say. A handshaked client is written to every 100 ms, which keeps
        // keepalive from ever probing it; the idle timeout in endIdleClients covers that case.
        socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MILLIS);

        const tcpClient: TcpClient = {
            id,
            socket,
            reader: new FrameReader(maxBufferSize),
            address: socket.remoteAddress || 'UNDEFINED',
            app: '',
            name: '',
            version: '0',
            disconnected: false,
            closeTimer: undefined,
            dropping: false,
            droppedSinceWarning: 0,
            lastInboundAt: performance.now(),
        };
        this.waitingClients.set(tcpClient.id, tcpClient);

        socket.on('data', (data) => {
            this.handleSocketData(tcpClient, data);
        });

        socket.on('error', (error) => {
            this.handleSocketError(tcpClient, error);
        });

        // 'close' always fires exactly once, whether the socket ended gracefully, errored,
        // or was destroyed outright - unlike 'end', which never fires on an abrupt
        // disconnect (e.g. a client that vanishes without sending FIN), which used to leak
        // that client in `clients`/`clientsByApp` forever.
        socket.on('close', () => {
            clearTimeout(tcpClient.closeTimer);
            this.handleSocketDisconnect(tcpClient);
        });
    }

    private handleSocketData(client: TcpClient, data: Buffer): void {
        // A client this server has already refused or cut off: the peer can keep sending
        // until it notices our FIN, and none of it is meant to be acted on.
        if (client.disconnected) return;

        const now = performance.now();
        client.lastInboundAt = now;

        let frames;
        try {
            frames = client.reader.append(data);
        } catch (err) {
            if (err instanceof V1FramingError) {
                this.reportV1Client(client);
            } else {
                const reason = err instanceof FrameError ? err.message : String(err);
                this.logError(
                    `Invalid frame from client ${client.id}, discarding buffer and terminating connection: ${reason}`,
                    false
                );
            }
            client.reader.reset();
            this.closeClient(client);
            return;
        }

        for (const frame of frames) {
            // A handshake earlier in this same chunk may have refused the client; the frames
            // queued behind it must not be relayed or logged as orphans.
            if (client.disconnected) return;

            switch (frame.type) {
                case FrameType.Handshake:
                    try {
                        this.assignApp(client, frame.app, frame.name, frame.version);
                    } catch (err) {
                        this.logError(
                            `Invalid handshake packet received from client ${client.id}`,
                            false
                        );
                        if (err instanceof Error) this.logError(err.stack || '', false);
                        else console.error(err);
                    }
                    break;

                case FrameType.Heartbeat:
                    this.handlePong(client, frame.pingTimestamp);
                    break;

                case FrameType.Message:
                    if (!client.app) {
                        this.logError(
                            `Ignoring message (${frame.channel} / ${frame.command}) from client ${client.id} without app`,
                            false
                        );
                        break;
                    }

                    // The client's own limit first: a message over it is the client's doing, and
                    // counts towards its episode rather than the server's.
                    if (isDroppable(frame.channel, frame.command)
                        && (!this.rateLimiter.admit(client, now) || this.dropForBacklog())) {
                        break;
                    }

                    this.postClientMessage(client, frame.channel, frame.command, frame.payload);
                    break;
            }
        }
    }

    private assignApp(client: TcpClient, app: string, name: string, version: string): void {
        // Refuse before the client is indexed, so a mismatched client never reaches an app's
        // broadcast set, never posts clientConnected$, and never shows up in the admin UI as
        // a half-connected ghost.
        if (version !== PROTOCOL_VERSION) {
            this.rejectProtocolVersion(client, name, version);
            return;
        }

        // A second handshake frame with a different app would otherwise leave the client in
        // its previous app's Set forever - removeFromAppIndex only ever looks at the
        // client's *current* app - so a disconnected socket would keep receiving
        // writeToClient calls for the app it first announced.
        if (client.app) {
            this.removeFromAppIndex(client);
        }

        client.app = app;
        client.name = name;
        client.version = version;
        this.logDebug(
            `Setting app of new colibri client '${name}' (${client.id}, v${version}) to "${app}"`,
            {
                clientApp: client.app,
                clientName: client.name,
                clientId: client.id,
            }
        );
        this.waitingClients.delete(client.id);
        this.clients.set(client.id, client);
        this.addToAppIndex(client);
        this.postMessage('clientConnected$', { id: client.id, app, name, version });
    }

    // Tells the client why it was refused and closes the connection. Only a client that speaks
    // this server's *framing* gets here - one whose handshake frame decoded, but announced another
    // protocol version - so it can read the refusal. A Colibri 1.x client never reaches this
    // method: its handshake is not a valid frame in the current framing, so FrameReader throws a
    // V1FramingError on its first bytes and reportV1Client names it instead (it could not decode
    // a refusal anyway). Either way the log line is the diagnostic an integrator will look at.
    //
    // end(packet) rather than write-then-end: it queues the rejection and the FIN together,
    // so the frame cannot be lost to a close that races the write callback.
    private rejectProtocolVersion(client: TcpClient, name: string, version: string): void {
        const rejection = protocolRejection(version);
        this.logError(
            `Refusing client '${name}' (${client.id}, ${client.address}): ${rejection.reason}`,
            false
        );

        let packet: Buffer | undefined;
        try {
            packet = encodeMessageFrame({
                channel: COLIBRI_CHANNEL,
                command: PROTOCOL_REJECTED_COMMAND,
                payload: Buffer.from(JSON.stringify(rejection), 'utf8'),
            }, maxBufferSize);
        } catch {
            // Nothing useful to say if even the refusal cannot be encoded - the socket is
            // going away either way.
        }
        this.closeClient(client, packet);
    }

    // A 1.x client cannot be sent a refusal it would understand - the framing itself differs -
    // so this warning is the whole diagnostic. Before it, all the log said was an anonymous
    // "Invalid frame length: 1744830464" once a second, which names neither the client nor
    // the fix.
    private reportV1Client(client: TcpClient): void {
        const now = performance.now();
        const lastWarned = this.v1WarnedAt.get(client.address);
        if (lastWarned !== undefined && now - lastWarned < V1_WARNING_INTERVAL_MILLIS) {
            this.logDebug(`Refusing Colibri 1.x client ${client.id} from ${client.address} (warned about this address already)`);
            return;
        }

        this.rememberV1Warning(client.address, now);
        this.logWarning(
            `Refusing a connection from ${client.address}: it looks like a Colibri 1.x client (it speaks the 1.x wire format), ` +
                `but this server speaks protocol v${PROTOCOL_VERSION}. Upgrade the Colibri Unity package (de.uni.kn.colibri) ` +
                'in that app to 2.x. A 1.x client retries about once a second; this is logged at most once a minute per address.'
        );
    }

    private rememberV1Warning(address: string, now: number): void {
        this.v1WarnedAt.delete(address);

        // Oldest first: drop entries whose interval has passed, plus the oldest live ones
        // while the map is full. Stops at the first entry that is neither.
        for (const [warnedAddress, warnedAt] of this.v1WarnedAt) {
            if (now - warnedAt < V1_WARNING_INTERVAL_MILLIS && this.v1WarnedAt.size < MAX_V1_WARNING_ADDRESSES) break;
            this.v1WarnedAt.delete(warnedAddress);
        }

        this.v1WarnedAt.set(address, now);
    }

    // Ends a connection from this side: drops the client from every index *now*, rather than
    // when its 'close' event eventually arrives. Until then it used to stay listed, so the next
    // 100ms heartbeat wrote to the ended socket - "write after end", logged twice, and a destroy
    // that could truncate the refusal frame still being flushed.
    //
    // end(finalPacket) queues that frame ahead of the FIN, so it is still delivered. The timer
    // only matters for a peer that never closes its side; a well-behaved one closes first and
    // the socket's 'close' handler clears it.
    private closeClient(client: TcpClient, finalPacket?: Buffer): void {
        if (client.disconnected) return;

        this.handleSocketDisconnect(client);
        if (finalPacket) {
            client.socket.end(finalPacket);
        } else {
            client.socket.end();
        }

        client.closeTimer = setTimeout(() => client.socket.destroy(), CLOSE_GRACE_MILLIS);
        // Never the reason a worker thread stays alive.
        client.closeTimer.unref();
    }

    // A client echoes a server-sent heartbeat frame's timestamp back verbatim; relay it
    // into the normal clientMessage$ pipeline as a 'colibri'/'latency' message so
    // MeasureLatency's existing round-trip math (unchanged) handles it exactly as it
    // would a message-level ping reply. hrtime is a system-wide monotonic clock, so a
    // timestamp this worker generated remains valid to diff against once it reaches the
    // main thread. The difference from before is purely in what it cost to get here: one
    // fixed 13-byte frame each way instead of a full channel/command/payload message.
    private handlePong(client: TcpClient, pingTimestamp: bigint): void {
        if (!client.app) return;

        // ownBytes: a Buffer.from() this small is a view into the 64 KiB Buffer pool, and
        // postMessage would clone all of it - ten times a second per client.
        this.postClientMessage(client, 'colibri', 'latency', ownBytes(Buffer.from(pingTimestamp.toString(), 'utf8')));
    }

    // Every message for the main thread's hooks goes through here, so each one is counted in the
    // backlog that TCPServerProxy counts back down once it has been dispatched.
    private postClientMessage(client: TcpClient, channel: string, command: string, payload: Buffer): void {
        this.inboundBacklog.posted();
        this.postMessage('clientMessage$', {
            channel,
            command,
            payload,
            origin: {
                id: client.id,
                app: client.app,
                name: client.name,
                version: client.version,
                metadata: {},
            },
        });
    }

    // Past the backlog limit the main thread is further behind than it can make up while clients
    // keep sending at this rate, and every further message would only sit in the queue - in
    // memory, getting older. Dropping the droppable ones here is what keeps both bounded.
    private dropForBacklog(): boolean {
        if (!this.inboundBacklog.full) return false;

        if (this.backlogEpisode.recordDrop(performance.now())) {
            // The limit rather than a fresh read of the counter, which the main thread may have
            // counted down a little since `full` read it - "1998 behind, limit 2000" just confuses.
            this.logWarning(
                `The main thread has fallen ${this.inboundBacklog.limit} TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT): ` +
                    'the server is taking in more than it can process. ' +
                    'Dropping model::update and broadcast::* messages from Unity clients until it catches up, so synced objects ' +
                    'will lag or jump. Fewer synced objects, a lower sync rate or fewer clients per app reduce the load.'
            );
        }
        return true;
    }

    private handleSocketError(client: TcpClient, error: Error): void {
        // ignore ECONNRESET errors, as they are caused by the client disconnecting
        if (error.message.indexOf('ECONNRESET') === -1) {
            this.logError(error.message, false);
        }

        // No need to call handleSocketDisconnect here - a socket's 'close' event always
        // fires directly after 'error', and that already handles cleanup.
    }

    private handleSocketDisconnect(client: TcpClient): void {
        if (client.disconnected) return;
        client.disconnected = true;

        this.logDebug(`Colibri client ${client.address} disconnected`, {
            clientApp: client.app,
            clientName: client.name,
            clientId: client.id,
        });
        this.clients.delete(client.id);
        this.waitingClients.delete(client.id);
        this.removeFromAppIndex(client);
        this.rateLimiter.forget(client);
        this.postMessage('clientDisconnected$', { id: client.id });
    }

    private addToAppIndex(client: TcpClient): void {
        let clients = this.clientsByApp.get(client.app);
        if (!clients) {
            clients = new Set();
            this.clientsByApp.set(client.app, clients);
        }
        clients.add(client);
    }

    private removeFromAppIndex(client: TcpClient): void {
        const clients = this.clientsByApp.get(client.app);
        if (!clients) return;

        clients.delete(client);
        if (clients.size === 0) {
            this.clientsByApp.delete(client.app);
        }
    }

    // Only clients whose handshake was accepted. A heartbeat is the server saying "you are
    // connected": colibri-unity counts a session as connected from the first frame it decodes, so
    // heartbeating a client still waiting for its handshake to be checked made one this server was
    // about to refuse fire OnConnected first, and ProtocolMismatch a moment later. Now the first
    // frame a client sees is either protocol::rejected or a heartbeat after acceptance. Nothing
    // else needed the early ones: a waiting client's echo was discarded (handlePong) anyway.
    private handleHeartbeat(): void {
        const packet = encodeHeartbeatFrame(process.hrtime.bigint());
        for (const client of this.clients.values()) {
            this.writeToClient(client, packet);
        }
    }
}

if (!threads.isMainThread && (threads.workerData as { role?: string } | null)?.role === TCP_SERVER_WORKER_ROLE) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const server = new TCPServerWorker();
}
