import { describe, it, expect, vi } from 'vitest';
import { Payload } from '../../src/server/modules/core/payload.js';

describe('Payload', () => {
    it('fromString: asString() returns the raw string without parsing', () => {
        const payload = Payload.fromString('{"x":1}');
        expect(payload.asString()).toBe('{"x":1}');
    });

    it('fromString: asValue() parses lazily and memoizes the result', () => {
        const payload = Payload.fromString('{"x":1}');
        const first = payload.asValue<{ x: number }>();
        const second = payload.asValue<{ x: number }>();
        expect(first).toEqual({ x: 1 });
        expect(first).toBe(second);
    });

    it('fromValue: asValue() returns the value without stringifying', () => {
        const value = { x: 1 };
        const payload = Payload.fromValue(value);
        expect(payload.asValue()).toBe(value);
    });

    it('fromValue: asString() stringifies lazily and memoizes the result', () => {
        const payload = Payload.fromValue({ x: 1 });
        const spy = vi.spyOn(JSON, 'stringify');
        const first = payload.asString();
        const second = payload.asString();
        expect(first).toBe('{"x":1}');
        expect(second).toBe('{"x":1}');
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });

    it('fromBytes: asBytes() returns the raw bytes without transcoding', () => {
        const bytes = Buffer.from('{"x":1}', 'utf8');
        const payload = Payload.fromBytes(bytes);
        expect(payload.asBytes()).toBe(bytes);
    });

    it('fromBytes: asString() decodes utf8 lazily and memoizes the result', () => {
        const bytes = Buffer.from('{"x":1}', 'utf8');
        const payload = Payload.fromBytes(bytes);
        expect(payload.asString()).toBe('{"x":1}');
    });

    it('fromBytes: asValue() decodes and parses lazily', () => {
        const bytes = Buffer.from('{"x":1}', 'utf8');
        const payload = Payload.fromBytes(bytes);
        expect(payload.asValue()).toEqual({ x: 1 });
    });

    it('fromString: asBytes() utf8-encodes lazily and memoizes the result', () => {
        const payload = Payload.fromString('{"x":1}');
        const first = payload.asBytes();
        const second = payload.asBytes();
        expect(first).toEqual(Buffer.from('{"x":1}', 'utf8'));
        expect(first).toBe(second);
    });

    it('fromValue: asBytes() stringifies then encodes lazily', () => {
        const payload = Payload.fromValue({ x: 1 });
        expect(payload.asBytes()).toEqual(Buffer.from('{"x":1}', 'utf8'));
    });
});
