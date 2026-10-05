import type { Colibri } from './Colibri';

/*
 *  Hooks into the life of a Colibri instance, for the rest of the library.
 *
 *  Internal, and deliberately not exported from index.ts. RegisterModelSync and RemoteLogger
 *  can be called before `new Colibri()`, and this is how they find out when it happens.
 *
 *  Only a type is imported from Colibri, so the two modules do not depend on each other at
 *  runtime. That is also why nothing here checks whether an instance already exists: callers
 *  ask Colibri.getInstance(false) first and only queue when there is none.
 */

type InstanceAction = (colibri: Colibri) => void;

const awaitingInstance: InstanceAction[] = [];

/**
 * Queues `action` to run with the instance as soon as `new Colibri()` has constructed one.
 * Returns a function that unqueues it again.
 */
export const whenColibriCreated = (action: InstanceAction): (() => void) => {
    awaitingInstance.push(action);
    return () => {
        const index = awaitingInstance.indexOf(action);
        if (index >= 0) awaitingInstance.splice(index, 1);
    };
};

/** Runs, in order, everything {@link whenColibriCreated} queued. Called by the Colibri constructor. */
export const colibriCreated = (colibri: Colibri): void => {
    for (const action of awaitingInstance.splice(0)) {
        // One failing action must not take the others down with it, nor turn into an exception
        // out of `new Colibri()` that has nothing to do with the arguments it was given.
        try {
            action(colibri);
        } catch (error) {
            console.error('Colibri: a registration made before new Colibri() failed to attach.', error);
        }
    }
};
