import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DataStore, DEFAULT_TOMBSTONE_MILLIS, MAX_TOMBSTONES_PER_APP } from '../../src/server/modules/command-hooks/data-store.js';

describe('DataStore', () => {
    it('updateModel/getModel/getAll round-trip within a group+channel', () => {
        const store = new DataStore();
        store.updateModel('app', 'channel', { id: 'a', x: 1 });
        store.updateModel('app', 'channel', { id: 'b', x: 2 });

        expect(store.getModel('app', 'channel', 'a')).toEqual({ id: 'a', x: 1 });
        expect(store.getAll('app', 'channel')).toEqual([
            { id: 'a', x: 1 },
            { id: 'b', x: 2 },
        ]);
    });

    it('updateModel merges into an existing model instead of replacing it', () => {
        const store = new DataStore();
        store.updateModel('app', 'channel', { id: 'a', x: 1, y: 1 });
        store.updateModel('app', 'channel', { id: 'a', x: 2 });

        expect(store.getModel('app', 'channel', 'a')).toEqual({ id: 'a', x: 2, y: 1 });
    });

    it('removeModel deletes only the targeted model', () => {
        const store = new DataStore();
        store.updateModel('app', 'channel', { id: 'a' });
        store.updateModel('app', 'channel', { id: 'b' });
        store.removeModel('app', 'channel', 'a');

        expect(store.getModel('app', 'channel', 'a')).toBeUndefined();
        expect(store.getModel('app', 'channel', 'b')).toEqual({ id: 'b' });
    });

    it('does not confuse app "ab" + channel "c" with app "a" + channel "bc"', () => {
        const store = new DataStore();
        store.updateModel('ab', 'c', { id: 'x', from: 'ab/c' });
        store.updateModel('a', 'bc', { id: 'x', from: 'a/bc' });

        expect(store.getModel('ab', 'c', 'x')).toEqual({ id: 'x', from: 'ab/c' });
        expect(store.getModel('a', 'bc', 'x')).toEqual({ id: 'x', from: 'a/bc' });
    });

    it('clearApp only clears the exact app, not apps it prefixes', () => {
        const store = new DataStore();
        store.updateModel('test', 'channel', { id: 'a' });
        store.updateModel('test2', 'channel', { id: 'b' });

        store.clearApp('test');

        expect(store.getAll('test', 'channel')).toEqual([]);
        expect(store.getAll('test2', 'channel')).toEqual([{ id: 'b' }]);
    });

    it('clear removes only the targeted group+channel', () => {
        const store = new DataStore();
        store.updateModel('app', 'channel1', { id: 'a' });
        store.updateModel('app', 'channel2', { id: 'b' });

        store.clear('app', 'channel1');

        expect(store.getAll('app', 'channel1')).toEqual([]);
        expect(store.getAll('app', 'channel2')).toEqual([{ id: 'b' }]);
    });

    // What is left of a deleted model, so that an update arriving after the delete - from another
    // client, or released late by the server's own limits - does not create the model again.
    describe('tombstones', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('remembers which client deleted a model, for 10 minutes by default', () => {
            const store = new DataStore();
            store.updateModel('app', 'channel', { id: 'a' });

            store.removeModel('app', 'channel', 'a', 'client-1');

            expect(store.deletion('app', 'channel', 'a')).toMatchObject({ channel: 'channel', id: 'a', deletedBy: ['client-1'] });
            vi.advanceTimersByTime(DEFAULT_TOMBSTONE_MILLIS - 1);
            expect(store.deletion('app', 'channel', 'a')).toBeDefined();
            vi.advanceTimersByTime(1);
            expect(store.deletion('app', 'channel', 'a')).toBeUndefined();
        });

        it('remembers a delete for an id it never had', () => {
            const store = new DataStore();

            store.removeModel('app', 'channel', 'never-seen', 'client-1');

            expect(store.deletion('app', 'channel', 'never-seen')).toBeDefined();
        });

        it('remembers nothing with tombstoneMillis at 0', () => {
            const store = new DataStore();
            store.tombstoneMillis = 0;

            store.removeModel('app', 'channel', 'a', 'client-1');

            expect(store.deletion('app', 'channel', 'a')).toBeUndefined();
            expect(store.tombstoneCount('app')).toBe(0);
        });

        it('keeps apps and channels apart', () => {
            const store = new DataStore();

            store.removeModel('app', 'channel', 'a', 'client-1');

            expect(store.deletion('app', 'other', 'a')).toBeUndefined();
            expect(store.deletion('other', 'channel', 'a')).toBeUndefined();
            expect(store.deletion('app', 'channel', 'b')).toBeUndefined();
        });

        it('counts a delete of a deleted model as the latest, and remembers each client that sent one', () => {
            const store = new DataStore();
            store.tombstoneMillis = 1000;
            store.removeModel('app', 'channel', 'a', 'client-1');
            vi.advanceTimersByTime(800);

            store.removeModel('app', 'channel', 'a', 'client-2');
            store.removeModel('app', 'channel', 'a', 'client-1');
            vi.advanceTimersByTime(800);

            expect(store.deletion('app', 'channel', 'a')?.deletedBy).toEqual(['client-1', 'client-2']);
            expect(store.tombstoneCount('app')).toBe(1);
        });

        it('forgets a deletion it is told to', () => {
            const store = new DataStore();
            store.removeModel('app', 'channel', 'a', 'client-1');
            store.removeModel('app', 'channel', 'b', 'client-1');

            store.forgetDeletion('app', 'channel', 'a');

            expect(store.deletion('app', 'channel', 'a')).toBeUndefined();
            expect(store.deletion('app', 'channel', 'b')).toBeDefined();
            expect(store.tombstoneCount('app')).toBe(1);
        });

        it('keeps at most MAX_TOMBSTONES_PER_APP per app, forgetting the oldest first', () => {
            const store = new DataStore();
            for (let i = 0; i <= MAX_TOMBSTONES_PER_APP; i++) store.removeModel('app', `channel-${i % 3}`, `id-${i}`, 'client-1');
            store.removeModel('other', 'channel-0', 'id-0', 'client-1');

            expect(store.tombstoneCount('app')).toBe(MAX_TOMBSTONES_PER_APP);
            expect(store.deletion('app', 'channel-0', 'id-0')).toBeUndefined();
            expect(store.deletion('app', 'channel-1', 'id-1')).toBeDefined();
            expect(store.deletion('app', `channel-${MAX_TOMBSTONES_PER_APP % 3}`, `id-${MAX_TOMBSTONES_PER_APP}`)).toBeDefined();
            expect(store.deletion('other', 'channel-0', 'id-0')).toBeDefined();
        });

        it('drops expired tombstones as new ones come, without being asked about them', () => {
            const store = new DataStore();
            store.tombstoneMillis = 1000;
            for (let i = 0; i < 100; i++) store.removeModel('app', 'channel', `old-${i}`, 'client-1');

            vi.advanceTimersByTime(1000);
            store.removeModel('app', 'channel', 'new', 'client-1');

            expect(store.tombstoneCount('app')).toBe(1);
        });

        // The models go when the app's last client leaves; the tombstones go with them, so a
        // session started afresh is not haunted by the deletes of the one before.
        it('forgets an app\'s tombstones with its models, and only that app\'s', () => {
            const store = new DataStore();
            store.removeModel('test', 'channel', 'a', 'client-1');
            store.removeModel('test2', 'channel', 'a', 'client-2');

            store.clearApp('test');

            expect(store.deletion('test', 'channel', 'a')).toBeUndefined();
            expect(store.tombstoneCount('test')).toBe(0);
            expect(store.deletion('test2', 'channel', 'a')).toBeDefined();
        });
    });
});
