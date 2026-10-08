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

    // Own models asked for by id, on registerModel or after a reconnect, whose answer has not
    // arrived yet - and the instance that asked, which is the one to answer through.
    const awaitingAnswer = new Map<string, Colibri>();

    // Own models the server has answered for, on this connection or an earlier one: those this
    // client held before an outage, and asks for again after it.
    const answered = new WeakSet<T>();

    // From a reconnect until everything else is asked for, the instance to ask through.
    let catchingUpThrough: Colibri | undefined;

    // Own models whose wait for an answer a model::delete ended (see onDelete). That delete may
    // have been relayed from another client just before the answer, and a server that does not
    // remember deletes (MODEL_TOMBSTONE_SECONDS=0) still answers with the bare id, which must not
    // become a model of its own.
    const deletedWhileAwaited = new Set<string>();

    // Changes to own models held back instead of sent, by the property names SyncModel reports
    // them under: made while the connection was down, or since registering the model or since a
    // reconnect but before the server answered for it (see registerModel).
    const heldChanges = new WeakMap<T, Set<string>>();

    // Changes to own models made while nothing was held back, waiting for SyncModel to report them
    // (it buffers for 1 ms) to go out together.
    const changesToSend = new WeakMap<T, Set<string>>();

    // From a disconnect until the next connect.
    let disconnected = false;

    // Asks the server for an own model by id; onUpdate or onDelete takes the answer. The server
    // answers with what it has - or, for a model it does not have, a bare { id }, and only then
    // does onUpdate send the model's full state. What the server does have is applied rather than
    // overwritten, since it is what every other client has - except what this client changed
    // itself since registering the model or while it waited, which it sends instead.
    //
    // A model this client held before an outage is asked for `again: true`. Another client may
    // have deleted it meanwhile, and the delete it relayed never arrived here. The server
    // remembers a delete for a while (MODEL_TOMBSTONE_SECONDS) and answers such a request with
    // model::delete, which onDelete applies. Asked for without the flag, as a model this client
    // has right now (registerModel, or one registered while the connection was down), the server
    // forgets that delete and answers with the bare id: the model is in use again. Once that while
    // is over, a deleted model looks the same as one the server forgot, and is sent again.
    const askFor = (colibri: Colibri, model: T) => {
        awaitingAnswer.set(model.id, colibri);
        colibri.sendMessage(
            name,
            'model::request',
            answered.has(model) ? { id: model.id, again: true } : { id: model.id }
        );
    };

    // At first and after a reconnect, everything else is asked for once every own model asked for
    // has its answer, so that that answer has what was sent in between.
    const catchUpOnceAnswered = () => {
        if (!catchingUpThrough || awaitingAnswer.size > 0) return;
        const colibri = catchingUpThrough;
        catchingUpThrough = undefined;
        colibri.sendMessage(name, 'model::request');
    };

    // initial data fetch - and the same again after every reconnect, since an update relayed while
    // this client was disconnected is gone for it, and only asking again brings it back. The
    // server answers with one model::update per model it has, which onUpdate applies to the
    // model with that id where there is one, so this catches up without duplicating anything.
    //
    // The server may have lost this client's own models meanwhile, though: it forgets every model
    // of an app when the app's last client leaves, and when it restarts. Nothing sent them again,
    // so a client that joined later never saw them. So after a reconnect each own model is asked
    // for by id first (see askFor), and everything else only once they all have their answer.
    //
    // The first time too, everything is asked for only once the models registered by then have
    // their answer: those registered before `new Colibri()`, or in the same block of code as this.
    // Asked for first, the answer for every model came first, carried the id as well, and was
    // taken for the answer to the request for the id; the real one came next, without the changes
    // this client had sent in between, and undid them here.
    withColibri(colibri => {
        catchingUpThrough = colibri;
        setTimeout(catchUpOnceAnswered, 0);
        onColibriDisconnected(colibri, () => {
            disconnected = true;
        });
        onColibriReconnected(colibri, () => {
            disconnected = false;
            // Whatever was asked on the connection before this one is not going to be answered.
            awaitingAnswer.clear();
            deletedWhileAwaited.clear();
            catchingUpThrough = colibri;
            for (const model of models.value) {
                if (ownModels.has(model)) askFor(colibri, model);
            }
            catchUpOnceAnswered();
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
            if (model) answered.add(model);
            const held = model ? releaseHeldChanges(model) : [];

            if (isBare(modelData)) {
                // Not for a model whose delete() was called since: that ended what it sends.
                if (model && ownModels.has(model)) asker.sendMessage(name, 'model::update', model.toJson());
            } else if (model) {
                applyUpdate(model, withoutChanges(modelData, model, held));
                if (held.length > 0) asker.sendMessage(name, 'model::update', model.toJson(held));
            } else {
                applyUpdate(model, modelData);
            }

            catchUpOnceAnswered();
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
        // the model as much as an update would, and after a reconnect, once every own model is
        // settled, everything else is still to be asked for. Left waiting, the id kept that from
        // ever happening, and every other model stayed as it was before the outage.
        if (awaitingAnswer.delete(id)) {
            deletedWhileAwaited.add(id);
            catchUpOnceAnswered();
        }
    };

    // The server may already have a model with this id: one another client created, or this
    // client before the page was reloaded, kept while another client of the app stayed connected.
    // Sending the model in full straight away overwrote that copy on the server and every other
    // client, while the answer to the request for every model, already on its way, overwrote this
    // client's copy with the old one, so the two ended up apart. So the model is asked for by id
    // first, the way Unity's SyncBehaviour does it (see askFor): what the server has wins, and the
    // model is sent in full only when the server has nothing for it.
    //
    // The id can also be listed already: as the copy the server told this client about, or as
    // another instance registered earlier. Both used to stay, and every later update for the id went
    // to whichever came first, so the instance registered last never received one. Now the instance
    // registered last replaces the listed one, in place, and the listed one is ended as delete()
    // ends it: it no longer sends its changes. Registering the instance already listed does nothing.
    const registerModel = (model: T) => {
        const listed = models.value.find(m => m.id === model.id);
        if (listed === model) return;
        if (listed && ownModels.has(listed)) {
            console.warn(
                `Colibri: registerModel was given a second model with the id '${model.id}' on channel ` +
                    `'${name}'. It replaces the first one, which no longer syncs.`
            );
        }

        // Whether a change is held back is decided as it is made, not once SyncModel reports it
        // 1 ms later: an answer that came in between was applied over it, and the report then sent
        // the server's old value in its place, to every client.
        //
        // Held back until the server has answered for the model, and then sent on top of what it
        // has: a change made since registering (before `new Colibri()` included), or after a
        // reconnect but before the answer, which the answer would otherwise undo. Also one made
        // while disconnected, which Socket.IO would buffer and send on the reconnect ahead of the
        // request for the model: to a server that had forgotten the model, that change alone
        // became all of it, the answer had fields in it, and the rest was never sent again.
        const mustHold = () => !Colibri.getInstance(false) || disconnected || awaitingAnswer.has(model.id);
        model.modelChanges.subscribe(change => {
            if (mustHold()) {
                holdChanges(model, [change]);
                return;
            }
            const toSend = changesToSend.get(model);
            if (toSend) toSend.add(change);
            else changesToSend.set(model, new Set([change]));
        });
        model.modelChanges$.subscribe({
            next: () => {
                const changes = [...(changesToSend.get(model) ?? [])];
                changesToSend.delete(model);
                if (changes.length === 0) return;

                const colibri = Colibri.getInstance(false);
                if (!colibri || mustHold()) holdChanges(model, changes);
                else colibri.sendMessage(name, 'model::update', model.toJson(changes));
            },
            // delete() ends the stream: this client sends nothing more for the model - so neither
            // a held change, nor the whole model again after a reconnect.
            complete: () => {
                ownModels.delete(model);
                heldChanges.delete(model);
                changesToSend.delete(model);
            }
        });

        ownModels.add(model);
        if (listed) {
            listed.delete();
            models.next(models.value.map(m => (m === listed ? model : m)));
        } else {
            models.next([...models.value, model]);
        }

        // While disconnected, the reconnect asks for it.
        withColibri(colibri => {
            if (!disconnected && ownModels.has(model)) askFor(colibri, model);
        });
    };

    return [models.asObservable(), registerModel];
};
