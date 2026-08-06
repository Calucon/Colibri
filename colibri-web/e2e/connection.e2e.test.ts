import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'socket.io-client';
import { PROTOCOL_VERSION } from '../src/Colibri';
import { HOST, PORT, createClient, disconnectAll, nextMessage, uniqueApp } from './helpers';

afterEach(() => {
    disconnectAll();
});

describe('connecting to a real colibri-server', () => {
    it('completes the version-2 handshake and receives the latency heartbeat', async () => {
        const client = await createClient(uniqueApp('connection'));

        const msg = await nextMessage(client, { channel: 'colibri', command: 'latency' }, 3000);

        expect(msg.channel).toBe('colibri');
        expect(msg.command).toBe('latency');
    });

    it('supports two independently connected clients on different apps', async () => {
        const a = await createClient(uniqueApp('connection-a'));
        const b = await createClient(uniqueApp('connection-b'));

        const [msgA, msgB] = await Promise.all([
            nextMessage(a, { channel: 'colibri', command: 'latency' }, 3000),
            nextMessage(b, { channel: 'colibri', command: 'latency' }, 3000)
        ]);

        expect(msgA.command).toBe('latency');
        expect(msgB.command).toBe('latency');
    });

    // The Colibri class always announces PROTOCOL_VERSION, so a mismatch can only be
    // produced with a raw socket - which is also the honest shape of the test, since what
    // matters is what the *server* does with a version it does not support.
    it('refuses a client announcing an unsupported protocol version', async () => {
        const socket = connect(`ws://${HOST}:${PORT}`, {
            query: { app: uniqueApp('protocol-mismatch'), version: `${PROTOCOL_VERSION}-wrong` },
            transports: ['websocket'],
            reconnection: false
        });

        try {
            const rejection = await new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('no rejection received'));
                }, 5000);
                socket.on('colibri', (msg: { command: string; payload: Record<string, unknown> }) => {
                    if (msg.command !== 'protocol::rejected') return;
                    clearTimeout(timer);
                    resolve(msg.payload);
                });
            });

            expect(rejection.serverVersion).toBe(PROTOCOL_VERSION);
            expect(rejection.clientVersion).toBe(`${PROTOCOL_VERSION}-wrong`);
            expect(String(rejection.reason)).toContain('Unsupported protocol version');

            // And the server must not leave the refused client connected.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    reject(new Error('server never closed the connection'));
                }, 5000);
                if (!socket.connected) {
                    clearTimeout(timer);
                    resolve();
                    return;
                }
                socket.on('disconnect', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        } finally {
            socket.disconnect();
        }
    });
});
