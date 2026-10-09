import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ConnectionState, LogMessage, LogService, Reconnect, SocketIOService } from '../../services';
import { FLUSH_INTERVAL } from '../../services/log.service';
import { LogComponent, PAGE_SIZE } from './log.component';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'test',
    level: 2,
    message: 'm',
    group: 'g',
    created: 1000,
    first: 1000,
    count: 0,
    metadata: {},
    ...overrides
});

describe('LogComponent', () => {
    let channels: Map<string, Subject<{ command: string; payload: unknown }>>;
    let emit: ReturnType<typeof vi.fn>;
    let state: ReturnType<typeof signal<ConnectionState>>;
    let lostAt: ReturnType<typeof signal<number | null>>;

    const channel = (name: string) => {
        if (!channels.has(name)) channels.set(name, new Subject());
        return channels.get(name)!;
    };
    const history = (messages: LogMessage[]) => {
        const request = emit.mock.calls.filter(call => call[1] === 'requestLog').at(-1)![2].request;
        channel('colibri::log').next({ command: 'history', payload: { request, messages } });
    };
    const live = (overrides: Partial<LogMessage>) => {
        channel('colibri::log').next({ command: 'message', payload: message(overrides) });
        vi.advanceTimersByTime(FLUSH_INTERVAL);
    };

    const create = () => {
        const fixture = TestBed.createComponent(LogComponent);
        fixture.detectChanges();
        TestBed.flushEffects();
        return { fixture, component: fixture.componentInstance, log: TestBed.inject(LogService) };
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('ResizeObserver', class {
            observe(): void { /* not needed here */ }
            disconnect(): void { /* not needed here */ }
        });
        channels = new Map();
        emit = vi.fn();
        state = signal<ConnectionState>('connected');
        lostAt = signal<number | null>(null);

        TestBed.configureTestingModule({
            providers: [{
                provide: SocketIOService,
                useValue: {
                    listen: (name: string) => channel(name).asObservable(),
                    emit,
                    reconnected$: new Subject<Reconnect>().asObservable(),
                    state,
                    lostAt
                }
            }]
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('shows the newest page of lines, and older ones on request', () => {
        const { fixture, component } = create();
        history(Array.from({ length: PAGE_SIZE + 5 }, (_, i) => message({ id: `${i}` })));
        fixture.detectChanges();

        expect(component.rows().length).toBe(PAGE_SIZE);
        expect(component.rows()[0].id).toBe('5');
        expect(fixture.nativeElement.querySelector('.older').textContent).toContain('Show 5 older lines');

        component.showOlder();
        expect(component.rows().length).toBe(PAGE_SIZE + 5);
    });

    it('shows only the lines that match the search', () => {
        const { component, log } = create();
        history([ message({ id: 'a', message: 'Scene loaded' }), message({ id: 'b', message: 'Asset missing' }) ]);

        log.search.set('ASSET');

        expect(component.rows().map(r => r.id)).toEqual([ 'b' ]);
        expect(component.matches().length).toBe(1);
    });

    // new lines, repeats moving to the end and old lines making room would move what is read
    it('keeps the lines still while paused, counts the new ones, and catches up on follow', () => {
        const { component } = create();
        history([ message({ id: 'a' }), message({ id: 'b' }) ]);

        component.pause();
        live({ id: 'c' });
        live({ id: 'a', count: 1, created: 2000 });

        expect(component.rows().map(r => r.id)).toEqual([ 'a', 'b' ]);
        expect(component.newLines()).toBe(2);

        component.follow();
        expect(component.rows().map(r => r.id)).toEqual([ 'b', 'c', 'a' ]);
        expect(component.newLines()).toBe(0);
    });

    it('follows again when the filters change, since the server sends a new history', () => {
        const { component, log } = create();
        history([ message({ id: 'a' }) ]);
        component.pause();

        log.setLevels([ 0 ]);
        TestBed.flushEffects();

        expect(component.following()).toBe(true);
    });

    it('says why the log is empty, with a way out', () => {
        const { fixture, component, log } = create();
        history([]);
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('.empty').textContent).toContain('No log lines yet.');

        log.setLevels([]);
        TestBed.flushEffects();
        history([]);
        expect(component.empty()?.text).toBe('All levels are hidden.');

        log.setLevels([ 0, 1, 2, 3 ]);
        log.filter.set('no-such-app');
        TestBed.flushEffects();
        history([]);
        expect(component.empty()?.text).toBe('No lines from no-such-app at these levels.');
        component.empty()?.action?.run();
        expect(log.filter()).toBe('');
    });
});
