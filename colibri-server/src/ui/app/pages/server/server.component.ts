import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AdminService, BuildInfo, ServerSnapshot, SettingValue } from '../../services';
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
    /** Shown on hover. */
    title?: string;
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
    'MODEL_TOMBSTONE_SECONDS', 'TRUSTED_PROXIES', 'TCP_PROXY_PROTOCOL', 'TCP_TLS_AT_PROXY'
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

// As the server's log names it: unique in the repository, and git takes it wherever it takes a hash.
const SHORT_COMMIT_LENGTH = 10;

/** The commit it was built from, for a build with its own changes; the full hash and the build time on hover. */
const commit = function (build: BuildInfo, format: (time: number) => string): Fact {
    const built = build.builtAt === null ? [] : [ `Built ${format(build.builtAt)}` ];
    if (build.commit === null) {
        return {
            label: 'Commit', value: 'unknown', tone: 'off',
            title: [ 'Built without git information, e.g. a Docker build without COLIBRI_COMMIT', ...built ].join('\n')
        };
    }
    return {
        label: 'Commit', value: build.commit.slice(0, SHORT_COMMIT_LENGTH), mono: true,
        note: build.dirty ? 'uncommitted changes' : undefined,
        title: [ build.commit, ...built ].join('\n')
    };
};

const onOff = function (label: string, on: boolean, variable?: string, note?: string): Fact {
    return { label, variable, value: on ? 'On' : 'Off', tone: on ? 'ok' : 'off', note };
};

/** Why the web port counts as HTTPS at a proxy, on hover. */
const WEB_TLS_AT_PROXY = 'A trusted proxy reported HTTPS in X-Forwarded-Proto for a web client or admin page connected now';
/** Why the TCP port counts as TLS at a proxy, on hover. */
const TCP_TLS_AT_PROXY = 'TCP_TLS_AT_PROXY says the trusted proxy ends TLS for the Unity clients that come through it '
    + '(TCP_PROXY_PROTOCOL). Its PROXY protocol header does not say';
/** What an unset TCP_TLS_AT_PROXY means, on hover. */
const TCP_TLS_NOT_DECLARED = 'Whether the proxy in front of the TCP port ends TLS is not declared, which does not mean it does not. '
    + 'Set TCP_TLS_AT_PROXY=true if it does';
/** Why the TCP port is only unencrypted here, on hover. */
const TCP_THROUGH_PROXY = 'Unity clients come through a trusted proxy (TCP_PROXY_PROTOCOL), which may end TLS without saying so '
    + 'in its PROXY protocol header. If the proxy\'s TCP port uses TLS, set TCP_TLS_AT_PROXY=true to show it here, '
    + 'and tick "Server supports SSL/TLS?" in the Unity apps';

export const serverSections = function (s: ServerSnapshot, format: (time: number) => string): Section[] {
    const set = s.settings;
    const tls = s.tls;
    const proxies = Array.isArray(set['TRUSTED_PROXIES']) ? set['TRUSTED_PROXIES'] : [];

    // TLS that ends at a reverse proxy in front of this server. The server then sees only the
    // proxy's plain connections, so the rule goes by what the proxy reported for the web clients and
    // admin pages connected now, this page included: HTTPS at the proxy if any of them came through
    // a TRUSTED_PROXIES address whose X-Forwarded-Proto said https (tlsAtProxy.web). With the
    // server's own TLS on, that is what a direct connection uses, and the rows say so instead.
    const webTlsAtProxy = tls === null && s.tlsAtProxy.web;
    const scheme = tls ? 'HTTPS and WSS' : webTlsAtProxy ? 'HTTP here, HTTPS at the proxy' : 'HTTP and WS';
    // Unity clients through a proxy: its PROXY protocol header does not say whether it ended TLS, so
    // the operator does, with TCP_TLS_AT_PROXY (tlsAtProxy.tcp). Without that, the TCP row says only
    // that the connection here is unencrypted, not that the clients use no TLS.
    const tcpTlsAtProxy = tls === null && s.tlsAtProxy.tcp;
    const tcpThroughProxy = tls === null && set['TCP_PROXY_PROTOCOL'] === true && proxies.length > 0;
    const tcpNote = tls ? 'TLS'
        : tcpTlsAtProxy ? 'unencrypted here, TLS at the proxy'
        : tcpThroughProxy ? 'unencrypted here, proxy TLS not reported'
        : 'unencrypted';
    const tcpTitle = tcpTlsAtProxy ? TCP_TLS_AT_PROXY : tcpThroughProxy ? TCP_THROUGH_PROXY : undefined;
    // Not a bare Off, which reads as "turn TLS off in the clients".
    const atProxy = [
        ...(webTlsAtProxy ? [ { what: 'HTTPS', why: WEB_TLS_AT_PROXY } ] : []),
        ...(tcpTlsAtProxy ? [ { what: 'TCP TLS', why: TCP_TLS_AT_PROXY } ] : [])
    ];
    const tlsFact: Fact = atProxy.length > 0
        ? {
            label: 'TLS', variable: 'TLS_CERT, TLS_KEY', value: 'Not on this server',
            note: `${atProxy.map(end => end.what).join(' and ')} at the proxy`, title: atProxy.map(end => end.why).join('\n')
        }
        : onOff('TLS', tls !== null, 'TLS_CERT, TLS_KEY');
    // Unset, it is not a bare Off either, which reads as "the proxy's TCP port has no TLS": the
    // server just does not know. Set without TCP_PROXY_PROTOCOL, it does nothing, as the server
    // warns at startup.
    const tcpTlsAtProxyLabel = 'TLS at the TCP proxy';
    const tcpTlsAtProxyFact: Fact = set['TCP_TLS_AT_PROXY'] !== true
        ? {
            label: tcpTlsAtProxyLabel, variable: 'TCP_TLS_AT_PROXY', value: 'Not declared', tone: 'off',
            note: set['TCP_PROXY_PROTOCOL'] === true ? 'proxy TLS not reported' : undefined, title: TCP_TLS_NOT_DECLARED
        }
        : s.tlsAtProxy.tcp
            ? onOff(tcpTlsAtProxyLabel, true, 'TCP_TLS_AT_PROXY')
            : {
                label: tcpTlsAtProxyLabel, variable: 'TCP_TLS_AT_PROXY', value: 'On', tone: 'warn', note: 'needs TCP_PROXY_PROTOCOL',
                title: 'No effect: without TCP_PROXY_PROTOCOL, the server cannot tell which Unity clients come through the proxy'
            };

    const sections: Section[] = [
        {
            id: 'server', title: 'Server', facts: [
                { label: 'Version', value: s.version, mono: true },
                commit(s.build, format),
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
                {
                    label: 'Web', variable: 'WEBSERVER_HOST, WEBSERVER_PORT', value: `${text(set['WEBSERVER_HOST'])}:${text(set['WEBSERVER_PORT'])}`, mono: true,
                    note: scheme, title: webTlsAtProxy ? WEB_TLS_AT_PROXY : undefined
                },
                {
                    label: 'TCP', variable: 'TCP_HOST, TCP_PORT', value: `${text(set['TCP_HOST'])}:${text(set['TCP_PORT'])}`, mono: true,
                    note: tcpNote, title: tcpTitle
                },
                { label: 'Voice', variable: 'VOICE_HOST, VOICE_PORT', value: `${text(set['VOICE_HOST'])}:${text(set['VOICE_PORT'])}`, mono: true, note: 'UDP' },
                { label: 'Base URL', variable: 'BASE_URL', value: text(set['BASE_URL']) || '/', mono: true },
                tlsFact,
                {
                    label: 'Trusted proxies', variable: 'TRUSTED_PROXIES', value: proxies.length > 0 ? proxies.join(', ') : 'None',
                    mono: proxies.length > 0, tone: proxies.length > 0 ? undefined : 'off'
                },
                onOff('PROXY protocol on TCP', set['TCP_PROXY_PROTOCOL'] === true, 'TCP_PROXY_PROTOCOL'),
                tcpTlsAtProxyFact
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
