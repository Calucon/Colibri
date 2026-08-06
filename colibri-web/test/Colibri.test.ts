import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { firstValueFrom } from 'rxjs';
import { connect } from 'socket.io-client';
import {
    Colibri,
    GetRestApi,
    type Message,
    PROTOCOL_VERSION,
    PutRestApi,
    RegisterChannel,
    RegisterOnce,
    SendMessage,
    UnregisterChannel
} from '../src/Colibri';
import { ProtocolMismatchError } from '../src/ColibriError';

const connectMock = connect as unknown as Mock;

type SocketHandler = (...args: unknown[]) => void;

function makeFakeSocket() {
    return {
        on: vi.fn<(event: string, cb: SocketHandler) => void>(),
        once: vi.fn<(event: string, cb: SocketHandler) => void>(),
        off: vi.fn<(event: string, cb: SocketHandler) => void>(),
        onAny: vi.fn<(cb: SocketHandler) => void>(),
        emit: vi.fn<(event: string, ...args: unknown[]) => void>(),
        disconnect: vi.fn<() => void>(),
        // Read when the old-server timer expires: a socket that is already down explains the
        // silence by itself, so the check must not fire on it.
        connected: true,
        // The Manager, which is what actually owns the retry policy - a protocol rejection
        // has to switch it off there, not on the socket.
        io: { reconnection: vi.fn<(on: boolean) => void>() }
    };
}

function getAnyHandler(mock: ReturnType<typeof makeFakeSocket>['onAny']): SocketHandler {
    const call = mock.mock.calls.at(0);
    if (!call) throw new Error('no onAny handler registered');
    return call[0];
}

function getHandler(mock: ReturnType<typeof makeFakeSocket>['on'], event: string): SocketHandler {
    const call = mock.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`no handler registered for "${event}"`);
    return call[1];
}

let fakeSocket: ReturnType<typeof makeFakeSocket>;

beforeEach(() => {
    vi.clearAllMocks();
    fakeSocket = makeFakeSocket();
    connectMock.mockReturnValue(fakeSocket);
});

afterEach(() => {
    // Colibri.instance is a private static that must not leak between tests.
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
    vi.unstubAllGlobals();
});

describe('Colibri constructor', () => {
    it('throws when the server address is empty', () => {
        expect(() => new Colibri('app', '', 9011)).toThrow('Server Address missing or empty!');
    });

    it('throws when the server address is whitespace only', () => {
        expect(() => new Colibri('app', '   ', 9011)).toThrow('Server Address missing or empty!');
    });

    it.each([0, -1, 65536, 100000])('throws when the port %d is out of range', port => {
        expect(() => new Colibri('app', 'localhost', port)).toThrow('Port out of allowed range (0 - 65535)');
    });

    it('builds a ws:// uri when the server has no scheme', () => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.uri).toBe('ws://localhost:9011');
    });

    it('leaves an explicit ws:// scheme untouched', () => {
        const c = new Colibri('app', 'ws://localhost', 9011);
        expect(c.uri).toBe('ws://localhost:9011');
    });

    it('leaves an explicit wss:// scheme untouched', () => {
        const c = new Colibri('app', 'wss://example.com', 443);
        expect(c.uri).toBe('wss://example.com:443');
    });

    it('derives an http REST API uri from a ws server', () => {
        const c = new Colibri('myapp', 'localhost', 9011);
        expect(c.uriRestApi).toBe('http://localhost:9011/api/store/myapp/');
    });

    it('derives an https REST API uri from a wss server', () => {
        const c = new Colibri('myapp', 'wss://example.com', 443);
        expect(c.uriRestApi).toBe('https://example.com:443/api/store/myapp/');
    });

    it('connects with the app/version query and websocket transport', () => {
        new Colibri('myapp', 'localhost', 9011);
        expect(connectMock).toHaveBeenCalledWith('ws://localhost:9011', {
            query: { app: 'myapp', version: '2' },
            transports: ['websocket']
        });
    });

    it('registers the connect handler and the colibri latency channel', () => {
        new Colibri('app', 'localhost', 9011);
        expect(fakeSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(fakeSocket.on).toHaveBeenCalledWith('colibri', expect.any(Function));
        expect(fakeSocket.onAny).toHaveBeenCalledWith(expect.any(Function));
    });

    it('echoes inbound latency messages back out through the colibri channel', () => {
        const c = new Colibri('app', 'localhost', 9011);
        const handler = getHandler(fakeSocket.on, 'colibri');

        handler({ channel: 'colibri', command: 'latency', payload: 123 });

        expect(fakeSocket.emit).toHaveBeenCalledWith('colibri', {
            command: 'latency',
            payload: 123
        });
        void c;
    });

    it('logs on socket connect', () => {
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        new Colibri('app', 'localhost', 9011);
        const connectHandler = getHandler(fakeSocket.on, 'connect');

        connectHandler();

        expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('Connected to colibri server'));
    });

    it('forwards inbound onAny messages through the messages observable', () => {
        const c = new Colibri('app', 'localhost', 9011);
        const [onAnyHandler] = fakeSocket.onAny.mock.calls[0];

        const received: unknown[] = [];
        c.messages.subscribe(msg => received.push(msg));

        onAnyHandler('some-channel', { command: 'cmd', payload: { a: 1 } });

        expect(received).toEqual([{ channel: 'some-channel', command: 'cmd', payload: { a: 1 } }]);
    });

    it('throws when a second instance is constructed', () => {
        new Colibri('app', 'localhost', 9011);
        expect(() => new Colibri('app2', 'localhost', 9012)).toThrow('A Colibri instance already exists!');
    });
});

describe('Colibri.getInstance', () => {
    it('warns and returns null when uninitialized', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(Colibri.getInstance()).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('does not warn when warnIfNotInitialized is false', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(Colibri.getInstance(false)).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns the existing instance without warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const c = new Colibri('app', 'localhost', 9011);

        expect(Colibri.getInstance()).toBe(c);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('Colibri instance methods delegate to the socket', () => {
    it('sendMessage emits {command, payload}, defaulting payload to {}', () => {
        const c = new Colibri('app', 'localhost', 9011);

        c.sendMessage('ch', 'cmd');
        expect(fakeSocket.emit).toHaveBeenCalledWith('ch', {
            command: 'cmd',
            payload: {}
        });

        c.sendMessage('ch', 'cmd2', { a: 1 });
        expect(fakeSocket.emit).toHaveBeenCalledWith('ch', {
            command: 'cmd2',
            payload: { a: 1 }
        });
    });

    it('registerChannel/unregisterChannel/registerOnce delegate to socket.on/off/once', () => {
        const c = new Colibri('app', 'localhost', 9011);
        const handler = () => undefined;

        c.registerChannel('ch', handler);
        expect(fakeSocket.on).toHaveBeenCalledWith('ch', handler);

        c.unregisterChannel('ch', handler);
        expect(fakeSocket.off).toHaveBeenCalledWith('ch', handler);

        c.registerOnce('ch', handler);
        expect(fakeSocket.once).toHaveBeenCalledWith('ch', handler);
    });
});

describe('Colibri.getRestUri', () => {
    it('joins the REST base uri with the trimmed key', () => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.getRestUri('mykey')).toBe('http://localhost:9011/api/store/app/mykey');
    });

    it('trims leading slashes from the key', () => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.getRestUri('///nested/key')).toBe('http://localhost:9011/api/store/app/nested/key');
    });

    it('returns null for an empty or whitespace-only key', () => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.getRestUri('')).toBeNull();
        expect(c.getRestUri('   ')).toBeNull();
    });
});

describe('Colibri REST API', () => {
    it('getRestObject skips fetch and returns null for an empty key', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.getRestObject('')).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getRestObject returns parsed JSON on success', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        const fetchMock = vi.fn().mockResolvedValue({
            status: 200,
            json: () => Promise.resolve({ a: 1 })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.getRestObject('mykey')).resolves.toEqual({ a: 1 });
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:9011/api/store/app/mykey', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
    });

    it('getRestObject returns null on a >= 400 status', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 404,
                json: () => Promise.resolve({})
            })
        );

        await expect(c.getRestObject('mykey')).resolves.toBeNull();
    });

    it('setRestObject skips fetch and returns false for an empty key', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.setRestObject('', { a: 1 })).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('setRestObject returns true on a 2xx status', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.setRestObject('mykey', { a: 1 })).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:9011/api/store/app/mykey', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ a: 1 })
        });
    });

    it('setRestObject returns false on a non-2xx status', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500 }));

        await expect(c.setRestObject('mykey', { a: 1 })).resolves.toBe(false);
    });
});

describe('wrapper functions', () => {
    it('return undefined when Colibri is not initialized', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(SendMessage('ch', 'cmd')).toBeUndefined();
        expect(RegisterChannel('ch', () => undefined)).toBeUndefined();
        expect(UnregisterChannel('ch', () => undefined)).toBeUndefined();
        expect(RegisterOnce('ch', () => undefined)).toBeUndefined();
        expect(GetRestApi('key')).toBeUndefined();
        expect(PutRestApi('key', {})).toBeUndefined();

        warnSpy.mockRestore();
    });

    it('delegate to the instance once Colibri is initialized', () => {
        new Colibri('app', 'localhost', 9011);
        const handler = () => undefined;

        SendMessage('ch', 'cmd', { a: 1 });
        expect(fakeSocket.emit).toHaveBeenCalledWith('ch', {
            command: 'cmd',
            payload: { a: 1 }
        });

        RegisterChannel('ch', handler);
        expect(fakeSocket.on).toHaveBeenCalledWith('ch', handler);

        UnregisterChannel('ch', handler);
        expect(fakeSocket.off).toHaveBeenCalledWith('ch', handler);

        RegisterOnce('ch', handler);
        expect(fakeSocket.once).toHaveBeenCalledWith('ch', handler);
    });
});

describe('protocol version handshake', () => {
    it('announces the client protocol version in the handshake query', () => {
        new Colibri('app', 'localhost', 9011);

        expect(connectMock).toHaveBeenCalledWith(
            'ws://localhost:9011',
            expect.objectContaining({ query: { app: 'app', version: PROTOCOL_VERSION } })
        );
    });

    it('stops reconnecting and reports a mismatch when the server refuses the version', async () => {
        const client = new Colibri('app', 'localhost', 9011);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const mismatch = firstValueFrom(client.protocolMismatch);

        getAnyHandler(fakeSocket.onAny)('colibri', {
            command: 'protocol::rejected',
            payload: { reason: 'nope', serverVersion: '9', clientVersion: PROTOCOL_VERSION }
        });

        const error = await mismatch;
        expect(error).toBeInstanceOf(ProtocolMismatchError);
        expect(error.serverVersion).toBe('9');
        expect(error.clientVersion).toBe(PROTOCOL_VERSION);
        // A mismatch cannot resolve itself; retrying would just bury the diagnostic.
        expect(fakeSocket.io.reconnection).toHaveBeenCalledWith(false);
        expect(fakeSocket.disconnect).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    it('keeps the rejection off the ordinary message stream', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: string[] = [];
        client.messages.subscribe(msg => seen.push(msg.command));

        const onAny = getAnyHandler(fakeSocket.onAny);
        onAny('colibri', { command: 'protocol::rejected', payload: { serverVersion: '9' } });
        onAny('colibri', { command: 'latency', payload: 1 });

        expect(seen).toEqual(['latency']);

        errorSpy.mockRestore();
    });

    it('survives a rejection payload with nothing useful in it', async () => {
        const client = new Colibri('app', 'localhost', 9011);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const mismatch = firstValueFrom(client.protocolMismatch);

        getAnyHandler(fakeSocket.onAny)('colibri', { command: 'protocol::rejected', payload: undefined });

        const error = await mismatch;
        expect(error.serverVersion).toBe('unknown');
        expect(error.message).toContain(PROTOCOL_VERSION);

        errorSpy.mockRestore();
    });
});

describe('detecting a server that predates the version check', () => {
    const TIMEOUT_MS = 5000;

    // Mirrors socket.io: onAny sees every event, and a channel handler sees its own channel.
    // Both matter here - the message stream runs through onAny, but only the colibri channel
    // handler clears the timer.
    const deliver = (channel: string, msg: { command: string; payload?: unknown }) => {
        getAnyHandler(fakeSocket.onAny)(channel, msg);
        const channelCall = fakeSocket.on.mock.calls.find(([event]) => event === channel);
        if (channelCall) channelCall[1](msg);
    };

    const connectSocket = () => {
        getHandler(fakeSocket.on, 'connect')();
    };

    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        warnSpy.mockRestore();
    });

    it('reports a suspected old server when no latency beat arrives', async () => {
        const client = new Colibri('app', 'localhost', 9011);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        vi.advanceTimersByTime(TIMEOUT_MS);

        const error = await mismatch;
        expect(error).toBeInstanceOf(ProtocolMismatchError);
        expect(error.serverVersion).toBe('<2.0.0');
        expect(error.clientVersion).toBe(PROTOCOL_VERSION);
        // The Socket.IO envelope did not change between v1 and v2, so this connection works.
        // Reporting it as fatal, or hanging up, would turn a warning into an outage.
        expect(error.fatal).toBe(false);
        expect(fakeSocket.disconnect).not.toHaveBeenCalled();
        expect(fakeSocket.io.reconnection).not.toHaveBeenCalled();
    });

    it('stays quiet once the server identifies itself', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        // Late, but inside the window - a loaded server is not an old one.
        vi.advanceTimersByTime(TIMEOUT_MS - 100);
        deliver('colibri', { command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
        vi.advanceTimersByTime(TIMEOUT_MS * 2);

        expect(seen).toEqual([]);
    });

    // The signal has to be the server naming itself, not any traffic that happens to look like a
    // current server. colibri-server 1.2.0 added the 100 ms `latency` broadcast while still
    // speaking the old protocol, so keying on that silently accepts every 1.2.x and 1.3.x server
    // as current - confirmed against the published 1.1.1 and 1.3.1 images.
    it('still reports an old server that sends the latency broadcast', async () => {
        const client = new Colibri('app', 'localhost', 9011);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        for (let i = 0; i < 50; i++) {
            deliver('colibri', { command: 'latency', payload: `${i}` });
            vi.advanceTimersByTime(100);
        }
        vi.advanceTimersByTime(TIMEOUT_MS);

        await expect(mismatch).resolves.toBeInstanceOf(ProtocolMismatchError);
    });

    // A pre-2.0.0 server relays broadcasts and model updates perfectly well, so if ordinary
    // traffic cleared the timer the check would never fire against a busy one.
    it('still reports a busy old server that is relaying traffic', async () => {
        const client = new Colibri('app', 'localhost', 9011);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        for (let i = 0; i < 10; i++) {
            deliver('positions', { command: 'broadcast::vector3', payload: [i, 0, 0] });
            deliver('player', { command: 'model::update', payload: { id: 'p1' } });
            vi.advanceTimersByTime(400);
        }
        vi.advanceTimersByTime(TIMEOUT_MS);

        await expect(mismatch).resolves.toBeInstanceOf(ProtocolMismatchError);
    });

    it('keeps the server hello off the ordinary message stream', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const seen: string[] = [];
        client.messages.subscribe(msg => seen.push(msg.command));

        connectSocket();
        deliver('colibri', { command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
        deliver('colibri', { command: 'latency', payload: 1 });

        expect(seen).toEqual(['latency']);
    });

    it('delivers messages untouched while the check is pending', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const seen: Message[] = [];
        client.messages.subscribe(msg => seen.push(msg));

        connectSocket();
        deliver('positions', { command: 'broadcast::vector3', payload: [1, 2, 3] });
        deliver('player', { command: 'model::update', payload: { id: 'p1' } });
        vi.advanceTimersByTime(TIMEOUT_MS);
        deliver('positions', { command: 'broadcast::vector3', payload: [4, 5, 6] });

        expect(seen).toEqual([
            { channel: 'positions', command: 'broadcast::vector3', payload: [1, 2, 3] },
            { channel: 'player', command: 'model::update', payload: { id: 'p1' } },
            { channel: 'positions', command: 'broadcast::vector3', payload: [4, 5, 6] }
        ]);
    });

    it('reports once, not once per reconnect', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        for (let i = 0; i < 3; i++) {
            connectSocket();
            vi.advanceTimersByTime(TIMEOUT_MS);
        }

        expect(seen).toHaveLength(1);
    });

    it('says nothing when the socket went down before the window elapsed', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        fakeSocket.connected = false;
        vi.advanceTimersByTime(TIMEOUT_MS);

        expect(seen).toEqual([]);
    });

    // A frozen tab stops draining the socket while timers keep their own schedule, so beats can
    // still be queued when this fires. Waiting another window costs nothing.
    it('waits another window instead of reporting while the tab is hidden', () => {
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        const client = new Colibri('app', 'localhost', 9011);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        vi.advanceTimersByTime(TIMEOUT_MS);
        expect(seen).toEqual([]);

        vi.stubGlobal('document', { visibilityState: 'visible' });
        deliver('colibri', { command: 'protocol::accepted', payload: { serverVersion: PROTOCOL_VERSION } });
        vi.advanceTimersByTime(TIMEOUT_MS * 2);

        expect(seen).toEqual([]);
    });

    it('does not follow an explicit refusal with a contradictory old-server guess', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        connectSocket();
        getAnyHandler(fakeSocket.onAny)('colibri', {
            command: 'protocol::rejected',
            payload: { reason: 'nope', serverVersion: '9', clientVersion: PROTOCOL_VERSION }
        });
        vi.advanceTimersByTime(TIMEOUT_MS * 2);

        expect(seen).toHaveLength(1);
        expect(seen[0].serverVersion).toBe('9');
        expect(seen[0].fatal).toBe(true);

        errorSpy.mockRestore();
    });
});
