// Temporary diagnostic: a v3 TCP client that joins the *same* app as the colibri-web
// verification peer, so that "does the server relay Socket.IO <-> TCP at all" can be
// answered without Unity in the picture.
import * as net from 'net';
import { Config } from '../src/server/configuration.js';
import {
    FrameReader,
    FrameType,
    encodeHandshakeFrame,
    encodeHeartbeatFrame,
    encodeMessageFrame,
} from '../src/server/modules/networking/protocol.js';

const app = process.argv[2] ?? 'myAppName';
const runMillis = Number(process.argv[3] ?? 20000);
const hostname = `tcp-crosstalk-${process.pid}`;

const onError = (err: Error | undefined) => {
    if (err) console.error(err);
};

const reader = new FrameReader();
let heartbeats = 0;
let messages = 0;
const client = new net.Socket();

client.on('data', data => {
    for (const frame of reader.append(data)) {
        switch (frame.type) {
            case FrameType.Heartbeat:
                heartbeats += 1;
                if (!client.writableEnded) client.write(encodeHeartbeatFrame(frame.pingTimestamp), onError);
                break;
            case FrameType.Message:
                messages += 1;
                console.log(`<- ${frame.channel} / ${frame.command} :: ${frame.payload.toString('utf8')}`);
                break;
            case FrameType.Handshake:
                console.log(`<- handshake ${frame.version} / ${frame.app} / ${frame.name}`);
                break;
        }
    }
});

client.on('error', err => console.error(err));
client.on('close', () => console.log(`done: ${heartbeats} heartbeat(s), ${messages} message(s)`));

client.connect(Config.TCP_PORT, '127.0.0.1', () => {
    console.log(`connected, handshaking as app "${app}"`);
    client.write(encodeHandshakeFrame('2', app, hostname), onError);

    setTimeout(() => {
        console.log('-> sending broadcast::string on myChannel');
        client.write(
            encodeMessageFrame({
                channel: 'myChannel',
                command: 'broadcast::string',
                payload: Buffer.from(JSON.stringify('hello from the raw tcp client'), 'utf8'),
            }),
            onError
        );
    }, 2000);

    setTimeout(() => client.end(), runMillis);
});
