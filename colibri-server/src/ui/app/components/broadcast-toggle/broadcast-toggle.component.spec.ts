import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BroadcastToggleComponent } from './broadcast-toggle.component';
import { LogService } from '../../services';

describe('BroadcastToggleComponent', () => {
    it('reads and writes LogService.showBroadcastTraffic', () => {
        const showBroadcastTraffic = signal(false);

        TestBed.configureTestingModule({
            providers: [{ provide: LogService, useValue: { showBroadcastTraffic } }]
        });

        const fixture = TestBed.createComponent(BroadcastToggleComponent);
        const component = fixture.componentInstance;

        expect(component.checked).toBe(false);

        component.checked = true;

        expect(showBroadcastTraffic()).toBe(true);
        expect(component.checked).toBe(true);
    });
});
