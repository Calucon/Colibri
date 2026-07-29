// Wraps a NetworkMessage's payload in whichever representation the producer already
// had (wire string from TCP, parsed value from Socket.IO) and memoizes the other one
// on first request. Same-transport relaying (TCP->TCP, web->web) then costs zero JSON
// work; only a genuine cross-transport hop pays for one parse/stringify.
export class Payload {
    private raw: string | undefined;
    private value: unknown;
    private valueResolved: boolean;

    private constructor(raw: string | undefined, value: unknown, valueResolved: boolean) {
        this.raw = raw;
        this.value = value;
        this.valueResolved = valueResolved;
    }

    public static fromString(raw: string): Payload {
        return new Payload(raw, undefined, false);
    }

    public static fromValue(value: unknown): Payload {
        return new Payload(undefined, value, true);
    }

    public asString(): string {
        if (this.raw === undefined) {
            this.raw = JSON.stringify(this.value);
        }
        return this.raw;
    }

    public asValue<T = unknown>(): T {
        if (!this.valueResolved) {
            this.value = this.raw ? JSON.parse(this.raw) : undefined;
            this.valueResolved = true;
        }
        return this.value as T;
    }
}
