import { LogLevel, LogMessage, Metadata, Payload, RingBuffer, Service } from '../core/index.js';
import { NetworkMessage } from '../command-hooks/index.js';
import { SocketIoClient, SocketIOServer } from '../networking/socket-io-server.js';
import { filter } from 'rxjs';
import { randomUUID } from 'crypto';

const LOGGING_APP = 'colibri';
const MAX_LOG_SIZE = 20000;

interface WebMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    created: number;
    count: number;
    metadata: Metadata;
}

interface LogPreferences {
    filter: string;
    levels: Set<number> | undefined;
    showBroadcastTraffic: boolean;
}

// What makes two log lines "the same" for merging; WebMessage copies all of it verbatim from
// the LogMessage, so an entry's key can be recomputed from either. The app is part of it: the
// clients of two apps on one host share a name (their IP address), so the same line from both
// used to become one entry, counted together and shown under the first app only.
const messageKey = function (msg: { level: number; group: string; message: string; metadata: Metadata }): string {
    return JSON.stringify([ msg.level, msg.group, msg.message, msg.metadata.clientApp ?? null ]);
};

const KNOWN_LEVELS: ReadonlySet<number> = new Set([ LogLevel.Error, LogLevel.Warn, LogLevel.Info, LogLevel.Debug ]);

// requestLog is accepted from any Socket.IO client of any app, so its payload is whatever
// that client chose to send. Each field is taken only if it has the expected type and is
// otherwise left at its default (no filter, all levels, no broadcast traffic): `levels: 1`
// used to reach `new Set(1)` and throw, `levels: 'x'` became Set {'x'} and silently hid
// every level, and a non-string `filter` silently hid every message.
const parseLogPreferences = function (body: unknown): LogPreferences {
    const fields = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    return {
        filter: typeof fields.filter === 'string' ? fields.filter : '',
        levels: Array.isArray(fields.levels)
            ? new Set(fields.levels.filter((level): level is number => typeof level === 'number' && KNOWN_LEVELS.has(level)))
            : undefined,
        showBroadcastTraffic: fields.showBroadcastTraffic === true
    };
};

export class WebLog extends Service {
    public serviceName = 'WebLog';
    public groupName = 'web';

    private readonly logMessages = new RingBuffer<WebMessage>(MAX_LOG_SIZE);

    // Exact-match index for merging repeats of the same (level, group, message), independent of
    // how much unrelated log traffic interleaves between occurrences - a positional lookback over
    // logMessages (the old approach) missed most repeats under any real amount of other traffic,
    // since the previous occurrence would already have scrolled past the lookback window.
    //
    // Holds exactly the entries still in logMessages (see pushMessage), so it is bounded by
    // MAX_LOG_SIZE too. It used to keep every key ever logged, each pinning its evicted
    // message: 100k distinct lines left 100k entries behind a 20k-entry history.
    private readonly recentByKey = new Map<string, WebMessage>();

    public constructor(private socketio: SocketIOServer) {
        super();
    }

    public override async init(): Promise<void> {
        super.init();

        this.socketio.messages$
            .pipe(filter(msg => msg.channel === 'colibri::log' && msg.command === 'requestLog'))
            .subscribe(networkMsg => {
                // RxJS rethrows an exception from a subscriber asynchronously, where it is an
                // uncaught exception and main.ts shuts the server down - so nothing a client
                // sends may escape from here.
                try {
                    this.handleRequestLog(networkMsg);
                } catch (err) {
                    this.logError(`Ignoring requestLog from client ${networkMsg.origin?.id}: ${err instanceof Error ? err.message : String(err)}`, false);
                }
            });

        Service.output$.subscribe(this.redirectLogMessage.bind(this));
    }

    private handleRequestLog(networkMsg: NetworkMessage): void {
        const socketClient = networkMsg.origin && this.socketio.getClient(networkMsg.origin.id);
        if (!socketClient) {
            this.logError('Unkown origin requested log messages', false);
            return;
        }

        const { filter, levels, showBroadcastTraffic } = parseLogPreferences(networkMsg.payload?.asValue());

        socketClient.metadata['log::filter'] = filter;
        socketClient.metadata['log::levels'] = levels;
        socketClient.metadata['log::broadcast'] = showBroadcastTraffic;

        // client can't handle too many messages at once
        const clientLimit = 10000;

        this.logMessages
            .toArray()
            .filter(msg => !filter || msg.metadata.clientApp === filter)
            .filter(msg => this.isVisibleToClient(msg.level, msg.metadata, levels, showBroadcastTraffic))
            .slice(-clientLimit)
            .map(msg => ({
                channel: 'colibri::log',
                command: 'message',
                payload: Payload.fromValue({ ...msg })
            }))
            .forEach(msg => this.socketio.broadcast(msg, [ socketClient ]));
    }

    private redirectLogMessage(log: LogMessage): void {
        // group identical messages together, as long as the earlier occurrence is still in
        // logMessages (an evicted one has already been dropped from recentByKey)
        const key = messageKey(log);
        let webMsg = this.recentByKey.get(key);

        if (webMsg) {
            webMsg.count += 1;
            webMsg.created = log.created.getTime();
        } else {
            webMsg = {
                id: randomUUID(),
                origin: log.origin,
                level: log.level,
                group: log.group,
                message: log.message,
                created: log.created.getTime(),
                count: 0,
                metadata: log.metadata
            };
            this.pushMessage(key, webMsg);
        }

        // History above is kept regardless (a client may request it later), but a single
        // pass over currentClients decides the recipients, and building the broadcast
        // payload is skipped entirely when no admin UI is connected to receive it.
        const clients: SocketIoClient[] = [];
        for (const client of this.socketio.currentClients) {
            if (client.app !== LOGGING_APP) continue;

            const clientFilter = client.metadata['log::filter'];
            if (clientFilter && clientFilter !== log.metadata.clientApp) continue;

            const clientLevels = client.metadata['log::levels'] as Set<number> | undefined;
            const clientBroadcast = client.metadata['log::broadcast'] as boolean | undefined;
            if (!this.isVisibleToClient(log.level, log.metadata, clientLevels, clientBroadcast)) continue;

            clients.push(client);
        }

        if (clients.length === 0) return;

        // Snapshot, not a reference: webMsg is a merge target that gets mutated in place on its
        // next repeat, and Payload.fromValue() stores whatever it's given verbatim - passing the
        // live object would let a later merge silently rewrite what an earlier broadcast for this
        // same entry sends.
        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'message',
            payload: Payload.fromValue({ ...webMsg })
        }, clients);
    }

    private pushMessage(key: string, webMsg: WebMessage): void {
        // Once full, push() overwrites the oldest entry, so that one leaves recentByKey first.
        if (this.logMessages.length >= MAX_LOG_SIZE) {
            const evicted = this.logMessages.at(0);
            if (evicted) {
                const evictedKey = messageKey(evicted);
                if (this.recentByKey.get(evictedKey) === evicted) this.recentByKey.delete(evictedKey);
            }
        }

        this.logMessages.push(webMsg);
        this.recentByKey.set(key, webMsg);
    }

    // Broadcast/sync traffic is governed exclusively by showBroadcastTraffic, never by levels,
    // even though it's always logged at Debug: lets an admin watch Debug output without sync
    // spam, or watch sync spam without unrelated Debug noise.
    private isVisibleToClient(level: number, metadata: Metadata, levels: Set<number> | undefined, showBroadcastTraffic: boolean | undefined): boolean {
        if (metadata['broadcastTraffic'] === true) {
            return showBroadcastTraffic === true;
        }
        return !levels || levels.has(level);
    }
}
