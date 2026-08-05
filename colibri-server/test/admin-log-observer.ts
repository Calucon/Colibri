// Stands in for the admin UI's /log page: subscribes to the same `colibri::log` channel the
// Angular LogService uses, so what a Unity client sends on the `log` channel can be read
// without a browser.
import { connect } from 'socket.io-client';

const socket = connect('ws://localhost:9011', {
    query: { app: 'colibri', version: '2' },
    transports: ['websocket']
});

const showBroadcastTraffic = process.argv[2] === 'traffic';

socket.on('connect', () => {
    console.log(`[admin] connected, requesting log (broadcast traffic: ${showBroadcastTraffic})`);
    socket.emit('colibri::log', {
        command: 'requestLog',
        payload: { filter: '', levels: [0, 1, 2, 3, 4], showBroadcastTraffic }
    });
});

socket.onAny((channel: string, msg: { command: string; payload: unknown }) => {
    if (channel !== 'colibri::log') return;
    const m = msg.payload as { level?: number; msg?: string; metadata?: Record<string, unknown> };
    if (m?.msg === undefined) return;
    console.log(`[admin] lvl=${m.level} ${JSON.stringify(m.msg)}  ${JSON.stringify(m.metadata ?? {})}`);
});

setTimeout(() => process.exit(0), Number(process.env.OBSERVE_MS ?? 20000));
