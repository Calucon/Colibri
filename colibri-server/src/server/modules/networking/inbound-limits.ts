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
