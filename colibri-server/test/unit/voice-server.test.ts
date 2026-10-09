import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as dgram from 'dgram';
import { once } from 'events';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
import { Subscription } from 'rxjs';
import wavefile from 'wavefile';
import { VoiceServer, wavHeader } from '../../src/server/modules/web/voice-server.js';
import { VoiceCodec, encodeVoicePacket, voiceAppId } from '../../src/server/modules/web/voice-packet.js';
import { ConsoleLog, LogLevel, LogMessage, Service } from '../../src/server/modules/core/index.js';

const { WaveFile } = wavefile;

const APP = voiceAppId('voice-test');

// A PCM voice packet of `appId`, as Unity sends it.
const voicePacket = function (userId: number, sequence: number, data: number[] = [ 0, 0 ], appId = APP): Buffer {
    return encodeVoicePacket({ appId, userId, sequence, frameSize: 960, codec: VoiceCodec.PCM, data: Buffer.from(data) });
};

// A PCM packet carrying `samples` as 16-bit little-endian values.
const pcmPacket = function (userId: number, sequence: number, samples: number[]): Buffer {
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
    return Buffer.concat([ voicePacket(userId, sequence, []), data ]);
};

interface VoiceServerInternals {
    udpSocket: dgram.Socket;
    clients: Map<string, unknown>;
    reportedAt: Map<string, number>;
    savingRecordings: Promise<void> | undefined;
    pruneReports(nowMillis: number): void;
    checkClientsDisconnected(): Promise<void>;
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
    const relayFailures = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error && /failed to relay/i.test(l.message));

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

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const socket of sockets) socket.close();
        await server.stop();
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

    it('rejects every length up to the 11-byte header, and accepts a header-only packet', async () => {
        const a = await openClient();
        const b = await openClient();

        for (let length = 0; length < 11; length++) {
            // The 0..10-byte prefix of a well-formed packet: only the full header may register.
            await send(a, voicePacket(1, 1).subarray(0, length));
        }
        await send(b, voicePacket(2, 1));
        // a has not been registered by any of those, so nothing reaches it yet; b is the
        // only client. A header-only (11-byte) packet from a then registers a.
        await send(a, voicePacket(1, 1, []));
        const relayed = await roundTrip(b, a, 2);

        expect(relayed).toEqual(voicePacket(2, 1));
        expect(internals.clients.size).toBe(2);
        // All eleven short ones came from a, so they were reported once.
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
        internals.pruneReports(Date.now() + 10000);
        expect(internals.reportedAt.size).toBe(0);
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

    it('keeps relaying to the other peers when send() throws for one of them', async () => {
        // Nothing that registers through the listener fails send()'s argument checks any more
        // (port 0 is dropped above), so a peer it rejects is planted directly. It goes in first,
        // so every relay reaches it before a and b.
        internals.clients.set('127.0.0.1:0', {
            ip: '127.0.0.1', port: 0, userId: 9, appId: APP, lastSequence: 0, lastHeartbeat: Date.now(),
            frameSize: 960, frameSizeMillis: 20, codec: 0, recordingStartDate: new Date(), recordingData: { length: 0 },
        });
        const a = await openClient();
        const b = await openClient();

        // The ERR_SOCKET_BAD_PORT thrown for the planted peer used to escape the listener
        // (an uncaught exception) and skip every peer after it.
        await send(a, voicePacket(1, 1));
        for (let i = 0; i < 5; i++) {
            expect(await roundTrip(b, a, 2)).toEqual(voicePacket(2, 1));
            expect(await roundTrip(a, b, 1)).toEqual(voicePacket(1, 1));
        }

        // Ten failed relays to it, reported once.
        expect(relayFailures()).toHaveLength(1);
        expect(relayFailures()[0]!.message).toContain('127.0.0.1:0');
        expect(relayFailures()[0]!.message).toContain('Port should be > 0');
    });

    it('reports a peer that keeps failing asynchronously once per interval', async () => {
        const a = await openClient();
        const b = await openClient();
        const bPort = (b.address() as AddressInfo).port;

        // An asynchronous send error, as for a peer that has dropped off the network
        // (EHOSTUNREACH), arrives in the callback for every packet relayed to it.
        const realSend = internals.udpSocket.send.bind(internals.udpSocket) as (...args: unknown[]) => void;
        vi.spyOn(internals.udpSocket, 'send').mockImplementation(((...args: unknown[]) => {
            if (args[3] !== bPort) return realSend(...args);
            const callback = args[args.length - 1] as (err: Error | null) => void;
            setImmediate(() => callback(Object.assign(new Error('send EHOSTUNREACH'), { code: 'EHOSTUNREACH' })));
        }) as never);

        await send(b, voicePacket(2, 1));
        for (let i = 0; i < 5; i++) {
            await send(a, voicePacket(1, 1));
            expect(await roundTrip(b, a, 2)).toEqual(voicePacket(2, 1));
        }
        await new Promise(resolve => setImmediate(resolve));

        expect(relayFailures()).toHaveLength(1);
        expect(relayFailures()[0]!.message).toContain(`127.0.0.1:${bPort}: send EHOSTUNREACH`);

        // A peer's own malformed packets are reported separately from relay failures to it.
        await send(b, [ 1, 2 ]);
        await roundTrip(b, a, 2);
        expect(malformedReports()).toHaveLength(1);
    });

    it('bounds what it remembers about malformed senders', () => {
        // Synthetic deliveries from many distinct sources, as from a flood of spoofed
        // addresses - no real socket can send from that many ports quickly.
        for (let i = 0; i < 5000; i++) {
            internals.udpSocket.emit('message', Buffer.from([ 1, 2 ]), { address: '10.0.0.1', port: 1024 + i, family: 'IPv4', size: 2 });
        }

        expect(internals.reportedAt.size).toBeLessThanOrEqual(100);
        expect(malformedReports().length).toBeLessThanOrEqual(100);
        expect(internals.clients.size).toBe(0);
    });
});

describe('VoiceServer startup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The 'listening' handler printed 'Voice server listening on ...' with a bare console.log
    // and then logged the same line, which the console sink prints as well.
    it('says it is listening exactly once', async () => {
        const printed: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        // The sink main.ts attaches, writing here instead of to stdout/stderr.
        const sink = new ConsoleLog({ minLevel: LogLevel.Debug, broadcastTraffic: false }, {
            out: line => printed.push(line),
            err: line => printed.push(line),
        });
        const subscription = sink.attach(Service.output$);

        const server = new VoiceServer(48000, '/nonexistent-voice-recordings');
        try {
            server.start(0, '127.0.0.1');
            await once((server as unknown as VoiceServerInternals).udpSocket, 'listening');

            const listening = printed.filter(line => line.includes('Voice server listening on'));
            expect(listening).toHaveLength(1);
            expect(listening[0]).toMatch(/ INFO {2}\[web\/VoiceServer\] Voice server listening on 127\.0\.0\.1:\d+$/);
        } finally {
            subscription.unsubscribe();
            await server.stop();
        }
    });

    // The socket's 'error' handler was a bare console.error(err.message): a voice port that
    // was already taken printed only 'bind EADDRINUSE 127.0.0.1:<port>' on stderr, never
    // reached the admin UI's log, and said nothing of voice being off while the rest ran on.
    describe('socket errors', () => {
        let logs: LogMessage[];
        let stderr: string[];
        let consoleError: ReturnType<typeof vi.spyOn>;
        let subscriptions: Subscription[];
        let sockets: dgram.Socket[];
        let server: VoiceServer;

        beforeEach(() => {
            logs = [];
            stderr = [];
            sockets = [];
            consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            // What the admin UI's WebLog sees, and what the sink main.ts attaches prints on stderr.
            const sink = new ConsoleLog({ minLevel: LogLevel.Info, broadcastTraffic: false }, {
                out: () => undefined,
                err: line => stderr.push(line),
            });
            subscriptions = [ Service.output$.subscribe(log => logs.push(log)), sink.attach(Service.output$) ];
            server = new VoiceServer(48000, '/nonexistent-voice-recordings');
        });

        afterEach(async () => {
            for (const subscription of subscriptions) subscription.unsubscribe();
            await server.stop();
            for (const socket of sockets) socket.close();
        });

        const errors = () => logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error);

        it('says where voice could not listen, and that voice is disabled, when the port is taken', async () => {
            const taken = dgram.createSocket('udp4');
            sockets.push(taken);
            taken.bind(0, '127.0.0.1');
            await once(taken, 'listening');
            const port = (taken.address() as AddressInfo).port;

            server.start(port, '127.0.0.1');
            await once((server as unknown as VoiceServerInternals).udpSocket, 'error');

            expect(errors()).toHaveLength(1);
            const message = errors()[0]!.message;
            expect(message).toContain(`Voice server could not listen on UDP 127.0.0.1:${port}`);
            expect(message).toContain('another process is already using');
            expect(message).toContain(`bind EADDRINUSE 127.0.0.1:${port}`);
            expect(message).toContain('Voice is disabled');
            expect(stderr).toHaveLength(1);
            expect(stderr[0]).toMatch(/ ERROR \[web\/VoiceServer\] Voice server could not listen on UDP /);
            expect(consoleError).not.toHaveBeenCalled();
            // afterEach then stops it, which must not throw for a socket that never listened.
        });

        it('reports an error once it is listening with its context, once per interval', async () => {
            server.start(0, '127.0.0.1');
            const udpSocket = (server as unknown as VoiceServerInternals).udpSocket;
            await once(udpSocket, 'listening');

            for (let i = 0; i < 3; i++) {
                udpSocket.emit('error', Object.assign(new Error('recvmsg ECONNRESET'), { code: 'ECONNRESET' }));
            }

            expect(errors()).toHaveLength(1);
            expect(errors()[0]!.message).toContain('Voice server socket error on UDP 127.0.0.1:0: recvmsg ECONNRESET');
            expect(errors()[0]!.message).not.toContain('Voice is disabled');
            expect(consoleError).not.toHaveBeenCalled();
        });
    });
});

describe('VoiceServer recordings', () => {
    const SAMPLING_RATE = 48000;

    let dir: string;
    let server: VoiceServer;
    let internals: VoiceServerInternals;
    let port: number;
    let sockets: dgram.Socket[];
    let logs: LogMessage[];
    let logSubscription: Subscription;

    beforeEach(async () => {
        sockets = [];
        logs = [];
        logSubscription = Service.output$.subscribe(log => logs.push(log));
        dir = await mkdtemp(path.join(tmpdir(), 'colibri-voice-recordings-'));

        server = new VoiceServer(SAMPLING_RATE, dir, true);
        internals = server as unknown as VoiceServerInternals;
        server.start(0, '127.0.0.1');
        await once(internals.udpSocket, 'listening');
        port = (internals.udpSocket.address() as AddressInfo).port;
    });

    afterEach(async () => {
        logSubscription.unsubscribe();
        for (const socket of sockets) socket.close();
        await server.stop();
        await rm(dir, { recursive: true, force: true });
    });

    const openClient = async (): Promise<dgram.Socket> => {
        const socket = dgram.createSocket('udp4');
        sockets.push(socket);
        socket.bind(0, '127.0.0.1');
        await once(socket, 'listening');
        return socket;
    };

    const send = (socket: dgram.Socket, bytes: Buffer): Promise<void> =>
        new Promise((resolve, reject) => socket.send(bytes, port, '127.0.0.1', err => err ? reject(err) : resolve()));

    // Sends `samples` from a new client as user `userId`, 480 to a packet, and returns once the
    // server has handled every packet: each is relayed to a listener registered beforehand,
    // which sends nothing that would be recorded itself.
    const talk = async (userId: number, samples: number[]): Promise<void> => {
        const listener = await openClient();
        await send(listener, voicePacket(99, 0, []));
        const speaker = await openClient();
        for (let i = 0; i < samples.length; i += 480) {
            const relayed = once(listener, 'message');
            await send(speaker, pcmPacket(userId, i / 480, samples.slice(i, i + 480)));
            await relayed;
        }
    };

    const recordings = async () => (await readdir(dir)).filter(name => name.endsWith('.wav')).sort();

    const readSamples = async (name: string): Promise<number[]> => {
        const wav = new WaveFile(await readFile(path.join(dir, name)));
        expect(wav.fmt).toMatchObject({ audioFormat: 1, numChannels: 1, sampleRate: SAMPLING_RATE, bitsPerSample: 16 });
        return Array.from(wav.getSamples(false, Int16Array) as unknown as Int16Array);
    };

    const savedLogs = () => logs.filter(l => l.origin === 'VoiceServer' && /Voice recording of client ID \d+ .* saved to /.test(l.message));

    const someSamples = (count: number, seed: number) => Array.from({ length: count }, (_, i) => Math.round(30000 * Math.sin((i + seed) / 7)));

    // A recording used to be saved only once its client had been quiet for 2 s. stop() closed the
    // socket and returned, so `docker stop` or a restart while anyone was still talking left no
    // .wav file, and no log line saying a recording had been dropped.
    it('saves a recording still in progress when it stops, and logs it', async () => {
        const samples = someSamples(4800, 0);
        await talk(7, samples);
        expect(await recordings()).toEqual([]);

        await server.stop();

        const files = await recordings();
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^rec_\d{4}-\d\d-\d\dT\d\d_\d\d_\d\d\.\d{3}Z_ID_7\.wav$/);
        expect(await readSamples(files[0]!)).toEqual(samples);

        const saved = savedLogs();
        expect(saved).toHaveLength(1);
        // Info, so the default CONSOLE_LOG_LEVEL prints it.
        expect(saved[0]!.level).toBe(LogLevel.Info);
        expect(saved[0]!.message).toContain('Voice recording of client ID 7 (127.0.0.1:');
        expect(saved[0]!.message).toContain(`, 0.1 s) saved to ${path.join(dir, files[0]!)}`);
    });

    it('saves every client\'s recording when it stops', async () => {
        const first = someSamples(960, 1);
        const second = someSamples(1440, 2);
        await talk(1, first);
        await talk(2, second);

        await server.stop();

        const files = await recordings();
        expect(files.map(name => name.replace(/^rec_.*_ID_/, ''))).toEqual([ '1.wav', '2.wav' ]);
        expect(await readSamples(files[0]!)).toEqual(first);
        expect(await readSamples(files[1]!)).toEqual(second);
        expect(savedLogs()).toHaveLength(2);
    });

    it('waits for a save the disconnect check started before it saves the rest', async () => {
        await talk(3, someSamples(480, 3));
        let release!: () => void;
        internals.savingRecordings = new Promise<void>(resolve => release = resolve);

        let stopped = false;
        const stopping = server.stop().then(() => stopped = true);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(stopped).toBe(false);
        expect(await recordings()).toEqual([]);

        release();
        await stopping;
        expect(await recordings()).toHaveLength(1);
    });

    it('still saves when its socket has been closed already', async () => {
        await talk(4, someSamples(480, 4));
        internals.udpSocket.close();

        await server.stop();

        expect(await recordings()).toHaveLength(1);
    });

    it('saves a recording once, when its client goes quiet, and not again when it stops', async () => {
        const samples = someSamples(960, 5);
        await talk(5, samples);
        for (const client of internals.clients.values()) (client as { lastHeartbeat: number }).lastHeartbeat -= 5000;

        await internals.checkClientsDisconnected();
        const files = await recordings();
        expect(files).toHaveLength(1);
        expect(await readSamples(files[0]!)).toEqual(samples);

        await server.stop();
        expect(await recordings()).toEqual(files);
        expect(savedLogs()).toHaveLength(1);
    });

    it('logs a recording it cannot save, and saves the others', async () => {
        await talk(6, someSamples(480, 6));
        await talk(8, someSamples(480, 8));
        // A directory where client 6's file would go.
        const client6 = Array.from(internals.clients.values()).find(client => (client as { userId: number }).userId === 6) as { recordingStartDate: Date };
        await mkdir(path.join(dir, `rec_${client6.recordingStartDate.toISOString().replace(/:/g, '_')}_ID_6.wav`));

        await server.stop();

        const failed = logs.filter(l => l.origin === 'VoiceServer' && l.level === LogLevel.Error);
        expect(failed).toHaveLength(1);
        expect(failed[0]!.message).toContain('Failed to save the voice recording of client ID 6 (127.0.0.1:');
        expect(failed[0]!.message).toContain('EISDIR');
        expect((await recordings()).filter(name => name.endsWith('_ID_8.wav'))).toHaveLength(1);
        expect(savedLogs()).toHaveLength(1);
    });

    // wavefile's fromScratch and toBuffer re-encoded every sample on the main thread: about
    // 1 to 4 s for a 10-minute recording, during which no TCP or Socket.IO message was relayed.
    it('saves a 10-minute recording without holding up the event loop', async () => {
        const samples = new Int16Array(SAMPLING_RATE * 600);
        for (let i = 0; i < samples.length; i++) samples[i] = (i * 31) % 20000 - 10000;
        internals.clients.set('127.0.0.1:9', {
            ip: '127.0.0.1', port: 9, userId: 9, appId: APP, lastSequence: 0, lastHeartbeat: Date.now(),
            frameSize: 480, frameSizeMillis: 10, codec: 0, recordingStartDate: new Date(),
            recordingData: { length: samples.length, toTypedArray: () => samples },
        });

        let longestGap = 0;
        let last = performance.now();
        const ticker = setInterval(() => {
            const now = performance.now();
            longestGap = Math.max(longestGap, now - last);
            last = now;
        }, 5);
        try {
            await server.stop();
        } finally {
            clearInterval(ticker);
        }
        longestGap = Math.max(longestGap, performance.now() - last);

        expect(longestGap).toBeLessThan(500);
        const files = await recordings();
        expect(files).toHaveLength(1);
        const bytes = await readFile(path.join(dir, files[0]!));
        expect(bytes.length).toBe(44 + samples.byteLength);
        expect(bytes.subarray(44).equals(Buffer.from(samples.buffer))).toBe(true);
    });
});

describe('wavHeader', () => {
    // The format the recordings had when wavefile wrote them, byte for byte.
    it.each([ 48000, 44100, 16000 ])('makes the same file as wavefile at %i Hz', (rate) => {
        const samples = new Int16Array([ 0, 1, -1, 32767, -32768, 1234, -4321 ]);
        const wav = new WaveFile();
        wav.fromScratch(1, rate, '16', samples);

        const ours = Buffer.concat([ wavHeader(rate, samples.byteLength), Buffer.from(samples.buffer) ]);

        expect(ours.equals(Buffer.from(wav.toBuffer()))).toBe(true);
    });

    it('makes the same header as wavefile for an empty recording', () => {
        const wav = new WaveFile();
        wav.fromScratch(1, 48000, '16', new Int16Array(0));

        expect(wavHeader(48000, 0).equals(Buffer.from(wav.toBuffer()))).toBe(true);
    });

    it('marks the sizes "up to the end of the file" past the 4 GiB they can hold, instead of throwing', () => {
        const header = wavHeader(48000, 5 * 1024 ** 3);

        expect(header.readUInt32LE(4)).toBe(0xFFFFFFFF);
        expect(header.readUInt32LE(40)).toBe(0xFFFFFFFF);
    });
});
