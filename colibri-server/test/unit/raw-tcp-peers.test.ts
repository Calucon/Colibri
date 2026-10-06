import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { once } from 'events';
import { readdirSync, readFileSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    COLIBRI_CHANNEL,
    FrameReader,
    FrameType,
    PROTOCOL_REJECTED_COMMAND,
    protocolRejection,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../../src/server/modules/networking/protocol.js';

// The scripts under test/ that talk to a server over raw TCP, the way a Unity client does.
const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.resolve(TEST_DIR, '..');

// length 1, type 0x07: a frame type no Colibri version has.
const UNDECODABLE_FRAME = Buffer.from([ 0x01, 0x00, 0x00, 0x00, 0x07 ]);

type Behaviour = (socket: net.Socket, frame: FrameType) => void;

// Stands in for the server: `behave` is called with every frame the client sends.
const fakeServer = async function (behave: Behaviour): Promise<net.Server> {
    const server = net.createServer(socket => {
        const reader = new FrameReader();
        socket.on('error', () => undefined);
        socket.on('data', data => {
            for (const frame of reader.append(data)) behave(socket, frame.type);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
};

const runTcpClientTest = async function (port: number, ...args: string[]): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(process.execPath, [ '--import', 'tsx', path.join(TEST_DIR, 'tcp-client-test.ts'), ...args ], {
        cwd: SERVER_DIR,
        env: { ...process.env, TCP_PORT: String(port) },
        stdio: [ 'ignore', 'ignore', 'pipe' ],
    });
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    const [ code ] = await once(child, 'exit') as [ number | null ];
    return { code, stderr };
};

describe('npm run test:tcpclient', () => {
    let server: net.Server | undefined;

    afterEach(async () => {
        server?.close();
        server = undefined;
    });

    const run = async (behave: Behaviour, ...args: string[]) => {
        server = await fakeServer(behave);
        return runTcpClientTest((server.address() as net.AddressInfo).port, ...args);
    };

    // Exit 0 used to mean only "at least one heartbeat arrived": a frame it could not decode
    // after that was printed, and then the script exited 0 as if all was well.
    it('exits 1 for a frame it cannot decode, after a heartbeat', async () => {
        const { code, stderr } = await run((socket, type) => {
            if (type === FrameType.Handshake) socket.write(encodeHeartbeatFrame(1n));
            // The echo: the heartbeat has been counted, so now the frame it cannot decode.
            if (type === FrameType.Heartbeat) socket.write(UNDECODABLE_FRAME);
        });

        expect(stderr).toContain('Malformed frame from server');
        expect(code).toBe(1);
    }, 15000);

    it('exits 1 for a frame it cannot decode, before any heartbeat', async () => {
        const { code } = await run((socket, type) => {
            if (type === FrameType.Handshake) socket.write(UNDECODABLE_FRAME);
        });

        expect(code).toBe(1);
    }, 15000);

    it('exits 1 when no heartbeat comes', async () => {
        const { code } = await run((socket, type) => {
            if (type === FrameType.Handshake) socket.end();
        });

        expect(code).toBe(1);
    }, 15000);

    it('exits 2 when the server refuses its protocol version', async () => {
        const { code, stderr } = await run((socket, type) => {
            if (type !== FrameType.Handshake) return;
            socket.end(encodeMessageFrame({
                channel: COLIBRI_CHANNEL,
                command: PROTOCOL_REJECTED_COMMAND,
                payload: Buffer.from(JSON.stringify(protocolRejection('1')), 'utf8'),
            }));
        }, '1');

        expect(stderr).toContain('REFUSED');
        expect(code).toBe(2);
    }, 15000);

    it('exits 0 after heartbeating with a server that does nothing wrong', async () => {
        const { code } = await run((socket, type) => {
            if (type === FrameType.Handshake) socket.write(encodeHeartbeatFrame(1n));
        });

        expect(code).toBe(0);
    }, 15000);
});

// A peer that announces a version of its own is refused as soon as PROTOCOL_VERSION moves on,
// and then looks like a broken server rather than a stale script.
describe('raw TCP peers under test/', () => {
    const scripts = readdirSync(TEST_DIR).filter(name => name.endsWith('.ts'));

    it.each(scripts)('%s announces PROTOCOL_VERSION, not a version literal of its own', name => {
        const source = readFileSync(path.join(TEST_DIR, name), 'utf8');

        expect(source).not.toMatch(/encodeHandshakeFrame\(\s*['"`]/);
    });
});
