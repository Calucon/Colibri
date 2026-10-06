import { afterEach, describe, expect, it } from 'vitest';
import { HOST, PORT, createClient, createClientWithAddress, disconnectAll, uniqueApp } from './helpers';

afterEach(() => {
    disconnectAll();
});

describe('REST store', () => {
    it('round-trips an object through setRestObject/getRestObject', async () => {
        const client = await createClient(uniqueApp('rest-app'));
        const key = uniqueApp('rest-key');
        const data = { hello: 'world', n: 42 };

        await expect(client.setRestObject(key, data)).resolves.toBe(true);
        await expect(client.getRestObject(key)).resolves.toEqual(data);
    });

    it('returns null for a key that was never set', async () => {
        const client = await createClient(uniqueApp('rest-app'));

        await expect(client.getRestObject(uniqueApp('missing-key'))).resolves.toBeNull();
    });

    // The admin UI's URL as copied out of the address bar, port and trailing slash included and no
    // port argument. The port used to stay in the host, so this retried 'ws://host:9011:9011'
    // forever and said nothing. The REST round trip checks the REST URL, the connect the socket's.
    it('connects and round-trips through the admin UI address, port included', async () => {
        const client = await createClientWithAddress(uniqueApp('rest-app'), `http://${HOST}:${PORT}/`);
        const key = uniqueApp('rest-key');

        expect(client.uri).toBe(`ws://${HOST}:${PORT}`);
        await expect(client.setRestObject(key, { from: 'address' })).resolves.toBe(true);
        await expect(client.getRestObject(key)).resolves.toEqual({ from: 'address' });
    });
});
