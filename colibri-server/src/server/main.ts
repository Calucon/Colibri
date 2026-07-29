import * as colibri from './modules/index.js';
import { Config } from './configuration.js';

/**
 * Debugging
 */

// See Config.STACK_TRACE_LIMIT for why this isn't Infinity.
Error.stackTraceLimit = Config.STACK_TRACE_LIMIT;

// Print console errors in GUI
// const redirectConsole = new colibri.RedirectConsole();
const dataStore = new colibri.DataStore();

/**
 *    Servers
 */
const webServer = new colibri.WebServer(
    Config.WEBSERVER_HOST,
    Config.WEBSERVER_PORT,
    Config.WEBSERVER_ROOT,
    Config.BASE_URL
);
const voiceServer = new colibri.VoiceServer(Config.VOICE_SAMPLING_RATE, Config.DATA_ROOT, Config.VOICE_RECORDING);

const tcpServer = new colibri.TCPServerProxy();
const socketioServer = new colibri.SocketIOServer();
const connectionPool = new colibri.ConnectionPool(tcpServer, socketioServer);

/**
 *    APIs
 */
const restApi = new colibri.RestAPI(Config.DATA_ROOT, webServer);

/**
 *    Plumbing
 *
 *    Constructed for their side effects only (each subscribes to the connection pool /
 *    registers itself as a Service in its constructor) - never referenced again, so none
 *    of these are assigned to a variable.
 */
new colibri.ClientLogger(connectionPool);
new colibri.WebLog(socketioServer);
new colibri.ModelSynchronization(connectionPool, dataStore);
new colibri.Broadcaster(connectionPool);
new colibri.ClientBroadcast(connectionPool);
new colibri.MeasureLatency(connectionPool, socketioServer);

/**
 *    Startup
 */

const startup = async () => {
    for (const service of colibri.Service.Current) {
        await service.init();
    }

    const httpServer = webServer.start();
    socketioServer.start(httpServer);
    tcpServer.start(Config.TCP_PORT, Config.TCP_HOST);
    voiceServer.start(Config.VOICE_PORT, Config.VOICE_HOST);
};

startup().catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
});

/**
 *    Shutdown
 */

// `docker stop` sends SIGTERM (then SIGKILL after a grace period) with no handler
// installed for either, so the TCP worker thread was never terminated and an in-flight
// store.json write could be lost. Guarded against running twice since SIGTERM and SIGINT
// could both arrive (e.g. an operator hits Ctrl+C right after `docker stop`).
let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Received ${signal}, shutting down...`);
    try {
        webServer.stop();
        socketioServer.stop();
        voiceServer.stop();
        await tcpServer.stop();
        await restApi.flush();
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }

    process.exit(0);
};

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});
