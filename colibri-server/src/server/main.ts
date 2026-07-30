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

// If a shutdown step wedges (a socket that won't close, a hung fs write) the process must
// still go away, or `docker stop` waits out its grace period and SIGKILLs us anyway.
const SHUTDOWN_TIMEOUT_MILLIS = 5000;

// Each step is isolated: a signal or crash arriving before startup() finished leaves some
// of these unstarted, and one failing stop() must not skip the steps behind it - least of
// all restApi.flush(), which is the only thing standing between a crash and up to
// SAVE_DEBOUNCE_MILLIS of lost store writes.
const runShutdownStep = async (name: string, step: () => void | Promise<void>): Promise<void> => {
    try {
        await step();
    } catch (err) {
        console.error(`Error stopping ${name}:`, err);
    }
};

const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`${reason}, shutting down...`);

    const watchdog = setTimeout(() => {
        console.error(`Shutdown did not complete within ${SHUTDOWN_TIMEOUT_MILLIS}ms, exiting`);
        process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MILLIS);
    watchdog.unref();

    await runShutdownStep('WebServer', () => webServer.stop());
    await runShutdownStep('SocketIOServer', () => socketioServer.stop());
    await runShutdownStep('VoiceServer', () => voiceServer.stop());
    await runShutdownStep('TCPServer', () => tcpServer.stop());
    await runShutdownStep('RestAPI', () => restApi.flush());

    clearTimeout(watchdog);
    process.exit(exitCode);
};

process.on('SIGTERM', (signal) => void shutdown(`Received ${signal}`, 0));
process.on('SIGINT', (signal) => void shutdown(`Received ${signal}`, 0));

// Both of these used to process.exit(1) directly, discarding whatever the debounced store
// save still had pending - in exactly the situation where losing it hurts most.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    void shutdown('Unhandled rejection', 1);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    void shutdown('Uncaught exception', 1);
});
