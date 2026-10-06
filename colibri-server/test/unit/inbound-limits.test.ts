import { describe, it, expect } from 'vitest';
import {
    DropEpisode,
    EPISODE_QUIET_MILLIS,
    InboundBacklog,
    describeEpisode,
    isDroppable,
} from '../../src/server/modules/networking/inbound-limits.js';

describe('inbound limits', () => {
    // The drop policy shared by the TCP backlog limit and the per-client rate limit: only traffic
    // that a later message makes up for, never anything whose loss nothing would repair.
    describe('isDroppable', () => {
        it.each([
            ['objects', 'model::update'],
            ['myChannel', 'broadcast::json'],
            ['myChannel', 'broadcast::string'],
            ['app::chan', 'broadcast::'],
        ])('drops %s / %s under overload', (channel, command) => {
            expect(isDroppable(channel, command)).toBe(true);
        });

        it.each([
            ['objects', 'model::request'],
            ['objects', 'model::delete'],
            ['clients', 'client::request'],
            ['log', 'info'],
            ['log', 'error'],
            ['log', 'broadcast::json'],
            ['colibri', 'latency'],
            ['colibri', 'model::update'],
            ['colibri', 'broadcast::json'],
            ['objects', 'model::updates'],
            ['objects', 'some::other'],
        ])('never drops %s / %s', (channel, command) => {
            expect(isDroppable(channel, command)).toBe(false);
        });
    });

    describe('DropEpisode', () => {
        it('reports only the drop that starts an episode', () => {
            const episode = new DropEpisode();

            expect(episode.recordDrop(0)).toBe(true);
            expect(episode.recordDrop(10)).toBe(false);
            expect(episode.recordDrop(20)).toBe(false);
            expect(episode.active).toBe(true);
        });

        it('ends once nothing has been dropped for a while, with what it dropped and for how long', () => {
            const episode = new DropEpisode();
            episode.recordDrop(1000);
            episode.recordDrop(1500);
            episode.recordDrop(3500);

            expect(episode.endIfQuiet(3500 + EPISODE_QUIET_MILLIS - 1)).toBeUndefined();
            const summary = episode.endIfQuiet(3500 + EPISODE_QUIET_MILLIS);

            expect(summary).toEqual({ dropped: 3, seconds: 2.5 });
            expect(describeEpisode(summary!)).toBe('dropped 3 message(s) over 2.5 s');
            expect(episode.active).toBe(false);
        });

        it('keeps one episode going while drops come in bursts closer together than the quiet period', () => {
            const episode = new DropEpisode();
            const starts: number[] = [];
            for (let t = 0; t < 10_000; t += 400) {
                if (episode.recordDrop(t)) starts.push(t);
                expect(episode.endIfQuiet(t + 300)).toBeUndefined();
            }

            expect(starts).toEqual([0]);
        });

        it('starts a new episode after one ended', () => {
            const episode = new DropEpisode();
            episode.recordDrop(0);
            episode.endIfQuiet(EPISODE_QUIET_MILLIS);

            expect(episode.recordDrop(5000)).toBe(true);
            expect(episode.end()).toEqual({ dropped: 1, seconds: 0 });
        });

        it('has nothing to end when nothing was dropped', () => {
            const episode = new DropEpisode();

            expect(episode.endIfQuiet(100_000)).toBeUndefined();
            expect(episode.end()).toBeUndefined();
        });
    });

    describe('InboundBacklog', () => {
        const counter = () => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

        it('counts every post into the shared counter', () => {
            const shared = counter();
            const backlog = new InboundBacklog(shared, 10);

            backlog.posted();
            backlog.posted();

            expect(Atomics.load(shared, 0)).toBe(2);
            expect(backlog.pending).toBe(2);
        });

        it('is full from the limit on, and no longer once the other side has counted back down', () => {
            const shared = counter();
            const backlog = new InboundBacklog(shared, 3);

            backlog.posted();
            backlog.posted();
            expect(backlog.full).toBe(false);
            backlog.posted();
            expect(backlog.full).toBe(true);

            Atomics.sub(shared, 0, 1);
            expect(backlog.full).toBe(false);
        });

        it('is never full with the limit off', () => {
            const shared = counter();
            const backlog = new InboundBacklog(shared, 0);

            for (let i = 0; i < 10_000; i++) backlog.posted();

            expect(backlog.full).toBe(false);
            expect(backlog.pending).toBe(10_000);
        });

        // Nobody would ever count it back down, so counting at all would end in dropping forever.
        it('counts nothing and is never full without a counter', () => {
            const backlog = new InboundBacklog(undefined, 1);

            backlog.posted();
            backlog.posted();

            expect(backlog.pending).toBe(0);
            expect(backlog.full).toBe(false);
        });
    });
});
