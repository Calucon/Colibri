import { describe, it, expect } from 'vitest';
import { DataStore } from '../../src/server/modules/command-hooks/data-store.js';

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
});
