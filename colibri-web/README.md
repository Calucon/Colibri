# Colibri Web

TypeScript client for [Colibri](../README.md): messaging and object synchronization with web and Unity clients, a
[key-value store](docs/guide.md#remote-store) and [remote logging](docs/guide.md#web-interface-for-logging). Requires a
[colibri-server](../colibri-server/README.md).

Full documentation: [docs/guide.md](docs/guide.md)

## Requirements

- colibri-server 2.x. A 2.x server refuses 1.x web clients, and this client warns about a 1.x server.
- TypeScript 5.0 or newer with standard decorators. Leave `experimentalDecorators` unset or `false`.
- rxjs 7.8.1 or a newer 7.x as a peer dependency. npm 7 and newer install it automatically.

## Installation

```sh
npm install @hcikn/colibri@2
```

Keep the `@2` to avoid installing a 1.x release. If npm reports `No matching version found for @hcikn/colibri@2`,
[build the package from source](docs/guide.md#installation).

## Quick start

```ts
import { Colibri, Sync } from '@hcikn/colibri';

new Colibri('your-app-name', 'http://<your-server>:9011'); // 9011 is the default port

Sync.receiveNumber('temperature', value => console.log('temperature', value));
Sync.sendNumber('temperature', 21.5);
```

- Only clients with the same app name exchange data, web and Unity alike. Use a name no other project on the server
  uses. The admin UI uses the app name `colibri`.
- The sender does not receive its own messages. Test with two clients, such as two browser tabs.

## Usage

### SyncModel

```ts
import { RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';

class Player extends SyncModel<Player> {
    @Synced()
    accessor score = 0;
}

const [players$, registerPlayer] = RegisterModelSync<Player>({ name: 'player', type: Player });
players$.subscribe(players => console.log(players.map(p => `${p.id}: ${p.score}`)));

const me = new Player(`player-${Date.now()}`); // the id must be unique across clients
registerPlayer(me);
me.score = 10; // sent to the other clients
```

- Requires the `new Colibri()` call from the quick start. With the page open in two tabs, each tab lists both players.
- Always pass `name`. Without it, the channel is the class name in lower case, which minification changes.
- To sync with a Unity `SyncBehaviour<T>`, set `name` to the Unity class name in lower case, followed by `_<ModelId>`
  if the component's `ModelId` is set ([details](docs/guide.md#syncmodel)).

## Configuration

`new Colibri(app, server, port)` takes the server as a host name or IP address, optionally with `http://`, `https://`,
`ws://` or `wss://` and a port. The port defaults to `9011`. Without `server`, a browser connects to the page's host.
Only one instance may exist. `Colibri.getInstance()` returns it. Details: [Configuration](docs/guide.md#configuration).

## Troubleshooting

| Symptom                                                                | Cause                                                                                                                                      | Fix                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `new Colibri()` throws a `ColibriError`                                | Path such as `/log`, query or fragment in the address, another scheme, a port that conflicts with the third argument, or a second instance | Pass only scheme, host and port. Use `Colibri.getInstance()`.              |
| Clients do not see each other                                          | Different app names or servers, or the listener was not registered and connected at send time                                              | Use the same app name and server. Register listeners first.                |
| Nothing connects from an `https://` page                               | The browser blocks `ws://` and `http://` (mixed content)                                                                                   | Use `https://` or `wss://` with [TLS](docs/guide.md#tls) or a TLS proxy    |
| `colibri.protocolMismatch` emits with `fatal: true`                    | The server refused this client and closed the connection                                                                                   | Use 2.x on both sides ([Protocol version](docs/guide.md#protocol-version)) |
| `colibri.protocolMismatch` emits with `fatal: false`                   | The server is probably older than 2.0.0. The connection keeps working.                                                                     | Upgrade the server to 2.x                                                  |
| `@Synced()` fails to compile or does not sync                          | `experimentalDecorators` is on, or a member lacks `accessor`                                                                               | Remove `experimentalDecorators`. Declare synced members with `accessor`.   |
| Models sync in development but not in a production build or with Unity | No `name` in `RegisterModelSync`                                                                                                           | Pass `name`                                                                |
| Unity never receives numbers from the web                              | colibri-web sends every number as `float`                                                                                                  | Receive with `Sync.Receive<float>` in Unity, not `Sync.Receive<int>`       |
| A colour is sometimes a string, sometimes an array                     | Unity sends `"#RRGGBBAA"`, colibri-web `[r, g, b, a]`                                                                                      | Normalize with `toHexColor()` or `toRgbaColor()`                           |
| `Sync.send*` does nothing                                              | Called before `new Colibri()`, dropped with a console warning                                                                              | Create the `Colibri` instance first                                        |

## Documentation

- [Guide](docs/guide.md), including [message types](docs/guide.md#sending-data-between-clients) and
  [samples](docs/guide.md#samples)
- [CHANGELOG](CHANGELOG.md), [upgrading from 1.x](../MIGRATION.md), [protocol](../colibri-server/docs/protocol.md)
- [Plain JavaScript workaround](docs/js-workaround/README.md), unsupported

## Testing

`npm test` runs the unit tests. `npm run test:e2e` runs the end-to-end tests and starts a colibri-server with Docker
Compose unless `COLIBRI_E2E_SERVER` is set ([details](docs/guide.md#for-maintainers)).
