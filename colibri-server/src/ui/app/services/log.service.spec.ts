import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { FLUSH_INTERVAL, LogMessage, LogService, MAX_MESSAGES } from './log.service';
import { Reconnect, SocketIOService } from './socketio.service';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'test',
    level: 0,
    message: 'm',
    group: 'g',
    created: 1000,
    first: 1000,
    count: 0,
    metadata: {},
    ...overrides
});

describe('LogService', () => {
    let logChannel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;
    let reconnected: Subject<Reconnect>;

    const live = (overrides: Partial<LogMessage>) => logChannel.next({ command: 'message', payload: message(overrides) });
    const history = (request: number | null, messages: LogMessage[]) => logChannel.next({ command: 'history', payload: { request, messages } });
    const lastRequest = (): number => emit.mock.lastCall![2].request;

    const start = (): LogService => {
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();
        history(lastRequest(), []);
        return service;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        logChannel = new Subject();
        emit = vi.fn();
        reconnected = new Subject();

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: { listen: () => logChannel.asObservable(), emit, reconnected$: reconnected.asObservable() }
            }]
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('requests the log with the default filter/levels/broadcast payload on construction', () => {
        TestBed.inject(LogService);
        TestBed.flushEffects();

        expect(emit).toHaveBeenCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0, 1, 2, 3 ],
            showBroadcastTraffic: false,
            request: 1
        });
    });

    it('loads the history it asked for, in the order sent', () => {
        const service = TestBed.inject(LogService);
        TestBed.flushEffects();
        expect(service.loading()).toBe(true);

        history(1, [ message({ id: 'a' }), message({ id: 'b' }) ]);

        expect(service.loading()).toBe(false);
        expect(service.messages().map(m => m.id)).toEqual([ 'a', 'b' ]);
    });

    it('re-requests the log and clears messages when levels change', () => {
        const service = start();

        live({ id: '1' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages().length).toBe(1);

        service.setLevels([ 0 ]);
        TestBed.flushEffects();

        expect(service.messages().length).toBe(0);
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0 ],
            showBroadcastTraffic: false,
            request: 2
        });
    });

    it('re-requests the log and clears messages when showBroadcastTraffic changes', () => {
        const service = start();

        live({ id: '1' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages().length).toBe(1);

        service.showBroadcastTraffic.set(true);
        TestBed.flushEffects();

        expect(service.messages().length).toBe(0);
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', {
            filter: '',
            levels: [ 0, 1, 2, 3 ],
            showBroadcastTraffic: true,
            request: 2
        });
    });

    // Lines sent before the server saw the new request were filtered by the old preferences,
    // and an older request's history can still be on its way.
    it('ignores live lines and older histories until the history it asked for arrives', () => {
        const service = start();

        service.setLevels([ 0 ]);
        TestBed.flushEffects();
        service.setLevels([ 0, 1 ]);
        TestBed.flushEffects();

        live({ id: 'old-live', level: 3 });
        history(2, [ message({ id: 'old-history', level: 3 }) ]);
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages()).toEqual([]);
        expect(service.loading()).toBe(true);

        history(3, [ message({ id: 'current' }) ]);
        live({ id: 'after' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ 'current', 'after' ]);
    });

    it('shows live lines in batches', () => {
        const service = start();

        live({ id: '1' });
        live({ id: '2' });
        expect(service.messages()).toEqual([]);

        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ '1', '2' ]);
        expect(service.appended()).toBe(2);
    });

    it('updates an existing message and moves it to the end', () => {
        const service = start();

        live({ id: '1', count: 0 });
        live({ id: '2', count: 0 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        const before = service.messages().find(m => m.id === '1');

        live({ id: '1', count: 1, created: 2000 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ '2', '1' ]);
        expect(service.messages().find(m => m.id === '1')?.count).toBe(1);
        // Must be a new object, not the same one mutated in place: LogMessageComponent is OnPush
        // with a signal input, so a same-reference update would never re-render the row's
        // count/timestamp - it would only appear to jump position in the list.
        expect(service.messages().find(m => m.id === '1')).not.toBe(before);
    });

    it('leaves a line in place when it is sent again unchanged', () => {
        const service = start();

        live({ id: '1' });
        live({ id: '2' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        live({ id: '1' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().map(m => m.id)).toEqual([ '1', '2' ]);
        expect(service.appended()).toBe(2);
    });

    it('keeps the newest MAX_MESSAGES lines', () => {
        const service = start();

        for (let i = 0; i < MAX_MESSAGES; i++) {
            live({ id: `${i}` });
        }
        vi.advanceTimersByTime(FLUSH_INTERVAL);
        expect(service.messages().length).toBe(MAX_MESSAGES);
        expect(service.messages()[0].id).toBe('0');

        live({ id: 'new' });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        expect(service.messages().length).toBe(MAX_MESSAGES);
        expect(service.messages()[0].id).toBe('1');
        expect(service.messages().at(-1)?.id).toBe('new');
    });

    it('keeps its lines after a reconnect, marks the gap and adds the history after it', () => {
        const service = start();

        live({ id: 'before' });
        live({ id: 'repeated', count: 0 });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        reconnected.next({ lostAt: 5000, at: 9000 });
        expect(emit).toHaveBeenLastCalledWith('colibri::log', 'requestLog', expect.objectContaining({ request: 2 }));

        history(2, [
            message({ id: 'before' }),
            message({ id: 'meanwhile', created: 6000 }),
            message({ id: 'repeated', count: 1, created: 7000 })
        ]);

        const rows = service.messages();
        expect(rows.map(m => m.id)).toEqual([ 'before', 'reconnect-9000', 'meanwhile', 'repeated' ]);
        expect(rows[1]).toEqual(expect.objectContaining({ reconnect: true, first: 5000, created: 9000 }));
        expect(rows[3].count).toBe(1);
    });

    it('remembers every app it has seen, across filter changes', () => {
        const service = start();

        live({ id: '1', metadata: { clientApp: 'a' } });
        live({ id: '2', metadata: { clientApp: 'b' } });
        vi.advanceTimersByTime(FLUSH_INTERVAL);

        service.filter.set('a');
        TestBed.flushEffects();

        expect([ ...service.apps() ]).toEqual([ 'a', 'b' ]);
    });
});
