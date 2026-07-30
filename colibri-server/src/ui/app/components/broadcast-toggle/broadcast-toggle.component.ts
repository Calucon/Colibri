import { Component, inject } from '@angular/core';
import { LogService } from '../../services';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'app-broadcast-toggle',
    standalone: true,
    templateUrl: './broadcast-toggle.component.html',
    styleUrls: ['./broadcast-toggle.component.scss'],
    imports: [ToggleSwitchModule, FormsModule]
})
export class BroadcastToggleComponent {
    private log = inject(LogService);

    get checked(): boolean {
        return this.log.showBroadcastTraffic$.value;
    }

    set checked(value: boolean) {
        this.log.showBroadcastTraffic$.next(value);
    }
}
