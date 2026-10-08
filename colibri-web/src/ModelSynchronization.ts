import { BehaviorSubject, Observable } from 'rxjs';
import { Colibri, Message, RegisterChannel, SendMessage } from './Colibri';
import { onColibriDisconnected, onColibriReconnected, whenColibriCreated } from './lifecycle';
import { SyncModel } from './SyncModel';

interface ModelSyncMsg<T extends SyncModel<T>> extends Message {
    command: 'model::update' | 'model::delete';
    payload: Partial<T> & { id: string };
}

interface ModelSyncRegistration<T> {
    /**
     * The channel to sync on. **Recommended.** Defaults to the class name lowercased, which a
     * minifying production build changes - so without this, two builds of the same app, or a
     * minified web build and Unity, can silently stop syncing with each other.
     */
    name?: string;
    type: { new (id: string): T };
}

type ModelSync<T> = [Observable<T[]>, (model: T) => void];

// Runs `action` against the Colibri instance now, or as soon as `new Colibri()` constructs one.
// Sending through SendMessage instead would drop the message, with nothing but a warning, when
// RegisterModelSync runs first - which, in a module-level `const [models$] = RegisterModelSync(...)`,
// is the usual order rather than a mistake.
const withColibri = (action: (colibri: Colibri) => void) => {
    const colibri = Colibri.getInstance(false);
    if (colibri) action(colibri);
    else whenColibriCreated(action);
};

// Channels already warned about, so that registering the same type again (on every render of a
// component, say) does not repeat it.
const warnedMinifiedNames = new Set<string>();

// A production bundler renames classes - typically to one or two letters, or to something with a
// `$` in it - so a channel derived from the class name differs between two builds of the same
// app, and between a minified web build and Unity, and they silently stop syncing.
const warnIfMinified = (className: string, channel: string) => {
    if ((channel.length > 2 && !channel.includes('$')) || warnedMinifiedNames.has(channel)) return;
    warnedMinifiedNames.add(channel);
    console.warn(
        `Colibri: RegisterModelSync is syncing on channel '${channel}', derived from the class name ` +
            `'${className}', which looks minified. A minified build renames classes, so this will not ` +
            `sync with another build or with Unity. Pass the channel explicitly: ` +
            `RegisterModelSync({ name: '...', type: ${className || 'YourModel'} }).`
    );
};

// Whether a model::update carries nothing but the id - which is how the server answers a request
// for a model it does not have. A change always has a field in it; only a model with no synced
// fields at all is ever sent like this.
const isBare = (modelData: object) => Object.keys(modelData).every(key => key === 'id');

export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();
    if (!registration.name) warnIfMinified(registration.type.name, name);

    const models = new BehaviorSubject<T[]>([]);

    // The models this client registered itself with registerModel, as opposed to those the server
    // told it about. Only these are this client's to send again (see below).
    const ownModels = new WeakSet<T>();

    // Own models asked for by id after a reconnect, whose answer has not arrived yet - and the
    // instance that asked, which is the one to answer through.
    const awaitingAnswer = new Map<string, Colibri>();

    // Own models whose wait for an answer a model::delete ended (see onDelete). That delete may
    // have been relayed from another client just before the answer, and a server that does not
    // remember deletes (MODEL_TOMBSTONE_SECONDS=0) still answers with the bare id, which must not
    // become a model of its own.
    const deletedWhileAwaited = new Set<string>();

    // Changes to own models held back instead of sent, by the property names SyncModel reports
    // them under: made while the connection was down, or since the reconnect but before the
    // server answered for the model (see registerModel).
    const heldChanges = new WeakMap<T, Set<string>>();

    // From a disconnect until the next connect.
    let disconnected = false;

    // initial data fetch - and the same again after every reconnect, since an update relayed while
    // this client was disconnected is gone for it, and only asking again brings it back. The
    // server answers with one model::update per model it has, which onUpdate applies to the
    // model with that id where there is one, so this catches up without duplicating anything.
    //
    // The server may have lost this client's own models meanwhile, though: it forgets every model
    // of an app when the app's last client leaves, and when it restarts. Nothing sent them again,
    // so a client that joined later never saw them. So each own model is asked for by id first,
    // which the server answers with what it has - or, for a model it does not have, a bare { id }.
    // Only then does onUpdate send the model's full state. What the server does have, another
    // client may have changed meanwhile, so it is applied rather than overwritten - except what
    // this client changed itself while it waited, which it sends instead. Everything else is asked
    // for once every own model has its answer, so that that answer has what was sent in between.
    //
    // Another client may also have deleted an own model while this one was away, and the delete
    // it relayed never arrived here. So the request says `again: true`: this client held the
    // model before the outage. The server remembers a delete for a while (MODEL_TOMBSTONE_SECONDS)
    // and answers such a request with model::delete, which onDelete applies. Without the flag the
    // server takes the request for one from a client that has the object now, and so forgets the
    // delete and answers with the bare id, and the full state sent then brings the model back on
    // every client. Once that while is over, a deleted model looks the same as one the server
    // forgot, and is sent again.
    withColibri(colibri => {
        colibri.sendMessage(name, 'model::request');
        onColibriDisconnected(colibri, () => {
            disconnected = true;
        });
        onColibriReconnected(colibri, () => {
            disconnected = false;
            // Whatever was asked on the connection before this one is not going to be answered.
            awaitingAnswer.clear();
            deletedWhileAwaited.clear();
            for (const model of models.value) {
                if (!ownModels.has(model)) continue;
                awaitingAnswer.set(model.id, colibri);
                colibri.sendMessage(name, 'model::request', { id: model.id, again: true });
            }
            if (awaitingAnswer.size === 0) colibri.sendMessage(name, 'model::request');
        });
    });

    // Register for updates (RegisterChannel itself waits for `new Colibri()` if it has to)
    RegisterChannel(name, (payload: Message) => {
        if (payload.command === 'model::update') {
            onUpdate((payload as ModelSyncMsg<T>).payload);
        } else if (payload.command === 'model::delete') {
            onDelete((payload as ModelSyncMsg<T>).payload.id);
        } else {
            console.error(`Unknown model command: ${payload.command}`);
        }
    });

    // Handle updates
    const onUpdate = (modelData: Partial<T>) => {
        const model = models.value.find(m => m.id === modelData.id);

        // The first update for an own model after its request settles it. One with fields in it
        // means the server has the model - the server stores an update before it relays it - and
        // is applied like any other, save for what this client changed while it waited: that is
        // sent instead, once the rest is applied, as it would have been when it was made. A bare
        // one means the server has nothing for it: send all of it. No model any more - deleted
        // since it was asked for - means nothing to send.
        const id = modelData.id;
        if (id !== undefined && deletedWhileAwaited.delete(id) && !model && isBare(modelData)) return;
        const asker = id === undefined ? undefined : awaitingAnswer.get(id);
        if (id !== undefined && asker) {
            awaitingAnswer.delete(id);
            const held = model ? releaseHeldChanges(model) : [];

            if (isBare(modelData)) {
                if (model) asker.sendMessage(name, 'model::update', model.toJson());
            } else if (model) {
                applyUpdate(model, withoutChanges(modelData, model, held));
                if (held.length > 0) asker.sendMessage(name, 'model::update', model.toJson(held));
            } else {
                applyUpdate(model, modelData);
            }

            if (awaitingAnswer.size === 0) asker.sendMessage(name, 'model::request');
            return;
        }

        applyUpdate(model, modelData);
    };

    const applyUpdate = (model: T | undefined, modelData: Partial<T>) => {
        if (model) {
            // Update existing model
            model.update(modelData);
            models.next([...models.value]);
        } else if (modelData.id) {
            const newModel = new registration.type(modelData.id);

            newModel.modelChanges$.subscribe(changes => {
                SendMessage(name, 'model::update', newModel.toJson(changes));
                models.next([...models.value]);
            });

            newModel.update(modelData);
            models.next([...models.value, newModel]);
        }
    };

    const holdChanges = (model: T, changes: string[]) => {
        const held = heldChanges.get(model);
        if (held) for (const change of changes) held.add(change);
        else heldChanges.set(model, new Set(changes));
    };

    const releaseHeldChanges = (model: T): string[] => {
        const held = [...(heldChanges.get(model) ?? [])];
        heldChanges.delete(model);
        return held;
    };

    // `modelData` without the fields that `changes` - property names, as SyncModel reports them -
    // are sent as.
    const withoutChanges = (modelData: Partial<T>, model: T, changes: string[]): Partial<T> => {
        if (changes.length === 0) return modelData;
        const changed = new Set(Object.keys(model.toJson(changes)).filter(key => key !== 'id'));
        return Object.fromEntries(Object.entries(modelData).filter(([key]) => !changed.has(key))) as Partial<T>;
    };

    const onDelete = (id: string) => {
        const model = models.value.find(m => m.id === id);
        if (model) heldChanges.delete(model);
        model?.delete();
        models.next(models.value.filter(m => m.id !== id));

        // A request for an own model can be answered with model::delete instead of the model: the
        // server's answer for one another client deleted while this client was away. That settles
        // the model as much as an update would, and once every own model is settled, everything
        // else is still to be asked for. Left waiting, the id kept that from ever happening, and
        // every other model stayed as it was before the outage.
        const asker = awaitingAnswer.get(id);
        if (asker) {
            awaitingAnswer.delete(id);
            deletedWhileAwaited.add(id);
            if (awaitingAnswer.size === 0) asker.sendMessage(name, 'model::request');
        }
    };

    const registerModel = (model: T) => {
        model.modelChanges$.subscribe({
            next: changes => {
                // Before `new Colibri()` a change has nowhere to go, and needs nowhere: the full
                // model below is read when it is sent, so it already carries the change.
                const colibri = Colibri.getInstance(false);
                if (!colibri) return;

                // Socket.IO would buffer a change made while disconnected and send it on the
                // reconnect ahead of the request for the model. To a server that had forgotten the
                // model, that change alone became all of it: the answer had fields in it, so the
                // rest was never sent again. So it is held back until the answer has come - as is
                // one made after the reconnect but before the answer, which the answer would
                // otherwise undo.
                if (disconnected || awaitingAnswer.has(model.id)) {
                    holdChanges(model, changes);
                    return;
                }
                colibri.sendMessage(name, 'model::update', model.toJson(changes));
            },
            // delete() ends the stream: this client sends nothing more for the model - so neither
            // a held change, nor the whole model again after a reconnect.
            complete: () => {
                ownModels.delete(model);
                heldChanges.delete(model);
            }
        });

        // send initial model - as it is when it can be sent, not as it was when registered
        withColibri(colibri => {
            colibri.sendMessage(name, 'model::update', model.toJson());
        });
        ownModels.add(model);
        models.next([...models.value, model]);
    };

    return [models.asObservable(), registerModel];
};
