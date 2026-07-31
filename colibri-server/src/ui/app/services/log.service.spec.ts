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

    beforeEach(() => {
        logChannel = new Subject();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: { listen: () => logChannel.asObservable(), emit: vi.fn() }
            }]
        });
    });

    it('hides broadcastTraffic messages by default', () => {
        const service = TestBed.inject(LogService);

        logChannel.next({ command: 'x', payload: message({ id: '1', metadata: { broadcastTraffic: true } }) });
        logChannel.next({ command: 'x', payload: message({ id: '2', metadata: {} }) });

        expect(service.visibleMessages().map(m => m.id)).toEqual(['2']);
    });

    it('shows broadcastTraffic messages once the toggle is on', () => {
        const service = TestBed.inject(LogService);
        service.showBroadcastTraffic.set(true);

        logChannel.next({ command: 'x', payload: message({ id: '1', metadata: { broadcastTraffic: true } }) });
        logChannel.next({ command: 'x', payload: message({ id: '2', metadata: {} }) });

        expect(service.visibleMessages().map(m => m.id)).toEqual(['1', '2']);
    });

    it('recomputes visibleMessages when the toggle changes after messages arrived', () => {
        const service = TestBed.inject(LogService);

        logChannel.next({ command: 'x', payload: message({ id: '1', metadata: { broadcastTraffic: true } }) });
        expect(service.visibleMessages().length).toBe(0);

        service.showBroadcastTraffic.set(true);
        expect(service.visibleMessages().length).toBe(1);

        service.showBroadcastTraffic.set(false);
        expect(service.visibleMessages().length).toBe(0);
    });

    it('updates an existing message in place and moves it to the end', () => {
        const service = TestBed.inject(LogService);

        logChannel.next({ command: 'x', payload: message({ id: '1', count: 0 }) });
        logChannel.next({ command: 'x', payload: message({ id: '2', count: 0 }) });
        logChannel.next({ command: 'x', payload: message({ id: '1', count: 1 }) });

        expect(service.visibleMessages().map(m => m.id)).toEqual(['2', '1']);
        expect(service.visibleMessages().find(m => m.id === '1')?.count).toBe(1);
    });

    it('evicts the oldest message once more than 10001 messages have arrived', () => {
        const service = TestBed.inject(LogService);

        for (let i = 0; i <= 10000; i++) {
            logChannel.next({ command: 'x', payload: message({ id: `${i}` }) });
        }
        expect(service.visibleMessages().length).toBe(10001);
        expect(service.visibleMessages().find(m => m.id === '0')).toBeDefined();

        logChannel.next({ command: 'x', payload: message({ id: '10001' }) });

        expect(service.visibleMessages().length).toBe(10001);
        expect(service.visibleMessages().find(m => m.id === '0')).toBeUndefined();
        expect(service.visibleMessages().find(m => m.id === '10001')).toBeDefined();
    });

    it('exposes the raw message list unfiltered by the broadcast-traffic toggle', () => {
        const service = TestBed.inject(LogService);

        logChannel.next({ command: 'x', payload: message({ id: '1', metadata: { broadcastTraffic: true } }) });
        logChannel.next({ command: 'x', payload: message({ id: '2', metadata: {} }) });

        expect(service.messages().map(m => m.id)).toEqual(['1', '2']);
    });
});
