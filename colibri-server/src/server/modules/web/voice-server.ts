import { Service } from '../core/index.js';
import * as dgram from 'dgram';
import { AddressInfo } from 'net';
import { mkdir, writeFile } from 'fs/promises';
import { endianness } from 'os';
import * as path from 'path';

// Recordings can run for minutes at 48kHz, so a plain number[] would mean millions of
// boxed-double pushes. This keeps samples in a flat Int16Array, growing (doubling) only
// when the current capacity is exhausted, same trade-off as FrameReader's growable buffer.
class GrowableInt16Buffer {
    private data: Int16Array;
    private len = 0;

    public constructor(initialCapacity = 48000) {
        this.data = new Int16Array(initialCapacity);
    }

    public get length(): number {
        return this.len;
    }

    public push(value: number): void {
        if (this.len >= this.data.length) {
            const grown = new Int16Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        this.data[this.len++] = value;
    }

    public toTypedArray(): Int16Array {
        return this.data.subarray(0, this.len);
    }
}

interface VoiceClient {
    ip: string;
    port: number;
    userId: number;
    lastSequence: number;
    lastHeartbeat: number;
    frameSize: number; // How many samples are sent at one time
    frameSizeMillis: number;
    codec: Codec;
    recordingStartDate: Date;
    recordingData: GrowableInt16Buffer;
}

enum Codec {
    PCM,
    OPUS
}

// |userId(2)|sequence(2)|frameSize(2)|codec(1)|, see the message handler.
const HEADER_LENGTH = 7;

const WAV_HEADER_LENGTH = 44;

/**
 * The 44-byte RIFF header of a mono, 16-bit PCM .wav file holding `dataBytes` bytes of samples.
 *
 * Written by hand because it is all a recording needs: building the file with wavefile
 * (fromScratch, then toBuffer) re-encoded every sample on the main thread, which held up all
 * TCP and Socket.IO relaying for seconds when a long recording was saved.
 */
export const wavHeader = function (samplingRate: number, dataBytes: number): Buffer {
    // The sizes are 32-bit. Past 4 GiB (12 h at 48 kHz) they say "as much as there is", which
    // players read to the end of the file, instead of failing the save and losing it all.
    const size = (value: number) => Math.min(value, 0xFFFFFFFF);
    const header = Buffer.alloc(WAV_HEADER_LENGTH);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(size(WAV_HEADER_LENGTH - 8 + dataBytes), 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(samplingRate, 24);
    header.writeUInt32LE(samplingRate * 2, 28); // bytes per second
    header.writeUInt16LE(2, 32); // bytes per sample frame
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(size(dataBytes), 40);
    return header;
};

/** The samples as the little-endian bytes a .wav file holds, without copying them where it can. */
const littleEndianBytes = function (samples: Int16Array): Buffer {
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    return endianness() === 'LE' ? bytes : Buffer.from(bytes).swap16();
};

// A source sending malformed packets, or a peer that can't be relayed to, fails at packet rate
// (up to ~50/s per voice client), so each is reported at most once per this interval rather
// than once per packet...
const REPORT_INTERVAL_MILLIS = 10000;
// ...and only this many distinct sources and peers are remembered at a time, so a burst from
// many addresses can't grow the map without bound. Once full, new ones go unreported until
// the next prune frees a slot.
const REPORT_MAX_KEYS = 100;

export class VoiceServer extends Service {

    public get serviceName(): string { return 'VoiceServer'; }
    public get groupName(): string { return 'web'; }

    private udpSocket!: dgram.Socket;
    private clients: Map<string, VoiceClient> = new Map<string, VoiceClient>();
    private disconnectTimeoutMillis = 2000;
    private disconnectCheckInterval!: NodeJS.Timeout;

    // Rebuilt only when a client joins or times out, instead of re-scanning/re-deriving
    // `this.clients` on every incoming voice packet (received at up to ~50 packets/s/client).
    private clientsCache: VoiceClient[] | undefined;

    // The recordings checkClientsDisconnected is saving, while it is. Guards it against
    // overlapping fs work when a save outlives its tick (see the comment there), and lets
    // stop() wait for it.
    private savingRecordings: Promise<void> | undefined;

    // Report key (see reportMalformedPacket and reportRelayFailure) -> when it was last
    // reported. See REPORT_INTERVAL_MILLIS; pruned every disconnect-check tick.
    private readonly reportedAt = new Map<string, number>();

    public constructor(private samplingRate: number, private voiceRecordingPath: string, private recordingVoiceData: boolean = false) {
        super();
    }

    public start(voicePort: number, hostname: string) {
        let listening = false;
        this.udpSocket = dgram.createSocket('udp4');
        this.udpSocket.on('listening', () => {
            listening = true;
            const address = this.udpSocket.address() as AddressInfo;
            this.logInfo(`Voice server listening on ${address.address}:${address.port}`);
            this.logInfo(`Voice server Sampling Rate: ${this.samplingRate} Hz`);
            if (this.recordingVoiceData) this.logWarning('Warning: Voice recording is enabled');
        });
        this.udpSocket.on('message', (message, remote) => {
            const now = new Date();
            const nowMillis = now.getTime();
            const clientKey = `${remote.address}:${remote.port}`;

            // Every header read below is at a fixed offset, so the whole header has to be
            // there. This used to check for only 2 bytes: a single 2-6 byte datagram then
            // reached readInt16LE(2)/readInt8(6), and the ERR_OUT_OF_RANGE thrown out of this
            // listener was an uncaught exception that shut the whole server down.
            if (message.length < HEADER_LENGTH) {
                this.reportMalformedPacket(clientKey, `${message.length} bytes is shorter than the ${HEADER_LENGTH}-byte header`, nowMillis);
                return;
            }

            // Source port 0 means the sender named no port to reply to (RFC 768), and nothing
            // can be sent back to it: udpSocket.send() rejects port 0 synchronously with
            // ERR_SOCKET_BAD_PORT.
            // Such a sender used to register like any other, and the next packet from anyone
            // else threw out of this listener while relaying to it and shut the server down.
            // Only a raw socket can send one, but that is one packet from any machine on the LAN.
            if (remote.port === 0) {
                this.reportMalformedPacket(clientKey, 'its source port is 0, so nothing can be relayed back to it', nowMillis);
                return;
            }

            // Voice message with 7 bytes header: |userId(2)|sequence(2)|frameSize(2)|codec(1)|data|
            const userId = message.readInt16LE(0); // .net (Unity) decodes default in little-endian order
            const sequence = message.readInt16LE(2);
            const frameSize = message.readInt16LE(4);
            const codec: Codec = message.readInt8(6);

            // Current voice client
            let voiceClient = this.clients.get(clientKey);

            // Add to clients if new client
            if (!voiceClient) {
                voiceClient = {
                    ip: remote.address,
                    port: remote.port,
                    userId: userId,
                    lastSequence: sequence,
                    lastHeartbeat: nowMillis,
                    frameSize,
                    frameSizeMillis: frameSize / this.samplingRate * 1000,
                    codec,
                    recordingStartDate: now,
                    recordingData: new GrowableInt16Buffer(),
                };
                this.clients.set(clientKey, voiceClient);
                this.clientsCache = undefined;
                this.logDebug(`New voice client connected from ${remote.address}:${remote.port} ID: ${userId} Codec: ${codec === Codec.OPUS ? 'Opus' : 'PCM'}`);
                if (this.recordingVoiceData) {
                    this.logWarning('Warning: Voice recording is enabled');
                    if (codec !== Codec.PCM) this.logWarning('Voice recording is only supported for PCM data');
                }
            }

            // Update last heartbeat
            voiceClient.lastSequence = sequence;
            voiceClient.lastHeartbeat = nowMillis;

            // Send message to all other clients
            for (const peer of this.getClientsCache()) {
                if (peer === voiceClient) continue;

                // send() checks its arguments synchronously and throws, and anything thrown
                // out of this listener is an uncaught exception that shuts the server down.
                // Nothing that registers should fail those checks (see the port 0 check
                // above), so this is a backstop. It also keeps one peer that can't be sent
                // to from stopping the relay to every peer after it.
                try {
                    this.udpSocket.send(message, 0, message.length, peer.port, peer.ip, (err) => {
                        if (err) this.reportRelayFailure(peer, err, Date.now());
                    });
                } catch (err) {
                    this.reportRelayFailure(peer, err, nowMillis);
                }
            }

            if (codec === Codec.PCM && this.recordingVoiceData) {
                // i + 2 <= length: an odd trailing byte is dropped rather than over-read.
                for (let i = HEADER_LENGTH; i <= message.length - 2; i += 2) {
                    voiceClient.recordingData.push(message.readInt16LE(i));
                }
            }
        });
        // A failed bind (the voice port taken, a VOICE_HOST that does not resolve or is not
        // this machine's) is only ever reported here, and the rest of the server runs on
        // without voice. This used to be a bare console.error of the message - on stderr
        // only, never in the admin UI's log, and as nothing more than
        // 'bind EADDRINUSE 0.0.0.0:9013', without saying what had failed or what it meant.
        this.udpSocket.on('error', (err: NodeJS.ErrnoException) => {
            if (!listening) {
                const inUse = err.code === 'EADDRINUSE' ? ', which another process is already using' : '';
                this.logError(`Voice server could not listen on UDP ${hostname}:${voicePort}${inUse}: ${err.message}. `
                    + 'Voice is disabled until the server is restarted with a VOICE_HOST and VOICE_PORT it can listen on; '
                    + 'everything else keeps running.', false);
                return;
            }
            // Once it listens, this is a failed receive, which a peer could cause at packet rate.
            if (!this.claimReport('socket error', Date.now())) return;
            this.logError(`Voice server socket error on UDP ${hostname}:${voicePort}: ${err.message}`
                + ` (further ones are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
        });
        this.udpSocket.bind(voicePort, hostname);

        // Check if clients disconnected every second
        this.disconnectCheckInterval = setInterval(() => {
            this.pruneReports(Date.now());
            void this.checkClientsDisconnected();
        }, 1000);
    }

    // Tolerates never having been started, for the same reason as SocketIOServer.stop().
    //
    // Saves every recording still held before it resolves. A recording used to be saved only
    // once its client had been quiet for disconnectTimeoutMillis, so stopping the server (docker
    // stop, a restart, a crash) while anyone was still talking, or within 2 s of them stopping,
    // dropped their whole recording without a word.
    public async stop(): Promise<void> {
        if (this.disconnectCheckInterval) clearInterval(this.disconnectCheckInterval);
        if (this.udpSocket) {
            // Throws if the socket is closed already. That must not cost the recordings below.
            try {
                this.udpSocket.close();
            } catch {
                // Nothing left to close.
            }
        }

        // A save the last disconnect check started may still be writing. Waiting for it keeps
        // the two from writing at once; the clients it is saving are no longer in the map.
        await this.savingRecordings;

        const pendingRecordings = Array.from(this.clients.values()).filter(client => client.recordingData.length > 0);
        this.clients.clear();
        this.clientsCache = undefined;
        if (pendingRecordings.length === 0) return;

        this.logInfo(`Saving ${pendingRecordings.length} voice recording(s) still in progress before stopping`);
        for (const client of pendingRecordings) {
            await this.saveRecording(client);
        }
    }

    private reportMalformedPacket(source: string, reason: string, nowMillis: number): void {
        if (!this.claimReport(source, nowMillis)) return;

        this.logError(`Ignoring malformed voice packet from ${source}: ${reason}`
            + ` (further ones from this source are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
    }

    private reportRelayFailure(peer: VoiceClient, err: unknown, nowMillis: number): void {
        const target = `${peer.ip}:${peer.port}`;
        // Keyed apart from the peer's own malformed packets, so neither report hides the other.
        if (!this.claimReport(`relay to ${target}`, nowMillis)) return;

        this.logError(`Failed to relay voice packet to ${target}: ${err instanceof Error ? err.message : String(err)}`
            + ` (further failures for this peer are not reported for ${REPORT_INTERVAL_MILLIS / 1000}s)`, false);
    }

    // True, and remembers the time, if `key` may be reported now: at most once per
    // REPORT_INTERVAL_MILLIS, and only while fewer than REPORT_MAX_KEYS keys are remembered.
    private claimReport(key: string, nowMillis: number): boolean {
        const reportedAt = this.reportedAt.get(key);
        if (reportedAt !== undefined && nowMillis - reportedAt < REPORT_INTERVAL_MILLIS) return false;
        if (reportedAt === undefined && this.reportedAt.size >= REPORT_MAX_KEYS) return false;

        this.reportedAt.set(key, nowMillis);
        return true;
    }

    private pruneReports(nowMillis: number): void {
        for (const [key, reportedAt] of this.reportedAt) {
            if (nowMillis - reportedAt >= REPORT_INTERVAL_MILLIS) {
                this.reportedAt.delete(key);
            }
        }
    }

    private getClientsCache(): VoiceClient[] {
        if (!this.clientsCache) {
            this.clientsCache = Array.from(this.clients.values());
        }
        return this.clientsCache;
    }

    // setInterval never awaits this, so the timed-out clients are collected and removed
    // before anything is awaited. Deleting only after `await saveRecording(...)` meant a
    // save slower than the 1s tick let the next tick find the same client still registered
    // and write the same recording to the same filename a second time.
    private async checkClientsDisconnected(): Promise<void> {
        if (this.savingRecordings) return;

        const now = Date.now();
        const pendingRecordings: VoiceClient[] = [];

        for (const [key, value] of this.clients) {
            // Remove inactive clients
            if (now - value.lastHeartbeat > this.disconnectTimeoutMillis) {
                this.clients.delete(key);
                this.clientsCache = undefined;
                this.logDebug(`Voice client ${value.ip}:${value.port} disconnected ID: ${value.userId}`);

                // Check if recording data is available
                if (value.recordingData.length > 0) {
                    pendingRecordings.push(value);
                }
            }
        }

        if (pendingRecordings.length === 0) return;

        const saving = (async () => {
            for (const client of pendingRecordings) {
                await this.saveRecording(client);
            }
        })();
        this.savingRecordings = saving;
        try {
            await saving;
        } finally {
            this.savingRecordings = undefined;
        }
    }

    // Never throws: a failed save is logged. Nothing here re-encodes the samples on the main
    // thread (see wavHeader): writeFile hands their bytes to the file system in chunks.
    private async saveRecording(client: VoiceClient): Promise<void> {
        const samples = client.recordingData.toTypedArray();
        const dateString = client.recordingStartDate.toISOString().replace(/:/g, '_');
        const filename = path.join(this.voiceRecordingPath, `rec_${dateString}_ID_${client.userId}.wav`);
        const seconds = (samples.length / this.samplingRate).toFixed(1);
        try {
            await mkdir(this.voiceRecordingPath, { recursive: true });
            await writeFile(filename, [ wavHeader(this.samplingRate, samples.byteLength), littleEndianBytes(samples) ]);
            this.logInfo(`Voice recording of client ID ${client.userId} (${client.ip}:${client.port}, ${seconds} s) saved to ${filename}`);
        } catch (err) {
            // An fs error names the file itself.
            this.logError(`Failed to save the voice recording of client ID ${client.userId} (${client.ip}:${client.port}, ${seconds} s): `
                + `${err instanceof Error ? err.message : String(err)}`, false);
        }
    }
}
