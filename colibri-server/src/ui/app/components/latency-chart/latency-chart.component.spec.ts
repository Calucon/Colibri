import { perSecond } from './latency-chart.component';

describe('perSecond', () => {
    it('draws a client as the median of each second, at the samples\' mean time', () => {
        expect(perSecond([ [ 1000, 5 ], [ 1100, 1 ], [ 1200, 9 ], [ 2050, 4 ], [ 2150, 6 ] ])).toEqual([ [ 1100, 5 ], [ 2100, 5 ] ]);
        expect(perSecond([])).toEqual([]);
    });
});
