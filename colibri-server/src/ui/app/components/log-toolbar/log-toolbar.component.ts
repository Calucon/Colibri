import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ClientService, LOG_LEVELS, LogService } from '../../services';
import { LEVEL_TAGS } from '../log-message/log-format';

/** How long typing pauses before the search runs, in ms. */
export const SEARCH_DELAY = 150;

interface AppOption {
    name: string;
    /** How many of its clients are connected. */
    clients: number;
}

interface ActiveFilter {
    label: string;
    clear: () => void;
}

@Component({
    selector: 'app-log-toolbar',
    templateUrl: './log-toolbar.component.html',
    styleUrls: ['./log-toolbar.component.scss'],
    imports: [FormsModule, SelectModule, ToggleSwitchModule],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogToolbarComponent implements OnDestroy {
    log = inject(LogService);
    private clients = inject(ClientService);

    /** Whether the log scrolls to new lines. */
    following = input(true);
    followChange = output<boolean>();
    /** How many lines match the search, or null without one. */
    matches = input<number | null>(null);

    levelOptions = LOG_LEVELS;
    tags = LEVEL_TAGS;

    /** Whether the filters are shown on a phone, where they are folded away. */
    open = signal(false);

    private searchInput = viewChild.required<ElementRef<HTMLInputElement>>('searchInput');
    private searchTimer: ReturnType<typeof setTimeout> | undefined;

    allLevels = computed(() => this.log.levels().size === LOG_LEVELS.length);

    // Every app seen in the log since the page loaded and every app with a client connected, so
    // that the list does not shrink to the one app being shown.
    appOptions = computed<AppOption[]>(() => {
        const counts = new Map<string, number>();
        for (const app of this.log.apps()) counts.set(app, 0);
        for (const client of this.clients.clients()) {
            if (client.app !== 'colibri') counts.set(client.app, (counts.get(client.app) ?? 0) + 1);
        }
        const filter = this.log.filter();
        if (filter && !counts.has(filter)) counts.set(filter, 0);

        return [ ...counts ]
            .map(([ name, clients ]) => ({ name, clients }))
            .sort((a, b) => a.name.localeCompare(b.name));
    });

    /** The filters folded away on a phone that are not at their defaults. */
    activeFilters = computed<ActiveFilter[]>(() => {
        const active: ActiveFilter[] = [];
        const app = this.log.filter();
        if (app) active.push({ label: `App: ${app}`, clear: () => this.log.filter.set('') });
        const search = this.log.search();
        if (search) active.push({ label: `Search: ${search}`, clear: () => this.log.search.set('') });
        if (this.log.showBroadcastTraffic()) active.push({ label: 'Sync traffic', clear: () => this.log.showBroadcastTraffic.set(false) });
        return active;
    });

    /** 1234 as 1.2k: a chip keeps its width as the log grows. */
    shortCount(count: number): string {
        if (count < 1000) return `${count}`;
        if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
        return `${Math.round(count / 1000)}k`;
    }

    isOn(level: number): boolean {
        return this.log.levels().has(level);
    }

    toggleLevel(level: number): void {
        const levels = new Set(this.log.levels());
        if (levels.has(level)) levels.delete(level);
        else levels.add(level);
        this.log.setLevels([ ...levels ].sort());
    }

    onSearch(value: string): void {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.log.search.set(value.trim()), SEARCH_DELAY);
    }

    clearSearch(input: HTMLInputElement): void {
        clearTimeout(this.searchTimer);
        input.value = '';
        this.log.search.set('');
        input.blur();
    }

    // '/' moves to the search, as in many developer tools, unless something else takes text
    @HostListener('document:keydown', [ '$event' ])
    onKey(event: KeyboardEvent): void {
        if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

        event.preventDefault();
        this.open.set(true);
        this.searchInput().nativeElement.focus();
    }

    ngOnDestroy(): void {
        clearTimeout(this.searchTimer);
    }
}
