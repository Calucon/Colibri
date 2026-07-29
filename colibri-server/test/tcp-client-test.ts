import * as net from 'net';
import { Config } from '../src/server/configuration.js';
import { encodeHandshakeFrame } from '../src/server/modules/networking/protocol.js';

const address = '127.0.0.1';
const port = Config.TCP_PORT;
const app = 'TEST';
const version = '1';
const hostname = Math.random().toString();

const onError = (err: Error | undefined) => {
    if (err) {
        console.error(err);
    } else {
        console.log('No error');
    }
};

// create a connection to the server and send some data:
const client = new net.Socket();
client.connect(port, address, () => {
    console.log('Connected, sending handshake');
    const handshake = encodeHandshakeFrame(version, app, hostname);
    client.write(handshake, onError);


    setTimeout(() => {
        client.end();
    }, 1000);
});
