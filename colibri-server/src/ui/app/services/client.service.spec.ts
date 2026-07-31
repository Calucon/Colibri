import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ClientService, ColibriClient } from './client.service';
import { SocketIOService } from './socketio.service';

describe('ClientService', () => {
    let latencyChannel: Subject<{ command: string; payload: Record<string, [number, number][]> }>;
    let clientsChannel: Subject<{ command: string; payload: Partial<ColibriClient> }>;

    beforeEach(() => {
        latencyChannel = new Subject();
        clientsChannel = new Subject();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: {
                    listen: (channel: string) =>
                        (channel === 'colibri::latency' ? latencyChannel : clientsChannel).asObservable(),
                    emit: vi.fn()
                }
            }]
        });
    });

    it('adds a client on client::connected', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });

        expect(service.clients().map(c => c.id)).toEqual(['a']);
        expect(service.clients()[0].latency).toEqual([]);
    });

    it('removes a client on client::disconnected', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });
        clientsChannel.next({ command: 'client::connected', payload: { id: 'b', app: 'colibri', name: 'B', version: '1' } });
        clientsChannel.next({ command: 'client::disconnected', payload: { id: 'a' } });

        expect(service.clients().map(c => c.id)).toEqual(['b']);
    });

    it('appends latency samples for a known client', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });
        latencyChannel.next({ command: 'x', payload: { a: [[1000, 5], [1001, 6]] } });
        latencyChannel.next({ command: 'x', payload: { a: [[1002, 7]] } });

        expect(service.clients()[0].latency).toEqual([[1000, 5], [1001, 6], [1002, 7]]);
    });

    it('caps latency history at the last 1000 samples', () => {
        const service = TestBed.inject(ClientService);

        clientsChannel.next({ command: 'client::connected', payload: { id: 'a', app: 'colibri', name: 'A', version: '1' } });

        const samples: [number, number][] = Array.from({ length: 1200 }, (_, i) => [i, i]);
        latencyChannel.next({ command: 'x', payload: { a: samples } });

        expect(service.clients()[0].latency.length).toBe(1000);
        expect(service.clients()[0].latency[0]).toEqual([200, 200]);
        expect(service.clients()[0].latency[999]).toEqual([1199, 1199]);
    });

    it('ignores latency samples for unknown clients', () => {
        const service = TestBed.inject(ClientService);

        latencyChannel.next({ command: 'x', payload: { unknown: [[1000, 5]] } });

        expect(service.clients()).toEqual([]);
    });
});
