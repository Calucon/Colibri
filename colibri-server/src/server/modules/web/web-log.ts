import { LogMessage, Metadata, Payload, RingBuffer, Service } from '../core/index.js';
import { SocketIoClient, SocketIOServer } from '../networking/socket-io-server.js';
import { filter } from 'rxjs';
import { randomUUID } from 'crypto';

const LOGGING_APP = 'colibri';
const MAX_LOG_SIZE = 20000;
const LOOKUP_COUNT = 5; // how far back log messages are searched for identical messages

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

export class WebLog extends Service {
    public serviceName = 'WebLog';
    public groupName = 'web';

    private readonly logMessages = new RingBuffer<WebMessage>(MAX_LOG_SIZE);

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

                const filter = networkMsg.payload?.asValue<{ filter?: string }>()?.filter || '';
                socketClient.metadata['log::filter'] = filter;

                // client can't handle too many messages at once
                const clientLimit = 10000;

                this.logMessages
                    .toArray()
                    .filter(msg => !filter || msg.metadata.clientApp === filter)
                    .slice(-clientLimit)
                    .map(msg => ({
                        channel: 'colibri::log',
                        command: 'message',
                        payload: Payload.fromValue(msg)
                    }))
                    .forEach(msg => this.socketio.broadcast(msg, [ socketClient ]));
            });

        Service.output$.subscribe(this.redirectLogMessage.bind(this));
    }

    private redirectLogMessage(log: LogMessage): void {
        // search last few messages for identical messages, group them together
        let webMsg: WebMessage | undefined = undefined;
        for (let i = this.logMessages.length - 1; i >= 0 && i > this.logMessages.length - LOOKUP_COUNT && !webMsg; i--) {
            const tmpMsg = this.logMessages.at(i);

            if (tmpMsg && tmpMsg.message === log.message && tmpMsg.group === log.group && tmpMsg.level === log.level) {
                webMsg = tmpMsg;
                webMsg.count += 1;
                webMsg.created = log.created.getTime();
            }
        }

        // if no similar message was found, add a new one
        if (!webMsg) {
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
        }

        // History above is kept regardless (a client may request it later), but a single
        // pass over currentClients decides the recipients, and building the broadcast
        // payload is skipped entirely when no admin UI is connected to receive it.
        const clients: SocketIoClient[] = [];
        for (const client of this.socketio.currentClients) {
            if (client.app !== LOGGING_APP) continue;

            const clientFilter = client.metadata['log::filter'];
            if (clientFilter && clientFilter !== log.metadata.clientApp) continue;

            clients.push(client);
        }

        if (clients.length === 0) return;

        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'message',
            payload: Payload.fromValue(webMsg)
        }, clients);
    }
}
