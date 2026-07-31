import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { SocketIOService } from './socketio.service';

export interface LogMessage {
    id: string;
    origin: string;
    level: number;
    message: string;
    group: string;
    created: number;
    count: number;
    metadata: Record<string, unknown>;
}

@Injectable({
    providedIn: 'root'
})
export class LogService {
    private readonly socketio = inject(SocketIOService);

    private readonly _messages = signal<ReadonlyArray<LogMessage>>([]);
    public readonly messages = this._messages.asReadonly();

    public readonly filter = signal<string>(location.hash.substring(1));
    public readonly showBroadcastTraffic = signal(false);

    public readonly visibleMessages = computed(() =>
        this.showBroadcastTraffic()
            ? this._messages()
            : this._messages().filter(m => !m.metadata?.['broadcastTraffic'])
    );

    // for quick lookup of messages by id
    private messageIds: { [id: string]: LogMessage } = {};

    constructor() {
        this.socketio
            .listen('colibri::log')
            .subscribe((msg) => {
                const m = msg.payload as LogMessage;

                let messages = this._messages();
                while (messages.length > 10000) {
                    delete this.messageIds[messages[0].id];
                    messages = messages.slice(1);
                }

                if (this.messageIds[m.id]) {
                    // update existing message
                    const existing = this.messageIds[m.id];
                    existing.count = m.count;
                    existing.created = m.created;

                    // put it to the end of the list
                    const index = messages.indexOf(existing);
                    messages = [ ...messages.slice(0, index), ...messages.slice(index + 1), existing ];
                } else {
                    // create new entry
                    messages = [ ...messages, m ];
                    this.messageIds[m.id] = m;
                }

                this._messages.set(messages);
            });

        effect(() => {
            const filter = this.filter();

            this.socketio.emit('colibri::log', 'requestLog', { filter });
            location.hash = filter || '';

            // reload messages
            this._messages.set([]);
            this.messageIds = {};
        });
    }
}
