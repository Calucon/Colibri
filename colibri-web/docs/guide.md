# colibri-web guide

Full reference for colibri-web. The [README](../README.md) is the short version. Release notes and breaking changes
since 1.x: [CHANGELOG.md](../CHANGELOG.md). Upgrading all Colibri components to 2.0: [MIGRATION.md](../../MIGRATION.md).

- [Installation](#installation)
    - [Building from source](#building-from-source)
- [Configuration](#configuration)
    - [TLS](#tls)
    - [Protocol version](#protocol-version)
- [Usage](#usage)
    - [Sending Data between Clients](#sending-data-between-clients)
    - [SyncModel](#syncmodel)
    - [Remote Store](#remote-store)
    - [Web Interface for Logging](#web-interface-for-logging)
- [Samples](#samples)
- [For maintainers](#for-maintainers)

## Installation

```sh
npm install @hcikn/colibri@2
yarn add @hcikn/colibri@2
```

- Keep the `@2` to avoid getting a 1.x release.
- colibri-web 2.x needs colibri-server 2.x. A 2.x server refuses 1.x web clients. A 2.x web client warns about a 1.x
  server ([Protocol version](#protocol-version)).
- Peer dependency: `rxjs` 7.8.1 or a newer 7.x. npm 7 and newer install it. Otherwise, add it to your project.
- TypeScript 5.0 or newer with standard decorators. `@Synced()` is a TypeScript decorator, and the documentation,
  samples and tests assume TypeScript. Plain JavaScript: [unsupported workaround](js-workaround/README.md).

### Building from source

Build the package from this repository, with Node.js 22 or newer, if npm reports
`No matching version found for @hcikn/colibri@2` (yarn: `Couldn't find any versions`), or to use a version not on npm,
such as a commit after the latest release.

```sh
cd colibri-web
npm ci
npm run build
npm pack
```

`npm pack` writes `hcikn-colibri-<version>.tgz`, such as `hcikn-colibri-2.0.0.tgz`. Copy it into your project,
install it with `npm install ./hcikn-colibri-2.0.0.tgz` or `yarn add ./hcikn-colibri-2.0.0.tgz`, and commit it.
`package.json` refers to the file by its path. Without Git history, these commands print `.git can't be found`, which
is harmless.

## Configuration

Server setup: [colibri-server](../../colibri-server/). Create the client once:

```ts
import { Colibri } from '@hcikn/colibri';

// the admin UI's address as the browser shows it, without '/log' at the end
new Colibri('app_name', 'http://<your-server>:9011');

// or the host, with an optional port
new Colibri('app_name', '<your-server>');
new Colibri('app_name', '<your-server>', 9011);
```

| Argument | Default                                      | Description                                                                                                      |
| -------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `app`    | required                                     | App name. Messages, synchronized models and stored data are shared only within one app name.                     |
| `server` | Host that served the page. Required in Node. | Host name or IP address, optionally with `http://`, `ws://`, `https://` or `wss://`, `:port` and a trailing `/`. |
| `port`   | `9011`                                       | A `number` from 1 to 65535.                                                                                      |

#### App name

- All clients of your app, web and Unity, must use the same name.
- Anyone else using the name joins your app and sees its messages and objects. Choose a unique name, not a placeholder
  like `app_name`.
- `colibri` is reserved for the admin UI. The server treats such a client as an admin UI, and colibri-web warns.

#### Server address and port

- `https://` and `wss://` encrypt the socket and the REST requests, and need [TLS](#tls) on the server.
- An IPv6 address goes in brackets: `http://[::1]:9011`.
- A path such as the admin UI's `/log`, a query, a fragment or another scheme throws a `ColibriError`.
- The port in the address applies, else the third argument, else 9011. If both give a port, they must match, or
  `new Colibri()` throws. `colibri.port` returns the port in use.
- The scheme never implies a port. `https://<your-server>` means port 9011, not 443.
- Convert a port from `URLSearchParams` first: `Number(params.get('port') ?? 9011)`. Plain JavaScript may still pass a
  string of digits such as `'9011'`, as in 1.x.

#### Instance and connection

- A second `new Colibri()` throws a `ColibriError`.
- `Colibri.getInstance()` returns the instance, or `null` with the warning
  `Colibri not initialized yet! (Instance is null)`. `Colibri.getInstance(false)` skips the warning.
- Colibri retries a failed connection until the server answers, with one warning per outage.
- Browsers block `ws://` and `http://` from an `https://` page (mixed content). Use `wss://` or `https://` there, with
  [TLS](#tls) on the server or a TLS proxy.
- After an outage, a background tab may reconnect late (90 s in a test with Chrome). Browsers throttle timers in hidden
  tabs, including Socket.IO's reconnect backoff. A visible tab reconnects within seconds.

### TLS

With TLS on (`TLS_CERT` and `TLS_KEY`, see [TLS](../../colibri-server/docs/guide.md#tls) in the server guide),
colibri-server serves its web port over HTTPS and WSS only.

- Connect with `https://<your-server>:9011` or `wss://<your-server>:9011`. Either means `wss` for the socket and
  `https` for the REST requests.
- The admin UI is at `https://<your-server>:9011`.
- `http://<your-server>:9011` gets no answer. The connection is closed, not redirected.

| Certificate                                         | Client setup                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Self-signed, in a browser                           | Open `https://<your-server>:9011` once and accept the certificate, or install it. |
| Self-signed, under Node (scripts, tests)            | Start Node with `NODE_EXTRA_CA_CERTS=<cert.pem>`.                                 |
| From a certificate authority, such as Let's Encrypt | None                                                                              |
| Reverse proxy that adds TLS                         | Give the proxy's port, such as `wss://<your-server>:443`.                         |

### Protocol version

The server refuses a client whose protocol version (`PROTOCOL_VERSION`, exported) differs from its own.
`colibri.protocolMismatch` emits a `ProtocolMismatchError`:

| `fatal` | Cause                                                                                     | Effect                                                 |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `true`  | The server refused this client.                                                           | The connection is closed. Colibri does not reconnect.  |
| `false` | The server did not identify itself within 5 s of connecting, so it is probably pre-2.0.0. | The connection stays up and works. Upgrade the server. |

- Each kind is emitted at most once per `Colibri` instance, and also logged to the console.
- A suspected mismatch can be followed by a refusal, not the other way round.
- Nothing is replayed to a late subscriber. Subscribe right after `new Colibri()`.
- `serverVersion` and `clientVersion` are protocol versions (`'1'`, `'2'`), not release versions.

```ts
import { Colibri } from '@hcikn/colibri';

const colibri = new Colibri('app_name', 'http://<your-server>:9011');
colibri.protocolMismatch.subscribe(error => {
    if (error.fatal) {
        // disconnected for good: install matching colibri-web and colibri-server versions
        console.error(`Server protocol v${error.serverVersion}, client protocol v${error.clientVersion}`);
    } else {
        // the server is older than 2.0.0, the connection still works
    }
});
```

## Usage

### Sending Data between Clients

Colibri supports simple data transmission via pub/sub communication. Data can be published from anywhere in the
executed code, as illustrated with the following simple example of sending a boolean value on a "myChannel" channel:

```ts
import { Sync } from '@hcikn/colibri';
Sync.sendBool('myChannel', true);
```

The sent data can then be received anywhere by registering a listener:

```ts
const onValue = (value: boolean) => {
    // Will be called whenever a bool on "myChannel" channel is received
};
Sync.receiveBool('myChannel', onValue);
```

The listener can be deregistered via:

```ts
Sync.unregister('myChannel', onValue);
```

Listeners may be registered (and deregistered) before `new Colibri()`; they are attached once it is created. Sending
needs the instance: a `Sync.send*` call before `new Colibri()` is dropped with a console warning.

The following built-in types are available for sync: `bool, int (as number), float (as number), string, Vector2, Vector3, Quaternion, Color` and arrays thereof. For arbitrary data, you can use JSON:

```ts
Sync.sendJson('myChannel', { foo: 'bar' });
Sync.receiveJson('myChannel', json => {
    /* ... */
});
```

Vectors, quaternions and colours are plain arrays here, where Unity uses its own structs:
`Sync.sendVector2('myChannel', [1, 2])`, `Sync.sendVector3('myChannel', [1, 2, 3])`,
`Sync.sendColor('myChannel', [1, 0, 0, 1])` with each colour component 0-1.

**A colour arrives in either of two forms.** A Unity client sends the HTML string
`"#RRGGBBAA"`; a colibri-web client sends `[r, g, b, a]`. Both reach your callback, so normalize
rather than assuming one:

```ts
import { Sync, toHexColor, toRgbaColor } from '@hcikn/colibri';

Sync.receiveColor('myChannel', color => {
    element.style.background = toHexColor(color); // "#ff0000ff", whoever sent it
    const [r, g, b, a] = toRgbaColor(color); // ...or 0-1 components
});
```

Both normalizers warn and fall back to opaque black on a payload that is not a colour, rather
than throwing. The full wire format is in
[the protocol docs](../../colibri-server/docs/protocol.md#payload-shapes).

See also [the broadcast sample](../samples/broadcast.ts) (run sample with `npm run samples/broadcast`).

Limitations:

- The server relays data, it does not store it: a listener only receives what is sent while it is registered and
  connected
- Data goes to the _other_ clients with the same app name; the sender does not receive its own data
- Type and channel _must_ match between Listener and Sender. JavaScript has one number type, so
  everything this library sends is tagged `float`, including `sendInt`, which exists only for API
  symmetry with Unity. **Unity clients must receive numbers sent from web with `Sync.Receive<float>`,
  never `Sync.Receive<int>`.** The other direction is handled: `receiveNumber` accepts both.
- Remember to unregister your listener where necessary!
- By default the server takes up to 1000 broadcasts and model updates a second from one client, in bursts of up
  to 2000. Beyond that it drops the client's broadcasts, and holds back its model updates, merging them per object so
  that the latest value of every field still arrives. It logs a warning naming the client. The limit is there to catch
  a runaway send loop, and the server's operator can change it.

### SyncModel

(Counterpart to [SyncBehaviour in Unity client](../../colibri-unity/docs/guide.md#syncbehaviour))

For more complex scenarios, Colibri supports synchronization of data models (e.g., for use in model-view-controller architectures). For this, we need to extend the _Model_ with `SyncModel`:

```ts
import { SyncModel, Synced } from '@hcikn/colibri';

export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    accessor name = '';

    @Synced()
    accessor age = 0;

    @Synced('billingAddress')
    accessor address = '';
}
```

`@Synced()` requires TypeScript's standard decorators, the default since TypeScript 5.0. Make sure `experimentalDecorators` is **not** set (or is `false`) in your `tsconfig.json`, and declare every synced member with the `accessor` keyword.

Any `accessor` member marked with `@Synced()` will be synchronized across all network clients.

> **Migrating from 1.x:** remove `experimentalDecorators` from your `tsconfig.json`, and turn every
> synced field/property into an `accessor` (e.g. `@Synced() private age = 0;` → `@Synced() accessor age = 0;`).
> This also fixes field synchronization in frameworks like React, which never worked correctly under
> the legacy decorator.

Lastly, we need to register the class with the Synchronization mechanism by calling `RegisterModelSync`:

```ts
import { RegisterModelSync } from '@hcikn/colibri';
const [SampleClasses$, registerExampleClass] = RegisterModelSync<SampleClass>({
    name: 'sampleclass',
    type: SampleClass
});
```

`name` is the channel the models are synchronized on. **Always pass it.** Without it, Colibri uses the class name in
lower case, which a minifying production build changes, so two builds of your app, or a minified build and Unity, stop
synchronizing without an error; Colibri only warns in the console when the class name looks minified. To synchronize
with a Unity `SyncBehaviour<T>`, use the Unity class name in lower case (`MyClass` → `'myclass'`), followed by
`_<ModelId>` if that component's `ModelId` is set. Property names are compared in lower case too, so
`@Synced() accessor myString` matches Unity's `[Sync] public string MyString`.

The first return value (e.g., `SampleClasses$`) is an RxJS [Observable](https://rxjs.dev/guide/observable) of all
synchronized SampleClass instances. It emits the current list as soon as you subscribe, and again whenever an instance
is added or deleted, or another client updates one. The second return value (e.g., `registerExampleClass`) can be used
to sync new instantiations:

```ts
const mySample = new SampleClass('myId'); // mySample is not synchronized across clients yet
registerExampleClass(mySample); // from now on mySample is synchronized with the other clients
```

The id identifies the instance on every client, so it has to be unique. `registerModel` first asks the server for that
id. If the server already has a model with it (another client created it, or this page did before it was reloaded while
another client of the app stayed connected), the server's copy wins: its values replace the ones the instance had when
it was registered, and changes made after `registerModel` are sent on top of them and kept, also when an update another
client made to the model arrives before the server's answer. Otherwise the instance is sent to the other clients in
full. An id that is already in the list, such as a copy the server sent earlier, is replaced by the instance you
register; the replaced one stops syncing, and Colibri warns in the console if this client had registered it itself.

`SampleClasses$` emits a freshly registered instance once with its constructor values, in the same tick as
`registerModel` and before the server's answer arrives, so a UI bound to it briefly shows the defaults; nothing of it is
sent until that answer.

`RegisterModelSync` and registering instances may happen before `new Colibri()`; the server is asked once it is
created. After a reconnect, Colibri asks the server again for each instance this client registered, then for all the
others, so what changed in the meantime is applied. A change made while that answer is on its way is kept, at first,
after a reconnect, and when another `RegisterModelSync` on the channel asks: the server made the answer before it had
the change. So is a change not yet sent when an update for the instance arrives: `SyncModel` sends changes 1 ms after
they are made, and the server reads the change after that update. An instance the server no longer has is sent again in
full: the server forgets an app's models when it restarts and when the app's last client disconnects, which is what a
lone client's outage looks like to it. A registered instance another client deleted during the outage is removed from
the list, if the delete is no more than `MODEL_TOMBSTONE_SECONDS` (10 minutes by default) old. See
[After a reconnect](../../colibri-server/docs/protocol.md#after-a-reconnect) in the protocol docs.

A change to a registered instance made just before the connection dies without closing (Wi-Fi dropping out, say) may
never reach the server: Socket.IO notices such a connection only after its ping timeout, up to about 45 s with the
server's defaults, and what is sent until then is lost. When the server's answer after the reconnect, or an update from
another client that arrives before the answers are over, shows a field with an earlier value it had here, one it still
had in the 10 s before the connection stopped working, Colibri keeps the local value and sends it again once the answers
are over, however many changes were made in the meantime. A value this client never had is another client's and is
applied. This holds when the connection dies again before that answer comes, too, or before the value sent again
arrives.

See also [the model-sync sample](../samples/model-sync.ts) (run sample with `npm run samples/model-sync`).

Limitations:

- The server keeps synchronized models in memory only, per app name, and forgets them when the last client of that app
  disconnects or the server restarts. This client sends the instances it registered again after a reconnect; any other
  model comes back only from a client that has it.
- colibri-web cannot delete an instance for the other clients: `delete()` only stops that instance sending its changes.
  An instance another client (e.g. Unity) deletes is removed from the list. If this client was disconnected at the
  time, that happens on the reconnect only for an instance it registered itself, and only within
  `MODEL_TOMBSTONE_SECONDS` of the delete; any other stays in the list.
- A change lost in a connection that died is sent again only for an instance this client registered. On a model listed
  from the server, the server's value replaces it after the reconnect.
- A field changed more than about 8 times within roughly 100 ms of the last message from the server before the
  connection died (a fast drag on a slow link, say) may not be recognised; the server's value is then applied.
- Another client that sets a field back during the outage, or just after the reconnect, to a value the field had here in
  the 10 s before the connection died, looks like a lost change: this client's value replaces it.
- A field changed while this client waits for the server's answer after `registerModel` or a reconnect is sent again
  when the server still shows the value it replaced a round trip later, even if another client set it back meanwhile.
- Two `RegisterModelSync` on one channel in the same page do not receive each other's updates: the server relays an
  update to every client but the one that sent it, and both use the page's one connection. Call `RegisterModelSync`
  once per channel and share what it returns.

### Remote Store

Colibri offers persistent data storage on the server, so that data can be shared easily between connected clients. Each object is identified by its individual `key`, within the app name passed to `new Colibri()`:

```ts
import { Colibri, GetRestApi, PutRestApi } from '@hcikn/colibri';

const key = 'sampleKey';
const data = { name: 'Test', age: 32 };

// either directly via the Colibri instance...
const colibri = Colibri.getInstance();
if (colibri) {
    await colibri.setRestObject(key, data); // true if stored
    const stored = await colibri.getRestObject(key); // null if there is nothing stored under key
}

// ...or via the wrapper functions, which return undefined if there is no Colibri instance yet
await PutRestApi(key, data);
const stored = await GetRestApi(key);
```

A stored value can be any JSON value up to 5 MiB, `null` included; `undefined` is not one, so
`setRestObject(key, undefined)` stores nothing. `setRestObject` resolves to `false` if the server did not store it,
and `getRestObject` to `null` if there is no such key or the server answered with an error; both reject if the server
cannot be reached. A key is URL-encoded, so any key works, `/`, `#`, `?`, `%` and spaces included, and addresses the
same value as Unity's `Store`. Whitespace around a key and slashes in front of it are stripped, and an empty key, `.`
or `..` stores and finds nothing (`false` and `null`).

### Web Interface for Logging

Colibri provides a _web logger_ with web interface to send diagnostic data (currently: console logs) to the server. This may be useful for devices (e.g., VR devices, smartphones) where access to the console is not easily available.

To setup, import the `RemoteLogger` and construct a new instance. Any subsequent `console` calls should now also appear on your colibri server's web interface, which can be accessed via `http://<your-server-ip>:9011`. The server also prints them to its console output (`docker logs` for a Docker server), apart from `console.debug` lines unless it runs with `CONSOLE_LOG_LEVEL=debug`.

```ts
import { RemoteLogger } from '@hcikn/colibri';
const logger = new RemoteLogger();

// en-/disable RemoteLogger
logger.enable();
logger.disable();
```

Create one `RemoteLogger`, at startup. A second one does not forward again. It warns once, and from then on its
`enabled` argument, `enable()` and `disable()` control the first one. It may be created before `new Colibri()`:
the first 100 lines logged until then are kept and sent once Colibri exists, and any further lines are counted and
reported in one warning. Forwarding never makes a `console` call throw.

See also [the remote-logging sample](../samples/remote-logging.ts) (run sample with `npm run samples/remote-logging`).

## Samples

See [Sample folder](../samples/) for more examples on how to use the Colibri web client.

The samples are TypeScript and run with [tsx](https://tsx.is/) directly against the sources. The interactive ones ask
for the server address and port, sharing their prompts via `common.ts`; `verification-peer` takes them as arguments
instead and sends one value of every type, for testing against a Unity client.

| Sample                                               | Run with                                             |
| ---------------------------------------------------- | ---------------------------------------------------- |
| [broadcast](../samples/broadcast.ts)                 | `npm run samples/broadcast`                          |
| [model-sync](../samples/model-sync.ts)               | `npm run samples/model-sync`                         |
| [remote-logging](../samples/remote-logging.ts)       | `npm run samples/remote-logging`                     |
| [rest-api](../samples/rest-api.ts)                   | `npm run samples/rest-api`                           |
| [verification-peer](../samples/verification-peer.ts) | `npm run samples/verification-peer -- [host] [port]` |

## For maintainers

- `npm test` runs the unit tests, `npm run typecheck` type-checks sources, samples and tests, and `npm run lint` and
  `npm run format:check` check the style.
- `npm run test:e2e` runs the end-to-end tests against a real colibri-server. It starts one from `../colibri-server`
  with Docker Compose on port 9011, unless `COLIBRI_E2E_SERVER` names a running server (port: `COLIBRI_E2E_PORT`,
  default 9011).
- `npm run release` builds and publishes the package to npm; a plain `npm publish` builds first as well. The 1.x
  `publish` script is gone.
