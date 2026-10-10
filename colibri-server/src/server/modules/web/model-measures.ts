// What the admin UI's model snapshots measure and format of a model: its size and its value as
// indented JSON. Both cost time on the main thread in proportion to the model's size, so how much of
// that is done is bounded per second for all pages together, not per snapshot, and does not grow
// with how large the models are or how often they change.
import { ModelEntry } from '../command-hooks/index.js';

// How many bytes of models are measured a second, for all pages together: about 20 ms of the main
// thread. The budget holds at most one second's worth.
export const MODEL_BYTES_PER_SECOND = 2 * 1024 * 1024;

// How long the size of a model that has changed since it was measured is shown before it is
// measured again. A model that changes every frame would otherwise be measured on every refresh.
export const MODEL_SIZE_REFRESH_MILLIS = 10_000;

// How much of a model's formatted JSON the model topic carries.
export const MAX_MODEL_JSON_LENGTH = 512 * 1024;

// How many models' formatted JSON is kept, for the models the pages have open.
export const FORMATTED_MODELS_KEPT = 8;

interface Size {
    bytes: number;
    // The model's version, and performance.now(), when it was measured.
    version: number;
    at: number;
}

export interface FormattedJson {
    json: string;
    // Whether json is only the start of the value, cut at MAX_MODEL_JSON_LENGTH.
    truncated: boolean;
}

interface Formatted extends FormattedJson {
    version: number;
}

/**
 * Measures and formats models for the admin UI's snapshots, one instance for all of them. Read
 * only: what it keeps of a model lives here, not in the store.
 */
export class ModelMeasures {
    private readonly sizes = new WeakMap<Readonly<ModelEntry>, Size>();
    // Oldest used first, at most FORMATTED_MODELS_KEPT.
    private readonly formatted = new Map<Readonly<ModelEntry>, Formatted>();
    private tokens: number;
    private refilledAt: number;

    public constructor(private readonly bytesPerSecond = MODEL_BYTES_PER_SECOND, now = performance.now()) {
        this.tokens = bytesPerSecond;
        this.refilledAt = now;
    }

    /**
     * The model's size as compact JSON, in bytes: measured afresh when the budget allows, otherwise
     * the size it had when it was last measured, at most MODEL_SIZE_REFRESH_MILLIS before, or null
     * if it has not been measured yet.
     */
    public bytes(entry: Readonly<ModelEntry>, now = performance.now()): number | null {
        const known = this.sizes.get(entry);
        if (known && (known.version === entry.version || now - known.at < MODEL_SIZE_REFRESH_MILLIS)) return known.bytes;

        // A model is measured once the budget holds as much as it took last time, or the budget is
        // full. One larger than the budget leaves it in debt, which the following seconds pay off.
        const left = this.refill(now);
        if (left <= 0 || left < Math.min(known?.bytes ?? 0, this.bytesPerSecond)) return known?.bytes ?? null;

        const bytes = Buffer.byteLength(JSON.stringify(entry.model), 'utf8');
        this.tokens -= bytes;
        this.sizes.set(entry, { bytes, version: entry.version, at: now });
        return bytes;
    }

    /** The model's value as JSON indented by two spaces, cut to MAX_MODEL_JSON_LENGTH characters. */
    public json(entry: Readonly<ModelEntry>): FormattedJson {
        let formatted = this.formatted.get(entry);
        this.formatted.delete(entry);
        if (!formatted || formatted.version !== entry.version) {
            formatted = { ...formatJson(entry.model, MAX_MODEL_JSON_LENGTH), version: entry.version };
        }
        this.formatted.set(entry, formatted);
        if (this.formatted.size > FORMATTED_MODELS_KEPT) this.formatted.delete(this.formatted.keys().next().value!);
        return { json: formatted.json, truncated: formatted.truncated };
    }

    private refill(now: number): number {
        if (now > this.refilledAt) {
            this.tokens = Math.min(this.bytesPerSecond, this.tokens + ((now - this.refilledAt) * this.bytesPerSecond) / 1000);
            this.refilledAt = now;
        }
        return this.tokens;
    }
}

// What JSON.stringify leaves out of an object and writes as null in an array.
const isSkipped = function (value: unknown): boolean {
    return value === undefined || typeof value === 'function' || typeof value === 'symbol';
};

// A value as JSON.stringify sees it: after its toJSON, and unboxed.
const prepare = function (value: unknown, key: string | number): unknown {
    let prepared = value;
    if (prepared !== null && typeof prepared === 'object' && typeof (prepared as { toJSON?: unknown }).toJSON === 'function') {
        prepared = (prepared as { toJSON(key: string): unknown }).toJSON(`${key}`);
    }
    if (prepared instanceof Number || prepared instanceof String || prepared instanceof Boolean) return prepared.valueOf();
    return prepared;
};

/**
 * JSON.stringify(value, null, 2), cut to maxLength characters. It stops writing once it has that
 * many, so its cost grows with maxLength, not with the value: a model of 50 MB costs as much as one
 * of 512 KiB. It also stops a value that contains itself, where JSON.stringify throws.
 */
export const formatJson = function (value: unknown, maxLength: number): FormattedJson {
    const parts: string[] = [];
    let length = 0;
    const newlines: string[] = [];
    const newline = (depth: number): string => (newlines[depth] ??= '\n' + '  '.repeat(depth));

    // Each of these returns whether maxLength has been passed, so that nothing more is written.
    const write = (text: string): boolean => {
        parts.push(text);
        length += text.length;
        return length > maxLength;
    };

    // A string longer than what is left is escaped only as far as the cut, plus a character: the
    // escaped start of a string is the start of the escaped string.
    const writeString = (text: string): boolean => {
        const left = maxLength - length;
        return write(JSON.stringify(text.length > left ? text.slice(0, left + 1) : text));
    };

    const writeValue = (item: unknown, depth: number): boolean => {
        if (typeof item === 'string') return writeString(item);
        if (item === null || typeof item !== 'object') return write(JSON.stringify(item) ?? 'null');

        if (Array.isArray(item)) {
            if (item.length === 0) return write('[]');
            if (write('[')) return true;
            for (let i = 0; i < item.length; i++) {
                const element = prepare(item[i], i);
                if (write((i > 0 ? ',' : '') + newline(depth + 1))) return true;
                if (isSkipped(element) ? write('null') : writeValue(element, depth + 1)) return true;
            }
            return write(newline(depth) + ']');
        }

        if (write('{')) return true;
        let empty = true;
        for (const key of Object.keys(item)) {
            const field = prepare((item as Record<string, unknown>)[key], key);
            if (isSkipped(field)) continue;
            if (write((empty ? '' : ',') + newline(depth + 1)) || writeString(key) || write(': ') || writeValue(field, depth + 1)) return true;
            empty = false;
        }
        return write(empty ? '}' : newline(depth) + '}');
    };

    const root = prepare(value, '');
    if (!isSkipped(root)) writeValue(root, 0);

    const json = parts.join('');
    return json.length > maxLength ? { json: json.slice(0, maxLength), truncated: true } : { json, truncated: false };
};
