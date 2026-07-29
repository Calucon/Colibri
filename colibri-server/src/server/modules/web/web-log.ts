import { LogMessage, Metadata, Payload, RingBuffer, Service } from '../core/index.js';
import { SocketIOServer } from '../networking/socket-io-server.js';
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
                const socketClient = this.socketio.currentClients.find(c => c === networkMsg.origin);

                if (networkMsg.origin) {
                    networkMsg.origin.metadata['log::filter'] = networkMsg.payload?.asValue<{ filter?: string }>()?.filter || '';
                }

                if (socketClient) {
                    const filter = socketClient.metadata['log::filter'] || '';

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
                } else {
                    this.logError('Unkown origin requested log messages', false);
                }
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

        // history above is kept regardless (a client may request it later), but skip
        // building the broadcast payload and filtering currentClients when there's no
        // admin UI connected to receive it.
        if (!this.socketio.currentClients.some(c => c.app === LOGGING_APP)) {
            return;
        }

        const clients = this.socketio.currentClients
            .filter(c => c.app === LOGGING_APP)
            .filter(c => !c.metadata['log::filter'] || c.metadata['log::filter'] === log.metadata.clientApp);
        this.socketio.broadcast({
            channel: 'colibri::log',
            command: 'message',
            payload: Payload.fromValue(webMsg)
        }, clients);
    }
}
