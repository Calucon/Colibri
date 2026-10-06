# Changelog

All notable changes to `@hcikn/colibri` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

Made for colibri-server 2.0.0 or newer: that server refuses colibri-web 1.x, and this release
warns about an older server. [MIGRATION.md](../MIGRATION.md) walks through upgrading every
Colibri component from 1.x.

### Changed

- **Breaking:** `@Synced()` now requires TypeScript's standard TC39 `accessor` decorators
  instead of legacy (`experimentalDecorators`) ones. Remove `experimentalDecorators` from
  your `tsconfig.json` and turn every synced field/property into an `accessor` (e.g.
  `@Synced() private age = 0;` → `@Synced() accessor age = 0;`). This also fixes field
  synchronization in frameworks like React, which never worked correctly under the legacy
  decorator.
- **Breaking:** Colibri now targets TypeScript (5.0 or newer). `@Synced()` is a TypeScript
  decorator, and the documentation, samples and tests all assume a TypeScript project; the
  plain-JavaScript sample ports were removed again. Projects that are tied to plain
  JavaScript can fall back on the [workaround](docs/js-workaround/README.md) documented in
  the repository.
- **Breaking:** the socket handshake announces protocol version `'2'` instead of `'1'`, and
  colibri-server 2.0.0 checks it and refuses any other version. colibri-web 1.x and
  colibri-server 2.0.0 therefore cannot be used together; upgrade both. See
  `Colibri.protocolMismatch` below for what this release does about a mismatch.
- **Breaking:** `Sync.receiveColor`/`receiveColorArray` callbacks get a `ColorValue` instead
  of a `string`. Unity puts the HTML string `"#RRGGBBAA"` on the wire for a colour and this
  library puts `[r, g, b, a]`, so a colour sent by another web client arrived as an array
  through a callback typed `string`. Both forms are now typed and delivered, matching the
  tolerance colibri-unity's `ToColor` already had. Code that assumed a string needs a
  `toHexColor()` around it. What goes on the wire is unchanged.
- `rxjs` moved from a regular dependency to a `peerDependency`, since its types are part of
  this package's public API (`SyncModel`, `RegisterModelSync`, `Colibri.messages`).
- `typescript` is no longer installed as a dependency of this package, and `engines` asks for
  Node 22 or newer.
- For maintainers: the `publish` npm script is now `release`. Under its old name npm also ran
  it after every `npm publish`, which tried to publish a second time and failed.

### Added

- **`Colibri.protocolMismatch` and `ProtocolMismatchError` (both exported).** colibri-server
  2.0.0 checks the handshake `version`, and when it refuses a client it sends a `colibri` /
  `protocol::rejected` message before disconnecting. `Colibri` handles that itself: it turns
  off Socket.IO reconnection (a mismatch cannot resolve itself, and retrying only buries the
  diagnostic), logs what both sides speak, and emits a `ProtocolMismatchError` on
  `Colibri.protocolMismatch`. The rejection is deliberately kept off `Colibri.messages` — it
  is Colibri's own plumbing, not an application message.
- **A warning when the server predates the version check.** That check is server-side, so a
  server too old to have it can neither refuse this client nor announce itself. A 2.0.0+ server
  says `colibri`/`protocol::accepted` on connect; five seconds without it emits a
  `ProtocolMismatchError` on `Colibri.protocolMismatch` with `serverVersion: '1'` — inferred
  rather than received, since every release before 2.0.0 speaks protocol v1. It **stays
  connected**: the Socket.IO envelope did not change between v1 and v2, so the connection
  genuinely works and hanging up over this would turn a warning into an outage. Ordinary
  traffic deliberately does not count as proof of life: a 1.x server relays broadcasts and
  model updates perfectly well, and the 100 ms `latency` broadcast it may also send has been
  there since colibri-server 1.2.0.
- `ProtocolMismatchError` carries `serverVersion` and `clientVersion`, both **protocol**
  versions (`'1'`, `'2'`) and never release versions, so the two are always comparable. Its
  `fatal` flag tells the two cases apart: `true` when the server refused this client and the
  connection is gone, `false` for the suspicion above. **If you subscribe to
  `protocolMismatch` and tear anything down in response, check this flag.** Each kind is
  emitted at most once per `Colibri` instance; a suspicion can be followed by a refusal, but
  not the other way round.
- `PROTOCOL_VERSION` (exported): the version announced in the handshake query.
- **`Sync.sendVector2` / `sendVector2Array` / `receiveVector2` / `receiveVector2Array`.** The
  README has listed `Vector2` as a supported type since 1.x and it was never implemented, so a
  `broadcast::vector2` from a Unity client — which Unity has always been able to send — was
  dropped here without a word.
- **`toHexColor()` and `toRgbaColor()` (exported), plus the `ColorValue` type.** Normalize a
  received colour to whichever shape you want. They warn and fall back to opaque black on a
  payload that is not a colour, rather than throwing.
- A console warning when `RegisterModelSync` derives its channel from a class name that looks
  minified (two characters or fewer, or containing `$`). A minifying build renames classes, so
  such a channel differs between builds and from Unity's; pass `name` explicitly.
- Samples: `npm run samples/rest-api`, and `npm run samples/verification-peer -- [host] [port]`,
  a non-interactive peer that sends and receives one value of every type, for testing against
  a Unity client.
- A Vitest unit-test suite (`npm test`), an end-to-end suite against a real colibri-server
  (`npm run test:e2e`), and `npm run typecheck`.

### Fixed

- **The remote store did not work:** `getRestObject` and `setRestObject` (and with them
  `GetRestApi` and `PutRestApi`) requested a `ws://` URL, which `fetch` rejects. They now use
  `http://`, or `https://` for a secure server address.
- **Integers sent by Unity were dropped.** Unity tags `Sync.Send(channel, 5)` as
  `broadcast::int`, and `receiveNumber`/`receiveNumberArray` only listened for
  `broadcast::float`. They now receive both.
- **Registering before `new Colibri()` silently did nothing.** `Sync.receive*`,
  `RegisterChannel`, `RegisterOnce` and `RegisterModelSync` called before it now attach once
  it is constructed, `RegisterModelSync`'s request for the existing models and a registered
  model's first full update are sent at that point, and `Sync.unregister`/`UnregisterChannel`
  called before it take back a pending registration.
- **Model updates missed during a disconnect were never caught up.** After every reconnect,
  each `RegisterModelSync` asks the server for the current state again; existing models are
  updated in place. A model deleted while this client was away is still not removed.
- `new RemoteLogger()` before `new Colibri()` overflowed the stack on the first `console`
  call. Lines logged before Colibri exists are now kept (the first 100) and sent once it is
  constructed; any further lines are counted and reported in one warning.
- With `RemoteLogger` installed, logging a value JSON cannot encode (a `BigInt`, a throwing
  `toJSON`) threw out of `console.log`. Forwarding never throws now, and a `BigInt` is sent as
  its decimal string.
- **Server addresses in the form a browser shows them.** `'http://host'` and `'https://host'`
  became `ws://http://host:9011`, and a port in the address, as in the admin UI's
  `'http://host:9011'`, became `ws://host:9011:9011`; both retried forever without an error.
  `http://` and `ws://` now mean `ws` for the socket and `http` for the REST API, `https://`
  and `wss://` mean `wss` and `https`, a port in the address is used, and a trailing slash is
  ignored. `Colibri.port` is the port actually used: the one in the address, else the one
  passed, else 9011. A `ColibriError` is now thrown for anything that cannot connect: a port
  in the address that disagrees with the one passed, a path, query or fragment after the host
  (such as the admin UI's `/log`), any other scheme, an IPv6 address without brackets, and a
  port that is not a whole number from 1 to 65535 (`NaN` used to get through).
- `new Colibri(app)` without a server address outside a browser throws a `ColibriError`
  instead of `ReferenceError: window is not defined`.
- `ColibriError` is now a named export, fixing `import { ColibriError } from '@hcikn/colibri'`,
  which previously failed silently because a default export is not re-exported by `export *`.
- Removed a stray `console.log` on every model registration that, combined with `RemoteLogger`,
  produced unnecessary network traffic to the server.
- The package's entry points: `module` pointed at a file that was never built, and `require()`
  got the ES module build. An `exports` map now gives `import` and `require()` each their own
  build and type declarations (`.d.ts`/`.d.cts`).
- The published npm package now includes a `LICENSE` file.
- `Sync.sendInt` is now documented as emitting `broadcast::float` — JavaScript has one number
  type, so it cannot do otherwise, and a Unity peer must listen with `Sync.Receive<float>`. The
  alias stays for API symmetry.
