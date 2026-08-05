# colibri-server v2.0.0 — Change Log

Summary of everything that changed in the `1.3.1` → `2.0.0` modernization, derived from
[`colibri-server-v2-plan.md`](./colibri-server-v2-plan.md) and the post-implementation review in
[`review-the-overview-repository-colibri-s-effervescent-spark.md`](./review-the-overview-repository-colibri-s-effervescent-spark.md),
cross-checked against the commit history.

**Not included in this release:** batched `model::request` replies (plan item 23) and all of Phase 5
(security hardening) were deliberately deferred — see [Deferred work](#deferred-work) below. 30 of the
32 remaining in-scope plan items shipped clean; 2 shipped partial and were closed out in follow-up
fixes (noted inline).

---

## Runtime, build & tooling

- Migrated `src/server` to native ESM (`"type": "module"`, explicit `.js` import extensions,
  `fileURLToPath` in place of `__filename`); the Angular UI build keeps working unaffected.
  `publish.js` → `publish.mjs`.
- `src/server/tsconfig.json` is now self-contained instead of extending the Angular root config:
  `strict`, `noUncheckedIndexedAccess`, `nodenext` module resolution, Node 24 target.
- Runtime bumped from `node:20-alpine` (EOL) to `node:24-alpine`; `@types/node` refreshed;
  `source-map-support/register` replaced with `--enable-source-maps`.
- `package-lock.json` un-ignored and committed; Docker build uses `npm ci` instead of `npm install`.
- Dockerfile rewritten as multi-stage: builder runs `npm ci` + full build (UI and server), runtime
  image ships `dist/` and production `node_modules` only, runs as the non-root `node` user, and adds a
  `HEALTHCHECK` against the web port.
- Added Vitest (`test`/`bench` scripts), a `test/` unit suite, and a `bench/` harness
  (`connection-pool.bench.ts`, `data-store.bench.ts`, framing benchmarks); captured a Phase 0 baseline
  before any hot-path changes landed.
- Added `.github/workflows/lint-server.yml` (Node 24, build → lint → test), mirroring the existing
  `colibri-web` workflow, path-filtered on `colibri-server/**`.
- Removed `body-parser` (→ `express.json()`/`express.urlencoded()`), `uuid` (→
  `crypto.randomUUID()`), `source-map-support`, and `flatbuffers` (removed once the v3 TCP protocol
  landed). `lodash` was removed from all server-side code; the dependency itself stayed in
  `package.json` because `src/ui` (out of scope) still imported it — closed out in the UI
  modernization pass below.
- Version bumped `1.3.1` → `2.0.0`; dropped the blanket `eslint-disable no-unused-vars` in `main.ts`
  and cleaned up its unused imports.
- Documented the v3 wire protocol in `docs/protocol.md`.

## Hot-path performance

- **`Payload` abstraction** (`modules/core/payload.ts`): holds whichever representation (string or
  parsed value) arrived and memoizes the other on first access, replacing the double
  `JSON.stringify`/`JSON.parse` round trip on every cross-transport message. Both `FIXME: terrible
  workaround` blocks in `socket-io-server.ts` are gone; web→web and TCP→TCP relaying now does zero
  JSON work.
- **Socket.IO rooms**: clients join a room per app on connect; app-scoped broadcasts go through
  `io.to(app).except(originId).emit(...)`, so Socket.IO encodes each packet once per room instead of
  once per recipient.
- **Client indexing**: `ConnectionPool` and the TCP worker/proxy now resolve recipients from
  `Map`-based indexes (`Map<id, client>`, `Map<app, Set<client>>`) instead of linear `find`/`filter`
  scans.
- **No more UUID arrays across the worker boundary**: the `m:broadcast` message now carries
  `{ msg, app, exclude }`; the worker resolves recipients from its own per-app index instead of
  structured-cloning a full client-id array per broadcast.
- **App-scoped broadcasts resolve from the worker's own index** (closes out the item-11 gap flagged in
  review §5): both the TCP and Socket.IO sides now cheaply check whether an app has any clients of that
  transport before touching the payload, instead of paying a full parse/stringify and encode for apps
  with zero clients on that transport.
- **`DataStore` rewritten onto nested `Map`s** (`Map<app, Map<channel, Map<id, SyncModel>>>`),
  replacing the O(n) array `_.find` scan. This also fixes two real bugs structurally: the ambiguous
  `group + channel` string-key collision (app `'ab'` + channel `'c'` vs. app `'a'` + channel `'bc'`),
  and `clearApp` over-matching on a `startsWith` prefix (disconnecting the last client of app `test`
  no longer wipes app `test2`'s store). Regression tests cover both.
- **Single merged message stream**: the RxJS `merge(...)` that used to rebuild on every access via a
  getter is now built once in the `ConnectionPool` constructor and routed through a command lookup
  table instead of seven independent `filter` chains.
- **Ring buffers** replace `Array.shift()`-based eviction for per-client latency samples
  (`measure-latency.ts`) and the in-memory log buffer (`web-log.ts`, cap reduced from 1,000,000 to
  ~20,000).
- **Log fan-out early-out**: `redirectLogMessage` skips `JSON.stringify` entirely when no `colibri`-app
  client is connected; the log bus is now a shared `Service`-level publish target instead of an
  init-time snapshot of the service list, so coverage no longer depends on construction order. The SPA
  fallback's per-unmatched-route warning was demoted to debug level.

## v3 TCP protocol (breaking change)

- Replaced the v1 ASCII-length-delimited FlatBuffer framing with a fixed binary header (`u32` length +
  `u8` type + body), removing per-packet `toString('utf8')` and `indexOf('\0', …)` scanning and
  replacing the loose `Number.isFinite` length check with a real bounds check.
- Replaced per-`data`-event `Buffer.concat` with a persistent, growable read buffer with read/write
  cursors — removes the O(n²) copy cost on fragmented streams (`maxBufferSize` kill-switch retained).
  Compaction currently runs on every `append()` rather than past a threshold as originally specced —
  the O(n²) case is genuinely fixed, but a connection that consistently leaves a partial tail pays a
  memmove per `data` event and the buffer's steady-state size can sit near ~2× `maxFrameLength` instead
  of shrinking back down (tracked as a known residual, see review §10).
- TCP payloads relay as raw bytes; `toString('utf8')` only happens where a hook actually needs the
  string, so TCP→TCP `broadcast::` traffic never becomes a JS string.
- Egress now writes the header in place into one pre-sized `Buffer` — no separate `TextEncoder`, no
  merged `Uint8Array`, no FlatBuffer builder. The `flatbuffers` dependency and
  `modules/networking/message.ts` were deleted.
- Backpressure: writes are checked against `socket.writableLength`/a high-water mark, and a stale
  update is dropped (logged) rather than buffered without bound for a client that can't keep up.
- Heartbeat and latency ping merged into a single 100 ms frame (the ping timestamp rides in the type
  `0x00` heartbeat), halving idle TCP packet rate. Confirmed correct for Socket.IO; TCP-side latency
  was unverifiable at the time of this release because `colibri-unity` was still on v1 framing —
  since `colibri-unity` 2.0.0 the Unity client echoes the v3 heartbeat verbatim, so the TCP latency
  path now has a real client behind it.
- `test/tcp-client-test.ts` updated to speak v3 framing (handshake + writes); it does not yet decode
  or echo frames back, so it currently only smoke-tests the handshake, not a full round trip.

## Correctness & robustness

- **Graceful shutdown**: `SIGTERM`/`SIGINT` now close the HTTP/Socket.IO/UDP servers, terminate the TCP
  worker thread, flush the REST store, and exit 0; `startup()` is awaited with a `.catch`, and
  `unhandledRejection`/`uncaughtException` handlers log and exit non-zero.
- **VoiceServer hardening**: removed the `throw err` inside the UDP send callback that used to crash
  the whole process on a transient send failure; the client key is computed once per packet instead of
  up to four times; the peer list is precomputed instead of re-scanning the client `Map` per packet;
  recordings are stored in a growable `Int16Array` instead of a boxed-number array; recording I/O moved
  to `fs/promises` with recursive `mkdir`.
- **REST store**: `saveData()` is now debounced (~250 ms) and atomic (write `store.json.tmp`, then
  rename); `readData()` runs inside `Service.init()` via `fs/promises` so requests can no longer be
  served before the store has loaded.
- **TCP disconnect handling**: `'close'` is now subscribed, and `handleSocketDisconnect` is guarded so
  `clientDisconnected$` fires exactly once per client instead of twice.
- **Config validation**: startup now fails fast on `NaN`/out-of-range environment values instead of
  silently coercing to `NaN`.
- **Stack traces**: `Error.stackTraceLimit` is configurable (default ~30) instead of `Infinity`, and
  `Service.logError` no longer defaults `printStacktrace` to `true` at call sites that already carry
  context.
- **Crash-time data loss, closed in follow-up fixes after the initial review:**
  - `Payload.fromValue(undefined).asBytes()` no longer throws and crashes the process — a web client
    emitting `broadcast::*` with no `payload` key used to propagate through `Broadcaster` →
    `ConnectionPool` → `TCPServerProxy.broadcastToApp` → `asBytes()` → an uncaught exception →
    `process.exit(1)`, even with zero TCP clients connected. Fixed, with `Payload` edge-case tests
    added (`undefined`/`null`/empty-string/invalid-JSON).
  - The REST store is now flushed on crash paths, not just on a clean signal-triggered shutdown, and
    voice recordings are no longer double-saved when a save takes longer than the disconnect-check
    interval.
  - App-scoped broadcast recipients are resolved from an index end-to-end (closing the item-11 gap
    noted above) and verified with dedicated tests covering the TCP worker, the REST store, and these
    crash edge cases.

## Deprecations (kept, not deleted)

- Added `@deprecated` JSDoc to `modules/core/serializable.ts`, `modules/core/error-handler.ts`,
  `modules/core/redirect-console.ts`, and `DataStore.addModel`/`DataStore.clear`.

## Tests added

- `protocol.test.ts` — v3 frame parser: byte-by-byte and split fragmentation, coalescing,
  complete-plus-trailing-partial, oversized frames, and four malformed-input variants.
- `data-store.test.ts` — nested-`Map` behavior plus regressions for both original key bugs.
- `connection-pool.test.ts` — routing, app isolation, `emit` after disconnect.
- `payload.test.ts` — single-evaluation/memoization behavior (`JSON.stringify` spy), plus the
  `undefined`/`null`/empty-string/invalid-JSON edge cases added after the crash fix above.
- Follow-up suite covering the TCP worker's disconnect dedupe and `clientsByApp` lifecycle, and the
  REST store's debounce/atomicity/`init()` behavior.

## Documentation

- Added `docs/protocol.md` describing the v3 framing.
- README updated for the Node 24 requirement, the v3 protocol, and the new npm scripts.

---

## Deferred work

Not part of this release:

- **Plan item 23 — batched `model::request` reply.** Left as one packet per model
  (`model-sync.ts` still loops `connectionPool.emit(...)`), specifically to avoid a coordinated
  breaking change with `colibri-web`'s `ModelSynchronization.ts`/e2e suite and `colibri-unity`. No
  partial implementation exists. The unbatched path is at least no longer untested against a Unity
  client: in the 2026-08-05 run a late joiner re-created a model from stored state via
  `model::request` with every synced member applied, as exactly one instance.
- **Phase 5 — security hardening**, in full: no shared-secret handshake token, no split between the
  `colibri` app name and actual admin privilege, no CORS allowlist, no null-prototype model objects,
  no REST key rejection for `__proto__`/`constructor`/`prototype`, no rate limiting, no connection
  caps, no TLS. The structural wins Phase 5's costing had already credited as "free" (Socket.IO rooms,
  `Map` keying in `DataStore`, v3 ingress bounds checks) landed anyway as part of Phases 1–2, since
  they were justified on performance grounds independent of security.
- ~~**`colibri-unity`** client rewrite for the v3 protocol — required to actually exercise items
  17–22 end-to-end (framing, heartbeat/latency merge) over TCP; the client in this repo is still on
  v1 FlatBuffers, so no TCP client can currently connect.~~ **Landed and now exercised** —
  `colibri-unity` 2.0.0, see [`colibri-unity/CHANGELOG.md`](../../colibri-unity/CHANGELOG.md). The
  end-to-end run against a live 2.0.0 server on 2026-08-05 closes this out at the wire level, with a
  decoding proxy in front of the TCP port:
  - **Framing.** The handshake was read off the wire as
    `C->S HANDSHAKE version=2 app=myAppName name=DESKTOP-PUO2MAQ` — the documented
    `version::app::name` body, client version `2`. Message frames carried all 17 payload shapes in
    both directions, relayed **byte-verbatim**: a `broadcast::string` payload arrives as
    `"hello from unity round 1"`, 26 bytes for 24 characters, while the `log` channel's
    `payload(23B)="verification log line 1"` stays unquoted at 23 bytes for 23 characters. That is
    the relay being byte-verbatim in the way `Payload` was meant to make it: what a client sends is
    what the other side receives, quoting included, with no re-serialization in between.
  - **Heartbeat/latency merge.** The 100 ms server heartbeat was echoed continuously by the Unity
    client; a raw client counted 369 heartbeats in one 40 s session, and the client-side 2 s watchdog
    never fired across many minutes of connected time.
  - **Reconnect.** Killing the transport mid-session produced exactly one
    `connection to localhost failed (ConnectionReset), retrying...`, then a reconnect, a fresh
    handshake, and queued messages resuming with no gap in their numbering — the retry queue
    drained in order. No `FrameException` reached the client console and there was no retry spin, so
    neither side was left mid-frame by the drop.

  The C# codec remains pinned to this server's encoder by byte-for-byte vectors in its EditMode test
  suite (52 tests, green against this server's own 102).

## `src/ui` modernization (follow-up pass)

The Angular admin UI was explicitly out of scope for the `2.0.0` release above; it was modernized
separately in a follow-up pass:

- Replaced the dead Karma/Protractor `test`/`server-app-e2e` targets in `angular.json` (both pointed
  at files that never existed) with Angular's first-party `@angular/build:unit-test` builder
  (Vitest runner) — the UI previously had zero test coverage; an initial `LogService`/`ClientService`/
  `BroadcastToggleComponent` spec batch now exists under `src/ui`, wired into
  `.github/workflows/lint-server.yml` as a `gui:test` step.
- Replaced `socketio.service.ts`'s `_.throttle` NgZone-batching with RxJS `throttleTime`; `lodash`
  and `@types/lodash` are now fully removed from `package.json` — the note above is closed.
- Fixed the services barrel (`src/ui/app/services/index.ts`) to re-export `ClientService`, matching
  `SocketIOService`/`LogService`.
- Replaced `RootComponent`'s direct `location.pathname` read with the Angular `Router`, fixing the
  tab-underline indicator not updating on browser back/forward navigation.
- Self-hosted fonts via `@fontsource/roboto` and `@fontsource/fira-mono`, and dropped the Material
  Icons webfont in favor of the already-loaded `primeicons` — the UI no longer loads anything from
  `fonts.googleapis.com`/`fonts.gstatic.com` at runtime.
- Migrated `LogService`/`ClientService`'s materialized state (message list, client list, filter,
  broadcast-traffic toggle) from `BehaviorSubject` to Angular signals/`computed()`, and converted
  `@Input()`/`@ViewChild` to `input()`/`viewChild()` across the log and latency-chart components,
  applying `OnPush` app-wide. Socket.IO's streaming ingestion layer (`SocketIOService`) stayed RxJS
  deliberately — it's a better fit for multiplexed async event streams than for synchronous
  snapshot state. Zoneless change detection was evaluated and deliberately deferred (the D3 latency
  chart renders entirely outside Angular's template bindings, and the zone-throttle mechanism above
  only exists because zone.js CD is expensive on this app's bursty socket traffic) — this pass makes
  a future zoneless flip cheaper and safer, but doesn't attempt it.

## Known residuals (not blocking, tracked for follow-up)

- Unvalidated egress framing: header field writes for an over-length channel/command string can throw
  `ERR_OUT_OF_RANGE` inside the TCP worker with no surrounding try/catch, which would currently kill
  the worker thread (HTTP/Socket.IO keep serving).
- Re-handshaking a TCP client with a different app leaves it registered under the old app's index.
- `RestAPI.scheduleSave` doesn't chain onto an in-flight save promise, so two rapid concurrent writes
  can race on the same `store.json.tmp`.
- Benchmark before/after numbers in `bench/baseline.md` were captured across two different Node
  versions (Phase 0 baseline vs. Phase 4 final run), so the headline speedup figures aren't strictly
  like-for-like; a same-runtime re-run is outstanding.
- Minor housekeeping: a stale ESLint ignore for the deleted `message.ts`, a benchmark file named
  differently than the plan text, `protocol.js` not re-exported from the networking barrel, and
  `.env.example`/README not yet documenting `STACK_TRACE_LIMIT`.
