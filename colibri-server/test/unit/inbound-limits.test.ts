import { describe, it, expect } from 'vitest';
import {
    DropEpisode,
    EPISODE_QUIET_MILLIS,
    EpisodeSummary,
    InboundBacklog,
    InboundRateLimiter,
    TokenBucket,
    describeEpisode,
    isDroppable,
    rateLimitEndWarning,
    rateLimitStartWarning,
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

    describe('TokenBucket', () => {
        it('lets a full burst through at once, then nothing more', () => {
            const bucket = new TokenBucket({ messagesPerSecond: 10, burst: 5 }, 0);

            const passed = Array.from({ length: 8 }, () => bucket.take(0));

            expect(passed).toEqual([true, true, true, true, true, false, false, false]);
        });

        it('refills at the sustained rate', () => {
            const bucket = new TokenBucket({ messagesPerSecond: 10, burst: 5 }, 0);
            for (let i = 0; i < 5; i++) bucket.take(0);

            expect(bucket.take(99)).toBe(false);
            expect(bucket.take(100)).toBe(true);
            expect(bucket.take(100)).toBe(false);
            expect(bucket.take(250)).toBe(true);
        });

        it('sustains exactly the configured rate over time', () => {
            const bucket = new TokenBucket({ messagesPerSecond: 1000, burst: 2000 }, 0);
            let passed = 0;
            // 3000 a second for 10 s, one every third of a millisecond.
            for (let i = 0; i < 30_000; i++) if (bucket.take(i / 3)) passed++;

            // The burst plus 10 s at the sustained rate, give or take the last refill.
            expect(passed).toBeGreaterThanOrEqual(2000 + 9_990);
            expect(passed).toBeLessThanOrEqual(2000 + 10_000);
        });

        it('never holds more than one burst, however long it was idle', () => {
            const bucket = new TokenBucket({ messagesPerSecond: 1000, burst: 3 }, 0);

            const passed = Array.from({ length: 5 }, () => bucket.take(3_600_000));

            expect(passed).toEqual([true, true, true, false, false]);
        });
    });

    describe('InboundRateLimiter', () => {
        type Event = [string, string, EpisodeSummary?, boolean?];

        const limiter = function (messagesPerSecond: number, burst: number) {
            const events: Event[] = [];
            const rateLimiter = new InboundRateLimiter<string>({ messagesPerSecond, burst }, {
                started: client => events.push(['started', client]),
                ended: (client, summary, left) => events.push(['ended', client, summary, left]),
            });
            return { rateLimiter, events };
        };

        it('limits each client on its own', () => {
            const { rateLimiter } = limiter(10, 2);

            expect([rateLimiter.admit('a', 0), rateLimiter.admit('a', 0), rateLimiter.admit('a', 0)]).toEqual([true, true, false]);
            expect([rateLimiter.admit('b', 0), rateLimiter.admit('b', 0)]).toEqual([true, true]);
        });

        it('reports one start per episode, however much it drops', () => {
            const { rateLimiter, events } = limiter(10, 1);

            for (let t = 0; t < 500; t += 1) rateLimiter.admit('a', t);

            expect(events).toEqual([['started', 'a']]);
        });

        it('reports the end once the client has stayed under the limit for the quiet period', () => {
            const { rateLimiter, events } = limiter(10, 1);
            rateLimiter.admit('a', 0);
            rateLimiter.admit('a', 0);
            rateLimiter.admit('a', 50);

            rateLimiter.sweep(50 + EPISODE_QUIET_MILLIS - 1);
            expect(events).toHaveLength(1);
            rateLimiter.sweep(50 + EPISODE_QUIET_MILLIS);
            rateLimiter.sweep(50 + 2 * EPISODE_QUIET_MILLIS);

            expect(events).toEqual([['started', 'a'], ['ended', 'a', { dropped: 2, seconds: 0.05 }, false]]);
        });

        it('reports a client that leaves mid-episode as having left, and forgets it', () => {
            const { rateLimiter, events } = limiter(10, 1);
            rateLimiter.admit('a', 0);
            rateLimiter.admit('a', 0);

            rateLimiter.forget('a');
            rateLimiter.sweep(10_000);

            expect(events).toEqual([['started', 'a'], ['ended', 'a', { dropped: 1, seconds: 0 }, true]]);
            // A client of the same identity that comes back starts with a full bucket.
            expect(rateLimiter.admit('a', 0)).toBe(true);
        });

        it('says nothing about a client that leaves without ever being limited', () => {
            const { rateLimiter, events } = limiter(10, 5);
            rateLimiter.admit('a', 0);

            rateLimiter.forget('a');

            expect(events).toEqual([]);
        });

        it('admits everything with the limit off', () => {
            const { rateLimiter, events } = limiter(0, 0);

            for (let i = 0; i < 10_000; i++) expect(rateLimiter.admit('a', 0)).toBe(true);
            expect(events).toEqual([]);
        });

        it('words its warnings with the client, the limit and the settings to change', () => {
            const start = rateLimitStartWarning('Unity client \'quest-3\'', { messagesPerSecond: 1000, burst: 2000 });
            expect(start).toContain('Unity client \'quest-3\' is sending more than 1000');
            expect(start).toContain('CLIENT_MESSAGE_RATE_LIMIT');

            expect(rateLimitEndWarning('c', { dropped: 3, seconds: 1.25 }, false)).toBe(
                'c is back under the message rate limit; dropped 3 message(s) over 1.3 s.'
            );
            expect(rateLimitEndWarning('c', { dropped: 3, seconds: 1.25 }, true)).toContain('c disconnected while over');
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
