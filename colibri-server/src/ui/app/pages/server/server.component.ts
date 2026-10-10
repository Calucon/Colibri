import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AdminService, ServerSnapshot, SettingValue } from '../../services';
import { LiveStatusComponent } from '../../components/live-status/live-status.component';
import { OfflineBannerComponent } from '../../components/offline-banner/offline-banner.component';
import { count, duration } from '../../format';

export interface Fact {
    label: string;
    value: string;
    /** The variable that sets it. */
    variable?: string;
    /** More about the value, after it. */
    note?: string;
    tone?: 'ok' | 'warn' | 'err' | 'off';
    mono?: boolean;
    /** A page that shows more of it. */
    link?: string;
}

export interface Section {
    id: string;
    title: string;
    facts: Fact[];
}

/** A certificate this close to its end gets a warning, in days. */
const EXPIRY_WARNING_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

// The settings each section shows; the rest are listed under Other settings.
const SHOWN = new Set([
    'WEBSERVER_HOST', 'WEBSERVER_PORT', 'BASE_URL', 'TCP_HOST', 'TCP_PORT', 'VOICE_HOST', 'VOICE_PORT',
    'VOICE_SAMPLING_RATE', 'VOICE_RECORDING', 'TCP_IDLE_TIMEOUT_SECONDS', 'TCP_INBOUND_BACKLOG_LIMIT',
    'CLIENT_MESSAGE_RATE_LIMIT', 'CLIENT_MESSAGE_RATE_BURST', 'APP_CLIENT_WARNING_THRESHOLD',
    'MODEL_TOMBSTONE_SECONDS', 'TRUSTED_PROXIES', 'TCP_PROXY_PROTOCOL'
]);

const text = function (value: SettingValue | undefined): string {
    if (value === undefined) return '-';
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    return `${value}`;
};

const number = function (value: SettingValue | undefined): number | null {
    return typeof value === 'number' ? value : null;
};

const plural = function (n: number, one: string, many: string): string {
    return `${count(n)} ${n === 1 ? one : many}`;
};

/** A limit that 0 turns off. */
const limit = function (label: string, variable: string, value: SettingValue | undefined, format: (n: number) => string): Fact {
    const n = number(value);
    return n === 0
        ? { label, variable, value: 'Off', tone: 'off' }
        : { label, variable, value: n === null ? text(value) : format(n) };
};

const onOff = function (label: string, on: boolean, variable?: string, note?: string): Fact {
    return { label, variable, value: on ? 'On' : 'Off', tone: on ? 'ok' : 'off', note };
};

export const serverSections = function (s: ServerSnapshot, format: (time: number) => string): Section[] {
    const set = s.settings;
    const tls = s.tls;
    const scheme = tls ? 'HTTPS and WSS' : 'HTTP and WS';
    const proxies = Array.isArray(set['TRUSTED_PROXIES']) ? set['TRUSTED_PROXIES'] : [];

    const sections: Section[] = [
        {
            id: 'server', title: 'Server', facts: [
                { label: 'Version', value: s.version, mono: true },
                { label: 'Protocol version', value: s.protocolVersion, mono: true },
                { label: 'Node.js', value: s.node, mono: true },
                { label: 'Started', value: format(s.startedAt) },
                { label: 'Uptime', value: duration(s.uptime) }
            ]
        },
        {
            id: 'counts', title: 'Clients and data', facts: [
                { label: 'Unity clients', value: count(s.counts.tcpClients), note: 'TCP', link: '/clients' },
                { label: 'Web clients', value: count(s.counts.webClients), note: 'Socket.IO', link: '/clients' },
                { label: 'Apps', value: count(s.counts.apps), note: 'with clients connected' },
                { label: 'Admin pages', value: count(s.counts.adminPages), note: 'open, this one included' },
                {
                    label: 'Synced models', value: count(s.counts.models), link: '/models',
                    note: `in ${plural(s.counts.modelChannels, 'channel', 'channels')} of ${plural(s.counts.modelApps, 'app', 'apps')}`
                },
                {
                    label: 'Recently deleted models', value: count(s.counts.deletedModels),
                    note: `kept for ${text(set['MODEL_TOMBSTONE_SECONDS'])} s`, link: '/models'
                },
                { label: 'REST store', value: plural(s.counts.storeKeys, 'value', 'values'), note: `in ${plural(s.counts.storeApps, 'app', 'apps')}` }
            ]
        },
        {
            id: 'network', title: 'Network', facts: [
                { label: 'Web', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', value: `${text(set['WEBSERVER_HOST'])}:${text(set['WEBSERVER_PORT'])}`, mono: true, note: scheme },
                { label: 'TCP', variable: 'TCP_HOST, TCP_PORT', value: `${text(set['TCP_HOST'])}:${text(set['TCP_PORT'])}`, mono: true, note: tls ? 'TLS' : 'unencrypted' },
                { label: 'Voice', variable: 'VOICE_HOST, VOICE_PORT', value: `${text(set['VOICE_HOST'])}:${text(set['VOICE_PORT'])}`, mono: true, note: 'UDP' },
                { label: 'Base URL', variable: 'BASE_URL', value: text(set['BASE_URL']) || '/', mono: true },
                onOff('TLS', tls !== null, 'TLS_CERT, TLS_KEY'),
                {
                    label: 'Trusted proxies', variable: 'TRUSTED_PROXIES', value: proxies.length > 0 ? proxies.join(', ') : 'None',
                    mono: proxies.length > 0, tone: proxies.length > 0 ? undefined : 'off'
                },
                onOff('PROXY protocol on TCP', set['TCP_PROXY_PROTOCOL'] === true, 'TCP_PROXY_PROTOCOL')
            ]
        }
    ];

    if (tls) {
        const days = Math.floor((tls.validTo - s.at) / DAY);
        const expiry: Fact = { label: 'Valid until', value: format(tls.validTo) };
        if (tls.validTo <= s.at) Object.assign(expiry, { tone: 'err', note: 'expired' });
        else if (days < EXPIRY_WARNING_DAYS) Object.assign(expiry, { tone: 'warn', note: days === 0 ? 'expires today' : `expires in ${plural(days, 'day', 'days')}` });
        else expiry.note = `in ${plural(days, 'day', 'days')}`;

        sections.push({
            id: 'certificate', title: 'TLS certificate', facts: [
                { label: 'Names', value: tls.names, mono: true },
                { label: 'Issuer', value: tls.issuer, note: tls.selfSigned ? 'self-signed' : undefined },
                { label: 'Valid from', value: format(tls.validFrom), tone: tls.validFrom > s.at ? 'err' : undefined, note: tls.validFrom > s.at ? 'not yet valid' : undefined },
                expiry,
                { label: 'SHA-256 fingerprint', value: tls.fingerprint256, mono: true }
            ]
        });
    }

    const rate = number(set['CLIENT_MESSAGE_RATE_LIMIT']);
    sections.push({
        id: 'limits', title: 'Load limits', facts: [
            limit('Messages per client', 'CLIENT_MESSAGE_RATE_LIMIT', set['CLIENT_MESSAGE_RATE_LIMIT'], n => `${count(n)} a second`),
            rate === 0
                ? { label: 'Burst', variable: 'CLIENT_MESSAGE_RATE_BURST', value: 'Off', tone: 'off' }
                : limit('Burst', 'CLIENT_MESSAGE_RATE_BURST', set['CLIENT_MESSAGE_RATE_BURST'], n => `${count(n)} messages`),
            limit('TCP inbound backlog', 'TCP_INBOUND_BACKLOG_LIMIT', set['TCP_INBOUND_BACKLOG_LIMIT'], n => `${count(n)} messages`),
            limit('TCP idle timeout', 'TCP_IDLE_TIMEOUT_SECONDS', set['TCP_IDLE_TIMEOUT_SECONDS'], n => `${count(n)} s`),
            limit('App client warning', 'APP_CLIENT_WARNING_THRESHOLD', set['APP_CLIENT_WARNING_THRESHOLD'], n => `above ${plural(n, 'client', 'clients')}`),
            limit('Deleted models kept', 'MODEL_TOMBSTONE_SECONDS', set['MODEL_TOMBSTONE_SECONDS'], n => `${count(n)} s`)
        ]
    });

    const voice = s.voice;
    sections.push({
        id: 'voice', title: 'Voice', facts: [
            onOff('Voice server', voice?.listening === true, undefined, voice?.listening ? undefined : 'not listening'),
            onOff('Recording', voice ? voice.recording : set['VOICE_RECORDING'] === true, 'VOICE_RECORDING'),
            { label: 'Sampling rate', variable: 'VOICE_SAMPLING_RATE', value: `${count(voice?.samplingRate ?? number(set['VOICE_SAMPLING_RATE']) ?? 0)} Hz` },
            { label: 'Voice clients', value: count(voice?.clients ?? 0) }
        ]
    });

    const other = Object.keys(set).filter(name => !SHOWN.has(name)).sort();
    if (other.length > 0) {
        sections.push({
            id: 'other', title: 'Other settings',
            facts: other.map(name => ({ label: name, value: text(set[name]), mono: true }))
        });
    }
    return sections;
};

@Component({
    selector: 'app-server',
    templateUrl: './server.component.html',
    styleUrl: './server.component.scss',
    imports: [RouterLink, LiveStatusComponent, OfflineBannerComponent],
    providers: [DatePipe],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ServerComponent {
    private admin = inject(AdminService);
    private datePipe = inject(DatePipe);

    feed = this.admin.feed<ServerSnapshot>('server');

    sections = computed(() => {
        const snapshot = this.feed.data();
        return snapshot ? serverSections(snapshot, time => this.datePipe.transform(time, 'yyyy-MM-dd HH:mm:ss') ?? '') : [];
    });
}
