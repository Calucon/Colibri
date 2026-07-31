import { AfterViewChecked, AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { LogMessage, LogService } from '../../services';

import { LogMessageComponent } from '../../components/log-message/log-message.component';
import { CdkVirtualScrollableElement, CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { ButtonModule } from 'primeng/button';

@Component({
    selector: 'app-log',
    templateUrl: './log.component.html',
    styleUrls: ['./log.component.scss'],
    imports: [CdkVirtualScrollableElement, CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf, LogMessageComponent, ButtonModule],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogComponent implements AfterViewInit, AfterViewChecked {
    log = inject(LogService);

    private scrollContainer = viewChild.required<ElementRef>('scrollContainer');
    manualScroll = signal(false);

    ngAfterViewInit() {
        this.scrollContainer().nativeElement.addEventListener('wheel', (ev: WheelEvent) => this.onScroll(ev.deltaY), { passive: true });
    }

    ngAfterViewChecked(): void {
        this.scrollToBottom();
    }

    private scrollToBottom(): void {
        if (!this.manualScroll()) {
            try {
                const el = this.scrollContainer().nativeElement;
                el.scrollTop = el.scrollHeight;
            } catch (err) {
                console.error(err);
            }
        }
    }

    getId(index: number, entry: LogMessage): string {
        return entry.id;
    }

    onScroll(deltaY: number): void {
        const el = this.scrollContainer().nativeElement;
        if (deltaY < 0) {
            this.manualScroll.set(true);
        } else if (el.scrollTop + el.offsetHeight >= el.scrollHeight) {
            this.manualScroll.set(false);
        }
    }

    scrollAutomatically(): void {
        this.manualScroll.set(false);
        this.scrollToBottom();
    }

    isNewDay(index: number): boolean {
        if (index === 0)
            return true;

        const messages = this.log.visibleMessages();
        const currentDay = new Date(messages[index].created);
        const previousDay = new Date(messages[index - 1].created);
        return currentDay.getDate() !== previousDay.getDate();
    }
}
