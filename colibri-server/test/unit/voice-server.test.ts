import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as dgram from 'dgram';
import { once } from 'events';
import { AddressInfo } from 'net';
import { Subscription } from 'rxjs';
import { VoiceServer } from '../../src/server/modules/web/voice-server.js';
import { LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';

// |userId(2)|sequence(2)|frameSize(2)|codec(1)|data|, little-endian, as Unity sends it.
const voicePacket = function (userId: number, sequence: number, data: number[] = [ 0, 0 ]): Buffer {
    const header = Buffer.alloc(7);
    header.writeInt16LE(userId, 0);
    header.writeInt16LE(sequence, 2);
    header.writeInt16LE(960, 4);
    header.writeInt8(0, 6); // PCM
    return Buffer.concat([ header, Buffer.from(data) ]);
};

interface VoiceServerInternals {
    udpSocket: dgram.Socket;
    clients: Map<string, unknown>;
    malformedReportedAt: Map<string, number>;
    pruneMalformedReports(nowMillis: number): void;
}

describe('VoiceServer', () => {
    let server: VoiceServer;
    let internals: VoiceServerInternals;
    let port: number;
    let sockets: dgram.Socket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;

    const openClient = async (): Promise<dgram.Socket> => {
        const socket = dgram.createSocket('udp4');
        sockets.push(socket);
        socket.bind(0, '127.0.0.1');
        await once(socket, 'listening');
        return socket;
    };

    const send = (socket: dgram.Socket, bytes: Buffer | number[]): Promise<void> =>
        new Promise((resolve, reject) => socket.send(Buffer.from(bytes), port, '127.0.0.1', err => err ? reject(err) : resolve()));

    const nextMessage = (socket: dgram.Socket): Promise<Buffer> =>
        new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('no voice packet relayed within 2s')), 2000);
            socket.once('message', (msg) => {
                clearTimeout(timeout);
                resolve(msg);
            });
        });

    const malformedReports = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error && /malformed/i.test(l.message));

    // Relays a valid packet from `from` to `to` and waits for it: a datagram sent earlier from
    // the same loopback socket has been handled by the time this one comes out the other side.
    const roundTrip = async (from: dgram.Socket, to: dgram.Socket, userId: number): Promise<Buffer> => {
        const relayed = nextMessage(to);
        await send(from, voicePacket(userId, 1));
        return relayed;
    };

    beforeEach(async () => {
        sockets = [];
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));

        server = new VoiceServer(48000, '/nonexistent-voice-recordings');
        internals = server as unknown as VoiceServerInternals;
        server.start(0, '127.0.0.1');
        await once(internals.udpSocket, 'listening');
        port = (internals.udpSocket.address() as AddressInfo).port;
    });

    afterEach(() => {
        logSubscription.unsubscribe();
        for (const socket of sockets) socket.close();
        server.stop();
    });

    it('survives a datagram shorter than the header and still relays valid packets', async () => {
        const a = await openClient();
        const b = await openClient();

        // The 2-byte datagram that used to kill the process with ERR_OUT_OF_RANGE.
        await send(a, [ 1, 2 ]);

        // a registers with a valid packet, then b's packet is relayed to a.
        await send(a, voicePacket(1, 1));
        const relayed = await roundTrip(b, a, 2);

        expect(relayed).toEqual(voicePacket(2, 1));
        expect(malformedReports()).toHaveLength(1);
        expect(malformedReports()[0]!.message).toContain(`127.0.0.1:${(a.address() as AddressInfo).port}`);
    });

    it('rejects every length up to the 7-byte header, and accepts a header-only packet', async () => {
        const a = await openClient();
        const b = await openClient();

        for (let length = 0; length < 7; length++) {
            // The 0..6-byte prefix of a well-formed packet: only the full header may register.
            await send(a, voicePacket(1, 1).subarray(0, length));
        }
        await send(b, voicePacket(2, 1));
        // a has not been registered by any of those, so nothing reaches it yet; b is the
        // only client. A header-only (7-byte) packet from a then registers a.
        await send(a, voicePacket(1, 1, []));
        const relayed = await roundTrip(b, a, 2);

        expect(relayed).toEqual(voicePacket(2, 1));
        expect(internals.clients.size).toBe(2);
        // All seven short ones came from a, so they were reported once.
        expect(malformedReports()).toHaveLength(1);
    });

    it('reports malformed packets once per source per interval', async () => {
        const a = await openClient();
        const b = await openClient();

        await send(a, [ 1, 2 ]);
        await send(a, [ 1, 2, 3 ]);
        await send(a, [ 1 ]);
        await send(a, voicePacket(1, 1));
        await roundTrip(b, a, 2);
        expect(malformedReports()).toHaveLength(1);

        // A different source is reported on its own.
        await send(b, [ 9, 9 ]);
        await roundTrip(a, b, 1);
        expect(malformedReports()).toHaveLength(2);

        // Once the interval has passed, the same source is reported again.
        internals.pruneMalformedReports(Date.now() + 10000);
        expect(internals.malformedReportedAt.size).toBe(0);
        await send(a, [ 1, 2 ]);
        await roundTrip(a, b, 1);
        expect(malformedReports()).toHaveLength(3);
    });

    it('drops a datagram from source port 0 instead of crashing on the next relay', async () => {
        const a = await openClient();
        const b = await openClient();

        // Only a raw socket can send from port 0, so this delivery is synthetic. A valid
        // packet from port 0 used to register a peer that udpSocket.send() rejects
        // synchronously (ERR_SOCKET_BAD_PORT), so relaying the next packet from anyone else
        // threw out of the 'message' listener: an uncaught exception that stops the server.
        internals.udpSocket.emit('message', voicePacket(9, 1), { address: '127.0.0.1', port: 0, family: 'IPv4', size: 9 });
        expect(internals.clients.size).toBe(0);

        // a and b register and relay to each other as if nothing had happened.
        await send(a, voicePacket(1, 1));
        expect(await roundTrip(b, a, 2)).toEqual(voicePacket(2, 1));
        expect(await roundTrip(a, b, 1)).toEqual(voicePacket(1, 1));

        expect(internals.clients.size).toBe(2);
        expect(malformedReports()).toHaveLength(1);
        expect(malformedReports()[0]!.message).toContain('127.0.0.1:0');
    });

    it('bounds what it remembers about malformed senders', () => {
        // Synthetic deliveries from many distinct sources, as from a flood of spoofed
        // addresses - no real socket can send from that many ports quickly.
        for (let i = 0; i < 5000; i++) {
            internals.udpSocket.emit('message', Buffer.from([ 1, 2 ]), { address: '10.0.0.1', port: 1024 + i, family: 'IPv4', size: 2 });
        }

        expect(internals.malformedReportedAt.size).toBeLessThanOrEqual(100);
        expect(malformedReports().length).toBeLessThanOrEqual(100);
        expect(internals.clients.size).toBe(0);
    });
});
