import { Payload, Service } from '../core/index.js';
import { ConnectionPool, NetworkMessage } from './connection-pool.js';
import { DataStore, SyncModel } from './data-store.js';

export class ModelSynchronization extends Service {
    public serviceName = 'ModelSync';
    public groupName = 'colibri';

    public constructor(private connectionPool: ConnectionPool, private store: DataStore) {
        super();

        connectionPool.onCommand('model::request', this.sendInitialState.bind(this));
        connectionPool.onCommand('model::update', this.onModelUpdate.bind(this));
        connectionPool.onCommand('model::delete', this.onModelDelete.bind(this));


        // clear datastore when all clients from the same app disconnect
        connectionPool.clientDisconnected$.subscribe(client => {
            const hasClients = this.connectionPool.currentClients.some(c => c.app === client.app);
            if (!hasClients) {
                this.store.clearApp(client.app);
            }
        });
    }

    public sendInitialState(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client', false);
            return;
        }

        const app = msg.origin.app;
        try {
            const payload = (msg.payload?.asValue<{ id?: string }>()) || {};

            if (typeof(payload?.id) === 'string') {
                const model = this.store.getModel(app, msg.channel, payload.id) || { id: payload.id };
                this.connectionPool.emit({
                    channel: msg.channel,
                    command: 'model::update',
                    payload: Payload.fromValue(model)
                }, msg.origin);
            } else {
                for (const model of this.store.getAll(app, msg.channel)) {
                    this.connectionPool.emit({
                        channel: msg.channel,
                        command: 'model::update',
                        payload: Payload.fromValue(model)
                    }, msg.origin);
                }
            }
        } catch (error) {
            this.logError(`Failed to send initial state to client ${msg.origin.id}: ${error}`, false);
        }
    }

    public onModelUpdate(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client', false);
            return;
        }

        try {
            const payload = (msg.payload?.asValue<{ id?: string }>()) || {};
            if (typeof(payload?.id) !== 'string') {
                this.logError('Cannot update model without "id" attribute', false);
                return;
            }

            // An update to a model deleted a moment ago would create it afresh, here and in every
            // other client (see DataStore.removeModel) - unless it comes from a client that deleted
            // it itself. Each client's messages arrive in the order it sent them, so for that one
            // client an update after its delete is no straggler: it is creating the model again,
            // e.g. a scene it unloaded being loaded again, with its synced objects' fixed ids.
            const deletion = this.store.deletion(msg.origin.app, msg.channel, payload.id);
            if (deletion) {
                if (!deletion.deletedBy.includes(msg.origin.id)) {
                    this.logDebug(
                        `Ignoring a model::update for '${payload.id}' on channel '${msg.channel}' from client '${msg.origin.name}' ` +
                            `(${msg.origin.id}, app '${msg.origin.app}'): that model was deleted (MODEL_TOMBSTONE_SECONDS)`
                    );
                    return;
                }
                this.store.forgetDeletion(msg.origin.app, msg.channel, payload.id);
            }

            this.store.updateModel(msg.origin.app, msg.channel, payload as SyncModel);
            this.connectionPool.broadcast(msg);
        } catch (error) {
            this.logError(`Failed to update model: ${error}`, false);
        }
    }

    public onModelDelete(msg: NetworkMessage): void {
        if (!msg.origin) {
            this.logError('Cannot send initial state to unknown client', false);
            return;
        }

        try {
            const payload = msg.payload?.asValue<{ id?: string }>();

            if (payload?.id) {
                this.store.removeModel(msg.origin.app, msg.channel, payload.id, msg.origin.id);
                this.connectionPool.broadcast(msg);
            } else {
                this.logWarning('Received delete message without payload');
            }
        } catch (error) {
            this.logError(`Failed to delete model: ${error}`, false);
        }
    }
}