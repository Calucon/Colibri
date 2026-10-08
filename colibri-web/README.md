# Colibri - Web Client

The TypeScript client for Colibri, a toolkit for connecting cross-reality research prototypes. It sends data between
clients on named channels, keeps objects in sync with other web and Unity clients, stores JSON values on the server and
can forward console logs to it. Every client connects to a [colibri-server](../colibri-server/).

This page is the short version. The [full guide](docs/guide.md) has every option and detail. Release notes are in
[CHANGELOG.md](CHANGELOG.md), and upgrading all components from 1.x is in [MIGRATION.md](../MIGRATION.md).

## Requirements

- **A running colibri-server 2.x** ([how to start one](../colibri-server/)). A 2.x server refuses 1.x web clients,
  and this client warns about a 1.x server.
- **TypeScript 5.0 or newer**, with standard decorators: `experimentalDecorators` off (unset or `false`) in
  `tsconfig.json`.
- **rxjs 7.8.1 or a newer 7.x**, a peer dependency. npm 7 and newer install it for you; otherwise add it to your
  project yourself.

## Install

```sh
npm install @hcikn/colibri@2
# or
yarn add @hcikn/colibri@2
```

Keep the `@2`, so that you never get a 1.x release by accident. If npm answers
`No matching version found for @hcikn/colibri@2` (yarn: `Couldn't find any versions`), build the package from a
checkout of this repository instead ([how](docs/guide.md#installation)).

## Quick start

### Sending data between clients

```ts
import { Colibri, Sync } from '@hcikn/colibri';

// your colibri-server; 9011 is its default port
new Colibri('your-app-name', 'http://<your-server>:9011');

Sync.receiveNumber('temperature', value => console.log('temperature', value));
Sync.sendNumber('temperature', 21.5);
```

Only clients with the same app name see each other's data, web and Unity alike. Give every client of your prototype
the same one, and pick one nobody else on the server uses (`colibri` is taken by the admin UI). The sender does not
receive its own data, so try it with two clients, such as two browser tabs, or a tab and a Unity client.

### SyncModel

Synchronized objects extend `SyncModel` and mark their fields with `@Synced()`. This example needs the
`new Colibri()` from the one above:

```ts
import { RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';

class Player extends SyncModel<Player> {
    @Synced()
    accessor score = 0;
}

const [players$, registerPlayer] = RegisterModelSync<Player>({ name: 'player', type: Player });
players$.subscribe(players => console.log(players.map(p => `${p.id}: ${p.score}`)));

// the id names this object on every client, so give each object its own
const me = new Player(`player-${Date.now()}`);
registerPlayer(me);
me.score = 10; // sent to the other clients
```

Open the page in a second tab, and each tab lists both players.

Always pass `name`. To sync with a Unity `SyncBehaviour<T>`, use the Unity class name in lower case, followed by
`_<ModelId>` if that component's `ModelId` is set. More in [SyncModel](docs/guide.md#syncmodel).

## Common problems

- **`new Colibri()` throws a `ColibriError`.** The address has a path such as `/log`, a query or a fragment after the
  host and port, a scheme other than `http`, `https`, `ws` or `wss`, or a port that disagrees with the third argument.
  Or an instance already exists: use `Colibri.getInstance()`.
- **Clients do not see each other.** They use different app names or servers. A listener only receives what is sent
  while it is registered and connected.
- **Nothing connects from an `https://` page.** Browsers block `ws://` and `http://` from it (mixed content). Use
  `https://` or `wss://`, which needs [TLS on the server](docs/guide.md#tls) or a proxy in front of it that adds TLS.
- **`colibri.protocolMismatch` emits.** With `fatal: true` the server refused this client and the connection is
  closed; with `fatal: false` the server is suspected to be older than 2.0.0, and the connection keeps working. Use
  2.x on both sides. See [Protocol version](docs/guide.md#protocol-version).
- **`@Synced()` fails to compile or does not sync.** Remove `experimentalDecorators` from `tsconfig.json` and declare
  every synced member with `accessor`.
- **Models sync during development but not in a production build, or not with Unity.** Pass `name` to
  `RegisterModelSync`. Without it the channel is the class name in lower case, which minifying changes.
- **Unity never receives numbers from the web.** Every number sent from here is a `float`: receive it in Unity with
  `Sync.Receive<float>`, never `Sync.Receive<int>`.
- **A colour is sometimes a string and sometimes an array.** Unity sends `"#RRGGBBAA"`, colibri-web `[r, g, b, a]`.
  Pass it through `toHexColor()` or `toRgbaColor()`.
- **`Sync.send*` does nothing.** A call before `new Colibri()` is dropped with a console warning.

## Full guide

- [Installation](docs/guide.md#installation): building the package from a checkout
- [Configuration](docs/guide.md#configuration): app name, server address, port, HTTPS
- [TLS](docs/guide.md#tls): a server with TLS on, self-signed certificates in browsers and Node
- [Protocol version](docs/guide.md#protocol-version): what `protocolMismatch` reports
- [Sending data between clients](docs/guide.md#sending-data-between-clients): types, colours, numbers, rate limits
- [SyncModel](docs/guide.md#syncmodel): ids, channel names, reconnects, deleting
- [Remote Store](docs/guide.md#remote-store): JSON values stored on the server
- [Web Interface for Logging](docs/guide.md#web-interface-for-logging): forwarding console logs with `RemoteLogger`
- [Samples](docs/guide.md#samples): runnable examples
- [For maintainers](docs/guide.md#for-maintainers): tests and releases

Further reading: the [protocol docs](../colibri-server/docs/protocol.md), and a
[plain JavaScript workaround](docs/js-workaround/README.md) for projects that cannot use TypeScript (not supported).
