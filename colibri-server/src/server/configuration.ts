import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// automatically load .env file. Quietly: dotenv 17 otherwise prints an "injected env"
// line with a rotating advertising tip on every start, docker logs included.
dotenv.config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `Number(process.env.X)` silently yields NaN for anything malformed, which then
// propagates into `net.Server.listen`/`dgram.Socket.bind` and fails in confusing ways far
// from the actual misconfiguration. Fail fast at startup instead, with a message that
// names the offending variable.
const parsePort = function (name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`Invalid ${name}: "${raw}" is not a valid port (expected an integer between 1 and 65535)`);
    }
    return value;
};

const parsePositiveInt = function (name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}: "${raw}" is not a positive integer`);
    }
    return value;
};

// For the limits below, where 0 is meaningful: it switches the limit off.
const parseNonNegativeInt = function (name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid ${name}: "${raw}" is not a non-negative integer (0 turns it off)`);
    }
    return value;
};

export const Config = {
    TCP_HOST: process.env.TCP_HOST || '0.0.0.0',
    TCP_PORT: parsePort('TCP_PORT', process.env.TCP_PORT, 9012),

    VOICE_HOST: process.env.VOICE_HOST || '0.0.0.0',
    VOICE_PORT: parsePort('VOICE_PORT', process.env.VOICE_PORT, 9013),
    VOICE_SAMPLING_RATE: parsePositiveInt('VOICE_SAMPLING_RATE', process.env.VOICE_SAMPLING_RATE, 48000),
    VOICE_RECORDING: process.env.VOICE_RECORDING?.toLowerCase() === 'true',

    WEBSERVER_HOST: process.env.WEBSERVER_HOST || '0.0.0.0',
    WEBSERVER_PORT: parsePort('WEBSERVER_PORT', process.env.WEBSERVER_PORT, 9011),
    // WEBSERVER_ROOT and DATA_ROOT use path.resolve, not path.join: join glued even an
    // absolute path onto __dirname, so DATA_ROOT=/var/lib/colibri ended up at
    // dist/server/var/lib/colibri. A relative path still resolves against __dirname
    // (dist/server) to the same place as before.
    WEBSERVER_ROOT: path.resolve(
        __dirname,
        process.env.WEBSERVER_ROOT || '../ui/'
    ),

    BASE_URL: process.env.BASE_URL || '',

    DATA_ROOT: path.resolve(
        __dirname,
        process.env.DATA_ROOT || '../../data/'
    ),

    // Default of 30 (was Error.stackTraceLimit = Infinity) caps the cost of every stack
    // capture - each logError call with printStacktrace on walks this many frames - while
    // still being enough to see past RxJS's internal call chain into application code.
    STACK_TRACE_LIMIT: parsePositiveInt('STACK_TRACE_LIMIT', process.env.STACK_TRACE_LIMIT, 30),

    // How many TCP messages may wait for the main thread before the TCP worker drops incoming
    // model::update and broadcast::* messages (see DEFAULT_INBOUND_BACKLOG_LIMIT). 0: never drop.
    TCP_INBOUND_BACKLOG_LIMIT: parseNonNegativeInt('TCP_INBOUND_BACKLOG_LIMIT', process.env.TCP_INBOUND_BACKLOG_LIMIT, 2000),

    // How many model::update and broadcast::* messages a second one client may send, on either
    // transport, before the rest are dropped (see DEFAULT_RATE_LIMIT); 0: no limit. The burst is
    // how many it may send at once after a quieter stretch.
    CLIENT_MESSAGE_RATE_LIMIT: parseNonNegativeInt('CLIENT_MESSAGE_RATE_LIMIT', process.env.CLIENT_MESSAGE_RATE_LIMIT, 1000),
    CLIENT_MESSAGE_RATE_BURST: parsePositiveInt('CLIENT_MESSAGE_RATE_BURST', process.env.CLIENT_MESSAGE_RATE_BURST || undefined, 2000),
};
