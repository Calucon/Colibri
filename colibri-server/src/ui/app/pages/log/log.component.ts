import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy, afterNextRender, afterRenderEffect, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { LogMessage, LogService, SocketIOService } from '../../services';
import { LogMessageComponent } from '../../components/log-message/log-message.component';
import { LogToolbarComponent } from '../../components/log-toolbar/log-toolbar.component';
import { OfflineBannerComponent } from '../../components/offline-banner/offline-banner.component';
import { matchesSearch } from '../../components/log-message/log-format';

/**
 * How many lines are on the page at first, and how many more each "Show older lines" adds: half
 * as many on a phone, upright or sideways. The rows have the height their text needs, so they
 * are not virtualized, and a page of 10,000 rows would take seconds to build on a phone.
 */
export const PAGE_SIZE = 1000;
const screenPageSize = (): number =>
    window.matchMedia?.('(max-width: 699.98px), (max-height: 499.98px)').matches ? PAGE_SIZE / 2 : PAGE_SIZE;

/** How close to the end, in px, still counts as at the end. */
const END_SLACK = 24;

/** Whether an event is on a line, or on "Show older lines" above them. */
const onLine = (event: Event): boolean =>
    event.target instanceof Element && event.target.closest('app-log-message, .older') !== null;

interface EmptyState {
    text: string;
    action?: { label: string; run: () => void };
}

@Component({
    selector: 'app-log',
    templateUrl: './log.component.html',
    styleUrls: ['./log.component.scss'],
    imports: [DatePipe, LogMessageComponent, LogToolbarComponent, OfflineBannerComponent],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogComponent implements AfterViewInit, OnDestroy {
    log = inject(LogService);
    private socketio = inject(SocketIOService);
    private injector = inject(Injector);

    private scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

    /** Whether the page scrolls to new lines as they arrive. */
    following = signal(true);

    // While paused, the page shows the lines it had then: new lines, repeats moving to the end and
    // the oldest lines making room would all shift what is being read.
    private frozen = signal<ReadonlyArray<LogMessage> | null>(null);
    private frozenIds = computed(() => new Set(this.frozen()?.map(line => line.id)));
    private readonly pageSize = screenPageSize();
    private limit = signal(this.pageSize);

    search = computed(() => this.log.search().toLowerCase());

    matches = computed(() => {
        const lines = this.frozen() ?? this.log.messages();
        const search = this.search();
        return search ? lines.filter(line => matchesSearch(line, search)) : lines;
    });

    rows = computed(() => {
        const matches = this.matches();
        const limit = this.limit();
        return matches.length > limit ? matches.slice(-limit) : matches;
    });

    hidden = computed(() => this.matches().length - this.rows().length);
    olderStep = computed(() => Math.min(this.pageSize, this.hidden()));

    /** How many lines arrived since the page was paused, not counting repeats of lines it shows. */
    newLines = computed(() => {
        if (!this.frozen()) return 0;
        const shown = this.frozenIds();
        let count = 0;
        for (const line of this.log.messages()) {
            if (!shown.has(line.id) && !line.reconnect) count++;
        }
        return count;
    });

    /** The rows that start a new day, which get the date above them. */
    dayStarts = computed(() => {
        const starts = new Set<string>();
        let previous = '';
        for (const row of this.rows()) {
            const day = new Date(row.created).toDateString();
            if (day !== previous) starts.add(row.id);
            previous = day;
        }
        return starts;
    });

    empty = computed<EmptyState | null>(() => {
        if (this.rows().length > 0) return null;
        if (this.socketio.state() === 'connecting') return { text: 'Connecting to the server…' };
        if (this.log.loading()) return { text: 'Loading the log…' };

        const clear = { label: 'Clear filters', run: () => this.log.clearFilters() };
        if (this.log.levels().size === 0) return { text: 'All levels are hidden.', action: clear };
        if (this.search()) return { text: `No lines match "${this.log.search()}".`, action: { label: 'Clear search', run: () => this.log.search.set('') } };
        if (this.log.filter()) return { text: `No lines from ${this.log.filter()} at these levels.`, action: clear };
        return { text: 'No log lines yet.' };
    });

    private lastTop = 0;
    private lastHeight = 0;
    private resizeObserver: ResizeObserver | undefined;

    constructor() {
        // After the first render: by then the address is this page's, not the one it came from.
        afterNextRender(() => this.log.openPage());

        afterRenderEffect(() => {
            this.rows();
            if (this.following()) this.scrollToEnd();
        });

        // The server sends a new history for new filters; the paused lines were filtered by the old.
        effect(() => {
            this.log.filter();
            this.log.levels();
            this.log.showBroadcastTraffic();
            this.log.showConnections();
            untracked(() => this.follow());
        });
    }

    ngAfterViewInit(): void {
        // a new height (a rotated phone, the filters opening) would leave the end out of view
        this.resizeObserver = new ResizeObserver(() => {
            if (this.following()) this.scrollToEnd();
        });
        this.resizeObserver.observe(this.scroller().nativeElement);

        // passive, so that the browser never waits for these before it scrolls
        const el = this.scroller().nativeElement;
        el.addEventListener('wheel', this.onWheel, { passive: true });
        el.addEventListener('touchstart', this.onTouchStart, { passive: true });
        el.addEventListener('touchmove', this.onTouchMove, { passive: true });
    }

    ngOnDestroy(): void {
        this.log.closePage();
        this.resizeObserver?.disconnect();
        const el = this.scroller().nativeElement;
        el.removeEventListener('wheel', this.onWheel);
        el.removeEventListener('touchstart', this.onTouchStart);
        el.removeEventListener('touchmove', this.onTouchMove);
    }

    pause(): void {
        if (!this.following()) return;
        this.frozen.set(this.log.messages());
        this.following.set(false);
    }

    follow(): void {
        this.frozen.set(null);
        this.limit.set(this.pageSize);
        this.following.set(true);
    }

    showOlder(): void {
        this.limit.update(limit => limit + this.pageSize);
    }

    // Any way of scrolling up pauses: wheel, touch, keys or the scroll bar. The height check tells
    // them from the list changing size under the scroll position. Back at the end, it follows again.
    onScroll(): void {
        const el = this.scroller().nativeElement;
        const sameContent = el.scrollHeight === this.lastHeight;
        const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= END_SLACK;

        if (sameContent && !atEnd && el.scrollTop < this.lastTop - 1) {
            this.pause();
        } else if (sameContent && atEnd && el.scrollTop > this.lastTop && !this.following()) {
            this.follow();
        }

        this.lastTop = el.scrollTop;
        this.lastHeight = el.scrollHeight;
    }

    // The wheel and a finger pause at once, before the first scroll event: under a busy stream, the
    // next batch of lines would otherwise scroll back to the end under the reader.
    private onWheel = (event: WheelEvent): void => {
        const el = this.scroller().nativeElement;
        if (event.deltaY < 0 && el.scrollHeight > el.clientHeight) this.pause();
    };

    private touchY = 0;

    private onTouchStart = (event: TouchEvent): void => {
        this.touchY = event.touches[0]?.clientY ?? 0;
    };

    // a finger moving down scrolls the log up
    private onTouchMove = (event: TouchEvent): void => {
        const el = this.scroller().nativeElement;
        const y = event.touches[0]?.clientY ?? 0;
        if (y > this.touchY + 8 && el.scrollHeight > el.clientHeight) this.pause();
    };

    // Pressing the mouse on a line is the start of reading, selecting or opening it.
    onPointerDown(event: PointerEvent): void {
        if (event.pointerType === 'mouse' && event.button === 0 && onLine(event)) this.pause();
    }

    // A tap opens a line, and the lines stay still while it is read. Not a button of the empty
    // state: "Clear search" left the log paused.
    onClick(event: MouseEvent): void {
        if (!onLine(event)) return;
        this.pause();

        // Once paused, the "Jump to latest" button covers the bottom of the log, where the newest
        // line, the one opened most, is. Its scroll-padding makes this move the line above it.
        const line = (event.target as Element).closest('app-log-message');
        if (line) afterNextRender(() => line.scrollIntoView({ block: 'nearest' }), { injector: this.injector });
    }

    private scrollToEnd(): void {
        const el = this.scroller().nativeElement;
        el.scrollTop = el.scrollHeight;
        this.lastTop = el.scrollTop;
        this.lastHeight = el.scrollHeight;
    }
}
