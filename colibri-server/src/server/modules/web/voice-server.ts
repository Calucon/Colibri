import { Service } from '../core/index.js';
import * as dgram from 'dgram';
import { AddressInfo } from 'net';
import wavefile from 'wavefile';
const { WaveFile } = wavefile;
import { mkdir, writeFile } from 'fs/promises';
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

    // Guards checkClientsDisconnected against overlapping fs work when a save outlives its
    // tick; see the comment there.
    private savingRecordings = false;

    public constructor(private samplingRate: number, private voiceRecordingPath: string, private recordingVoiceData: boolean = false) {
        super();
    }

    public start(voicePort: number, hostname: string) {
        this.udpSocket = dgram.createSocket('udp4');
        this.udpSocket.on('listening', () => {
            const address = this.udpSocket.address() as AddressInfo;
            console.log(`Voice server listening on ${address.address}:${address.port}`);
            this.logInfo(`Voice server listening on ${address.address}:${address.port}`);
            this.logInfo(`Voice server Sampling Rate: ${this.samplingRate} Hz`);
            if (this.recordingVoiceData) this.logWarning('Warning: Voice recording is enabled');
        });
        this.udpSocket.on('message', (message, remote) => {
            if (message.length < 2) {
                this.logError(`Invalid voice packet received from client ${remote.address}:${remote.port}`, false);
                return;
            }
            const now = new Date();
            const nowMillis = now.getTime();
            const clientKey = `${remote.address}:${remote.port}`;

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

                this.udpSocket.send(message, 0, message.length, peer.port, peer.ip, (err) => {
                    if (err) {
                        this.logError(`Failed to relay voice packet to ${peer.ip}:${peer.port}: ${err.message}`, false);
                    }
                });
            }

            if (codec === Codec.PCM && this.recordingVoiceData) {
                for (let i = 7; i <= message.length - 2; i += 2) {
                    voiceClient.recordingData.push(message.readInt16LE(i));
                }
            }
        });
        this.udpSocket.on('error', (exception) => {
            console.error(exception.message);
        });
        this.udpSocket.bind(voicePort, hostname);

        // Check if clients disconnected every second
        this.disconnectCheckInterval = setInterval(() => this.checkClientsDisconnected(), 1000);
    }

    // Tolerates never having been started, for the same reason as SocketIOServer.stop().
    public stop(): void {
        if (this.disconnectCheckInterval) clearInterval(this.disconnectCheckInterval);
        if (this.udpSocket) this.udpSocket.close();
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

        this.savingRecordings = true;
        try {
            for (const client of pendingRecordings) {
                await this.saveRecording(client);
            }
        } finally {
            this.savingRecordings = false;
        }
    }

    private async saveRecording(client: VoiceClient): Promise<void> {
        try {
            // Create wave file from recording data
            const wav = new WaveFile();
            wav.fromScratch(1, this.samplingRate, '16', client.recordingData.toTypedArray());

            // Save wave file
            const dateString = client.recordingStartDate.toISOString().replace(/:/g, '_');
            await mkdir(this.voiceRecordingPath, { recursive: true });
            const filename = `rec_${dateString}_ID_${client.userId}.wav`;
            await writeFile(path.join(this.voiceRecordingPath, filename), wav.toBuffer());
            this.logDebug(`Voice recording saved to ${filename}`);
        } catch (err) {
            this.logError(`Failed to save voice recording: ${err instanceof Error ? err.message : String(err)}`, false);
        }
    }
}
