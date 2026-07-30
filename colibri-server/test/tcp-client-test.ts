// Manual v3 protocol smoke test: connects, handshakes, then decodes what the server sends
// and echoes heartbeat frames back the way a real client must. Run against a live server
// (`npm run server:start` in another shell) with `npm run test:tcpclient`.
//
// The echo is what makes item 22 (heartbeat + latency ping merged into one frame)
// observable at all: the server derives a client's latency purely from the ping timestamp
// coming back in a 0x00 frame, so without a client that returns it there is nothing to see
// in the admin UI's latency chart.
import * as net from 'net';
import { Config } from '../src/server/configuration.js';
import {
    FrameReader,
    FrameType,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';

const address = '127.0.0.1';
const port = Config.TCP_PORT;
const app = 'TEST';
const version = '1';
const hostname = `tcp-client-test-${process.pid}`;
const runMillis = 3000;

const onError = (err: Error | undefined) => {
    if (err) console.error(err);
};

const reader = new FrameReader();
let heartbeats = 0;
let messages = 0;

const client = new net.Socket();

client.on('data', (data) => {
    let frames;
    try {
        frames = reader.append(data);
    } catch (err) {
        console.error('Malformed frame from server:', err);
        client.destroy();
        return;
    }

    for (const frame of frames) {
        switch (frame.type) {
            case FrameType.Heartbeat:
                heartbeats += 1;
                // Echoed back verbatim - the server diffs it against its own clock. The
                // server keeps sending heartbeats until it notices the half-closed socket,
                // so stop replying once this side has ended.
                if (!client.writableEnded) {
                    client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
                }
                break;

            case FrameType.Message:
                messages += 1;
                console.log(
                    `<- message ${frame.channel} / ${frame.command} (${frame.payload.length} payload bytes)`
                );
                break;

            case FrameType.Handshake:
                console.log(`<- handshake ${frame.version} / ${frame.app} / ${frame.name}`);
                break;
        }
    }
});

client.on('error', (err) => console.error(err));

client.on('close', () => {
    console.log(`Disconnected after ${heartbeats} heartbeat(s) and ${messages} message(s)`);
    if (heartbeats === 0) {
        console.error('No heartbeat received - the server is not sending v3 heartbeat frames');
        process.exitCode = 1;
    }
});

client.connect(port, address, () => {
    console.log(`Connected to ${address}:${port}, sending handshake`);
    client.write(encodeHandshakeFrame(version, app, hostname), onError);

    // One real message, so the server's ingress path is exercised too and anything the
    // server relays back to this app shows up in the log above.
    client.write(
        encodeMessageFrame({
            channel: `${app}::test`,
            command: 'ping',
            payload: Buffer.from(JSON.stringify({ from: hostname }), 'utf8'),
        }),
        onError
    );

    setTimeout(() => client.end(), runMillis);
});
