import { LogMessage, Metadata, Payload, RingBuffer, Service } from '../core/index.js';
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

interface RequestLogPayload {
    filter?: string;
    levels?: number[];
    showBroadcastTraffic?: boolean;
}

export class WebLog extends Service {
    public serviceName = 'WebLog';
    public groupName = 'web';

    private readonly logMessages = new RingBuffer<WebMessage>(MAX_LOG_SIZE);

    // Exact-match index for merging repeats of the same (level, group, message), independent of
    // how much unrelated log traffic interleaves between occurrences - a positional lookback over
    // logMessages (the old approach) missed most repeats under any real amount of other traffic,
    // since the previous occurrence would already have scrolled past the lookback window.
    private readonly recentByKey = new Map<string, { msg: WebMessage; seq: number }>();
    private totalPushed = 0;

    public constructor(private socketio: SocketIOServer) {
        super();
    }

    public override async init(): Promise<void> {
        super.init();

        this.socketio.messages$
            .pipe(filter(msg => msg.channel === 'colibri::log' && msg.command === 'requestLog'))
            .subscribe(networkMsg => {
                const socketClient = networkMsg.origin && this.socketio.getClient(networkMsg.origin.id);
                if (!socketClient) {
                    this.logError('Unkown origin requested log messages', false);
                    return;
                }

                const body = networkMsg.payload?.asValue<RequestLogPayload>() ?? {};
                const filter = body.filter || '';
                const levels = body.levels ? new Set(body.levels) : undefined;
                const showBroadcastTraffic = body.showBroadcastTraffic === true;

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
            });

        Service.output$.subscribe(this.redirectLogMessage.bind(this));
    }

    private redirectLogMessage(log: LogMessage): void {
        // group identical messages together, as long as the earlier occurrence hasn't since
        // been evicted from logMessages (its seq would then be below the oldest surviving one)
        const key = JSON.stringify([ log.level, log.group, log.message ]);
        const oldestSurvivingSeq = this.totalPushed - this.logMessages.length;
        const candidate = this.recentByKey.get(key);

        let webMsg: WebMessage;
        if (candidate && candidate.seq >= oldestSurvivingSeq) {
            webMsg = candidate.msg;
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
            this.logMessages.push(webMsg);
            this.recentByKey.set(key, { msg: webMsg, seq: this.totalPushed });
            this.totalPushed += 1;
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
