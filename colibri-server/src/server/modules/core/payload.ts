// Wraps a NetworkMessage's payload in whichever representation the producer already
// had (raw bytes off the TCP wire, wire string, or parsed value from Socket.IO) and
// memoizes the others on first request. Same-transport relaying (TCP->TCP, web->web)
// then costs zero JSON work and - for TCP->TCP - never even transcodes the payload to
// a JS string; only a genuine cross-transport hop, or a hook that inspects the
// payload, pays for decoding it.
export class Payload {
    private bytes: Buffer | undefined;
    private raw: string | undefined;
    private value: unknown;
    private valueResolved: boolean;

    private constructor(bytes: Buffer | undefined, raw: string | undefined, value: unknown, valueResolved: boolean) {
        this.bytes = bytes;
        this.raw = raw;
        this.value = value;
        this.valueResolved = valueResolved;
    }

    public static fromBytes(bytes: Buffer): Payload {
        return new Payload(bytes, undefined, undefined, false);
    }

    public static fromString(raw: string): Payload {
        return new Payload(undefined, raw, undefined, false);
    }

    public static fromValue(value: unknown): Payload {
        return new Payload(undefined, undefined, value, true);
    }

    // Only decodes to utf8 if nothing has requested a byte view yet; a TCP->TCP relay
    // that never calls asString()/asValue() never pays for this at all.
    public asBytes(): Buffer {
        if (this.bytes === undefined) {
            this.bytes = Buffer.from(this.asString(), 'utf8');
        }
        return this.bytes;
    }

    public asString(): string {
        if (this.raw === undefined) {
            this.raw = this.bytes !== undefined ? this.bytes.toString('utf8') : JSON.stringify(this.value);
        }
        return this.raw;
    }

    public asValue<T = unknown>(): T {
        if (!this.valueResolved) {
            const raw = this.asString();
            this.value = raw ? JSON.parse(raw) : undefined;
            this.valueResolved = true;
        }
        return this.value as T;
    }
}
