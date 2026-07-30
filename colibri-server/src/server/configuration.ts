import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// automatically load .env file
dotenv.config();

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

export const Config = {
    TCP_HOST: process.env.TCP_HOST || '0.0.0.0',
    TCP_PORT: parsePort('TCP_PORT', process.env.TCP_PORT, 9012),

    VOICE_HOST: process.env.VOICE_HOST || '0.0.0.0',
    VOICE_PORT: parsePort('VOICE_PORT', process.env.VOICE_PORT, 9013),
    VOICE_SAMPLING_RATE: parsePositiveInt('VOICE_SAMPLING_RATE', process.env.VOICE_SAMPLING_RATE, 48000),
    VOICE_RECORDING: process.env.VOICE_RECORDING?.toLowerCase() === 'true',

    // Mirrors broadcast/sync traffic into the admin log page (debug level) for visibility.
    // Defaults ON; set to 'false' to silence it if a high-frequency sync channel floods
    // the log page's ring buffer.
    LOG_BROADCAST_TRAFFIC: process.env.LOG_BROADCAST_TRAFFIC?.toLowerCase() !== 'false',

    WEBSERVER_HOST: process.env.WEBSERVER_HOST || '0.0.0.0',
    WEBSERVER_PORT: parsePort('WEBSERVER_PORT', process.env.WEBSERVER_PORT, 9011),
    WEBSERVER_ROOT: path.join(
        __dirname,
        process.env.WEBSERVER_ROOT || '../ui/'
    ),

    BASE_URL: process.env.BASE_URL || '',

    DATA_ROOT: path.join(
        __dirname,
        process.env.DATA_ROOT || '../../data/'
    ),

    // Default of 30 (was Error.stackTraceLimit = Infinity) caps the cost of every stack
    // capture - each logError call with printStacktrace on walks this many frames - while
    // still being enough to see past RxJS's internal call chain into application code.
    STACK_TRACE_LIMIT: parsePositiveInt('STACK_TRACE_LIMIT', process.env.STACK_TRACE_LIMIT, 30),
};
