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
dataStore.tombstoneMillis = Config.MODEL_TOMBSTONE_SECONDS * 1000;

/**
 *    Servers
 */

// With TLS_CERT and TLS_KEY set, the TCP port and the web port serve TLS with the same certificate,
// and take up a renewed one together. Config has checked both files already.
const tlsCertificate = Config.TLS_CERT && Config.TLS_KEY
    ? new colibri.TlsCertificate(Config.TLS_CERT, Config.TLS_KEY)
    : undefined;

const webServer = new colibri.WebServer(
    Config.WEBSERVER_HOST,
    Config.WEBSERVER_PORT,
    Config.WEBSERVER_ROOT,
    Config.BASE_URL,
    tlsCertificate
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

// Logs what happens to the process itself, and shuts it down, in this order. restApi.flush()
// is the only thing standing between a crash and up to SAVE_DEBOUNCE_MILLIS of lost store
// writes. The voice server goes last: it saves the voice recordings still in progress, which
// can take a while for long ones, and must not leave the store's pending writes to the watchdog.
const SHUTDOWN_TIMEOUT_MILLIS = 5000;
const serverProcess = new colibri.ServerProcess([
    { name: 'WebServer', stop: () => webServer.stop() },
    { name: 'SocketIOServer', stop: () => socketioServer.stop() },
    { name: 'TCPServer', stop: () => tcpServer.stop() },
    { name: 'RestAPI', stop: () => restApi.flush() },
    { name: 'VoiceServer', stop: () => voiceServer.stop() },
], SHUTDOWN_TIMEOUT_MILLIS);

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
    // Likewise: logs the certificate's fingerprint.
    tlsCertificate?.start();

    const rateLimit = { messagesPerSecond: Config.CLIENT_MESSAGE_RATE_LIMIT, burst: Config.CLIENT_MESSAGE_RATE_BURST };
    const httpServer = webServer.start();
    socketioServer.start(httpServer, { rateLimit });
    tcpServer.start(Config.TCP_PORT, Config.TCP_HOST, {
        inboundBacklogLimit: Config.TCP_INBOUND_BACKLOG_LIMIT,
        rateLimit,
        idleTimeoutMillis: Config.TCP_IDLE_TIMEOUT_SECONDS * 1000,
    }, tlsCertificate);
    voiceServer.start(Config.VOICE_PORT, Config.VOICE_HOST);
};

startup().catch((err) => {
    serverProcess.reportError('Startup failed', err);
    process.exit(1);
});

/**
 *    Shutdown
 */

// `docker stop` sends SIGTERM (then SIGKILL after a grace period) with no handler
// installed for either, so the TCP worker thread was never terminated and an in-flight
// store.json write could be lost.
process.on('SIGTERM', (signal) => void serverProcess.shutdown(`Received ${signal}`, 0));
process.on('SIGINT', (signal) => void serverProcess.shutdown(`Received ${signal}`, 0));

// Both of these used to process.exit(1) directly, discarding whatever the debounced store
// save still had pending - in exactly the situation where losing it hurts most.
process.on('unhandledRejection', (reason) => {
    serverProcess.reportError('Unhandled rejection', reason);
    void serverProcess.shutdown('Unhandled rejection', 1);
});

process.on('uncaughtException', (err) => {
    serverProcess.reportError('Uncaught exception', err);
    void serverProcess.shutdown('Uncaught exception', 1);
});
