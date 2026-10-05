import { BehaviorSubject, Observable } from 'rxjs';
import { Colibri, Message, RegisterChannel, SendMessage } from './Colibri';
import { whenColibriCreated } from './lifecycle';
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

export const RegisterModelSync = <T extends SyncModel<T>>(registration: ModelSyncRegistration<T>): ModelSync<T> => {
    const name = registration.name || registration.type.name.toLowerCase();
    if (!registration.name) warnIfMinified(registration.type.name, name);

    // initial data fetch
    withColibri(colibri => {
        colibri.sendMessage(name, 'model::request');
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
    const models = new BehaviorSubject<T[]>([]);

    const onUpdate = (modelData: Partial<T>) => {
        const model = models.value.find(m => m.id === modelData.id);
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
        models.next([...models.value, model]);
    };

    return [models.asObservable(), registerModel];
};
