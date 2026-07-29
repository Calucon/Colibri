import { describe, it, expect } from 'vitest';
import {
    FrameError,
    FrameReader,
    FrameType,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../../src/server/modules/networking/protocol.js';

const MAX_FRAME_LENGTH = 1024 * 1024;

const readAll = function (reader: FrameReader, data: Buffer) {
    return Array.from(reader.append(data));
};

describe('protocol v3 framing', () => {
    describe('heartbeat frames', () => {
        it('round-trips a ping timestamp', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHeartbeatFrame(123456789012345n);

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({ type: FrameType.Heartbeat, pingTimestamp: 123456789012345n });
        });
    });

    describe('handshake frames', () => {
        it('round-trips version/app/name', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHandshakeFrame('1', 'myApp', 'myClient');

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({ type: FrameType.Handshake, version: '1', app: 'myApp', name: 'myClient' });
        });

        it('throws FrameError on a malformed handshake body', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const body = Buffer.from('not-enough-parts', 'utf8');
            const frame = Buffer.alloc(5 + body.length);
            frame.writeUInt32LE(1 + body.length, 0);
            frame.writeUInt8(FrameType.Handshake, 4);
            body.copy(frame, 5);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });
    });

    describe('message frames', () => {
        it('round-trips channel, command, and payload bytes', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const payload = Buffer.from(JSON.stringify({ x: 1 }), 'utf8');
            const frame = encodeMessageFrame({ channel: 'app::chan', command: 'model::update', payload });

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({
                type: FrameType.Message,
                channel: 'app::chan',
                command: 'model::update',
                payload,
            });
        });

        it('round-trips an empty payload', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeMessageFrame({ channel: 'c', command: 'cmd', payload: Buffer.alloc(0) });

            const [decoded] = readAll(reader, frame);
            expect(decoded).toEqual({ type: FrameType.Message, channel: 'c', command: 'cmd', payload: Buffer.alloc(0) });
        });
    });

    describe('fragmentation', () => {
        it('reassembles a frame split across many small chunks', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const payload = Buffer.from(JSON.stringify({ points: Array.from({ length: 50 }, (_, i) => i) }), 'utf8');
            const frame = encodeMessageFrame({ channel: 'app::chan', command: 'model::update', payload });

            const decoded: unknown[] = [];
            for (let i = 0; i < frame.length; i++) {
                decoded.push(...readAll(reader, frame.subarray(i, i + 1)));
            }

            expect(decoded).toEqual([
                { type: FrameType.Message, channel: 'app::chan', command: 'model::update', payload },
            ]);
        });

        it('reassembles a frame split into two halves across separate append() calls', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = encodeHeartbeatFrame(42n);
            const mid = Math.floor(frame.length / 2);

            expect(readAll(reader, frame.subarray(0, mid))).toEqual([]);
            const decoded = readAll(reader, frame.subarray(mid));

            expect(decoded).toEqual([{ type: FrameType.Heartbeat, pingTimestamp: 42n }]);
        });
    });

    describe('coalescing', () => {
        it('yields multiple frames delivered in a single segment', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const a = encodeHeartbeatFrame(1n);
            const b = encodeHandshakeFrame('1', 'app', 'name');
            const c = encodeMessageFrame({ channel: 'x', command: 'y', payload: Buffer.from('z') });

            const decoded = readAll(reader, Buffer.concat([a, b, c]));

            expect(decoded).toHaveLength(3);
            expect(decoded[0]).toEqual({ type: FrameType.Heartbeat, pingTimestamp: 1n });
            expect(decoded[1]).toEqual({ type: FrameType.Handshake, version: '1', app: 'app', name: 'name' });
            expect(decoded[2]).toEqual({ type: FrameType.Message, channel: 'x', command: 'y', payload: Buffer.from('z') });
        });

        it('handles one complete frame plus a trailing partial frame in the same segment', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const a = encodeHeartbeatFrame(7n);
            const b = encodeHeartbeatFrame(8n);

            const first = readAll(reader, Buffer.concat([a, b.subarray(0, 3)]));
            expect(first).toEqual([{ type: FrameType.Heartbeat, pingTimestamp: 7n }]);

            const second = readAll(reader, b.subarray(3));
            expect(second).toEqual([{ type: FrameType.Heartbeat, pingTimestamp: 8n }]);
        });
    });

    describe('malformed / oversized input', () => {
        it('throws FrameError on a zero-length frame', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = Buffer.alloc(5);
            frame.writeUInt32LE(0, 0);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        it('throws FrameError when the declared length exceeds maxFrameLength', () => {
            const reader = new FrameReader(16);
            const frame = Buffer.alloc(5);
            frame.writeUInt32LE(1_000_000, 0);
            frame.writeUInt8(FrameType.Heartbeat, 4);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        it('throws FrameError on an unknown frame type', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const frame = Buffer.alloc(6);
            frame.writeUInt32LE(2, 0);
            frame.writeUInt8(0xff, 4);

            expect(() => readAll(reader, frame)).toThrow(FrameError);
        });

        it('throws FrameError when a message frame\'s channel length overruns the body', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const buffer = Buffer.alloc(9);
            buffer.writeUInt32LE(4, 0); // type + 2-byte channelLen field only, no body
            buffer.writeUInt8(FrameType.Message, 4);
            buffer.writeUInt16LE(9999, 5); // claims a channel far longer than what's present

            expect(() => readAll(reader, buffer)).toThrow(FrameError);
        });
    });

    describe('growth and compaction', () => {
        it('grows past the initial capacity for a single large frame', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH, 16);
            const payload = Buffer.alloc(10_000, 'a');
            const frame = encodeMessageFrame({ channel: 'c', command: 'cmd', payload });

            const decoded = readAll(reader, frame);
            expect(decoded).toEqual([{ type: FrameType.Message, channel: 'c', command: 'cmd', payload }]);
        });

        it('reclaims space after fully consuming buffered frames (pendingBytes returns to 0)', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            readAll(reader, encodeHeartbeatFrame(1n));
            expect(reader.pendingBytes).toBe(0);

            readAll(reader, encodeHeartbeatFrame(2n));
            expect(reader.pendingBytes).toBe(0);
        });

        it('keeps only the trailing partial frame pending across many small appends', () => {
            const reader = new FrameReader(MAX_FRAME_LENGTH);
            const complete = encodeHeartbeatFrame(1n);
            const partial = encodeHeartbeatFrame(2n).subarray(0, 5);

            readAll(reader, Buffer.concat([complete, partial]));
            expect(reader.pendingBytes).toBe(partial.length);
        });
    });
});
