import * as colibri from './modules/index.js';
import { Config } from './configuration.js';

/**
 * Debugging
 */

// See Config.STACK_TRACE_LIMIT for why this isn't Infinity.
Error.stackTraceLimit = Config.STACK_TRACE_LIMIT;

// Attached before any service exists, so nothing logged during construction or init() is missed
// - the admin UI's WebLog only starts listening once its own init() has run. The options are
// read here rather than when modules/ is imported, which happens before Config loads .env.
new colibri.ConsoleLog(colibri.ConsoleLog.optionsFromEnv(process.env)).attach(colibri.Service.output$);

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
connectionPool.appClientWarningThreshold = Config.APP_CLIENT_WARNING_THRESHOLD;

/**
 *    APIs
 */
const restApi = new colibri.RestAPI(Config.DATA_ROOT, webServer);
const dataRootCheck = new colibri.DataRootCheck(Config.DATA_ROOT);

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
new colibri.BroadcastLogger(connectionPool);
new colibri.ClientBroadcast(connectionPool);
new colibri.MeasureLatency(connectionPool, socketioServer);

/**
 *    Startup
 */

const startup = async () => {
    for (const service of colibri.Service.Current) {
        await service.init();
    }

    // After every init(), so the admin UI's WebLog is listening for it too. Not fatal: the
    // server is still useful without persistence, it just has to say so.
    await dataRootCheck.check();

    const rateLimit = { messagesPerSecond: Config.CLIENT_MESSAGE_RATE_LIMIT, burst: Config.CLIENT_MESSAGE_RATE_BURST };
    const httpServer = webServer.start();
    socketioServer.start(httpServer, { rateLimit });
    tcpServer.start(Config.TCP_PORT, Config.TCP_HOST, {
        inboundBacklogLimit: Config.TCP_INBOUND_BACKLOG_LIMIT,
        rateLimit,
        idleTimeoutMillis: Config.TCP_IDLE_TIMEOUT_SECONDS * 1000,
    });
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
