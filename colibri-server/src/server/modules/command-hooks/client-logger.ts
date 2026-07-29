import { filter } from 'rxjs/operators';
import { Service } from '../core/index.js';
import { ConnectionPool } from './connection-pool.js';

export class ClientLogger extends Service {
    public get serviceName(): string { return 'ClientLogger'; }
    public get groupName(): string { return 'hook'; }

    public constructor(pool: ConnectionPool) {
        super();

        pool.messages$
            .pipe(filter(m => m.channel === 'log'))
            .subscribe(m => {
                const name = m.origin?.name || 'UNKNOWN';
                const metadata = {
                    clientApp: m.origin?.app || 'UNKNOWN',
                    clientName: m.origin?.name || 'UNKNOWN',
                    clientId: m.origin?.id || 'UNKNOWN',
                };

                switch (m.command) {
                    case 'info':
                        this.logInfo(`[${name}] ${m.payload?.asString()}`, metadata);
                        break;

                    case 'warn':
                    case 'warning':
                        this.logWarning(`[${name}] ${m.payload?.asString()}`, metadata);
                        break;

                    case 'error':
                        this.logError(`[${name}] ${m.payload?.asString()}`, false, metadata);
                        break;

                    case 'debug':
                    default:
                        this.logDebug(`[${name}] ${m.payload?.asString()}`, metadata);
                        break;
                }
            });
    }
}
