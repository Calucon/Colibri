import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LOG_LEVELS, LogService } from '../../services';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SelectButtonChangeEvent, SelectButtonModule } from 'primeng/selectbutton';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'app-log-filters',
    templateUrl: './log-filters.component.html',
    styleUrls: ['./log-filters.component.scss'],
    imports: [ToggleSwitchModule, SelectButtonModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogFiltersComponent {
    private log = inject(LogService);

    levelOptions = [ ...LOG_LEVELS ];

    // computed(), not a getter: a getter returns a new array every template
    // check, and SelectButton's ngModel binding spins into an infinite
    // change-detection loop when the bound value is never reference-stable.
    selectedLevels = computed(() => [ ...this.log.levels() ]);

    onLevelsChanged(e: SelectButtonChangeEvent): void {
        this.log.setLevels(e.value ?? []);
    }

    get showBroadcastTraffic(): boolean {
        return this.log.showBroadcastTraffic();
    }

    set showBroadcastTraffic(value: boolean) {
        this.log.showBroadcastTraffic.set(value);
    }
}
