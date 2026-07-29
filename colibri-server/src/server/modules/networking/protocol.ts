// v3 TCP wire protocol (breaking change from the v1 flatbuffer framing).
//
// [u32 LE totalLength][u8 type][body]
//   totalLength counts every byte after the length field itself (type + body).
//   type 0x00  heartbeat   body: [u64 LE ping timestamp]
//   type 0x01  handshake   body: utf8 "version::app::name"
//   type 0x02  message     body: [u16 LE channelLen][channel]
//                               [u16 LE commandLen][command][payload bytes]
//
// Fixed offsets mean ingress parsing is readUInt32LE/readUInt8 with no string
// scanning, and length validation is a real bounds check instead of Number.isFinite
// on a hand-parsed ASCII string.

export enum FrameType {
    Heartbeat = 0x00,
    Handshake = 0x01,
    Message = 0x02,
}

const LENGTH_FIELD_SIZE = 4;
const TYPE_FIELD_SIZE = 1;
const HEADER_SIZE = LENGTH_FIELD_SIZE + TYPE_FIELD_SIZE;
const HEARTBEAT_BODY_SIZE = 8;

export class FrameError extends Error {}

export type DecodedFrame =
    | { type: FrameType.Heartbeat; pingTimestamp: bigint }
    | { type: FrameType.Handshake; version: string; app: string; name: string }
    | { type: FrameType.Message; channel: string; command: string; payload: Buffer };

export const encodeHeartbeatFrame = function (pingTimestamp: bigint): Buffer {
    const buffer = Buffer.allocUnsafe(HEADER_SIZE + HEARTBEAT_BODY_SIZE);
    buffer.writeUInt32LE(TYPE_FIELD_SIZE + HEARTBEAT_BODY_SIZE, 0);
    buffer.writeUInt8(FrameType.Heartbeat, LENGTH_FIELD_SIZE);
    buffer.writeBigUInt64LE(pingTimestamp, HEADER_SIZE);
    return buffer;
};

export const encodeHandshakeFrame = function (version: string, app: string, name: string): Buffer {
    const body = Buffer.from(`${version}::${app}::${name}`, 'utf8');
    const buffer = Buffer.allocUnsafe(HEADER_SIZE + body.length);
    buffer.writeUInt32LE(TYPE_FIELD_SIZE + body.length, 0);
    buffer.writeUInt8(FrameType.Handshake, LENGTH_FIELD_SIZE);
    body.copy(buffer, HEADER_SIZE);
    return buffer;
};

export interface EncodableMessage {
    channel: string;
    command: string;
    payload: Buffer;
}

// Single pre-sized allocation: no separate flatbuffers.Builder, no TextEncoder, no
// merged Uint8Array. Payload bytes are copied verbatim - never round-tripped through
// a JS string - so a byte-verbatim relay never pays a utf8 transcode.
export const encodeMessageFrame = function (msg: EncodableMessage): Buffer {
    const channel = Buffer.from(msg.channel, 'utf8');
    const command = Buffer.from(msg.command, 'utf8');
    const bodyLength = 2 + channel.length + 2 + command.length + msg.payload.length;
    const buffer = Buffer.allocUnsafe(HEADER_SIZE + bodyLength);

    let offset = 0;
    buffer.writeUInt32LE(TYPE_FIELD_SIZE + bodyLength, offset);
    offset += LENGTH_FIELD_SIZE;
    buffer.writeUInt8(FrameType.Message, offset);
    offset += TYPE_FIELD_SIZE;

    buffer.writeUInt16LE(channel.length, offset);
    offset += 2;
    channel.copy(buffer, offset);
    offset += channel.length;

    buffer.writeUInt16LE(command.length, offset);
    offset += 2;
    command.copy(buffer, offset);
    offset += command.length;

    msg.payload.copy(buffer, offset);

    return buffer;
};

// Growable read buffer with read/write cursors, replacing a Buffer.concat per `data`
// event. In the common case (no fragmentation) consumed frames are dropped by
// resetting both cursors to 0 - no copy at all. Only a frame split across TCP
// segments triggers a compaction, and that copy is bounded by the pending leftover
// (at most one frame's worth), not by total stream length - this is what avoids the
// O(n^2) cost of Buffer.concat on a long-lived fragmented connection.
export class FrameReader {
    private buffer: Buffer;
    private readPos = 0;
    private writePos = 0;

    public constructor(
        private readonly maxFrameLength: number,
        initialCapacity = 4096
    ) {
        this.buffer = Buffer.allocUnsafe(initialCapacity);
    }

    public get pendingBytes(): number {
        return this.writePos - this.readPos;
    }

    public reset(): void {
        this.readPos = 0;
        this.writePos = 0;
    }

    // Appends newly received bytes and yields every complete frame now available.
    // Throws FrameError on a malformed or oversized frame - callers should treat that
    // as fatal for the connection, same as the old maxBufferSize kill-switch.
    public *append(data: Buffer): Generator<DecodedFrame> {
        this.ensureCapacity(data.length);
        data.copy(this.buffer, this.writePos);
        this.writePos += data.length;

        for (;;) {
            const available = this.writePos - this.readPos;
            if (available < HEADER_SIZE) break;

            const totalLength = this.buffer.readUInt32LE(this.readPos);
            if (totalLength <= 0 || totalLength > this.maxFrameLength) {
                throw new FrameError(`Invalid frame length: ${totalLength}`);
            }

            // totalLength counts everything after the length field itself (type + body).
            const frameLength = LENGTH_FIELD_SIZE + totalLength;
            if (available < frameLength) break;

            const frameEnd = this.readPos + frameLength;

            const type = this.buffer.readUInt8(this.readPos + LENGTH_FIELD_SIZE);
            yield this.decodeFrame(type, this.readPos + HEADER_SIZE, frameEnd);

            this.readPos = frameEnd;
        }

        this.compact();
    }

    private decodeFrame(type: number, bodyStart: number, bodyEnd: number): DecodedFrame {
        switch (type) {
            case FrameType.Heartbeat: {
                if (bodyEnd - bodyStart !== HEARTBEAT_BODY_SIZE) {
                    throw new FrameError(`Malformed heartbeat frame (${bodyEnd - bodyStart} body bytes)`);
                }
                return { type: FrameType.Heartbeat, pingTimestamp: this.buffer.readBigUInt64LE(bodyStart) };
            }

            case FrameType.Handshake: {
                const text = this.buffer.toString('utf8', bodyStart, bodyEnd);
                const [version, app, name] = text.split('::');
                if (version === undefined || app === undefined || name === undefined) {
                    throw new FrameError(`Malformed handshake frame: "${text}"`);
                }
                return { type: FrameType.Handshake, version, app, name };
            }

            case FrameType.Message: {
                let offset = bodyStart;
                if (offset + 2 > bodyEnd) throw new FrameError('Malformed message frame: missing channel length');
                const channelLength = this.buffer.readUInt16LE(offset);
                offset += 2;
                if (offset + channelLength > bodyEnd) throw new FrameError('Malformed message frame: channel overruns body');
                const channel = this.buffer.toString('utf8', offset, offset + channelLength);
                offset += channelLength;

                if (offset + 2 > bodyEnd) throw new FrameError('Malformed message frame: missing command length');
                const commandLength = this.buffer.readUInt16LE(offset);
                offset += 2;
                if (offset + commandLength > bodyEnd) throw new FrameError('Malformed message frame: command overruns body');
                const command = this.buffer.toString('utf8', offset, offset + commandLength);
                offset += commandLength;

                // Copied out (not a subarray) since the backing buffer is reused/compacted
                // on subsequent append() calls.
                const payload = Buffer.from(this.buffer.subarray(offset, bodyEnd));
                return { type: FrameType.Message, channel, command, payload };
            }

            default:
                throw new FrameError(`Unknown frame type: ${type}`);
        }
    }

    private ensureCapacity(incoming: number): void {
        if (this.writePos + incoming <= this.buffer.length) return;

        this.compact();
        if (this.writePos + incoming <= this.buffer.length) return;

        let newSize = this.buffer.length * 2;
        while (newSize < this.writePos + incoming) newSize *= 2;

        const grown = Buffer.allocUnsafe(newSize);
        this.buffer.copy(grown, 0, 0, this.writePos);
        this.buffer = grown;
    }

    private compact(): void {
        if (this.readPos === 0) return;

        if (this.readPos === this.writePos) {
            this.readPos = 0;
            this.writePos = 0;
            return;
        }

        this.buffer.copy(this.buffer, 0, this.readPos, this.writePos);
        this.writePos -= this.readPos;
        this.readPos = 0;
    }
}
