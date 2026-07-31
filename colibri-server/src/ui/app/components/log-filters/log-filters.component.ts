import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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

    get selectedLevels(): number[] {
        return [ ...this.log.levels() ];
    }

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
