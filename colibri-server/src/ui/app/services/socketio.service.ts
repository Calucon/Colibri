/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NgZone, inject } from '@angular/core';
import { Subject, Observable, throttleTime } from 'rxjs';
import * as io from 'socket.io-client';

@Injectable({
    providedIn: 'root'
})
export class SocketIOService {
    private zone = inject(NgZone);

    private socket: io.Socket<any, any>;
    private listeners: { [name: string]: Subject<any> } = {};
    // coalesces NgZone re-entry from bursty socket events; only needed while zone.js CD is active
    private readonly changeTrigger$ = new Subject<void>();

    constructor() {
        // Must match PROTOCOL_VERSION in src/server/modules/networking/protocol.ts. The admin
        // UI is exempt from the disconnect-on-mismatch check (it ships with the server, so it
        // can only ever be out of step by mistake), but a stale value here still logs a
        // warning on every page load.
        this.socket = io.connect('', { query: { app: 'colibri', version: '2' } });

        this.changeTrigger$
            .pipe(throttleTime(50, undefined, { leading: true, trailing: true }))
            // eslint-disable-next-line no-empty-function
            .subscribe(() => this.zone.run(() => {}));
    }


    public listen(channel: string): Observable<any> {
        if (!this.listeners[channel]) {
            const msgStream = new Subject<any>();
            this.listeners[channel] = msgStream;

            this.socket.on(channel, (msg: any) => {
                msgStream.next({ command: msg.command, payload: msg.payload });
                this.changeTrigger$.next();
            });
        }

        return this.listeners[channel].asObservable();
    }

    public emit(channel: string, command: string, payload?: unknown): void {
        this.socket.emit(channel, {
            command,
            payload
        });
    }
}
