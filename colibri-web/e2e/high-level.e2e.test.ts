import { afterEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';
import { createSingletonWithPeer, disconnectAll, dropConnection, isConnected, nextMessage, uniqueApp } from './helpers';
import { Sync } from '../src/Broadcasting';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';
import { RemoteLogger } from '../src/RemoteLogger';

afterEach(() => {
    disconnectAll();
});

describe('Sync (Broadcasting) high-level API', () => {
    it('Sync.sendJson on the singleton is received by a raw peer as broadcast::json', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-app'));
        const channel = uniqueApp('sync-channel');

        const peerPromise = nextMessage(peer, {
            channel,
            command: 'broadcast::json'
        });

        Sync.sendJson(channel, { hello: 'world' });

        const msg = await peerPromise;
        expect(msg.payload).toEqual({ hello: 'world' });
    });

    it('Sync.sendFloat (Unity compatibility alias) is received as broadcast::float', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-app-float'));
        const channel = uniqueApp('sync-channel-float');

        const peerPromise = nextMessage(peer, {
            channel,
            command: 'broadcast::float'
        });

        Sync.sendFloat(channel, 3.5);

        const msg = await peerPromise;
        expect(msg.payload).toBe(3.5);
    });

    it('Sync.receiveBool fires when the raw peer sends a matching broadcast', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('sync-app-recv'));
        const channel = uniqueApp('sync-channel-recv');

        const received = await new Promise<boolean>(resolve => {
            Sync.receiveBool(channel, resolve);
            peer.sendMessage(channel, 'broadcast::bool', true);
        });

        expect(received).toBe(true);
    });
});

describe('RegisterModelSync high-level API', () => {
    class TestModel extends SyncModel<TestModel> {
        @Synced()
        accessor value = '';
    }

    it('propagates a locally registered model to a raw peer', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('modelsync-app'));
        const channelName = 'testmodel';

        const [, registerModel] = RegisterModelSync<TestModel>({
            type: TestModel
        });

        const model = new TestModel('model-1');
        model.value = 'initial';

        const peerUpdatePromise = nextMessage(peer, {
            channel: channelName,
            command: 'model::update'
        });

        registerModel(model);

        const msg = await peerUpdatePromise;
        expect(msg.payload).toEqual({ id: 'model-1', value: 'initial' });
    });

    it('adds a model to the observable array when a peer sends an inbound model::update', async () => {
        const { peer } = await createSingletonWithPeer(uniqueApp('modelsync-app-inbound'));
        const channelName = 'testmodel';

        const [models$] = RegisterModelSync<TestModel>({ type: TestModel });

        const modelsPromise = firstValueFrom(
            models$.pipe(
                filter(models => models.some(m => m.id === 'model-2')),
                timeout(5000)
            )
        );

        peer.sendMessage(channelName, 'model::update', {
            id: 'model-2',
            value: 'from-peer'
        });

        const models = await modelsPromise;
        const found = models.find(m => m.id === 'model-2');
        expect(found?.value).toBe('from-peer');
    });

    // The server relays model updates and does not replay them, so a client that missed one
    // while disconnected used to stay stale until that model happened to change again.
    it('catches up on a model update it missed while disconnected', async () => {
        const { singleton, peer } = await createSingletonWithPeer(uniqueApp('modelsync-app-resync'));
        const channelName = 'testmodel';

        const [models$] = RegisterModelSync<TestModel>({ type: TestModel });
        const modelWithValue = async (value: string) => {
            const models = await firstValueFrom(
                models$.pipe(
                    filter(ms => ms.some(m => m.id === 'model-3' && m.value === value)),
                    timeout(10_000)
                )
            );
            return models.filter(m => m.id === 'model-3');
        };

        const before = modelWithValue('before');
        peer.sendMessage(channelName, 'model::update', { id: 'model-3', value: 'before' });
        const [original] = await before;

        // A real outage: the transport goes away underneath Socket.IO, which reconnects by itself.
        await dropConnection(singleton);
        peer.sendMessage(channelName, 'model::update', { id: 'model-3', value: 'missed' });

        // Make sure the server stored that while the singleton was still away. It handles one
        // client's messages in order, so its answer to the peer's own request comes after it.
        const stored = nextMessage(peer, { channel: channelName, command: 'model::update' });
        peer.sendMessage(channelName, 'model::request');
        expect((await stored).payload).toEqual({ id: 'model-3', value: 'missed' });
        expect(isConnected(singleton)).toBe(false);

        // Updated in place: the answer to the re-request must not add a second model-3.
        const after = await modelWithValue('missed');
        expect(after).toHaveLength(1);
        expect(after[0]).toBe(original);
    });
});

describe('RemoteLogger high-level API', () => {
    it('forwards console.info without throwing or breaking the connection', async () => {
        const { singleton } = await createSingletonWithPeer(uniqueApp('logger-app'));

        const originalConsole = {
            debug: console.debug,
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error
        };

        const logger = new RemoteLogger();
        try {
            // The server's ClientLogger consumes 'log' channel messages for
            // its own admin UI and never relays them to other clients, so
            // receipt isn't observable from here — that's covered by the
            // mocked unit suite. Here we just assert the wire path doesn't
            // throw and the connection stays healthy afterwards.
            expect(() => {
                console.info('e2e log message');
            }).not.toThrow();

            await expect(
                nextMessage(singleton, { channel: 'colibri', command: 'latency' }, 3000)
            ).resolves.toBeDefined();
        } finally {
            console.debug = originalConsole.debug;
            console.log = originalConsole.log;
            console.info = originalConsole.info;
            console.warn = originalConsole.warn;
            console.error = originalConsole.error;
            logger.disable();
        }
    });
});
