import { bench, describe } from 'vitest';
import { encodeV1Packet } from '../src/server/modules/networking/tcp-server-worker.js';

// Baseline for the v1 TCP egress path: a fresh flatbuffers.Builder,
// TextEncoder, and merged Uint8Array per broadcast (Phase 2 replaces this
// with a single pre-sized Buffer write and drops flatbuffers entirely).
const SMALL_PAYLOAD = JSON.stringify({ x: 1, y: 2, z: 3 });
const LARGE_PAYLOAD = JSON.stringify({ points: Array.from({ length: 100 }, (_, i) => ({ x: i, y: i })) });

describe('TCP v1 packet encoding (flatbuffers + manual framing)', () => {
    bench('encode small payload (~30 bytes)', () => {
        encodeV1Packet({ channel: 'app::channel', command: 'model::update', payload: SMALL_PAYLOAD });
    });

    bench('encode large payload (~2KB)', () => {
        encodeV1Packet({ channel: 'app::channel', command: 'model::update', payload: LARGE_PAYLOAD });
    });
});
