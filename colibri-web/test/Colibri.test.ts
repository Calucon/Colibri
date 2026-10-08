import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { firstValueFrom, type Observable } from 'rxjs';
import { connect } from 'socket.io-client';
import { Sync } from '../src/Broadcasting';
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
import { ColibriError, ProtocolMismatchError } from '../src/ColibriError';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';

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
        // Whether Socket.IO will retry after a failed connection attempt, which it does unless
        // told not to.
        active: true,
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
        expect(() => new Colibri('app', 'localhost', port)).toThrow('Port out of allowed range (1 - 65535)');
    });

    // NaN fails every range comparison, so it used to sail through and connect to "host:NaN".
    it.each([NaN, 9011.5])('throws a ColibriError for the port %d, which is not a whole number', port => {
        expect(() => new Colibri('app', 'localhost', port)).toThrow(ColibriError);
    });

    // 1.x took '9011' from plain JavaScript because its range checks coerced the string; the
    // stricter whole-number check must not turn that into a refusal.
    it.each(['9011', ' 9011 '])('accepts the port as the numeric string %j', port => {
        const colibri = new Colibri('app', 'localhost', port as unknown as number);
        expect(colibri.port).toBe(9011);
        expect(colibri.uri).toBe('ws://localhost:9011');
    });

    it.each(['abc', '90x1', ''])('throws a ColibriError for the port string %j, which is not a number', port => {
        expect(() => new Colibri('app', 'localhost', port as unknown as number)).toThrow(
            'Port must be a whole number (1 - 65535)'
        );
    });

    it('accepts the ends of the port range', () => {
        expect(new Colibri('app', 'localhost', 1).uri).toBe('ws://localhost:1');
        (Colibri as unknown as { instance: Colibri | null }).instance = null;
        expect(new Colibri('app', 'localhost', 65535).uri).toBe('ws://localhost:65535');
    });

    // Under Node there is no `window` at all, so the default used to be a ReferenceError that
    // escaped the constructor instead of a ColibriError saying what was missing.
    it('throws a ColibriError, not a ReferenceError, when no server is given outside a browser', () => {
        expect(typeof window).toBe('undefined');
        expect(() => new Colibri('app')).toThrow(ColibriError);
        expect(() => new Colibri('app')).toThrow('pass it as the second argument');
    });

    it('defaults the server to the host that served the page in a browser', () => {
        vi.stubGlobal('window', { location: { hostname: 'colibri.example.org' } });

        const c = new Colibri('app');

        expect(c.server).toBe('colibri.example.org');
        expect(c.uri).toBe('ws://colibri.example.org:9011');
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

    // http(s):// is what an address bar shows for the same server, and used to be glued behind a
    // second scheme: 'ws://https://example.com:9011' and 'http://https://example.com:9011'.
    it.each([
        ['example.com', 'ws://example.com:9011', 'http://example.com:9011/api/store/app/'],
        ['ws://example.com', 'ws://example.com:9011', 'http://example.com:9011/api/store/app/'],
        ['wss://example.com', 'wss://example.com:9011', 'https://example.com:9011/api/store/app/'],
        ['http://example.com', 'ws://example.com:9011', 'http://example.com:9011/api/store/app/'],
        ['https://example.com', 'wss://example.com:9011', 'https://example.com:9011/api/store/app/'],
        ['HTTPS://example.com', 'wss://example.com:9011', 'https://example.com:9011/api/store/app/'],
        // A trailing slash, as copied out of an address bar, used to land in front of the port.
        ['example.com/', 'ws://example.com:9011', 'http://example.com:9011/api/store/app/'],
        ['https://example.com/', 'wss://example.com:9011', 'https://example.com:9011/api/store/app/'],
        ['  wss://example.com//  ', 'wss://example.com:9011', 'https://example.com:9011/api/store/app/']
    ])('maps the server %j to the socket %s and the REST API %s', (server, uri, rest) => {
        const c = new Colibri('app', server, 9011);

        expect(c.uri).toBe(uri);
        expect(c.uriRestApi).toBe(rest);
        expect(connectMock).toHaveBeenCalledWith(uri, expect.anything());
    });

    it('rejects a scheme that is neither ws(s) nor http(s)', () => {
        expect(() => new Colibri('app', 'ftp://example.com', 9011)).toThrow(ColibriError);
        expect(connectMock).not.toHaveBeenCalled();
    });

    it('rejects a server address that is nothing but a scheme', () => {
        expect(() => new Colibri('app', 'https://', 9011)).toThrow('Server Address missing or empty!');
    });

    // The admin UI's URL is 'http://<server>:9011', and the port in it used to stay part of the
    // host: 'ws://host:9011:9011', which retried forever without a word.
    it.each([
        ['http://example.com:9011/', 9011, 'ws://example.com:9011', 'http://example.com:9011/api/store/app/'],
        ['ws://example.com:8080', 8080, 'ws://example.com:8080', 'http://example.com:8080/api/store/app/'],
        ['https://example.com:443', 443, 'wss://example.com:443', 'https://example.com:443/api/store/app/'],
        ['example.com:9011', 9011, 'ws://example.com:9011', 'http://example.com:9011/api/store/app/'],
        ['http://[::1]:44011', 44011, 'ws://[::1]:44011', 'http://[::1]:44011/api/store/app/'],
        ['[::1]', 9011, 'ws://[::1]:9011', 'http://[::1]:9011/api/store/app/']
    ])('takes the port from the server %j when none is passed', (server, port, uri, rest) => {
        const c = new Colibri('app', server);

        expect(c.port).toBe(port);
        expect(c.uri).toBe(uri);
        expect(c.uriRestApi).toBe(rest);
        expect(connectMock).toHaveBeenCalledWith(uri, expect.anything());
    });

    it('accepts the same port in the server address and the argument', () => {
        expect(new Colibri('app', 'http://example.com:44011', 44011).uri).toBe('ws://example.com:44011');
    });

    it('rejects a server address whose port disagrees with the one passed', () => {
        expect(() => new Colibri('app', 'http://example.com:9011', 44011)).toThrow(ColibriError);
        expect(() => new Colibri('app', 'http://example.com:9011', 44011)).toThrow('give the port once');
        expect(connectMock).not.toHaveBeenCalled();
    });

    it('uses 9011 when neither the server address nor the argument has a port', () => {
        expect(new Colibri('app', 'example.com').port).toBe(9011);
    });

    it.each(['example.com:0', 'example.com:65536'])('rejects the out-of-range port in the server %j', server => {
        expect(() => new Colibri('app', server)).toThrow('Port out of allowed range (1 - 65535)');
    });

    // A path used to land in front of the port: 'wss://example.com/colibri:9011'.
    it.each([
        'https://example.com/colibri',
        'https://example.com/colibri/',
        'http://example.com:9011/log',
        'http://example.com:9011/#/log',
        'example.com?app=x'
    ])('rejects the server %j, which has a path or query after the host', server => {
        expect(() => new Colibri('app', server)).toThrow(ColibriError);
        expect(() => new Colibri('app', server)).toThrow('has a path or query after the host');
        expect(connectMock).not.toHaveBeenCalled();
    });

    it.each(['example.com:', 'example.com:abc', 'ws://:9011', 'fe80::1'])(
        'rejects the server %j, which is not a host and an optional port',
        server => {
            expect(() => new Colibri('app', server)).toThrow(ColibriError);
            expect(connectMock).not.toHaveBeenCalled();
        }
    );

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

    // The server takes a client of the app 'colibri' for its own admin UI: it gets the server's log
    // and every client's connects, and is exempt from the version check. Nothing used to say so.
    it("warns that the app name 'colibri' is reserved for the admin UI", () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        new Colibri('colibri', 'localhost', 9011);

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain("'colibri' is reserved for the server's admin UI");
        // Still connects under that name: an app relying on it keeps working.
        expect(connectMock).toHaveBeenCalledWith('ws://localhost:9011', {
            query: { app: 'colibri', version: PROTOCOL_VERSION },
            transports: ['websocket']
        });
        warnSpy.mockRestore();
    });

    // The server compares the name exactly, so only 'colibri' itself is the admin UI.
    it.each(['my-app', 'Colibri', 'colibri-study'])('does not warn about the app name %j', app => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        new Colibri(app, 'localhost', 9011);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
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
        expect(c.getRestUri('///nested/key')).toBe('http://localhost:9011/api/store/app/nested%2Fkey');
    });

    it('returns null for an empty or whitespace-only key', () => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.getRestUri('')).toBeNull();
        expect(c.getRestUri('   ')).toBeNull();
    });

    // The key is one path segment. Written in unencoded, '#' and '?' cut it short - 'a#b' and
    // 'a?b' were both stored as 'a', over each other - '/' made a path no route matched, and '%'
    // a URL the server answered 400 for.
    it.each([
        ['a b', 'a%20b'],
        ['a#b', 'a%23b'],
        ['a?b', 'a%3Fb'],
        ['a/b', 'a%2Fb'],
        ['50%', '50%25'],
        ['x%20y', 'x%2520y'],
        ['../x', '..%2Fx'],
        ['a..b', 'a..b'],
        ['plain-key_1', 'plain-key_1']
    ])('encodes the key %j as the path segment %j', (key, segment) => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.getRestUri(key)).toBe(`http://localhost:9011/api/store/app/${segment}`);
    });

    // A URL parser resolves '.' and '..' - encoded or not - as directory steps, so '..' used to
    // GET the server's list of apps instead of a value. No URL can name them as a key.
    it.each(['.', '..', ' .. ', '/..'])('returns null for the key %j, which a URL cannot carry', key => {
        const c = new Colibri('app', 'localhost', 9011);
        expect(c.getRestUri(key)).toBeNull();
    });

    it('encodes the app name in the REST API uri', () => {
        const c = new Colibri('my app/#?%', 'localhost', 9011);
        expect(c.uriRestApi).toBe('http://localhost:9011/api/store/my%20app%2F%23%3F%25/');
        expect(c.getRestUri('key')).toBe('http://localhost:9011/api/store/my%20app%2F%23%3F%25/key');
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

    it('skips fetch for the key .., which no URL can carry', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(c.getRestObject('..')).resolves.toBeNull();
        await expect(c.setRestObject('..', { a: 1 })).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
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

    // What the JSDoc promises: a server that cannot be reached is not a null or a false, it is a
    // rejection, exactly as fetch gives it.
    it('getRestObject and setRestObject reject when the server cannot be reached', async () => {
        const c = new Colibri('app', 'localhost', 9011);
        const networkError = new TypeError('fetch failed');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

        await expect(c.getRestObject('mykey')).rejects.toBe(networkError);
        await expect(c.setRestObject('mykey', { a: 1 })).rejects.toBe(networkError);
    });
});

describe('wrapper functions', () => {
    // RegisterChannel, UnregisterChannel and RegisterOnce are covered under "registering before
    // new Colibri()": they no longer do nothing without an instance.
    it('return undefined when Colibri is not initialized', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(SendMessage('ch', 'cmd')).toBeUndefined();
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

// Shared by the two describes below, which drive Sync and RegisterModelSync through the real
// Colibri rather than a mock of it.
class Widget extends SyncModel<Widget> {
    @Synced() accessor label = '';
}

// Mirrors socket.io: a message reaches every handler registered for its channel.
const deliver = (channel: string, msg: { command: string; payload?: unknown }) => {
    for (const [event, handler] of [...fakeSocket.on.mock.calls, ...fakeSocket.once.mock.calls]) {
        if (event === channel) handler({ channel, ...msg });
    }
};

const latest = <T>(models$: Observable<T[]>): T[] => {
    let current: T[] = [];
    models$.subscribe(m => (current = m)).unsubscribe();
    return current;
};

// RegisterModelSync asks for every model on the next task, once the models registered in the same
// block of code have been asked for.
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));

// Registering first and constructing Colibri second is the natural order for module-level code
// (`const [players$] = RegisterModelSync(...)` at the top of a file), and it used to leave every
// one of those registrations listening to nothing, silently.
describe('registering before new Colibri()', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('attaches RegisterChannel and RegisterOnce handlers once Colibri is constructed', () => {
        const handler = vi.fn();
        const onceHandler = vi.fn();
        RegisterChannel('early', handler);
        RegisterOnce('early-once', onceHandler);
        expect(connectMock).not.toHaveBeenCalled();

        new Colibri('app', 'localhost', 9011);

        expect(fakeSocket.on).toHaveBeenCalledWith('early', handler);
        expect(fakeSocket.once).toHaveBeenCalledWith('early-once', onceHandler);
        // Registering early is supported now, so it is no longer worth a warning.
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('lets UnregisterChannel take back a handler that is still waiting', () => {
        const handler = vi.fn();
        RegisterChannel('early', handler);
        RegisterOnce('early', handler);
        UnregisterChannel('early', handler);
        UnregisterChannel('early', handler);

        new Colibri('app', 'localhost', 9011);

        expect(fakeSocket.on).not.toHaveBeenCalledWith('early', handler);
        expect(fakeSocket.once).not.toHaveBeenCalledWith('early', handler);
    });

    it('delivers to a Sync.receive* listener registered before Colibri existed', () => {
        const received = vi.fn();
        Sync.receiveString('early-sync', received);

        new Colibri('app', 'localhost', 9011);
        deliver('early-sync', { command: 'broadcast::string', payload: 'hello' });

        expect(received).toHaveBeenCalledWith('hello');
    });

    it('does not attach a Sync listener that was unregistered before Colibri existed', () => {
        const received = vi.fn();
        Sync.receiveBool('early-unregistered', received);
        Sync.unregister('early-unregistered', received);

        new Colibri('app', 'localhost', 9011);

        expect(fakeSocket.on.mock.calls.map(([event]) => event)).not.toContain('early-unregistered');
    });

    it('requests the current state, and receives models, for a RegisterModelSync made first', async () => {
        const [models$] = RegisterModelSync({ name: 'early-widget', type: Widget });
        expect(warnSpy).not.toHaveBeenCalled();

        new Colibri('app', 'localhost', 9011);
        await nextTask();

        expect(fakeSocket.emit).toHaveBeenCalledWith('early-widget', { command: 'model::request', payload: {} });

        deliver('early-widget', { command: 'model::update', payload: { id: 'w1', label: 'from the server' } });

        const models = latest(models$);
        expect(models).toHaveLength(1);
        expect(models[0].label).toBe('from the server');
    });

    it('asks for a model registered before Colibri existed once Colibri does, and sends it as it is then', () => {
        vi.useFakeTimers();
        const [, registerModel] = RegisterModelSync({ name: 'early-local', type: Widget });
        const widget = new Widget('w1');
        try {
            registerModel(widget);
            widget.label = 'changed before connecting';

            new Colibri('app', 'localhost', 9011);

            expect(fakeSocket.emit).toHaveBeenCalledWith('early-local', {
                command: 'model::request',
                payload: { id: 'w1' }
            });

            // The server has nothing for it.
            deliver('early-local', { command: 'model::update', payload: { id: 'w1' } });

            expect(fakeSocket.emit).toHaveBeenCalledWith('early-local', {
                command: 'model::update',
                payload: { id: 'w1', label: 'changed before connecting' }
            });
        } finally {
            widget.delete();
            vi.useRealTimers();
        }
    });
});

// The server relays model updates, it does not replay them, so one relayed while this client was
// disconnected is simply gone for it - and it used to stay stale until that model changed again.
describe('catching up on models after a reconnect', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    const requested = () =>
        fakeSocket.emit.mock.calls
            .filter(([, msg]) => (msg as Message).command === 'model::request')
            .map(([channel]) => channel);

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    it('asks for every registered model channel again on each reconnect', async () => {
        new Colibri('app', 'localhost', 9011);
        RegisterModelSync({ name: 'resync-a', type: Widget });
        RegisterModelSync({ name: 'resync-b', type: Widget });
        await nextTask();
        expect(requested()).toEqual(['resync-a', 'resync-b']);

        // The first connect is not a reconnect: Socket.IO sends the requests above on it.
        connectSocket();
        expect(requested()).toEqual(['resync-a', 'resync-b']);

        connectSocket();
        expect(requested()).toEqual(['resync-a', 'resync-b', 'resync-a', 'resync-b']);

        connectSocket();
        expect(requested()).toHaveLength(6);
    });

    it('does the same for a RegisterModelSync made before new Colibri()', async () => {
        RegisterModelSync({ name: 'resync-early', type: Widget });
        new Colibri('app', 'localhost', 9011);
        await nextTask();

        connectSocket();
        connectSocket();

        expect(requested()).toEqual(['resync-early', 'resync-early']);
    });

    it('brings a model missed during the outage up to date, in place, without duplicating it', async () => {
        new Colibri('app', 'localhost', 9011);
        const [models$] = RegisterModelSync({ name: 'resync-widget', type: Widget });
        await nextTask();
        connectSocket();
        deliver('resync-widget', { command: 'model::update', payload: { id: 'w1', label: 'before' } });
        const [widget] = latest(models$);

        // Disconnected; another client changes w1 and the server relays it to everyone but us.
        connectSocket();
        expect(requested()).toEqual(['resync-widget', 'resync-widget']);

        // What the server answers that request with: one model::update per model it has.
        deliver('resync-widget', { command: 'model::update', payload: { id: 'w1', label: 'during the outage' } });

        const models = latest(models$);
        expect(models).toHaveLength(1);
        expect(models[0]).toBe(widget);
        expect(widget.label).toBe('during the outage');
    });
});

// The server forgets every model of an app when the app's last client leaves, and when it restarts.
// A model this client had registered itself was never sent again after that, so a client joining
// later never saw it.
describe('sending its own models again after a reconnect', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    /** Everything emitted with `command`, as [channel, payload]. */
    const sent = (command: string) =>
        fakeSocket.emit.mock.calls
            .filter(([, msg]) => (msg as Message).command === command)
            .map(([channel, msg]) => [channel, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    /** A Colibri with one own model, 'w1', connected and then reconnected. */
    const reconnectedWithOwnModel = () => {
        new Colibri('app', 'localhost', 9011);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);

        connectSocket();
        // The server had nothing for it, and was sent all of it.
        deliver('own', { command: 'model::update', payload: { id: 'w1' } });
        connectSocket();
        return { models$, widget };
    };

    it('asks again for each of its own models by id on a reconnect', async () => {
        new Colibri('app', 'localhost', 9011);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        registerModel(new Widget('w1'));
        registerModel(new Widget('w2'));
        await nextTask();

        connectSocket();
        expect(sent('model::request')).toEqual([
            ['own', { id: 'w1' }],
            ['own', { id: 'w2' }]
        ]);
        deliver('own', { command: 'model::update', payload: { id: 'w1' } });
        deliver('own', { command: 'model::update', payload: { id: 'w2' } });
        expect(sent('model::request').slice(2)).toEqual([['own', {}]]);

        connectSocket();
        expect(sent('model::request').slice(3)).toEqual([
            ['own', { id: 'w1', again: true }],
            ['own', { id: 'w2', again: true }]
        ]);
    });

    // Asked for again, the server would answer model::delete for an id another client deleted a
    // moment ago - but this client has the model now, and has never had an answer for it.
    it('asks afresh after a reconnect for an own model the server has not answered for yet', async () => {
        new Colibri('app', 'localhost', 9011);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        registerModel(new Widget('w1'));
        await nextTask();
        connectSocket();

        connectSocket();
        expect(sent('model::request')).toEqual([
            ['own', { id: 'w1' }],
            ['own', { id: 'w1' }]
        ]);
    });

    it('sends the whole model when the server answers with nothing but its id', () => {
        const { models$, widget } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        deliver('own', { command: 'model::update', payload: { id: 'w1' } });

        expect(sent('model::update')).toEqual([['own', { id: 'w1', label: 'mine' }]]);
        expect(latest(models$)).toEqual([widget]);
        expect(widget.label).toBe('mine');
    });

    // What the server has is newer than what this client kept: another client changed it.
    it('takes what the server has instead of overwriting it', async () => {
        const { models$, widget } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        // The answers to the request for every model, and to the one for w1.
        deliver('own', { command: 'model::update', payload: { id: 'w1', label: 'newer' } });
        deliver('own', { command: 'model::update', payload: { id: 'w1', label: 'newer' } });
        await settle();

        expect(sent('model::update')).toEqual([]);
        expect(widget.label).toBe('newer');
        expect(latest(models$)).toEqual([widget]);
    });

    it('leaves alone the models the server told it about', async () => {
        new Colibri('app', 'localhost', 9011);
        RegisterModelSync({ name: 'own', type: Widget });
        await nextTask();
        connectSocket();
        deliver('own', { command: 'model::update', payload: { id: 'theirs', label: 'not mine' } });

        connectSocket();
        expect(sent('model::request')).toEqual([
            ['own', {}],
            ['own', {}]
        ]);

        deliver('own', { command: 'model::update', payload: { id: 'theirs' } });
        await settle();
        expect(sent('model::update')).toEqual([]);
    });

    // The server's answer for an own model another client deleted while this one was away.
    it('drops an own model the server answers with model::delete, and asks for everything else', () => {
        const { models$ } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        deliver('own', { command: 'model::delete', payload: { id: 'w1' } });

        expect(sentInOrder()).toEqual([['model::request', {}]]);
        expect(latest(models$)).toEqual([]);
    });

    it('asks for everything else once every own model is answered, a delete among the answers', () => {
        new Colibri('app', 'localhost', 9011);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        const kept = new Widget('w2');
        registerModel(new Widget('w1'));
        registerModel(kept);
        connectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver('own', { command: 'model::delete', payload: { id: 'w1' } });
        expect(sent('model::request')).toEqual([]);

        deliver('own', { command: 'model::update', payload: { id: 'w2', label: 'kept' } });
        expect(sentInOrder()).toEqual([['model::request', {}]]);
        expect(latest(models$)).toEqual([kept]);
    });

    // A delete relayed just before the answer, from a server that does not remember deletes
    // (MODEL_TOMBSTONE_SECONDS=0) and so answers with the bare id.
    it('does not bring back an own model deleted before the answer came', () => {
        const { models$ } = reconnectedWithOwnModel();
        fakeSocket.emit.mockClear();

        deliver('own', { command: 'model::delete', payload: { id: 'w1' } });
        deliver('own', { command: 'model::update', payload: { id: 'w1' } });

        expect(sentInOrder()).toEqual([['model::request', {}]]);
        expect(latest(models$)).toEqual([]);
    });

    it('does it again on every reconnect', () => {
        reconnectedWithOwnModel();
        deliver('own', { command: 'model::update', payload: { id: 'w1' } });

        connectSocket();
        deliver('own', { command: 'model::update', payload: { id: 'w1' } });

        expect(sent('model::update')).toEqual([
            ['own', { id: 'w1', label: 'mine' }],
            ['own', { id: 'w1', label: 'mine' }],
            ['own', { id: 'w1', label: 'mine' }]
        ]);
    });

    it('does it for a model registered before new Colibri()', () => {
        const [, registerModel] = RegisterModelSync({ name: 'own-early', type: Widget });
        const widget = new Widget('early');
        widget.label = 'mine';
        registerModel(widget);
        new Colibri('app', 'localhost', 9011);
        connectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver('own-early', { command: 'model::update', payload: { id: 'early' } });

        expect(sent('model::update')).toEqual([['own-early', { id: 'early', label: 'mine' }]]);
    });

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }
    };

    /** Everything emitted, as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    /** A Colibri with one own model, 'p1', that has been connected and is now disconnected. */
    const disconnectedWithOwnPair = () => {
        new Colibri('app', 'localhost', 9011);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'A';
        pair.b = 'B';
        registerModel(pair);
        connectSocket();
        deliver('own', { command: 'model::update', payload: { id: 'p1' } });
        disconnectSocket();
        fakeSocket.emit.mockClear();
        return { models$, pair };
    };

    it('asks for everything else once its own models are answered, not before', () => {
        new Colibri('app', 'localhost', 9011);
        const [, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        registerModel(new Widget('w1'));
        registerModel(new Widget('w2'));
        connectSocket();
        connectSocket();
        fakeSocket.emit.mockClear();

        deliver('own', { command: 'model::update', payload: { id: 'w1', label: 'kept' } });
        expect(sent('model::request')).toEqual([]);

        deliver('own', { command: 'model::update', payload: { id: 'w2' } });
        expect(sentInOrder()).toEqual([
            ['model::update', { id: 'w2', label: '' }],
            ['model::request', {}]
        ]);
    });

    // Socket.IO buffers what is sent while disconnected and sends it on the reconnect, ahead of the
    // request for the model. A server that had forgotten the model kept that one change as all of
    // it, answered with it rather than a bare id, and the rest was never sent again.
    it('holds back a change made while disconnected, and sends it with the rest when the server forgot the model', async () => {
        const { pair } = disconnectedWithOwnPair();

        pair.a = 'A2';
        await settle();
        expect(sent('model::update')).toEqual([]);

        connectSocket();
        deliver('own', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1', again: true }],
            ['model::update', { id: 'p1', a: 'A2', b: 'B' }],
            ['model::request', {}]
        ]);
    });

    it('sends only the change it made while disconnected when the server has the model, and takes the rest', async () => {
        const { models$, pair } = disconnectedWithOwnPair();

        pair.a = 'A2';
        await settle();
        connectSocket();
        // Another client changed b meanwhile; a is still what this client last sent.
        deliver('own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B2' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['A2', 'B2']);
        expect(latest(models$)).toEqual([pair]);
        // Sent before everything else is asked for, so that that answer already has it.
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1', again: true }],
            ['model::update', { id: 'p1', a: 'A2' }],
            ['model::request', {}]
        ]);

        // Answered, so from now on a change goes out as it is made.
        fakeSocket.emit.mockClear();
        pair.b = 'B3';
        await settle();
        expect(sent('model::update')).toEqual([['own', { id: 'p1', b: 'B3' }]]);
    });

    // Sent at once, it would reach the server after the request, whose answer - without it - would
    // then undo it here.
    it('holds back a change made after the reconnect until the answer has come', async () => {
        const { pair } = disconnectedWithOwnPair();
        connectSocket();

        pair.b = 'B2';
        await settle();
        expect(sent('model::update')).toEqual([]);

        deliver('own', { command: 'model::update', payload: { id: 'p1', a: 'A', b: 'B' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['A', 'B2']);
        expect(sent('model::update')).toEqual([['own', { id: 'p1', b: 'B2' }]]);
    });

    it('still sends a held change when the connection drops again before the answer', async () => {
        const { pair } = disconnectedWithOwnPair();
        pair.a = 'A2';
        await settle();

        connectSocket();
        disconnectSocket();
        connectSocket();
        deliver('own', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1', again: true }],
            ['model::request', { id: 'p1', again: true }],
            ['model::update', { id: 'p1', a: 'A2', b: 'B' }],
            ['model::request', {}]
        ]);
    });

    // delete() stops this client sending the model's changes; the whole model is one of them.
    it('does not ask for or send again an own model whose delete() was called', async () => {
        new Colibri('app', 'localhost', 9011);
        const [models$, registerModel] = RegisterModelSync({ name: 'own', type: Widget });
        const widget = new Widget('w1');
        widget.label = 'mine';
        registerModel(widget);
        connectSocket();
        disconnectSocket();
        widget.label = 'changed';
        await settle();
        widget.delete();
        await settle();
        fakeSocket.emit.mockClear();

        connectSocket();
        deliver('own', { command: 'model::update', payload: { id: 'w1' } });
        await settle();

        expect(sentInOrder()).toEqual([['model::request', {}]]);
        expect(latest(models$)).toEqual([widget]);
    });

    it('does not send a change held for an own model deleted before the answer came', async () => {
        const { models$, pair } = disconnectedWithOwnPair();
        pair.a = 'A2';
        await settle();

        connectSocket();
        deliver('own', { command: 'model::delete', payload: { id: 'p1' } });
        deliver('own', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sent('model::update')).toEqual([]);
        expect(latest(models$)).toEqual([]);
    });
});

// The server may already have a model under the id registered: another client created it, or this
// one did before the page was reloaded, while another client kept the app alive. registerModel sent
// the model in full straight away, and the answer to the request for every model, already on its
// way, then put the old copy back here only: this client showed the old values while the server and
// every other client had the new ones.
describe('registering a model whose id the server may already have', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    const disconnectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'disconnect') handler('transport close');
        }
    };

    /** Everything emitted, as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    /**
     * A connected Colibri, a RegisterModelSync on 'reg' that has asked for every model, and then a
     * Pair 'p1' of its own, registered.
     */
    const registered = async () => {
        new Colibri('app', 'localhost', 9011);
        const [models$, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        expect(sentInOrder()).toEqual([['model::request', {}]]);
        fakeSocket.emit.mockClear();

        const pair = new Pair('p1');
        pair.a = 'mine-a';
        pair.b = 'mine-b';
        registerModel(pair);
        return { models$, registerModel, pair };
    };

    it('asks for the id, and sends nothing until the server has answered', async () => {
        await registered();
        await settle();

        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
    });

    it('takes what the server has for the id instead of overwriting it', async () => {
        const { models$, pair } = await registered();

        deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['server-a', 'server-b']);
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
        expect(latest(models$)).toEqual([pair]);
    });

    // RegisterModelSync asks for every model first, and that answer comes before the one for the id.
    it('takes the answer to the request for every model as its answer too', async () => {
        const { models$, pair } = await registered();

        deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['server-a', 'server-b']);
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
        expect(latest(models$)).toEqual([pair]);
    });

    it('sends a change made after registering on top of what the server has', async () => {
        const { pair } = await registered();
        pair.a = 'changed';
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);

        deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        await settle();

        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'changed' }]
        ]);
    });

    it('does not ask for everything again once the server has answered', async () => {
        await registered();

        deliver('reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'mine-a', b: 'mine-b' }]
        ]);
    });

    it('asks for a model registered while disconnected once reconnected, as one it has now', async () => {
        new Colibri('app', 'localhost', 9011);
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        disconnectSocket();
        fakeSocket.emit.mockClear();

        const pair = new Pair('p1');
        pair.a = 'mine-a';
        registerModel(pair);
        pair.b = 'changed while away';
        await settle();
        expect(sentInOrder()).toEqual([]);

        connectSocket();
        deliver('reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'mine-a', b: 'changed while away' }],
            ['model::request', {}]
        ]);
    });

    // delete() stops this client sending the model's changes; the whole model is one of them.
    it('does not send a model whose delete() was called before the answer came', async () => {
        const { pair } = await registered();
        pair.delete();

        deliver('reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
    });

    // Both used to stay listed, and every later update for the id went to the first of them only.
    it('replaces the copy of the id the server told it about, instead of listing the id twice', async () => {
        new Colibri('app', 'localhost', 9011);
        const [models$, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        connectSocket();
        await nextTask();
        deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        const [copy] = latest(models$);
        fakeSocket.emit.mockClear();

        const pair = new Pair('p1');
        registerModel(pair);
        expect(latest(models$)).toEqual([pair]);

        deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'server-a', b: 'server-b' } });
        deliver('reg', { command: 'model::update', payload: { id: 'p1', b: 'changed by another client' } });
        await settle();
        expect([pair.a, pair.b]).toEqual(['server-a', 'changed by another client']);
        expect(latest(models$)).toEqual([pair]);

        // The copy no longer sends its changes.
        copy.a = 'changed on the copy';
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);
    });

    it('does nothing when the model listed is registered again', async () => {
        const { models$, registerModel, pair } = await registered();
        registerModel(pair);

        deliver('reg', { command: 'model::update', payload: { id: 'p1' } });
        await settle();

        expect(latest(models$)).toEqual([pair]);
        expect(sentInOrder()).toEqual([
            ['model::request', { id: 'p1' }],
            ['model::update', { id: 'p1', a: 'mine-a', b: 'mine-b' }]
        ]);
    });

    it('replaces an own model registered earlier under the same id, and says so', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { models$, registerModel, pair } = await registered();
            deliver('reg', { command: 'model::update', payload: { id: 'p1' } });

            const second = new Pair('p1');
            registerModel(second);
            expect(latest(models$)).toEqual([second]);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain("'p1'");

            deliver('reg', { command: 'model::update', payload: { id: 'p1', a: 'mine-a', b: 'mine-b' } });
            fakeSocket.emit.mockClear();
            pair.a = 'changed on the first';
            second.b = 'changed on the second';
            await settle();

            expect(sentInOrder()).toEqual([['model::update', { id: 'p1', b: 'changed on the second' }]]);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

// A change made after registerModel, before the server has answered for the model, is held back and
// sent on top of what the server has. The answer to the request for every model carries the id too,
// though, and when it came first it was taken for the answer to the request for the id. The real
// answer then came after the change was sent, without it, and undid it on this client only: it
// showed the old value while the server and every other client had the new one.
describe('keeping a change made after registerModel', () => {
    const connectSocket = () => {
        for (const [event, handler] of fakeSocket.on.mock.calls) {
            if (event === 'connect') handler();
        }
    };

    /** Everything emitted, as [command, payload], in the order it was. */
    const sentInOrder = () =>
        fakeSocket.emit.mock.calls.map(([, msg]) => [(msg as Message).command, (msg as Message).payload]);

    // Long enough for a change a model reported to have been sent: SyncModel buffers for 1ms.
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));

    class Pair extends SyncModel<Pair> {
        @Synced() accessor a = '';
        @Synced() accessor b = '';
    }

    const server = { id: 'p1', a: 'server-a', b: 'server-b' };

    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        debugSpy.mockRestore();
    });

    // Registered at the top of a module, before new Colibri(), the usual order.
    it('asks for a model registered before new Colibri() before asking for every model', async () => {
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        const pair = new Pair('p1');
        registerModel(pair);
        pair.a = 'changed';
        new Colibri('app', 'localhost', 9011);
        connectSocket();
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);

        deliver('reg', { command: 'model::update', payload: server });
        await settle();
        expect(sentInOrder().slice(1)).toEqual([
            ['model::update', { id: 'p1', a: 'changed' }],
            ['model::request', {}]
        ]);
        // What that request is answered with has the change in it.
        deliver('reg', { command: 'model::update', payload: { ...server, a: 'changed' } });
        expect([pair.a, pair.b]).toEqual(['changed', 'server-b']);
    });

    it('asks for a model registered in the same block as RegisterModelSync before asking for every model', async () => {
        new Colibri('app', 'localhost', 9011);
        connectSocket();
        const [, registerModel] = RegisterModelSync({ name: 'reg', type: Pair });
        const pair = new Pair('p1');
        pair.a = 'mine';
        registerModel(pair);
        await settle();
        expect(sentInOrder()).toEqual([['model::request', { id: 'p1' }]]);

        deliver('reg', { command: 'model::update', payload: { id: 'p1' } });
        expect(sentInOrder().slice(1)).toEqual([
            ['model::update', { id: 'p1', a: 'mine', b: '' }],
            ['model::request', {}]
        ]);
    });
});

// Socket.IO retries a connection that fails, for as long as it takes, and a wrong address or a
// server that is down used to look like nothing more than a slow connection.
describe('reporting a server that cannot be reached', () => {
    const fire = (event: string, ...args: unknown[]) => {
        for (const [e, handler] of fakeSocket.on.mock.calls) {
            if (e === event) handler(...args);
        }
    };

    // What Socket.IO hands over under Node: a TransportError whose own message says little, and
    // whose description is the underlying error.
    const transportError = (cause?: string) =>
        Object.assign(new Error('websocket error'), cause ? { description: new Error(cause) } : {});

    let warnSpy: ReturnType<typeof vi.spyOn>;
    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        debugSpy.mockRestore();
    });

    it('warns once per outage, naming the address and the error, however often it retries', () => {
        new Colibri('app', 'colibri.example.org', 44011);

        for (let i = 0; i < 5; i++) fire('connect_error', transportError('connect ECONNREFUSED 10.0.0.1:44011'));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message] = warnSpy.mock.calls[0] as [string];
        expect(message).toContain('ws://colibri.example.org:44011');
        expect(message).toContain('websocket error: connect ECONNREFUSED 10.0.0.1:44011');
        expect(message).toContain('Retrying');
    });

    it('uses the message alone when the error has no underlying cause, as in a browser', () => {
        new Colibri('app', 'localhost', 9011);

        fire('connect_error', transportError());

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('(websocket error)');
    });

    it('warns again for the next outage, once connected in between', () => {
        new Colibri('app', 'localhost', 9011);

        fire('connect_error', transportError('first'));
        fire('connect');
        fire('connect_error', transportError('second'));
        fire('connect_error', transportError('second'));

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy.mock.calls[1][0]).toContain('second');
    });

    it('says nothing when the connection simply comes up', () => {
        new Colibri('app', 'localhost', 9011);

        fire('connect');
        fire('connect');

        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not promise a retry that Socket.IO will not make', () => {
        new Colibri('app', 'localhost', 9011);
        fakeSocket.active = false;

        fire('connect_error', new Error('refused by the server'));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('Not retrying');
        expect(warnSpy.mock.calls[0][0]).not.toContain('Retrying');
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

    it('reports a refusal once, however many times the server sends it', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        const onAny = getAnyHandler(fakeSocket.onAny);
        for (let i = 0; i < 3; i++) {
            onAny('colibri', { command: 'protocol::rejected', payload: { serverVersion: '9' } });
        }

        expect(seen).toHaveLength(1);
        expect(seen[0].fatal).toBe(true);
        expect(errorSpy).toHaveBeenCalledTimes(1);

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

    it('reports a suspected old server when it never announces itself', async () => {
        const client = new Colibri('app', 'localhost', 9011);
        const mismatch = firstValueFrom(client.protocolMismatch);

        connectSocket();
        vi.advanceTimersByTime(TIMEOUT_MS);

        const error = await mismatch;
        expect(error).toBeInstanceOf(ProtocolMismatchError);
        // A protocol version on both paths, so the two are comparable - not a release range.
        expect(error.serverVersion).toBe('1');
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

    // Each kind at most once, but the two are independent: a suspicion says nothing about whether
    // a refusal can follow, e.g. once the old server is replaced by one speaking another version.
    it('reports a suspicion and a later refusal once each', () => {
        const client = new Colibri('app', 'localhost', 9011);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const seen: ProtocolMismatchError[] = [];
        client.protocolMismatch.subscribe(e => seen.push(e));

        for (let i = 0; i < 2; i++) {
            connectSocket();
            vi.advanceTimersByTime(TIMEOUT_MS);
        }
        for (let i = 0; i < 2; i++) {
            getAnyHandler(fakeSocket.onAny)('colibri', {
                command: 'protocol::rejected',
                payload: { serverVersion: '9', clientVersion: PROTOCOL_VERSION }
            });
        }

        expect(seen.map(e => e.fatal)).toEqual([false, true]);

        errorSpy.mockRestore();
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
