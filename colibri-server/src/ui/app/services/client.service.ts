import { Injectable, inject, signal } from '@angular/core';
import { SocketIOService } from './socketio.service';

export interface ColibriClient {
    id: string;
    app: string;
    name: string;
    version: string;
    latency: [number, number][]
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
                    const client = {
                        ...msg.payload,
                        latency: []
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
    }

}
