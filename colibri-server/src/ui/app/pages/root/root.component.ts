import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterModule } from '@angular/router';

@Component({
    selector: 'app-root',
    templateUrl: './root.component.html',
    styleUrls: ['./root.component.scss'],
    imports: [RouterModule],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class RootComponent {
    tabs = [
        { label: 'Log', path: '/log' },
        { label: 'Statistics', path: '/statistics' },
    ];
}
