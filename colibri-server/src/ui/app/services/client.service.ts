import { Injectable, inject, signal } from '@angular/core';
import { SocketIOService } from './socketio.service';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    latency: [number, number][];
    /**
     * Its colour on the Statistics page: the lowest no other client had when it connected, kept
     * until it leaves. Its place in the list changed whenever a client before it left.
     */
    slot: number;
}

@Injectable({
    providedIn: 'root'
})
export class ClientService {
    private readonly _clients = signal<ReadonlyArray<ColibriClient>>([]);
    public readonly clients = this._clients.asReadonly();

    constructor() {
        const socketio = inject(SocketIOService);

        socketio
            .listen('colibri::latency')
            .subscribe(msg => {
                let changed = false;
                const clients = this._clients().map(client => {
                    const latency = msg.payload[client.id];
                    if (!latency) {
                        return client;
                    }

                    changed = true;
                    return { ...client, latency: [...client.latency, ...latency].slice(-1000) };
                });

                if (changed) {
                    this._clients.set(clients);
                }
            });

        socketio
            .listen('colibri::clients')
            .subscribe(msg => {
                if (msg.command === 'client::connected') {
                    const taken = new Set(this._clients().map(c => c.slot));
                    let slot = 0;
                    while (taken.has(slot)) slot++;

                    const client = {
                        ...msg.payload,
                        latency: [],
                        slot
                    };
                    this._clients.set([...this._clients(), client]);
                } else if (msg.command === 'client::disconnected') {
                    this._clients.set(this._clients().filter(c => c.id !== msg.payload.id));
                } else {
                    console.error('unknown client command', msg);
                }
            });

        // retrieve initial clients
        socketio.emit('colibri::clients', 'client::request', {});

        // clients that left while the connection was down were never reported
        socketio.reconnected$.subscribe(() => {
            this._clients.set([]);
            socketio.emit('colibri::clients', 'client::request', {});
        });
    }

}
