import { describe, it, expect } from 'vitest';
import {
    EPISODE_QUIET_MILLIS,
    EpisodeSummary,
    HeldUpdates,
    InboundBacklog,
    InboundRateLimiter,
    LimitEpisode,
    MAX_HELD_OBJECTS,
    TokenBucket,
    asModelUpdate,
    describeEpisode,
    isLimitable,
    rateLimitEndWarning,
    rateLimitStartWarning,
} from '../../src/server/modules/networking/inbound-limits.js';

describe('inbound limits', () => {
    // The policy shared by the TCP backlog limit and the per-client rate limit: only the bulk of a
    // sync loop's traffic is ever held back or dropped, never anything whose loss nothing repairs.
    describe('isLimitable', () => {
        it.each([
            ['objects', 'model::update'],
            ['myChannel', 'broadcast::json'],
            ['myChannel', 'broadcast::string'],
            ['app::chan', 'broadcast::'],
        ])('limits %s / %s under overload', (channel, command) => {
            expect(isLimitable(channel, command)).toBe(true);
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
        ])('never limits %s / %s', (channel, command) => {
            expect(isLimitable(channel, command)).toBe(false);
        });
    });

    describe('LimitEpisode', () => {
        it('reports only the message that starts an episode', () => {
            const episode = new LimitEpisode();

            expect(episode.record(0, 'held')).toBe(true);
            expect(episode.record(10, 'dropped')).toBe(false);
            expect(episode.record(20, 'held')).toBe(false);
            expect(episode.active).toBe(true);
        });

        it('ends once nothing has been over the limit for a while, with what became of what and for how long', () => {
            const episode = new LimitEpisode();
            episode.record(1000, 'held');
            episode.record(1500, 'dropped');
            episode.record(3500, 'held');

            expect(episode.endIfQuiet(3500 + EPISODE_QUIET_MILLIS - 1)).toBeUndefined();
            const summary = episode.endIfQuiet(3500 + EPISODE_QUIET_MILLIS);

            expect(summary).toEqual({ held: 2, dropped: 1, seconds: 2.5 });
            expect(describeEpisode(summary!)).toBe('held back 2 model::update(s), merged per object and dropped 1 message(s) over 2.5 s');
            expect(episode.active).toBe(false);
        });

        it('only mentions what happened', () => {
            expect(describeEpisode({ held: 4, dropped: 0, seconds: 1 })).toBe('held back 4 model::update(s), merged per object over 1.0 s');
            expect(describeEpisode({ held: 0, dropped: 3, seconds: 0 })).toBe('dropped 3 message(s) over 0.0 s');
        });

        it('keeps one episode going while the limit bites in bursts closer together than the quiet period', () => {
            const episode = new LimitEpisode();
            const starts: number[] = [];
            for (let t = 0; t < 10_000; t += 400) {
                if (episode.record(t, 'held')) starts.push(t);
                expect(episode.endIfQuiet(t + 300)).toBeUndefined();
            }

            expect(starts).toEqual([0]);
        });

        it('starts a new episode after one ended', () => {
            const episode = new LimitEpisode();
            episode.record(0, 'dropped');
            episode.endIfQuiet(EPISODE_QUIET_MILLIS);

            expect(episode.record(5000, 'held')).toBe(true);
            expect(episode.end()).toEqual({ held: 1, dropped: 0, seconds: 0 });
        });

        it('has nothing to end when nothing was over the limit', () => {
            const episode = new LimitEpisode();

            expect(episode.endIfQuiet(100_000)).toBeUndefined();
            expect(episode.end()).toBeUndefined();
        });
    });

    describe('asModelUpdate', () => {
        it('takes a JSON object with a string id', () => {
            const model = { id: 'cube', x: 1 };

            expect(asModelUpdate(model)).toBe(model);
        });

        it.each([
            ['no id', { x: 1 }],
            ['a numeric id', { id: 7 }],
            ['an array', [{ id: 'a' }]],
            ['null', null],
            ['a string', 'cube'],
            ['nothing', undefined],
        ])('refuses %s', (_case, value) => {
            expect(asModelUpdate(value)).toBeUndefined();
        });
    });

    // A model::update is a delta of the fields that changed. Dropping one could lose a field's
    // change for good; merging them per object loses nothing but intermediate states.
    describe('HeldUpdates', () => {
        it('merges the updates to one object field by field, later values winning', () => {
            const held = new HeldUpdates();

            held.hold('objects', { id: 'cube', x: 1, color: 'red' });
            held.hold('objects', { id: 'cube', x: 2 });
            held.hold('objects', { id: 'cube', isOn: true });

            expect(held.size).toBe(1);
            expect(held.takeAll()).toEqual([{ channel: 'objects', model: { id: 'cube', x: 2, color: 'red', isOn: true } }]);
        });

        // What a receiver ends up with is the same either way, which is the whole point.
        it('ends in the same state as applying every update in turn would', () => {
            const updates = [
                { id: 'cube', x: 1, y: 1 },
                { id: 'cube', isOn: true },
                { id: 'cube', x: 2 },
                { id: 'cube', isOn: false, label: 'a' },
                { id: 'cube', y: 5 },
            ];
            const appliedInTurn: Record<string, unknown> = {};
            for (const update of updates) Object.assign(appliedInTurn, update);

            const held = new HeldUpdates();
            for (const update of updates) held.hold('objects', update);
            const appliedMerged: Record<string, unknown> = { ...held.shift()!.model };

            expect(appliedMerged).toEqual(appliedInTurn);
        });

        it('keeps objects and channels apart', () => {
            const held = new HeldUpdates();

            held.hold('objects', { id: 'a', x: 1 });
            held.hold('objects', { id: 'b', x: 2 });
            held.hold('others', { id: 'a', x: 3 });

            expect(held.size).toBe(3);
        });

        it('hands them back oldest object first', () => {
            const held = new HeldUpdates();
            held.hold('objects', { id: 'a', x: 1 });
            held.hold('objects', { id: 'b', x: 1 });
            held.hold('objects', { id: 'a', x: 2 });

            expect(held.shift()?.model).toEqual({ id: 'a', x: 2 });
            expect(held.shift()?.model).toEqual({ id: 'b', x: 1 });
            expect(held.shift()).toBeUndefined();
        });

        it('does not change the update it was handed', () => {
            const held = new HeldUpdates();
            const first = { id: 'cube', x: 1 };
            held.hold('objects', first);
            held.hold('objects', { id: 'cube', x: 2 });

            expect(first).toEqual({ id: 'cube', x: 1 });
        });

        it('merges a field called __proto__ as data, without touching any prototype', () => {
            const held = new HeldUpdates();

            held.hold('objects', JSON.parse('{"id":"cube","__proto__":{"polluted":true}}') as { id: string });

            const model = held.shift()!.model;
            expect(JSON.parse(JSON.stringify(model))).toEqual(JSON.parse('{"id":"cube","__proto__":{"polluted":true}}'));
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        });

        it('holds at most MAX_HELD_OBJECTS objects, but still merges into those it has', () => {
            const held = new HeldUpdates();
            for (let i = 0; i < MAX_HELD_OBJECTS; i++) expect(held.hold('objects', { id: `o${i}` })).toBe(true);

            expect(held.hold('objects', { id: 'one-too-many' })).toBe(false);
            expect(held.hold('objects', { id: 'o0', x: 1 })).toBe(true);
            expect(held.size).toBe(MAX_HELD_OBJECTS);
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

        // What a transport does with each message: take a token, or record what became of it.
        const send = function (rateLimiter: InboundRateLimiter<string>, client: string, now: number): boolean {
            if (rateLimiter.take(client, now)) return true;
            rateLimiter.record(client, now, 'dropped');
            return false;
        };

        it('limits each client on its own', () => {
            const { rateLimiter } = limiter(10, 2);

            expect([rateLimiter.take('a', 0), rateLimiter.take('a', 0), rateLimiter.take('a', 0)]).toEqual([true, true, false]);
            expect([rateLimiter.take('b', 0), rateLimiter.take('b', 0)]).toEqual([true, true]);
        });

        it('reports one start per episode, however much is over the limit', () => {
            const { rateLimiter, events } = limiter(10, 1);

            for (let t = 0; t < 500; t += 1) send(rateLimiter, 'a', t);

            expect(events).toEqual([['started', 'a']]);
        });

        // A held-back update that is retried and refused again is still one message.
        it('counts only what is recorded, not every refused take', () => {
            const { rateLimiter, events } = limiter(10, 1);
            rateLimiter.take('a', 0);
            rateLimiter.record('a', 0, 'held');
            for (let i = 0; i < 50; i++) rateLimiter.take('a', 0);

            rateLimiter.sweep(EPISODE_QUIET_MILLIS);

            expect(events[1]).toEqual(['ended', 'a', { held: 1, dropped: 0, seconds: 0 }, false]);
        });

        it('reports the end once the client has stayed under the limit for the quiet period', () => {
            const { rateLimiter, events } = limiter(10, 1);
            send(rateLimiter, 'a', 0);
            send(rateLimiter, 'a', 0);
            send(rateLimiter, 'a', 50);

            rateLimiter.sweep(50 + EPISODE_QUIET_MILLIS - 1);
            expect(events).toHaveLength(1);
            rateLimiter.sweep(50 + EPISODE_QUIET_MILLIS);
            rateLimiter.sweep(50 + 2 * EPISODE_QUIET_MILLIS);

            expect(events).toEqual([['started', 'a'], ['ended', 'a', { held: 0, dropped: 2, seconds: 0.05 }, false]]);
        });

        it('reports a client that leaves mid-episode as having left, and forgets it', () => {
            const { rateLimiter, events } = limiter(10, 1);
            send(rateLimiter, 'a', 0);
            send(rateLimiter, 'a', 0);

            rateLimiter.forget('a');
            rateLimiter.sweep(10_000);

            expect(events).toEqual([['started', 'a'], ['ended', 'a', { held: 0, dropped: 1, seconds: 0 }, true]]);
            // A client of the same identity that comes back starts with a full bucket.
            expect(rateLimiter.take('a', 0)).toBe(true);
        });

        it('says nothing about a client that leaves without ever being limited', () => {
            const { rateLimiter, events } = limiter(10, 5);
            send(rateLimiter, 'a', 0);

            rateLimiter.forget('a');

            expect(events).toEqual([]);
        });

        it('lets everything through with the limit off', () => {
            const { rateLimiter, events } = limiter(0, 0);

            for (let i = 0; i < 10_000; i++) expect(send(rateLimiter, 'a', 0)).toBe(true);
            expect(events).toEqual([]);
        });

        it('words its warnings with the client, the limit, the settings to change and what happens meanwhile', () => {
            const start = rateLimitStartWarning('Unity client \'quest-3\'', { messagesPerSecond: 1000, burst: 2000 });
            expect(start).toContain('Unity client \'quest-3\' is sending more than 1000');
            expect(start).toContain('CLIENT_MESSAGE_RATE_LIMIT');
            expect(start).toContain('the latest value of every field still arrives');

            expect(rateLimitEndWarning('c', { held: 0, dropped: 3, seconds: 1.25 }, false)).toBe(
                'c is back under the message rate limit; dropped 3 message(s) over 1.3 s.'
            );
            expect(rateLimitEndWarning('c', { held: 0, dropped: 3, seconds: 1.25 }, true)).toContain('c disconnected while over');
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
