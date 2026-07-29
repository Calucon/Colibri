import { WorkerMessage } from './worker-message.js';
import { Service } from './service.js';
import * as threads from 'worker_threads';
import { Subject } from 'rxjs';
import { LogLevel } from './log-message.js';
import cluster, { Worker } from 'cluster';
import { WorkerLogMessage } from './worker-service.js';

export abstract class WorkerServiceProxy extends Service {
    private threadWorker!: threads.Worker;
    private clusterWorker!: Worker;


    private readonly workerMessages = new Subject<WorkerMessage>();
    protected readonly workerMessages$ = this.workerMessages.asObservable();

    public constructor() {
        super();
    }

    protected initCluster(path: string, env?: unknown): void {
        cluster.setupPrimary({
            exec: path
        });
        this.clusterWorker = cluster.fork(env);

        this.clusterWorker.on('online', () => {
            this.logInfo(`Cluster ${path} online`);
        });

        this.clusterWorker.on('close', () => {
            this.logInfo(`Cluster ${path} closed`);
        });

        this.clusterWorker.on('exit', () => {
            this.logInfo(`Cluster ${path} exited`);
        });

        this.clusterWorker.on('message', (data: WorkerMessage) => {
            if (data.channel === 'log') {
                this.handleLogMessage(data.content as unknown as WorkerLogMessage);
            } else {
                this.workerMessages.next(data);
            }
        });
    }

    protected initWorker(path: string, workerData?: unknown): void {
        this.threadWorker = new threads.Worker(path, { workerData: workerData });

        this.threadWorker.on('error', err => {
            this.logError(err.message + '\n' + err.stack, false);
        });

        this.threadWorker.on('online', () => {
            this.logInfo(`Worker ${path} online`);
        });

        this.threadWorker.on('close', () => {
            this.logInfo(`Worker ${path} closed`);
        });

        this.threadWorker.on('message', (data: WorkerMessage) => {
            if (data.channel === 'log') {
                this.handleLogMessage(data.content as unknown as WorkerLogMessage);
            } else {
                this.workerMessages.next(data);
            }
        });
    }

    // Docker's `stop` sends SIGTERM and, after a grace period, SIGKILL - if the worker
    // thread is never explicitly terminated, the process can outlive its own shutdown
    // handler (a worker_threads.Worker keeps the event loop alive on its own).
    protected async terminateWorker(): Promise<void> {
        if (this.threadWorker) {
            await this.threadWorker.terminate();
        }
    }

    protected postMessage(channel: string, content?: { [key: string]: unknown }) {
        const msg: WorkerMessage = {
            channel: channel,
            content: content || {}
        };

        if (this.threadWorker) {
            this.threadWorker.postMessage(msg);
        } else if (this.clusterWorker) {
            this.clusterWorker.send(msg);
        }
    }

    private handleLogMessage(log: WorkerLogMessage): void {
        switch (log.level) {
            case LogLevel.Debug:
                this.logDebug(log.msg, log.metadata);
                break;

            case LogLevel.Info:
                this.logInfo(log.msg, log.metadata);
                break;

            case LogLevel.Warn:
                this.logWarning(log.msg, log.metadata);
                break;

            case LogLevel.Error:
                this.logError(log.msg, false, log.metadata);
                break;

            default:
                this.logWarning('Unknown log level!');
                this.logDebug(log.msg);
                break;
        }
    }
}
