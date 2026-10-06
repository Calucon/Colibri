import { BehaviorSubject, Observable } from 'rxjs';
import { Colibri, Message, RegisterChannel, SendMessage } from './Colibri';
import { onColibriReconnected, whenColibriCreated } from './lifecycle';
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

    // initial data fetch - and the same again after every reconnect, since an update relayed while
    // this client was disconnected is gone for it, and only asking again brings it back. The
    // server answers with one model::update per model it has, which onUpdate applies to the
    // model with that id where there is one, so this catches up without duplicating anything.
    //
    // The server may have lost this client's own models meanwhile, though: it forgets every model
    // of an app when the app's last client leaves, and when it restarts. Nothing sent them again,
    // so a client that joined later never saw them. So each own model is also asked for by id,
    // which the server answers with what it has - or, for a model it does not have, a bare { id }.
    // Only then does onUpdate send the model's full state; what the server does have is newer than
    // this client's, and is applied rather than overwritten.
    //
    // The server keeps no record of deletes, so a model another client deleted while this one was
    // away looks the same as one the server forgot, and is sent again too.
    withColibri(colibri => {
        colibri.sendMessage(name, 'model::request');
        onColibriReconnected(colibri, () => {
            colibri.sendMessage(name, 'model::request');
            for (const model of models.value) {
                if (!ownModels.has(model)) continue;
                awaitingAnswer.set(model.id, colibri);
                colibri.sendMessage(name, 'model::request', { id: model.id });
            }
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
        // is applied below like any other. A bare one means the server has nothing for it: send
        // all of it. No model any more - deleted since it was asked for - means nothing to send,
        // and the bare id must not become a model of its own either.
        const id = modelData.id;
        const asker = id === undefined ? undefined : awaitingAnswer.get(id);
        if (id !== undefined && asker) {
            awaitingAnswer.delete(id);
            if (isBare(modelData)) {
                if (model) asker.sendMessage(name, 'model::update', model.toJson());
                return;
            }
        }

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

    const onDelete = (id: string) => {
        const model = models.value.find(m => m.id === id);
        model?.delete();
        models.next(models.value.filter(m => m.id !== id));
    };

    const registerModel = (model: T) => {
        model.modelChanges$.subscribe(changes => {
            // Before `new Colibri()` a change has nowhere to go, and needs nowhere: the full
            // model below is read when it is sent, so it already carries the change.
            Colibri.getInstance(false)?.sendMessage(name, 'model::update', model.toJson(changes));
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
