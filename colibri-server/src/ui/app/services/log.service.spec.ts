import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { LogMessage, LogService } from './log.service';
import { SocketIOService } from './socketio.service';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'test',
    level: 0,
    message: 'm',
    group: 'g',
    created: Date.now(),
    count: 0,
    metadata: {},
    ...overrides
});

describe('LogService', () => {
    let logChannel: Subject<{ command: string; payload: LogMessage }>;
    let emit: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        logChannel = new Subject();
        emit = vi.fn();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: { listen: () => logChannel.asObservable(), emit }
            }]
        });
    });

    it('requests the log with the default filter/levels/broadcast payload on construction', () => {
        TestBed.inject(LogService);
        TestBed.flushEffects();

        expect(emit).toHaveBeenCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0, 1, 2, 3 ],
            showBroadcastTraffic: false
        });
    });

    it('re-requests the log and clears messages when levels change', () => {
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();

        logChannel.next({ command: 'x', payload: message({ id: '1' }) });
        expect(service.messages().length).toBe(1);

        service.setLevels([ 0 ]);
        TestBed.flushEffects();

        expect(service.messages().length).toBe(0);
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0 ],
            showBroadcastTraffic: false
        });
    });

    it('re-requests the log and clears messages when showBroadcastTraffic changes', () => {
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();

        logChannel.next({ command: 'x', payload: message({ id: '1' }) });
        expect(service.messages().length).toBe(1);

        service.showBroadcastTraffic.set(true);
        TestBed.flushEffects();

        expect(service.messages().length).toBe(0);
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0, 1, 2, 3 ],
            showBroadcastTraffic: true
        });
    });

    it('updates an existing message in place and moves it to the end', () => {
        const service = TestBed.inject(LogService);

        logChannel.next({ command: 'x', payload: message({ id: '1', count: 0 }) });
        logChannel.next({ command: 'x', payload: message({ id: '2', count: 0 }) });
        logChannel.next({ command: 'x', payload: message({ id: '1', count: 1 }) });

        expect(service.messages().map(m => m.id)).toEqual(['2', '1']);
        expect(service.messages().find(m => m.id === '1')?.count).toBe(1);
    });

    it('evicts the oldest message once more than 10001 messages have arrived', () => {
        const service = TestBed.inject(LogService);

        for (let i = 0; i <= 10000; i++) {
            logChannel.next({ command: 'x', payload: message({ id: `${i}` }) });
        }
        expect(service.messages().length).toBe(10001);
        expect(service.messages().find(m => m.id === '0')).toBeDefined();

        logChannel.next({ command: 'x', payload: message({ id: '10001' }) });

        expect(service.messages().length).toBe(10001);
        expect(service.messages().find(m => m.id === '0')).toBeUndefined();
        expect(service.messages().find(m => m.id === '10001')).toBeDefined();
    });
});
