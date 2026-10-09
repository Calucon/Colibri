import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ClientService, ColibriClient } from '../../services';
import { clientColor } from '../../components/latency-chart/latency-chart.component';
import { StatisticsComponent } from './statistics.component';

describe('StatisticsComponent', () => {
    let clients: ReturnType<typeof signal<ReadonlyArray<ColibriClient>>>;

    beforeEach(() => {
        clients = signal<ReadonlyArray<ColibriClient>>([]);
        TestBed.configureTestingModule({ providers: [ { provide: ClientService, useValue: { clients } } ] });
        TestBed.overrideComponent(StatisticsComponent, { set: { imports: [], template: '' } });
    });

    it('lists each client with its chart colour, app, version and latency', () => {
        clients.set([
            { id: 'abcdef123', app: 'demo', name: '127.0.0.1', version: '2', latency: [ [ 1, 4 ], [ 2, 6 ], [ 3, 8 ] ] },
            { id: 'uvwxyz456', app: 'demo', name: '127.0.0.1', version: '2', latency: [] },
            { id: 'q1', app: 'other', name: 'Quest', version: '', latency: [] }
        ]);
        const component = TestBed.createComponent(StatisticsComponent).componentInstance;

        const [ first, second, third ] = component.rows();
        expect(first).toEqual(expect.objectContaining({ color: clientColor(0), app: 'demo', version: 'v2', median: 6, stdev: 2 }));
        expect(second.color).toBe(clientColor(1));
        expect(second.median).toBeNull();
        // two clients of one app with one name, as web clients on one host are, told apart by id
        expect([ first.idHint, second.idHint, third.idHint ]).toEqual([ 'abcdef', 'uvwxyz', null ]);
        expect(third.version).toBe('');
    });
});
