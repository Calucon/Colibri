// What the admin UI's client view shows of a client's traffic, on either transport.

// Which load limit holds a client's updates back: its own message rate (CLIENT_MESSAGE_RATE_LIMIT),
// or, for a TCP client, the main thread falling behind (TCP_INBOUND_BACKLOG_LIMIT).
export type LoadLimit = 'rate' | 'backlog';

export interface ClientActivity {
    // Messages a second it sent and was sent, over the last RATE_WINDOW_MILLIS. null until a full
    // window has passed since it connected. The heartbeats, the latency pings and their echoes are
    // not messages here.
    in: number | null;
    out: number | null;
    // The limit holding its model updates back, or dropping its broadcasts, now; null if none is.
    limit: LoadLimit | null;
    // How many objects it has model updates held back for.
    held: number;
}

// How often a transport turns its per-client message counts into rates.
export const RATE_WINDOW_MILLIS = 1000;

// A client's message counts, and its rates over the last window. The transport counts each message
// with a plain increment and calls sample() about once a window, so the cost per message is that
// increment, whether or not anyone looks at the rates.
export class TrafficMeter {
    public received = 0;
    public sent = 0;
    public receivedPerSecond: number | null = null;
    public sentPerSecond: number | null = null;

    private sampledReceived = 0;
    private sampledSent = 0;

    public constructor(private sampledAt: number) {}

    // `sent`: for a transport that counts what it sends some other way (see SocketIOServer).
    public sample(now: number, sent = this.sent): void {
        const elapsed = now - this.sampledAt;
        if (elapsed < RATE_WINDOW_MILLIS) return;

        this.receivedPerSecond = ((this.received - this.sampledReceived) * 1000) / elapsed;
        this.sentPerSecond = ((sent - this.sampledSent) * 1000) / elapsed;
        this.sampledReceived = this.received;
        this.sampledSent = sent;
        this.sampledAt = now;
    }
}
