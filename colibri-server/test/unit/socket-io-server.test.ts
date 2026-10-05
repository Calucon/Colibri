import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Subscription } from 'rxjs';
import { io as connectClient, Socket as ClientSocket } from 'socket.io-client';
import { SocketIOServer } from '../../src/server/modules/networking/socket-io-server.js';
import { PROTOCOL_VERSION } from '../../src/server/modules/networking/protocol.js';
import { Service } from '../../src/server/modules/core/service.js';
import { LogLevel, LogMessage } from '../../src/server/modules/core/log-message.js';
import { NetworkClient } from '../../src/server/modules/command-hooks/connection-pool.js';

interface ColibriEvent {
    command: string;
    payload: Record<string, unknown>;
}

// A real Socket.IO server on an ephemeral loopback port, and real socket.io-client connections:
// the behaviour under test is what a browser actually receives, in what order, and whether it
// stays connected - none of which a mocked Socket.IO would show.
describe('SocketIOServer', () => {
    let http: HttpServer;
    let server: SocketIOServer;
    let port: number;
    let clients: ClientSocket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;
    let connected: NetworkClient[];

    beforeEach(async () => {
        http = createServer();
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        port = (http.address() as AddressInfo).port;

        server = new SocketIOServer();
        server.start(http);

        clients = [];
        logs = [];
        logSubscription = Service.output$.subscribe(msg => logs.push(msg));
        connected = [];
        server.clientConnected$.subscribe(c => connected.push(c));
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const client of clients) client.disconnect();
        // Closes the HTTP server too.
        server.stop();
        await new Promise(resolve => http.once('close', resolve));
    });

    const connect = function (query: Record<string, string>): { socket: ClientSocket; colibri: ColibriEvent[] } {
        const socket = connectClient(`http://127.0.0.1:${port}`, {
            query,
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
        });
        clients.push(socket);

        const colibri: ColibriEvent[] = [];
        socket.on('colibri', (msg: ColibriEvent) => colibri.push(msg));
        return { socket, colibri };
    };

    const disconnectReason = function (socket: ClientSocket): Promise<string> {
        return new Promise(resolve => socket.once('disconnect', reason => resolve(reason)));
    };

    const nextColibriEvent = function (socket: ClientSocket): Promise<ColibriEvent> {
        return new Promise(resolve => socket.once('colibri', (msg: ColibriEvent) => resolve(msg)));
    };

    const logged = (level: LogLevel): string[] => logs.filter(l => l.level === level).map(l => l.message);

    describe('a client announcing another protocol version', () => {
        it('is told why and then disconnected', async () => {
            const { socket, colibri } = connect({ app: 'appA', version: '1' });

            expect(await disconnectReason(socket)).toBe('io server disconnect');

            expect(colibri).toHaveLength(1);
            expect(colibri[0]?.command).toBe('protocol::rejected');
            expect(colibri[0]?.payload).toMatchObject({ serverVersion: PROTOCOL_VERSION, clientVersion: '1' });
            expect(String(colibri[0]?.payload.reason)).toContain(`v${PROTOCOL_VERSION}`);
        });

        it('never joins: not listed, not announced as connected', async () => {
            const { socket } = connect({ app: 'appA', version: '1' });
            await disconnectReason(socket);

            expect(server.currentClients).toEqual([]);
            expect(connected).toEqual([]);
            expect(server.hasRecipients('appA')).toBe(false);
            expect(logged(LogLevel.Error).some(m => m.includes('Refusing client'))).toBe(true);
        });
    });

    describe('a client announcing no protocol version', () => {
        it('is refused and disconnected', async () => {
            const { socket, colibri } = connect({ app: 'appA' });

            expect(await disconnectReason(socket)).toBe('io server disconnect');
            expect(colibri.map(e => e.command)).toEqual(['protocol::rejected']);
            expect(colibri[0]?.payload).toMatchObject({ serverVersion: PROTOCOL_VERSION });
            expect(connected).toEqual([]);
        });
    });

    // The admin UI ships with the server, so a mismatch there is a bug to be warned about, not a
    // reason to lock the operator out of their own console.
    describe('the admin UI', () => {
        it('is warned about but accepted when it announces another version', async () => {
            const { socket } = connect({ app: 'colibri', version: '1' });

            const announced = await nextColibriEvent(socket);

            expect(announced.command).toBe('protocol::accepted');
            expect(socket.connected).toBe(true);
            expect(server.currentClients.map(c => c.app)).toEqual(['colibri']);
            expect(logged(LogLevel.Warn).some(m => m.includes('Admin UI client') && m.includes(`v${PROTOCOL_VERSION}`))).toBe(true);
            expect(logged(LogLevel.Error)).toEqual([]);
        });
    });

    describe('a client announcing the supported version', () => {
        it('is told which version this server speaks, before anything else', async () => {
            const { socket } = connect({ app: 'appA', version: PROTOCOL_VERSION });

            const first = await nextColibriEvent(socket);

            expect(first).toEqual({ command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
            expect(socket.connected).toBe(true);
        });

        it('joins its app', async () => {
            const { socket } = connect({ app: 'appA', version: PROTOCOL_VERSION });
            await nextColibriEvent(socket);

            expect(connected.map(c => c.app)).toEqual(['appA']);
            expect(server.hasRecipients('appA')).toBe(true);
            expect(logged(LogLevel.Error)).toEqual([]);
        });
    });
});
