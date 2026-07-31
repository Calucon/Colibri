import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LogService } from '../../services';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'app-broadcast-toggle',
    templateUrl: './broadcast-toggle.component.html',
    styleUrls: ['./broadcast-toggle.component.scss'],
    imports: [ToggleSwitchModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class BroadcastToggleComponent {
    private log = inject(LogService);

    get checked(): boolean {
        return this.log.showBroadcastTraffic();
    }

    set checked(value: boolean) {
        this.log.showBroadcastTraffic.set(value);
    }
}
