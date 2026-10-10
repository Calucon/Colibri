import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy, effect, inject, viewChild } from '@angular/core';
import { ClientService, ColibriClient } from '../../services';
import * as d3 from 'd3';
import { BoxplotStats, boxplot, boxplotStats, boxplotSymbolDot } from './boxplot';

const margin = { top: 12, right: 12, bottom: 28, left: 44 };
// we ping every 100ms and store the last 1000 values (and query every 1s = 1000ms)
const timeRange = 110 * 1000;
const barWidth = 24;
const boxplotPadding = 5;

// https://www.nordtheme.com/docs/colors-and-palettes
const colors = [
    '#88C0D0', // cyan
    '#A3BE8C', // green
    '#B48EAD', // purple
    '#EBCB8B', // yellow
    '#D08770', // orange
    '#81A1C1', // light blue
    '#BF616A', // red
    '#8FBCBB', // light cyan
    '#D8DEE9', // snow
    '#5E81AC', // blue
];

/** The colour of a client's slot (ColibriClient.slot), in the chart and its table. */
export const clientColor = function (slot: number): string {
    return colors[slot % colors.length];
};

const timeLabel = function (value: Date | d3.NumberValue): string {
    const date = value instanceof Date ? value : new Date(Number(value));
    return d3.timeFormat(date.getSeconds() === 0 ? '%H:%M' : ':%S')(date);
};

interface Line {
    client: ColibriClient;
    color: string;
}

@Component({
    selector: 'app-latency-chart',
    templateUrl: './latency-chart.component.html',
    styleUrls: ['./latency-chart.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class LatencyChartComponent implements AfterViewInit, OnDestroy {
    private clientService = inject(ClientService);
    private injector = inject(Injector);

    private latencyChart = viewChild.required<ElementRef<HTMLDivElement>>('latencyChart');
    clients = this.clientService.clients;

    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
    private lineChartSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private boxplotSvg: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisLeft: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
    private axisBottom: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;

    private width = 0;
    private height = 0;
    private resizeObserver: ResizeObserver | undefined;
    private intervalTimer: number | null = null;

    private lineX: d3.ScaleTime<number, number, never> = d3.scaleTime();

    ngAfterViewInit(): void {
        this.initChart();
        this.measure();
        this.updateChart();

        effect(() => {
            this.clients();
            this.updateChart();
        }, { injector: this.injector });

        this.intervalTimer = window.setInterval(() => {
            this.animateChart();
            this.updateChart();
        }, 1000);

        this.animateChart();

        // the size of its box, not of the window: the card changes width without a window resize
        this.resizeObserver = new ResizeObserver(() => {
            this.measure();
            this.animateChart();
            this.updateChart();
        });
        this.resizeObserver.observe(this.latencyChart().nativeElement);
    }

    ngOnDestroy(): void {
        if (this.intervalTimer !== null) {
            window.clearInterval(this.intervalTimer);
        }
        this.resizeObserver?.disconnect();
    }

    private initChart(): void {
        this.svg = d3.select(this.latencyChart().nativeElement).append('svg');

        this.boxplotSvg = this.svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

        this.lineChartSvg = this.svg
            .append('g')
            .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')')
            // extra container for smooth animations
            .append('g');

        this.axisBottom = this.svg.append('g').attr('class', 'axis');
        this.axisLeft = this.svg
            .append('g')
            .attr('class', 'axis')
            .attr('transform', `translate(${margin.left}, ${margin.top})`);
    }

    private measure(): void {
        const el = this.latencyChart().nativeElement;
        this.width = el.clientWidth;
        this.height = el.clientHeight;
        this.svg?.attr('width', this.width).attr('height', this.height);
        this.axisBottom?.attr('transform', `translate(${margin.left}, ${this.height - margin.bottom})`);
    }

    // The boxplots on the right take at most 40% of the plot, the line chart the rest.
    private layout(): { plotWidth: number; band: number } {
        const plotWidth = Math.max(0, this.width - margin.left - margin.right);
        const count = Math.max(1, this.clients().length);
        const band = Math.min(barWidth + boxplotPadding, (plotWidth * 0.4) / count);
        return { plotWidth, band };
    }

    private animateChart(): void {
        const { plotWidth, band } = this.layout();
        const now = Date.now();
        const boxplotWidth = this.clients().length * band;
        const linechartWidth = Math.max(0, plotWidth - boxplotWidth);

        if (this.boxplotSvg) {
            this.boxplotSvg
                .attr('transform', `translate(${margin.left + linechartWidth}, ${margin.top})`);
        }

        this.lineX = d3.scaleTime()
            .domain([ now - timeRange - 1000, now ])
            .range([0, linechartWidth]);

        if (this.lineChartSvg) {
            // animate until next (expected) update
            this.lineChartSvg
                .interrupt()
                .attr('transform', 'translate(0, 0)');

            this.lineChartSvg
                .transition()
                .ease(d3.easeLinear)
                .duration(1000)
                .attr('transform', `translate(${-this.lineX(now - timeRange)}, 0)`);
        }

        if (this.axisBottom) {
            this.axisBottom
                .transition()
                .duration(1000)
                .ease(d3.easeLinear)
                .call(d3.axisBottom(this.lineX)
                    .ticks(Math.max(2, Math.floor(linechartWidth / 80)))
                    .tickFormat(timeLabel));
        }
    }

    private updateChart(): void {
        if (this.width === 0 || this.height === 0) return;

        const clients = this.clients();
        const plotHeight = Math.max(0, this.height - margin.top - margin.bottom);
        const { band } = this.layout();
        const boxWidth = Math.max(4, band - boxplotPadding);

        // coloured by the client's slot, the same as in the table under the chart
        const lines: Line[] = clients
            .map(client => ({ client, color: clientColor(client.slot) }))
            .filter(line => line.client.latency.length > 0);

        const xScale = d3.scalePoint()
            .domain(clients.map(client => client.id))
            .range([0, clients.length * band])
            .padding(0.5);

        const maxLatency = d3.max(clients.flatMap(c => (c.latency || []).map(l => l[1]))) || 1;
        const yScale = d3.scaleLinear()
            .domain([Math.max(maxLatency, 10), 0])
            .range([0, plotHeight])
            .nice();

        if (this.boxplotSvg) {
            const boxplotData = lines.map(line => ({
                ...boxplotStats(line.client.latency.map(l => l[1])),
                id: line.client.id,
                color: line.color
            }));

            const draw = boxplot(true, yScale, boxWidth, boxWidth, false, boxplotSymbolDot, 0.5, 0.5);
            this.boxplotSvg
                .selectAll<SVGGElement, BoxplotStats & { id: string; color: string }>('g.plot')
                .data(boxplotData, d => d.id)
                .join('g')
                .attr('transform', d => `translate(${(xScale(d.id) || 0) - boxWidth / 2}, 0)`)
                .attr('color', d => d.color)
                .attr('class', 'plot')
                // one plot at a time: boxplot() adds its groups only where none of the selection has
                // them yet, so a client joining later got an empty plot
                .each(function () {
                    d3.select(this).call(draw);
                });
        }

        if (this.lineChartSvg) {
            const line = d3.line<[number, number]>()
                .x(d => this.lineX(d[0]))
                .y(d => yScale(d[1]));

            this.lineChartSvg
                .selectAll<SVGPathElement, Line>('path.line')
                .data(lines, d => d.client.id)
                .join('path')
                .attr('class', 'line')
                .attr('fill', 'none')
                .attr('stroke', d => d.color)
                .attr('stroke-width', 1.5)
                .attr('d', d => line(d.client.latency));
        }

        if (this.axisLeft) {
            this.axisLeft.call(d3.axisLeft(yScale).ticks(Math.max(2, Math.floor(plotHeight / 40))));
        }
    }
}
