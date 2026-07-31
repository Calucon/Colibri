import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { BroadcastToggleComponent } from './broadcast-toggle.component';
import { LogService } from '../../services';

describe('BroadcastToggleComponent', () => {
    it('reads and writes LogService.showBroadcastTraffic$', () => {
        const showBroadcastTraffic$ = new BehaviorSubject(false);

        TestBed.configureTestingModule({
            providers: [{ provide: LogService, useValue: { showBroadcastTraffic$ } }]
        });

        const fixture = TestBed.createComponent(BroadcastToggleComponent);
        const component = fixture.componentInstance;

        expect(component.checked).toBe(false);

        component.checked = true;

        expect(showBroadcastTraffic$.value).toBe(true);
        expect(component.checked).toBe(true);
    });
});
