import { TestBed } from '@angular/core/testing';
import { Component, input, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Subject } from 'rxjs';
import { ClientRow, ClientService, ColibriClient, ConnectionState, Reconnect, SocketIOService } from '../../services';
import { LatencyChartComponent, clientColor } from '../../components/latency-chart/latency-chart.component';
import { ClientsComponent, parseSort, sortClients } from './clients.component';

const client = (overrides: Partial<ClientRow>): ClientRow => ({
    id: 'id',
    app: 'demo',
    name: 'Quest',
    transport: 'tcp',
    version: '2',
    tls: false,
    address: '10.0.0.5',
    connectedAt: 0,
    latency: null,
    in: null,
    out: null,
    limit: null,
    held: 0,
    ...overrides
});

// The chart has tests of its own; its d3 transitions do not belong in these.
@Component({ selector: 'app-latency-chart', template: '' })
class LatencyChartStub {
    app = input('');
}

describe('ClientsComponent', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;
    let clients: ReturnType<typeof signal<ReadonlyArray<ColibriClient>>>;

    const snapshot = (rows: ClientRow[], extra: object = {}) => {
        const request = emit.mock.calls.filter(call => call[1] === 'subscribe').at(-1)![2].request;
        channel.next({ command: 'clients', payload: { request, at: 125_000, clients: rows, total: rows.length, adminPages: 1, ...extra } });
    };

    const open = async (url: string) => {
        const harness = await RouterTestingHarness.create();
        const component = await harness.navigateByUrl(url, ClientsComponent);
        TestBed.flushEffects();
        return { harness, component, root: harness.routeNativeElement! };
    };

    beforeEach(() => {
        channel = new Subject();
        emit = vi.fn();
        clients = signal<ReadonlyArray<ColibriClient>>([]);

        TestBed.configureTestingModule({
            providers: [
                provideRouter([ { path: 'clients', component: ClientsComponent } ]),
                {
                    provide: SocketIOService,
                    useValue: {
                        listen: () => channel.asObservable(),
                        emit,
                        reconnected$: new Subject<Reconnect>().asObservable(),
                        state: signal<ConnectionState>('connected'),
                        lostAt: signal<number | null>(null)
                    }
                },
                { provide: ClientService, useValue: { clients } }
            ]
        });
        TestBed.overrideComponent(ClientsComponent, { remove: { imports: [ LatencyChartComponent ] }, add: { imports: [ LatencyChartStub ] } });
    });

    it('subscribes to the clients while open, and stops when it closes', async () => {
        const { harness } = await open('/clients');
        expect(emit).toHaveBeenCalledWith('colibri::admin', 'subscribe', { topic: 'clients', request: expect.any(Number) });

        harness.fixture.destroy();
        expect(emit).toHaveBeenLastCalledWith('colibri::admin', 'unsubscribe', { topic: 'clients' });
    });

    it('lists each client with its transport, address, chart colour and load limit', async () => {
        clients.set([ { id: 'web1', app: 'demo', name: '127.0.0.1', version: '2', latency: [], slot: 3 } ]);
        const { harness, component } = await open('/clients');
        snapshot([
            client({ id: 'q1', connectedAt: 5_000, latency: 12.34, in: 30, out: 120.5, limit: 'rate', held: 4, tls: true }),
            client({ id: 'web1', transport: 'web', name: '127.0.0.1', address: '127.0.0.1', connectedAt: 65_000 })
        ]);
        harness.detectChanges();

        const quest = component.rows().find(row => row.id === 'q1');
        const web = component.rows().find(row => row.id === 'web1');
        expect(quest).toEqual(expect.objectContaining({
            label: 'Quest', byId: false, address: '10.0.0.5', transport: 'TCP', tls: true, connected: '2 min',
            latency: '12.3 ms', in: '30.0', out: '120.5', limit: 'Rate limit', held: 4, color: null
        }));
        // a web client by the start of its id, in its colour in the latency chart
        expect(web).toEqual(expect.objectContaining({ label: 'web1', byId: true, transport: 'Web', connected: '1 min', in: '-', color: clientColor(3) }));
        expect(component.summary()).toBe('2 connected: 1 TCP, 1 web');
        expect(harness.routeNativeElement!.querySelector('tr[data-id="q1"] td.c-limit')?.textContent).toContain('4 held');
    });

    it('shows the app in the address only, and links each client to its log', async () => {
        const { harness, component, root } = await open('/clients?app=demo');
        snapshot([ client({ id: 'a', app: 'demo' }), client({ id: 'b', app: 'other' }) ]);
        harness.detectChanges();

        expect(component.rows().map(row => row.id)).toEqual([ 'a' ]);
        expect(component.summary()).toBe('1 of 2 connected: 1 TCP, 0 web');
        expect(component.appOptions()).toEqual([ { name: 'demo', clients: 1 }, { name: 'other', clients: 1 } ]);
        expect(root.querySelector('td.c-log a')?.getAttribute('href')).toBe('/log?q=a#demo');
    });

    it('sorts by a column from the address, the rows without a value last', async () => {
        const { harness, component } = await open('/clients?sort=-latency');
        snapshot([ client({ id: 'a', latency: 5 }), client({ id: 'b', latency: null }), client({ id: 'c', latency: 9 }) ]);
        harness.detectChanges();
        expect(component.rows().map(row => row.id)).toEqual([ 'c', 'a', 'b' ]);

        await component.sortBy('latency');
        expect(component.rows().map(row => row.id)).toEqual([ 'a', 'c', 'b' ]);
    });

    it('says why the list is empty', async () => {
        const { component } = await open('/clients?app=gone');
        expect(component.empty()).toBe('Loading the clients…');
        snapshot([]);
        expect(component.empty()).toBe('No clients of gone connected.');
    });
});

describe('sortClients', () => {
    it('sorts by app and name by default, and a column either way', () => {
        const rows = [
            client({ id: '1', app: 'b', name: 'x', in: 3 }),
            client({ id: '2', app: 'a', name: 'y', in: null }),
            client({ id: '3', app: 'a', name: 'x', in: 7 })
        ];
        expect(sortClients(rows, null).map(r => r.id)).toEqual([ '3', '2', '1' ]);
        expect(sortClients(rows, { key: 'in', descending: true }).map(r => r.id)).toEqual([ '3', '1', '2' ]);
        expect(sortClients(rows, { key: 'in', descending: false }).map(r => r.id)).toEqual([ '1', '3', '2' ]);
        // the longest connected first
        expect(sortClients([ client({ id: 'new', connectedAt: 9 }), client({ id: 'old', connectedAt: 1 }) ], { key: 'connected', descending: true })
            .map(r => r.id)).toEqual([ 'old', 'new' ]);
    });

    it('reads a sort from the address, and nothing it does not know', () => {
        expect(parseSort('-latency')).toEqual({ key: 'latency', descending: true });
        expect(parseSort('name')).toEqual({ key: 'name', descending: false });
        expect(parseSort('password')).toBeNull();
        expect(parseSort(null)).toBeNull();
    });
});
