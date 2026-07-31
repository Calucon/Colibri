import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { FilterBarComponent } from '../../components/filter-bar/filter-bar.component';
import { LogFiltersComponent } from '../../components/log-filters/log-filters.component';


@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    imports: [RouterModule, FilterBarComponent, LogFiltersComponent],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class RootComponent {
    private router = inject(Router);

    tabs = [
        { label: 'Log', path: '/log' },
        { label: 'Statistics', path: '/statistics' },
    ];

    private currentPath = toSignal(
        this.router.events.pipe(
            filter((event): event is NavigationEnd => event instanceof NavigationEnd),
            map(event => event.urlAfterRedirects)
        ),
        { initialValue: this.router.url }
    );

    indicatorPosition = computed(() => {
        const index = Math.max(this.tabs.findIndex(tab => tab.path === this.currentPath()), 0);
        return `${index * 120}px`;
    });
}
