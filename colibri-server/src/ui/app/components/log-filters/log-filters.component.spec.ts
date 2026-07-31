import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LogFiltersComponent } from './log-filters.component';
import { LogService } from '../../services';

describe('LogFiltersComponent', () => {
    it('reads and writes LogService.showBroadcastTraffic', () => {
        const showBroadcastTraffic = signal(false);
        const levels = signal(new Set([ 0, 1, 2, 3 ]));
        const setLevels = (values: ReadonlyArray<number>) => levels.set(new Set(values));

        TestBed.configureTestingModule({
            providers: [{ provide: LogService, useValue: { showBroadcastTraffic, levels, setLevels } }]
        });

        const fixture = TestBed.createComponent(LogFiltersComponent);
        const component = fixture.componentInstance;

        expect(component.showBroadcastTraffic).toBe(false);

        component.showBroadcastTraffic = true;

        expect(showBroadcastTraffic()).toBe(true);
        expect(component.showBroadcastTraffic).toBe(true);
    });

    it('reads and writes LogService.levels', () => {
        const showBroadcastTraffic = signal(false);
        const levels = signal(new Set([ 0, 1, 2, 3 ]));
        const setLevels = (values: ReadonlyArray<number>) => levels.set(new Set(values));

        TestBed.configureTestingModule({
            providers: [{ provide: LogService, useValue: { showBroadcastTraffic, levels, setLevels } }]
        });

        const fixture = TestBed.createComponent(LogFiltersComponent);
        const component = fixture.componentInstance;

        expect(component.selectedLevels()).toEqual([ 0, 1, 2, 3 ]);

        component.onLevelsChanged({ value: [ 0 ] });

        expect(levels()).toEqual(new Set([ 0 ]));
        expect(component.selectedLevels()).toEqual([ 0 ]);
    });
});
