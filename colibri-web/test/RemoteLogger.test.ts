import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Only the socket is faked. RemoteLogger runs through the real Colibri, SendMessage and
// getInstance: mocking those away is what hid that a line logged before `new Colibri()` recursed
// through getInstance's own warning until the stack overflowed.
vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { Colibri } from '../src/Colibri';
import { RemoteLogger } from '../src/RemoteLogger';

const connectMock = connect as unknown as Mock;

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';
type PatchableConsole = Record<ConsoleMethod, (...args: unknown[]) => void>;
let originalConsole: Record<ConsoleMethod, Console[ConsoleMethod]>;

let emit: Mock<(channel: string, msg: { command: string; payload: unknown }) => void>;

beforeEach(() => {
    originalConsole = {
        debug: console.debug,
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error
    };
    // Stand-ins for the real console underneath the logger, so nothing reaches the test output
    // and what the logger passes through can be checked.
    for (const method of Object.keys(originalConsole) as ConsoleMethod[]) {
        (console as unknown as PatchableConsole)[method] = vi.fn();
    }

    emit = vi.fn();
    connectMock.mockReturnValue({
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        onAny: vi.fn(),
        emit,
        disconnect: vi.fn(),
        connected: false,
        io: { reconnection: vi.fn() }
    });
});

afterEach(() => {
    console.debug = originalConsole.debug;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
});

/** Every line that went out on the `log` channel, as [level, message]. */
const forwarded = () =>
    emit.mock.calls.filter(([channel]) => channel === 'log').map(([, msg]) => [msg.command, msg.payload]);

const createColibri = () => new Colibri('app', 'localhost', 9011);

describe('RemoteLogger console patching', () => {
    it.each([
        ['debug', 'debug'],
        ['log', 'info'],
        ['info', 'info'],
        ['warn', 'warn'],
        ['error', 'error']
    ] as const)('console.%s still calls the original and forwards as level "%s"', (method, level) => {
        const original = (console as unknown as PatchableConsole)[method];
        createColibri();
        new RemoteLogger();

        (console as unknown as PatchableConsole)[method]('hello', 42);

        expect(original).toHaveBeenCalledWith('hello', 42);
        expect(forwarded()).toEqual([[level, 'hello,42']]);
    });
});

describe('RemoteLogger enable/disable', () => {
    beforeEach(() => {
        createColibri();
    });

    it('does not forward when constructed with enabled=false', () => {
        new RemoteLogger(false);
        console.log('hidden');
        expect(forwarded()).toEqual([]);
    });

    it('disable() stops forwarding and enable() resumes it', () => {
        const logger = new RemoteLogger();

        logger.disable();
        console.log('hidden');
        expect(forwarded()).toEqual([]);

        logger.enable();
        console.log('visible');
        expect(forwarded()).toEqual([['info', 'visible']]);
    });
});

describe('RemoteLogger message stringification', () => {
    beforeEach(() => {
        createColibri();
    });

    const message = () => String(forwarded()[0][1]);

    it('stringifies an Error as its message plus stack', () => {
        new RemoteLogger();
        const err = new Error('boom');
        console.error(err);

        expect(message()).toContain('boom');
        expect(message()).toContain(err.stack);
    });

    it('passes plain strings through unchanged', () => {
        new RemoteLogger();
        console.log('hello world');

        expect(message()).toBe('hello world');
    });

    it('pretty-prints plain objects as indented JSON', () => {
        new RemoteLogger();
        console.log({ a: 1, b: 'two' });

        expect(JSON.parse(message())).toEqual({ a: 1, b: 'two' });
        expect(message()).toContain('\n');
    });

    it('does not throw on circular references', () => {
        new RemoteLogger();

        const obj: { a: number; self?: unknown } = { a: 1 };
        obj.self = obj;

        expect(() => {
            console.log(obj);
        }).not.toThrow();

        expect(() => {
            JSON.parse(message());
        }).not.toThrow();
    });
});

describe('RemoteLogger before new Colibri()', () => {
    it('does not overflow the stack on the first line', () => {
        const originalWarn = console.warn;
        new RemoteLogger();

        expect(() => {
            console.log('early');
        }).not.toThrow();
        // Nor does it complain, through the very console it is patching, that Colibri is missing.
        expect(originalWarn).not.toHaveBeenCalled();

        createColibri();
    });

    it('sends what was logged once Colibri is constructed, in order', () => {
        new RemoteLogger();
        console.log('first');
        console.warn('second');
        console.error('third');
        expect(emit).not.toHaveBeenCalled();

        createColibri();

        expect(forwarded()).toEqual([
            ['info', 'first'],
            ['warn', 'second'],
            ['error', 'third']
        ]);
    });

    it('keeps the first 100 lines and says how many more there were', () => {
        new RemoteLogger();
        for (let i = 0; i < 105; i++) console.log(`line ${i}`);

        createColibri();

        const lines = forwarded();
        expect(lines).toHaveLength(101);
        expect(lines[0]).toEqual(['info', 'line 0']);
        expect(lines[99]).toEqual(['info', 'line 99']);
        expect(lines[100][0]).toBe('warn');
        expect(lines[100][1]).toContain('5 more');
    });

    it('does not keep what was logged while disabled', () => {
        new RemoteLogger(false);
        console.log('hidden');

        createColibri();

        expect(forwarded()).toEqual([]);
    });
});

describe('RemoteLogger reentrancy', () => {
    // Anything that logs while a line is being forwarded - the socket, a getter that
    // JSON.stringify runs - must reach the console without being forwarded in turn, or one
    // line becomes an unbounded recursion.
    it('sends a line logged while forwarding to the console only', () => {
        const originalWarn = console.warn;
        createColibri();
        new RemoteLogger();
        emit.mockImplementation(() => {
            console.warn('logged from inside the socket');
        });

        expect(() => {
            console.log('outer');
        }).not.toThrow();

        expect(forwarded()).toEqual([['info', 'outer']]);
        expect(originalWarn).toHaveBeenCalledWith('logged from inside the socket');
    });

    it('sends a line logged while stringifying to the console only', () => {
        const originalLog = console.log;
        createColibri();
        new RemoteLogger();
        const noisy = {
            get value() {
                console.log('logged from a getter');
                return 1;
            }
        };

        console.info(noisy);

        expect(forwarded()).toHaveLength(1);
        expect(JSON.parse(String(forwarded()[0][1]))).toEqual({ value: 1 });
        expect(originalLog).toHaveBeenCalledWith('logged from a getter');
    });
});
