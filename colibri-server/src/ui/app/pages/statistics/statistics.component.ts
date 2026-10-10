import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import * as d3 from 'd3';
import { ClientService } from '../../services';
import { LatencyChartComponent, clientColor } from '../../components/latency-chart/latency-chart.component';
import { appColor, isAddress, shortId } from '../../components/log-message/log-format';

interface ClientRow {
    id: string;
    color: string;
    app: string;
    appColor: string;
    name: string;
    /** The start of the id, for a web client and for clients of one app that have the same name. */
    idHint: string | null;
    version: string;
    median: number | null;
    stdev: number | null;
}

@Component({
    selector: 'app-statistics',
    imports: [LatencyChartComponent, DecimalPipe],
    templateUrl: './statistics.component.html',
    styleUrl: './statistics.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class StatisticsComponent {
    private clientService = inject(ClientService);

    rows = computed<ClientRow[]>(() => {
        const clients = this.clientService.clients();
        const names = new Map<string, number>();
        for (const client of clients) {
            const key = `${client.app}\n${client.name}`;
            names.set(key, (names.get(key) ?? 0) + 1);
        }

        return clients.map(client => {
            const latency = (client.latency || []).map(sample => sample[1]);
            return {
                id: client.id,
                color: clientColor(client.slot),
                app: client.app,
                appColor: appColor(client.app),
                name: client.name,
                idHint: isAddress(client.name) || (names.get(`${client.app}\n${client.name}`) ?? 0) > 1 ? shortId(client.id) : null,
                version: client.version ? `v${client.version}` : '',
                median: d3.median(latency) ?? null,
                stdev: d3.deviation(latency) ?? null
            };
        });
    });
}
