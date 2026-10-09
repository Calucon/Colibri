# Colibri - Web Client Guide

The full reference for colibri-web. The [README](../README.md) has the short version: install, a minimal example and
the most common problems.

See [CHANGELOG.md](../CHANGELOG.md) for release notes, including breaking changes when upgrading from 1.x, and
[MIGRATION.md](../../MIGRATION.md) for upgrading all Colibri components to 2.0.

- [Installation](#installation)
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

- NPM: `npm install @hcikn/colibri@2`
- Yarn: `yarn add @hcikn/colibri@2`

`rxjs` (7.8.1 or a newer 7.x) is a peer dependency. npm 7 and newer install it for you; otherwise add it to your
project yourself.

colibri-web 2.x needs colibri-server 2.x: a 2.x server refuses 1.x web clients, and a 2.x web client warns about a 1.x
server (see [Protocol version](#protocol-version)). Keep the `@2` in the install command, so that you never get a 1.x
release by accident.

If npm answers `No matching version found for @hcikn/colibri@2` (yarn: `Couldn't find any versions`), or you need a
version that is not on npm, such as a commit newer than the latest release, build the package from a checkout of this
repository instead, with Node.js 22 or newer:

```sh
cd colibri-web
npm ci
npm run build
npm pack
```

`npm pack` writes `hcikn-colibri-<version>.tgz`, with the version from `package.json`, such as
`hcikn-colibri-2.0.0.tgz`. Copy it into your project, install it with
`npm install ./hcikn-colibri-2.0.0.tgz` (or `yarn add ./hcikn-colibri-2.0.0.tgz`), and commit it with your project,
because `package.json` refers to the file by its path. In a download without Git history, the `.git can't be found`
message these commands print is harmless.

> **Colibri targets TypeScript as of 2.0**: TypeScript 5.0 or newer, with standard
> (non-`experimentalDecorators`) decorators. `@Synced()` is a TypeScript decorator, and the
> documentation, samples and tests all assume a TypeScript project. For projects tied to plain
> JavaScript, [js-workaround](js-workaround/README.md) documents an unsupported workaround.

## Configuration

Initialize Colibri once with:

```ts
import { Colibri } from '@hcikn/colibri';

// the server's address as your browser shows it for the admin UI, without the '/log' at the end
new Colibri('app_name', 'http://<your-server>:9011');

// or just the host, with an optional port (the default is 9011)
new Colibri('app_name', '<your-server>');
new Colibri('app_name', '<your-server>', 9011);
```

- **App name:** clients only see each other's messages, synchronized models and stored data within the same app name,
  so every client of your prototype, web and Unity alike, must use the same one. It works the other way round too:
  everyone on the server who uses the same name is in one app and sees the others' messages and objects, so choose a
  name nobody else uses, not a placeholder like `app_name`. `colibri` is taken by the server's admin UI.
- **Server address:** a host name or IP address, optionally after `http://` or `ws://`, and optionally followed by
  `:port` and a trailing `/`. `https://` and `wss://` work too and encrypt both the socket and the REST requests; the
  server then needs [TLS](#tls). Anything after the host and port, such as the admin UI's `/log` path, a query or a
  fragment, throws a `ColibriError`, and so does any other scheme. An IPv6 address goes in brackets:
  `http://[::1]:9011`.
- **Port:** the one in the address, otherwise the third argument, otherwise 9011. If both have one they must agree,
  otherwise `new Colibri()` throws. The scheme never implies a port: `https://<your-server>` still means port 9011,
  not 443. `colibri.port` tells you which port is used. The third argument is a `number`, so convert a port read
  with `URLSearchParams` first, as in `Number(params.get('port') ?? 9011)`. (Plain JavaScript that passes a string
  of digits such as `'9011'` still gets that port, as in 1.x.)
- Without a server address, Colibri connects to the host that served the page. Outside a browser (Node) the address is
  required.
- Only one instance may exist; a second `new Colibri()` throws a `ColibriError`. Anywhere else in your code,
  `Colibri.getInstance()` returns it, or `null` before it has been created.

Browsers block plain `ws://` and `http://` connections from a page served over `https://` (mixed content), so such a
page has to use `wss://` or `https://`, which needs [TLS](#tls) on the server or a proxy in front of it.

For server setup, refer to [colibri-server](../../colibri-server/).

### TLS

A colibri-server with TLS turned on (`TLS_CERT` and `TLS_KEY`, see
[TLS](../../colibri-server/docs/guide.md#tls) in the server guide) serves its web port over HTTPS and WSS only. Connect
with `https://<your-server>:9011` or `wss://<your-server>:9011`: either one means `wss` for the socket and `https` for
the REST requests. The admin UI is then at `https://<your-server>:9011` too. `http://<your-server>:9011` gets no answer
once TLS is on: the connection is closed, not redirected.

- **Self-signed certificate, in a browser:** the browser has to be told once to trust it. Open
  `https://<your-server>:9011` and accept the certificate, or install it.
- **Self-signed certificate, under Node** (scripts, tests): start Node with `NODE_EXTRA_CA_CERTS=<cert.pem>`.
- **A certificate from a certificate authority**, such as Let's Encrypt: nothing to set.
- **Behind a reverse proxy that adds TLS:** give the proxy's port, such as `wss://<your-server>:443`, since the scheme
  never implies a port.

### Protocol version

The server checks the protocol version each client announces (`PROTOCOL_VERSION`, exported) and refuses a mismatch.
Colibri reports a mismatch on `colibri.protocolMismatch` as a `ProtocolMismatchError`, in one of two kinds:

- `fatal: true`: the server **refused** this client. The connection is closed, and Colibri does not try to reconnect.
- `fatal: false`: the server did not identify itself within 5 seconds of connecting, so it is **suspected** to be
  older than colibri-server 2.0.0. The connection stays up and keeps working; this is a reminder to upgrade the server,
  not a reason to tear anything down.

Each kind is emitted at most once per `Colibri` instance. A suspicion can later be followed by a refusal, but not the
other way round. Both are logged to the console as well. Nothing is replayed to a late subscriber, so subscribe right
after `new Colibri()`:

```ts
import { Colibri } from '@hcikn/colibri';

const colibri = new Colibri('app_name', 'http://<your-server>:9011');
colibri.protocolMismatch.subscribe(error => {
    if (error.fatal) {
        // disconnected for good: use colibri-web and colibri-server versions that match
        console.error(`Server speaks protocol v${error.serverVersion}, this client v${error.clientVersion}`);
    } else {
        // the server predates 2.0.0, but the connection still works
    }
});
```

`serverVersion` and `clientVersion` are protocol versions (`'1'`, `'2'`), not release versions.

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

Create only one `RemoteLogger`, since every instance forwards every line. It may be created before `new Colibri()`:
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
