import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ConnectionState, Reconnect, ServerSnapshot, SocketIOService } from '../../services';
import { Fact, ServerComponent, serverSections } from './server.component';

const DAY = 24 * 60 * 60 * 1000;

const snapshot = (overrides: Partial<ServerSnapshot> = {}): ServerSnapshot => ({
    request: 1,
    at: 100 * DAY,
    version: '2.0.0',
    build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: false, builtAt: 99 * DAY },
    protocolVersion: '2',
    node: 'v24.21.0',
    startedAt: 100 * DAY - 3_725_000,
    uptime: 3725,
    settings: {
        WEBSERVER_HOST: '0.0.0.0', WEBSERVER_PORT: 9011, BASE_URL: '', TCP_HOST: '0.0.0.0', TCP_PORT: 9012,
        VOICE_HOST: '0.0.0.0', VOICE_PORT: 9013, VOICE_SAMPLING_RATE: 48000, VOICE_RECORDING: false,
        TCP_IDLE_TIMEOUT_SECONDS: 10, TCP_INBOUND_BACKLOG_LIMIT: 2000, CLIENT_MESSAGE_RATE_LIMIT: 1000,
        CLIENT_MESSAGE_RATE_BURST: 2000, APP_CLIENT_WARNING_THRESHOLD: 8, MODEL_TOMBSTONE_SECONDS: 600,
        TRUSTED_PROXIES: [], TCP_PROXY_PROTOCOL: false
    },
    tls: null,
    tlsAtProxy: { web: false, tcp: false },
    voice: { listening: true, recording: false, samplingRate: 48000, clients: 0 },
    counts: {
        tcpClients: 3, webClients: 2, adminPages: 1, apps: 2, models: 1234, modelApps: 2, modelChannels: 3,
        deletedModels: 4, storeApps: 1, storeKeys: 7
    },
    ...overrides
});

const fact = (s: ServerSnapshot, section: string, label: string): Fact | undefined =>
    serverSections(s, time => new Date(time).toISOString()).find(x => x.id === section)?.facts.find(f => f.label === label);

describe('serverSections', () => {
    it('shows the versions, the uptime and the counts', () => {
        const s = snapshot();
        expect(fact(s, 'server', 'Uptime')?.value).toBe('1 h 2 min');
        expect(fact(s, 'counts', 'Synced models')).toEqual(expect.objectContaining({ value: '1,234', note: 'in 3 channels of 2 apps', link: '/models' }));
        expect(fact(s, 'counts', 'REST store')).toEqual(expect.objectContaining({ value: '7 values', note: 'in 1 app' }));
    });

    it('shows the commit after the version, short, with the full hash and the build time on hover', () => {
        const s = snapshot();
        expect(serverSections(s, String).find(x => x.id === 'server')?.facts.map(f => f.label).slice(0, 2)).toEqual([ 'Version', 'Commit' ]);
        expect(fact(s, 'server', 'Commit')).toEqual({
            label: 'Commit', value: '3e2855e0c1', mono: true, note: undefined,
            title: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6\nBuilt 1970-04-10T00:00:00.000Z'
        });
    });

    it('says when the build had uncommitted changes, or no git information', () => {
        expect(fact(snapshot({ build: { commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: null } }), 'server', 'Commit'))
            .toEqual(expect.objectContaining({ value: '3e2855e0c1', note: 'uncommitted changes', title: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6' }));

        const unknown = fact(snapshot({ build: { commit: null, dirty: false, builtAt: null } }), 'server', 'Commit');
        expect(unknown).toEqual(expect.objectContaining({ value: 'unknown', tone: 'off' }));
        expect(unknown?.mono).toBeUndefined();
        expect(unknown?.title).toBe('Built without git information, e.g. a Docker build without COLIBRI_COMMIT');
    });

    it('says which limits are off, and which variable sets each', () => {
        const s = snapshot();
        s.settings = { ...s.settings, CLIENT_MESSAGE_RATE_LIMIT: 0, TCP_IDLE_TIMEOUT_SECONDS: 0 };

        expect(fact(s, 'limits', 'Messages per client')).toEqual(expect.objectContaining({ value: 'Off', variable: 'CLIENT_MESSAGE_RATE_LIMIT' }));
        expect(fact(s, 'limits', 'Burst')?.value).toBe('Off');
        expect(fact(s, 'limits', 'TCP idle timeout')?.value).toBe('Off');
        expect(fact(s, 'limits', 'TCP inbound backlog')?.value).toBe('2,000 messages');
        expect(fact(s, 'network', 'Trusted proxies')?.value).toBe('None');
        expect(fact(s, 'network', 'TLS')?.value).toBe('Off');
    });

    it('describes the certificate, never more, and warns before it expires', () => {
        const tls = { names: 'colibri.example.org', issuer: 'Example CA', selfSigned: false, validFrom: 0, validTo: 110 * DAY, fingerprint256: 'AB:CD' };
        const s = snapshot({ tls });

        expect(serverSections(s, String).find(x => x.id === 'certificate')?.facts.map(f => f.label))
            .toEqual([ 'Names', 'Issuer', 'Valid from', 'Valid until', 'SHA-256 fingerprint' ]);
        expect(fact(s, 'certificate', 'Valid until')).toEqual(expect.objectContaining({ tone: 'warn', note: 'expires in 10 days' }));
        expect(fact(snapshot({ tls: { ...tls, validTo: 99 * DAY } }), 'certificate', 'Valid until')).toEqual(expect.objectContaining({ tone: 'err', note: 'expired' }));
        expect(fact(snapshot({ tls: { ...tls, validTo: 200 * DAY } }), 'certificate', 'Valid until')?.tone).toBeUndefined();
        expect(fact(s, 'network', 'Web')?.note).toBe('HTTPS and WSS');
    });

    describe('TLS on this server and at a proxy', () => {
        const certificate = { names: 'colibri.example.org', issuer: 'Example CA', selfSigned: false, validFrom: 0, validTo: 200 * DAY, fingerprint256: 'AB:CD' };
        const rows = (s: ServerSnapshot) => ({
            web: fact(s, 'network', 'Web')?.note,
            tcp: fact(s, 'network', 'TCP')?.note,
            tls: [ fact(s, 'network', 'TLS')?.value, fact(s, 'network', 'TLS')?.note, fact(s, 'network', 'TLS')?.tone ]
        });

        it.each([
            [ 'no TLS', null, false, { web: 'HTTP and WS', tcp: 'unencrypted', tls: [ 'Off', undefined, 'off' ] } ],
            [ 'TLS on this server', certificate, false, { web: 'HTTPS and WSS', tcp: 'TLS', tls: [ 'On', undefined, 'ok' ] } ],
            [ 'web TLS at the proxy', null, true, { web: 'HTTP here, HTTPS at the proxy', tcp: 'unencrypted', tls: [ 'Not on this server', 'HTTPS at the proxy', undefined ] } ],
            // a direct connection uses the server's own
            [ 'both', certificate, true, { web: 'HTTPS and WSS', tcp: 'TLS', tls: [ 'On', undefined, 'ok' ] } ]
        ])('with %s, says so in the Web, TCP and TLS rows', (_case, tls, web, expected) => {
            expect(rows(snapshot({ tls, tlsAtProxy: { web, tcp: false } }))).toEqual(expected);
        });

        it('says on hover why HTTPS is at the proxy, and only then', () => {
            const proxied = snapshot({ tlsAtProxy: { web: true, tcp: false } });
            expect(fact(proxied, 'network', 'Web')?.title).toContain('X-Forwarded-Proto');
            expect(fact(proxied, 'network', 'TLS')?.title).toBe(fact(proxied, 'network', 'Web')?.title);
            expect(fact(proxied, 'network', 'TLS')?.variable).toBe('TLS_CERT, TLS_KEY');

            expect(fact(snapshot(), 'network', 'Web')?.title).toBeUndefined();
            expect(fact(snapshot({ tls: certificate, tlsAtProxy: { web: true, tcp: false } }), 'network', 'Web')?.title).toBeUndefined();
        });

        it('with Unity clients through a proxy, says the TCP port is unencrypted only here', () => {
            const throughProxy = (tls: ServerSnapshot['tls'], web: boolean) => snapshot({
                tls, tlsAtProxy: { web, tcp: false }, settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true }
            });

            expect(rows(throughProxy(null, true))).toEqual({
                web: 'HTTP here, HTTPS at the proxy',
                tcp: 'unencrypted here, proxy TLS not reported',
                tls: [ 'Not on this server', 'HTTPS at the proxy', undefined ]
            });
            expect(rows(throughProxy(null, false)).tcp).toBe('unencrypted here, proxy TLS not reported');
            expect(fact(throughProxy(null, false), 'network', 'TCP')?.title).toContain('Server supports SSL/TLS?');
            // how to show it here
            expect(fact(throughProxy(null, false), 'network', 'TCP')?.title).toContain('set TCP_TLS_AT_PROXY=true');
            // a direct connection uses the server's own
            expect(rows(throughProxy(certificate, false)).tcp).toBe('TLS');
            expect(fact(throughProxy(certificate, false), 'network', 'TCP')?.title).toBeUndefined();
            expect(fact(snapshot(), 'network', 'TCP')?.title).toBeUndefined();
        });

        describe('with TCP_TLS_AT_PROXY', () => {
            const declared = (tls: ServerSnapshot['tls'], web: boolean) => snapshot({
                tls, tlsAtProxy: { web, tcp: true },
                settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true, TCP_TLS_AT_PROXY: true }
            });

            it.each([
                [ 'TCP only', false, { web: 'HTTP and WS', tcp: 'unencrypted here, TLS at the proxy', tls: [ 'Not on this server', 'TCP TLS at the proxy', undefined ] } ],
                [ 'web too', true, { web: 'HTTP here, HTTPS at the proxy', tcp: 'unencrypted here, TLS at the proxy', tls: [ 'Not on this server', 'HTTPS and TCP TLS at the proxy', undefined ] } ]
            ])('says TLS is at the proxy in the TCP and TLS rows, %s', (_case, web, expected) => {
                expect(rows(declared(null, web))).toEqual(expected);
            });

            it('names the setting on hover, next to the web rule', () => {
                expect(fact(declared(null, false), 'network', 'TCP')?.title).toContain('TCP_TLS_AT_PROXY says the trusted proxy ends TLS');
                expect(fact(declared(null, false), 'network', 'TLS')?.title).toBe(fact(declared(null, false), 'network', 'TCP')?.title);
                const both = fact(declared(null, true), 'network', 'TLS')?.title?.split('\n');
                expect(both).toEqual([ fact(declared(null, true), 'network', 'Web')?.title, fact(declared(null, true), 'network', 'TCP')?.title ]);
            });

            // a direct connection uses the server's own
            it('shows the server\'s own TLS instead when it has a certificate', () => {
                expect(rows(declared(certificate, false))).toEqual({ web: 'HTTPS and WSS', tcp: 'TLS', tls: [ 'On', undefined, 'ok' ] });
                expect(fact(declared(certificate, false), 'network', 'TCP')?.title).toBeUndefined();
            });
        });

        it('shows TCP_TLS_AT_PROXY next to TCP_PROXY_PROTOCOL, and when it has no effect', () => {
            const setting = (on: boolean, applies: boolean) => fact(snapshot({
                tlsAtProxy: { web: false, tcp: applies }, settings: { ...snapshot().settings, TCP_TLS_AT_PROXY: on }
            }), 'network', 'TLS at the TCP proxy');
            const labels = serverSections(snapshot(), String).find(x => x.id === 'network')?.facts.map(f => f.label);

            expect(labels?.slice(-2)).toEqual([ 'PROXY protocol on TCP', 'TLS at the TCP proxy' ]);
            expect(setting(true, true)).toEqual(expect.objectContaining({ value: 'On', tone: 'ok', variable: 'TCP_TLS_AT_PROXY', note: undefined }));
            expect(setting(true, false)).toEqual(expect.objectContaining({ value: 'On', tone: 'warn', note: 'needs TCP_PROXY_PROTOCOL' }));
            // and not again under Other settings
            expect(serverSections(snapshot({ settings: { ...snapshot().settings, TCP_TLS_AT_PROXY: true } }), String).some(x => x.id === 'other')).toBe(false);
        });

        // Not Off, which reads as "the proxy's TCP port has no TLS", so untick it in the Unity apps.
        it('shows TCP_TLS_AT_PROXY unset as not declared, saying what that means on hover', () => {
            const unset = (proxyProtocol: boolean) => fact(snapshot({
                settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: proxyProtocol, TCP_TLS_AT_PROXY: false }
            }), 'network', 'TLS at the TCP proxy');

            expect(unset(false)).toEqual(expect.objectContaining({ value: 'Not declared', tone: 'off', variable: 'TCP_TLS_AT_PROXY', note: undefined }));
            expect(unset(true)).toEqual(expect.objectContaining({ value: 'Not declared', tone: 'off', note: 'proxy TLS not reported' }));
            expect(unset(true)?.title).toContain('Set TCP_TLS_AT_PROXY=true if it does');
            // a server from before the setting
            expect(fact(snapshot(), 'network', 'TLS at the TCP proxy')?.value).toBe('Not declared');
        });
    });

    it('lists settings it does not know under Other settings', () => {
        const s = snapshot();
        s.settings = { ...s.settings, NEW_SETTING: 'x' };
        expect(fact(s, 'other', 'NEW_SETTING')?.value).toBe('x');
        expect(serverSections(snapshot(), String).some(x => x.id === 'other')).toBe(false);
    });
});

describe('ServerComponent', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        channel = new Subject();
        emit = vi.fn();
        TestBed.configureTestingModule({
            providers: [
                provideRouter([]),
                {
                    provide: SocketIOService,
                    useValue: {
                        listen: () => channel.asObservable(),
                        emit,
                        reconnected$: new Subject<Reconnect>().asObservable(),
                        state: signal<ConnectionState>('connected'),
                        lostAt: signal<number | null>(null)
                    }
                }
            ]
        });
    });

    const row = (overrides: Partial<ServerSnapshot>, label: string) => {
        const fixture = TestBed.createComponent(ServerComponent);
        fixture.detectChanges();
        const request = emit.mock.calls.filter(call => call[1] === 'subscribe').at(-1)![2].request;
        channel.next({ command: 'server', payload: snapshot({ request, ...overrides }) });
        fixture.detectChanges();
        const shownFact = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.fact')).find(f => f.querySelector('dt')?.textContent === label)!;
        return {
            value: shownFact.querySelector('.value')!, note: shownFact.querySelector('.note')?.textContent ?? null,
            variable: shownFact.querySelector('code')?.textContent ?? null
        };
    };

    const shown = (build: ServerSnapshot['build']) => row({ build }, 'Commit');

    it('shows the commit in mono with the full hash on hover, and a note for uncommitted changes', () => {
        const { value, note } = shown({ commit: '3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6', dirty: true, builtAt: null });
        expect(value.textContent?.trim()).toBe('3e2855e0c1');
        expect(value.classList.contains('mono')).toBe(true);
        expect(value.getAttribute('title')).toBe('3e2855e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a6');
        expect(note).toBe('uncommitted changes');
    });

    it('shows TLS at the proxy as not on this server, not muted, rather than Off', () => {
        const { value, note } = row({ tlsAtProxy: { web: true, tcp: false } }, 'TLS');
        expect(value.textContent?.trim()).toBe('Not on this server');
        expect(value.classList.contains('off')).toBe(false);
        expect(value.getAttribute('title')).toContain('X-Forwarded-Proto');
        expect(note).toBe('HTTPS at the proxy');
    });

    it('shows the TCP port behind a proxy as unencrypted here, saying why on hover', () => {
        const { value, note } = row({ settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true } }, 'TCP');
        expect(note).toBe('unencrypted here, proxy TLS not reported');
        expect(value.getAttribute('title')).toContain('PROXY protocol header');
        expect(value.getAttribute('title')).toContain('TCP_TLS_AT_PROXY');
    });

    describe('with TCP_TLS_AT_PROXY', () => {
        const declared: Partial<ServerSnapshot> = {
            tlsAtProxy: { web: false, tcp: true },
            settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true, TCP_TLS_AT_PROXY: true }
        };

        it('shows the TCP port as TLS at the proxy, naming the setting on hover', () => {
            const { value, note } = row(declared, 'TCP');
            expect(note).toBe('unencrypted here, TLS at the proxy');
            expect(value.getAttribute('title')).toContain('TCP_TLS_AT_PROXY');
        });

        it('shows TLS as not on this server, with TCP TLS at the proxy', () => {
            const { value, note } = row(declared, 'TLS');
            expect(value.textContent?.trim()).toBe('Not on this server');
            expect(value.classList.contains('off')).toBe(false);
            expect(note).toBe('TCP TLS at the proxy');
        });

        it('shows the setting on, with its variable', () => {
            const { value, note, variable } = row(declared, 'TLS at the TCP proxy');
            expect(value.textContent?.trim()).toBe('On');
            expect(value.classList.contains('ok')).toBe(true);
            expect(note).toBeNull();
            expect(variable).toBe('TCP_TLS_AT_PROXY');
        });

        it('shows the setting unset as not declared, not as Off', () => {
            const { value, note } = row({ settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_PROXY_PROTOCOL: true } }, 'TLS at the TCP proxy');
            expect(value.textContent?.trim()).toBe('Not declared');
            expect(value.classList.contains('off')).toBe(true);
            expect(value.getAttribute('title')).toContain('not declared');
            expect(note).toBe('proxy TLS not reported');
        });

        it('says when the setting has no effect', () => {
            const { value, note } = row({ settings: { ...snapshot().settings, TRUSTED_PROXIES: [ 'loopback' ], TCP_TLS_AT_PROXY: true } }, 'TLS at the TCP proxy');
            expect(value.classList.contains('warn')).toBe(true);
            expect(note).toBe('needs TCP_PROXY_PROTOCOL');
            expect(value.getAttribute('title')).toContain('No effect');
        });
    });

    it('shows an unknown commit muted, saying why on hover', () => {
        const { value, note } = shown({ commit: null, dirty: false, builtAt: null });
        expect(value.textContent?.trim()).toBe('unknown');
        expect(value.classList.contains('off')).toBe(true);
        expect(value.getAttribute('title')).toContain('without git information');
        expect(note).toBeNull();
    });
});
