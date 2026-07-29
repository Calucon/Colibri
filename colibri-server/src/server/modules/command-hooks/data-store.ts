import { Service } from '../core/service.js';

export interface SyncModel {
    id: string;
    [key: string]: unknown;
}

export class DataStore extends Service {
    public serviceName = 'DataStore';
    public groupName = 'core';

    // Nested by app -> channel -> model id, instead of a flat `group + channel` string key.
    // That flat key was ambiguous (app 'ab' + channel 'c' collided with app 'a' + channel
    // 'bc') and made clearApp() match with a prefix scan (`key.startsWith(group)`), which
    // wiped app 'test2' when the last client of app 'test' disconnected. Both bugs are
    // structural here: clearApp() just deletes the one Map entry for that app.
    private readonly store = new Map<string, Map<string, Map<string, SyncModel>>>();

    public constructor() {
        super();
    }

    /** @deprecated No current caller - `updateModel` already creates a model on first write. */
    public addModel(group: string, channel: string, id: string): void {
        const models = this.getOrCreateChannel(group, channel);
        if (!models.has(id)) {
            models.set(id, { id });
        }
    }

    public updateModel(group: string, channel: string, model: SyncModel): void {
        const models = this.getOrCreateChannel(group, channel);
        const existingModel = models.get(model.id);
        if (!existingModel) {
            models.set(model.id, model);
        } else {
            for (const k of Object.keys(model)) {
                existingModel[k] = model[k];
            }
        }
    }

    public removeModel(group: string, channel: string, id: string): void {
        this.store.get(group)?.get(channel)?.delete(id);
    }

    /** @deprecated No current caller - `clearApp` is what actually runs on disconnect. */
    public clear(group: string, channel: string): void {
        this.store.get(group)?.delete(channel);
    }

    public clearApp(group: string): void {
        this.store.delete(group);
    }

    public getModel(group: string, channel: string, id: string): SyncModel | undefined {
        return this.store.get(group)?.get(channel)?.get(id);
    }

    public getAll(group: string, channel: string): SyncModel[] {
        const models = this.store.get(group)?.get(channel);
        return models ? Array.from(models.values()) : [];
    }

    private getOrCreateChannel(group: string, channel: string): Map<string, SyncModel> {
        let byChannel = this.store.get(group);
        if (!byChannel) {
            byChannel = new Map();
            this.store.set(group, byChannel);
        }

        let models = byChannel.get(channel);
        if (!models) {
            models = new Map();
            byChannel.set(channel, models);
        }
        return models;
    }
}
