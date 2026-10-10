import { describe, it, expect } from 'vitest';
import { RATE_WINDOW_MILLIS, TrafficMeter } from '../../src/server/modules/networking/client-activity.js';

describe('TrafficMeter', () => {
    it('turns counts into rates once a window has passed', () => {
        const meter = new TrafficMeter(0);
        meter.received = 50;
        meter.sent = 10;
        meter.sample(RATE_WINDOW_MILLIS / 2);
        expect(meter.receivedPerSecond).toBeNull();

        meter.sample(2 * RATE_WINDOW_MILLIS);
        expect(meter.receivedPerSecond).toBe(25);
        expect(meter.sentPerSecond).toBe(5);

        meter.received += 30;
        meter.sample(3 * RATE_WINDOW_MILLIS, 40);
        expect(meter.receivedPerSecond).toBe(30);
        expect(meter.sentPerSecond).toBe(30);
    });
});
