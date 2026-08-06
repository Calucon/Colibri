# Changelog

All notable changes to `@hcikn/colibri` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The server now checks the handshake `version` and refuses a mismatch.** When it does, it
  sends a `colibri` / `protocol::rejected` message before disconnecting. `Colibri` handles that
  itself: it turns off Socket.IO reconnection (a mismatch cannot resolve itself, and retrying
  only buries the diagnostic), logs what both sides speak, and emits a `ProtocolMismatchError`
  on the new `Colibri.protocolMismatch` observable. The rejection is deliberately kept off
  `Colibri.messages` — it is Colibri's own plumbing, not an application message.
- `ProtocolMismatchError` (exported), carrying `serverVersion` and `clientVersion`.
- `PROTOCOL_VERSION` (exported) — the version announced in the handshake query, previously an
  inline `'2'`. Requires a `colibri-server` that speaks the same version.
- **`Sync.sendVector2` / `sendVector2Array` / `receiveVector2` / `receiveVector2Array`.** The
  README has listed `Vector2` as a supported type since 1.x and it was never implemented, so a
  `broadcast::vector2` from a Unity client — which Unity has always been able to send — was
  dropped here without a word.
- **`toHexColor()` and `toRgbaColor()` (exported), plus the `ColorValue` type.** Normalize a
  received colour to whichever shape you want.

### Fixed

- **A colour sent by another web client arrived through a callback typed `string`.** Unity puts
  the HTML string `"#RRGGBBAA"` on the wire for a colour and this library puts `[r, g, b, a]`;
  `receiveColor` declared only the first, so a web-to-web colour was an array masquerading as a
  string. Both forms are now typed and delivered as `ColorValue`, matching the tolerance
  colibri-unity's `ToColor` already had. Use `toHexColor`/`toRgbaColor` to settle on one shape —
  they warn and fall back to opaque black on a payload that is not a colour, rather than throwing.
  **This changes the type of `receiveColor`/`receiveColorArray` callbacks** from `string` to
  `ColorValue`; code that assumed a string needs a `toHexColor()` around it. What goes on the wire
  is unchanged.
- `Sync.sendInt` is now documented as emitting `broadcast::float` — JavaScript has one number
  type, so it cannot do otherwise, and a Unity peer must listen with `Sync.Receive<float>`. The
  alias stays for API symmetry.

## [2.0.0]

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
  JavaScript can fall back on the workaround documented in the repository.
- **Breaking:** the socket handshake `version` query bumped from `'1'` to `'2'` to mark the
  2.0 client line. This field is informational only on the server side and does not change
  wire compatibility with existing `colibri-server` deployments. *(No longer true as of
  Unreleased above: the server validates this field and refuses a mismatch.)*
- `rxjs` moved from a regular dependency to a `peerDependency`, since its types are part of
  this package's public API (`SyncModel`, `RegisterModelSync`, `Colibri.messages`).

### Fixed

- `ColibriError` is now a named export, fixing `import { ColibriError } from '@hcikn/colibri'`,
  which previously failed silently because a default export is not re-exported by `export *`.
- Removed a stray `console.log` on every model registration that, combined with `RemoteLogger`,
  produced unnecessary network traffic to the server.
- The published npm package now includes a `LICENSE` file.
- Hardened the `exports` map so `require()` consumers get their own `.d.cts` type
  declarations instead of sharing the ESM `.d.ts`.

### Added

- A full Vitest unit-test suite covering `Colibri`, `Broadcasting`, `RemoteLogger`,
  `SyncModel`, and `ModelSynchronization`.
