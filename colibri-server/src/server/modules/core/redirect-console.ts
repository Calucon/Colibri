import { Service } from './service.js';

/**
 * @deprecated Not instantiated anywhere in `main.ts` (see the commented-out line there) -
 * console output currently reaches the log stream only via services that call
 * `Service.logInfo`/`logWarning`/`logError` directly. Kept for the case where redirecting
 * raw `console.*` calls from third-party code is needed again.
 */
export class RedirectConsole extends Service {
    public serviceName = 'NodeJS';
    public groupName = 'core';

    public constructor() {
        super();

        const oldDebug = console.debug;
        console.debug = (msg) => {
            this.logDebug(msg);
            oldDebug(msg);
        };

        const oldLog = console.log;
        console.log = (msg) => {
            this.logInfo(msg);
            oldLog(msg);
        };

        const oldWarn = console.warn;
        console.warn = (msg) => {
            this.logWarning(msg);
            oldWarn(msg);
        };

        const oldError = console.error;
        console.error = (msg) => {
            // A synthetic stack captured here would only show this override chain, not
            // where the original console.error() call came from - console.error's own
            // formatting of an Error argument already includes the trace that matters.
            this.logError(msg, false);
            oldError(msg);
        };
    }
}
