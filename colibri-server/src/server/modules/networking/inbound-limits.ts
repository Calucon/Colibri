// What the server may shed on the way in when it is taking in more than it can process, and the
// bookkeeping that makes shedding visible in the log instead of silent.
import { COLIBRI_CHANNEL } from './protocol.js';

// The channel ClientLogger listens on.
const LOG_CHANNEL = 'log';

// Whether a message may be dropped under overload. Only the two commands that make up the bulk of
// a sync loop's traffic are:
//
// - model::update carries an object's whole synced state, and the store and every client keep only
//   the last one (last write wins), so a dropped update costs a stale moment that the object's next
//   update corrects.
// - broadcast::* is fire-and-forget application traffic with no reply and no stored state.
//
// Everything else is never dropped, because nothing later would repair the loss: the handshake and
// heartbeats (not messages at all), model::request (a client waiting for its initial state),
// model::delete (an object that would never go away), a client's log lines, and anything on the
// 'colibri' channel (latency replies, protocol messages, the admin UI).
export const isDroppable = function (channel: string, command: string): boolean {
    if (channel === COLIBRI_CHANNEL || channel === LOG_CHANNEL) return false;
    return command === 'model::update' || command.startsWith('broadcast::');
};

// An episode is over once nothing has been dropped for this long. Long enough that a load sitting
// right at the limit - dropping in bursts with gaps between them - is one episode with one pair of
// log lines rather than a pair every few hundred milliseconds.
export const EPISODE_QUIET_MILLIS = 1000;

export interface EpisodeSummary {
    dropped: number;
    // From the first drop to the last.
    seconds: number;
}

// One stretch of dropping, from the first message dropped until EPISODE_QUIET_MILLIS pass without
// another. The caller logs a warning when recordDrop() says an episode started, and a summary when
// endIfQuiet() or end() hands one back - two lines per episode however much is dropped in between,
// the same way the egress 'dropping' state in TCPServerWorker.writeToClient logs only transitions.
export class DropEpisode {
    private dropped = 0;
    private startedAt = 0;
    private lastDropAt = 0;

    public get active(): boolean {
        return this.dropped > 0;
    }

    // Returns true for the drop that started the episode.
    public recordDrop(now: number): boolean {
        this.lastDropAt = now;
        this.dropped += 1;
        if (this.dropped > 1) return false;

        this.startedAt = now;
        return true;
    }

    public endIfQuiet(now: number): EpisodeSummary | undefined {
        if (!this.active || now - this.lastDropAt < EPISODE_QUIET_MILLIS) return undefined;
        return this.end();
    }

    public end(): EpisodeSummary | undefined {
        if (!this.active) return undefined;

        const summary = { dropped: this.dropped, seconds: (this.lastDropAt - this.startedAt) / 1000 };
        this.dropped = 0;
        return summary;
    }
}

export const describeEpisode = function (summary: EpisodeSummary): string {
    return `dropped ${summary.dropped} message(s) over ${summary.seconds.toFixed(1)} s`;
};

export interface RateLimit {
    // Droppable messages a second a single client may send, sustained. 0 turns the limit off.
    messagesPerSecond: number;
    // How many it may send at once, after a quieter stretch.
    burst: number;
}

// Well above what any legitimate client sends - a Quest syncing 10 objects at 72 Hz sends 720
// updates a second - so this only ever bites on a runaway loop: a sync without a rate cap, or a
// send in Update() with nothing changing, which on its own can saturate the server for everyone.
export const DEFAULT_RATE_LIMIT: RateLimit = { messagesPerSecond: 1000, burst: 2000 };

// The classic token bucket: holds up to `burst` tokens, refills at `messagesPerSecond`, and a
// message passes only if it can take one.
export class TokenBucket {
    private tokens: number;
    private refilledAt: number;

    public constructor(private readonly limit: RateLimit, now: number) {
        this.tokens = limit.burst;
        this.refilledAt = now;
    }

    public take(now: number): boolean {
        if (now > this.refilledAt) {
            this.tokens = Math.min(this.limit.burst, this.tokens + ((now - this.refilledAt) * this.limit.messagesPerSecond) / 1000);
            this.refilledAt = now;
        }

        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

export interface RateLimitReporter<K> {
    // A client's first message over the limit since it was last under it.
    started(client: K): void;
    // The client has been under the limit for EPISODE_QUIET_MILLIS, or (`left`) disconnected.
    ended(client: K, summary: EpisodeSummary, left: boolean): void;
}

// A token bucket per client, for droppable messages only (see isDroppable), plus one drop episode
// per client so each stretch of dropping is reported once rather than per message. Shared by both
// transports; K is whatever object the transport keeps per client.
export class InboundRateLimiter<K> {
    private readonly clients = new Map<K, { bucket: TokenBucket; episode: DropEpisode }>();
    // Only these can have an episode to end, so sweep() never walks every connected client.
    private readonly dropping = new Set<K>();

    public constructor(
        public readonly limit: RateLimit,
        private readonly reporter: RateLimitReporter<K>
    ) {}

    // Whether a droppable message from this client may pass.
    public admit(client: K, now: number): boolean {
        if (this.limit.messagesPerSecond <= 0) return true;

        let state = this.clients.get(client);
        if (!state) {
            state = { bucket: new TokenBucket(this.limit, now), episode: new DropEpisode() };
            this.clients.set(client, state);
        }

        if (state.bucket.take(now)) return true;

        if (state.episode.recordDrop(now)) {
            this.dropping.add(client);
            this.reporter.started(client);
        }
        return false;
    }

    // Reports the end of every episode that has gone quiet. Call it periodically.
    public sweep(now: number): void {
        for (const client of this.dropping) {
            const summary = this.clients.get(client)?.episode.endIfQuiet(now);
            if (!summary) continue;

            this.dropping.delete(client);
            this.reporter.ended(client, summary, false);
        }
    }

    // For a client that has gone: reports its episode if it was in one, and lets go of it.
    public forget(client: K): void {
        const summary = this.clients.get(client)?.episode.end();
        this.clients.delete(client);
        this.dropping.delete(client);
        if (summary) this.reporter.ended(client, summary, true);
    }
}

export const rateLimitStartWarning = function (who: string, limit: RateLimit): string {
    return (
        `${who} is sending more than ${limit.messagesPerSecond} model::update and broadcast::* messages a second ` +
        `(CLIENT_MESSAGE_RATE_LIMIT, bursts up to CLIENT_MESSAGE_RATE_BURST=${limit.burst}); dropping what is over the limit ` +
        'until it slows down. The usual cause is something sending every frame without a rate cap.'
    );
};

export const rateLimitEndWarning = function (who: string, summary: EpisodeSummary, left: boolean): string {
    return left
        ? `${who} disconnected while over the message rate limit; ${describeEpisode(summary)}.`
        : `${who} is back under the message rate limit; ${describeEpisode(summary)}.`;
};

// The worker side of the count of TCP messages posted to the main thread and not yet dispatched
// there - the depth of the worker->main MessagePort queue, which nothing else can observe.
//
// The counter is an Int32 in a SharedArrayBuffer that TCPServerProxy owns: this side increments it
// for every clientMessage$ it posts, the proxy decrements it once that message has been dispatched.
// Without it the worker had no way to know the main thread was behind, kept posting at the rate
// clients sent, and the queue - every message in it a structured clone held in memory - grew
// without bound until the process was killed for running out of memory, while clients stayed
// connected and saw state that was seconds old.
export class InboundBacklog {
    // `counter` absent means nobody decrements, so nothing is counted either.
    public constructor(
        private readonly counter: Int32Array | undefined,
        // 0 turns the limit off; the backlog is still counted.
        public readonly limit: number
    ) {}

    public get pending(): number {
        return this.counter ? Atomics.load(this.counter, 0) : 0;
    }

    public posted(): void {
        if (this.counter) Atomics.add(this.counter, 0, 1);
    }

    public get full(): boolean {
        return this.limit > 0 && this.counter !== undefined && Atomics.load(this.counter, 0) >= this.limit;
    }
}
