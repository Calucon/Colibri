import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LogMessage } from '../../services';
import { DatePipe } from '@angular/common';

@Component({
    selector: 'app-log-message',
    templateUrl: './log-message.component.html',
    styleUrls: ['./log-message.component.scss'],
    imports: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogMessageComponent {
    public log = input.required<LogMessage>();
    public isNewDay = input(false);
}
