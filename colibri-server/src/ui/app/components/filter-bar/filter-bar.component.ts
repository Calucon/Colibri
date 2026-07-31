import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LogService } from '../../services';
import { SelectChangeEvent, SelectModule } from 'primeng/select';
import { FormsModule } from '@angular/forms';

interface ListElement {
    name: string;
}

@Component({
    selector: 'app-filter-bar',
    templateUrl: './filter-bar.component.html',
    styleUrls: ['./filter-bar.component.scss'],
    imports: [SelectModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class FilterBarComponent {
    private log = inject(LogService);

    appNames = computed<ListElement[]>(() => {
        const seen = new Set<string>();
        for (const m of this.log.messages()) {
            const app = m.metadata?.['clientApp'] as string | undefined;
            if (app) {
                seen.add(app);
            }
        }
        return [...seen].map(name => ({ name }));
    });

    selected = computed(() => this.appNames().find(a => a.name === this.log.filter()));

    onFilterChanged(e: SelectChangeEvent): void {
        this.log.filter.set(e.value);
    }
}
