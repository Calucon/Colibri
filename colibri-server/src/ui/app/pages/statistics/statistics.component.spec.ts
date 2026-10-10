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
            { id: 'abcdef123', app: 'demo', name: '127.0.0.1', version: '2', latency: [ [ 1, 4 ], [ 2, 6 ], [ 3, 8 ] ], slot: 1 },
            { id: 'uvwxyz456', app: 'demo', name: '127.0.0.1', version: '2', latency: [], slot: 0 },
            { id: 'q1', app: 'other', name: 'Quest', version: '', latency: [], slot: 2 },
            { id: 'lone12345', app: 'third', name: '10.0.0.5', version: '2', latency: [], slot: 3 }
        ]);
        const component = TestBed.createComponent(StatisticsComponent).componentInstance;

        const [ first, second, third ] = component.rows();
        // the colour of its slot, not of its place in the list
        expect(first).toEqual(expect.objectContaining({ color: clientColor(1), app: 'demo', version: 'v2', median: 6, stdev: 2 }));
        expect(second.color).toBe(clientColor(0));
        expect(second.median).toBeNull();
        // web clients, named by their address, are told apart by id
        expect(component.rows().map(row => row.idHint)).toEqual([ 'abcdef', 'uvwxyz', null, 'lone12' ]);
        expect(third.version).toBe('');
    });
});
