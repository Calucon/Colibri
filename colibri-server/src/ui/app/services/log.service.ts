import { Injectable, effect, inject, signal } from '@angular/core';
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

export const LOG_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0, label: 'Error' },
    { value: 1, label: 'Warn' },
    { value: 2, label: 'Info' },
    { value: 3, label: 'Debug' }
];

@Injectable({
    providedIn: 'root'
})
export class LogService {
    private readonly socketio = inject(SocketIOService);

    private readonly _messages = signal<ReadonlyArray<LogMessage>>([]);
    public readonly messages = this._messages.asReadonly();

    public readonly filter = signal<string>(location.hash.substring(1));
    public readonly levels = signal<ReadonlySet<number>>(new Set(LOG_LEVELS.map(l => l.value)));
    public readonly showBroadcastTraffic = signal(false);

    public setLevels(values: ReadonlyArray<number>): void {
        this.levels.set(new Set(values));
    }

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
                    // Replace with a new object (not mutate in place): LogMessageComponent is
                    // OnPush with a signal input, so it only re-renders when the reference passed
                    // into [log] actually changes - mutating the existing object left the count
                    // and timestamp stuck at their first-seen values on screen.
                    const existing = this.messageIds[m.id];
                    const updated = { ...existing, count: m.count, created: m.created };
                    this.messageIds[m.id] = updated;

                    // put it to the end of the list
                    const index = messages.indexOf(existing);
                    messages = [ ...messages.slice(0, index), ...messages.slice(index + 1), updated ];
                } else {
                    // create new entry
                    messages = [ ...messages, m ];
                    this.messageIds[m.id] = m;
                }

                this._messages.set(messages);
            });

        effect(() => {
            const filter = this.filter();
            const levels = this.levels();
            const showBroadcastTraffic = this.showBroadcastTraffic();

            this.socketio.emit('colibri::log', 'requestLog', { filter, levels: [ ...levels ], showBroadcastTraffic });
            location.hash = filter || '';

            // reload messages
            this._messages.set([]);
            this.messageIds = {};
        });
    }
}
