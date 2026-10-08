# colibri-server v2.0.0: Change Log

Everything that changed in colibri-server from `1.3.1` to `2.0.0`. To upgrade a project built on
Colibri 1.x, start with [MIGRATION.md](../../MIGRATION.md), which covers all three components;
this is the server's full detail.

---

## 2.0.0 (unreleased)

**Breaking changes**

- **New TCP framing.** The 1.x FlatBuffer framing is replaced by a fixed binary header (see
  [v3 TCP protocol](#v3-tcp-protocol-breaking-change)). colibri-unity 1.x cannot connect to this
  server; use colibri-unity 2.x.
- **Protocol version check.** Every client has to announce protocol version `2`, and anything
  else is refused. That includes colibri-web 1.x, which announces `1` although its Socket.IO
  envelope still works; use colibri-web 2.x. See
  [Protocol version checking](#protocol-version-checking).
- **Node 24 and native ESM** to run from source.
- **Docker image.** The server runs as the non-root `node` user, started through a new
  `colibri-entrypoint.sh` that replaces the node base image's entrypoint; `CMD` is
  `node --enable-source-maps dist/server/main.js` instead of `npm start`. See
  [Docker](#docker).

**Not in this release:** batched `model::request` replies, and security hardening beyond optional
[TLS](#tls); see [Deferred work](#deferred-work).

### Protocol version checking

- **Both transports check the protocol version.** `PROTOCOL_VERSION` in
  [`protocol.ts`](../src/server/modules/networking/protocol.ts) is the single source of truth
  for the TCP handshake and the Socket.IO query. Until now the version was parsed, stored and
  logged - and compared against nothing, so a client built against the wrong protocol reconnected
  forever against a server that said nothing unusual.

  A mismatched client is refused: it is told why with a `colibri` / `protocol::rejected` message
  (`{ reason, serverVersion, clientVersion }`) and then disconnected, and it never enters the app
  index or `clientConnected$`, so no half-connected ghost reaches the admin UI. The server logs
  every refusal with the client's address and both versions. The admin UI itself is exempt - it
  ships with the server, and a check that can lock you out of your own console is worse than the
  mismatch it detects - and its own query was bumped from the stale `'1'` to `'2'`. `clientVersion`
  is always a string: `''` when a Socket.IO client sent no version, with a reason that says
  `'(none)'`. Documented under [Version checking](./protocol.md#version-checking).

- **A refused TCP client is dropped at once.** The refusal frame is queued ahead of the FIN, and
  the client leaves every index straight away. Before, the next heartbeat logged a
  `write after end` warning and error and could cut off the refusal frame, and frames sent behind
  a refused handshake were logged as `Ignoring message ... without app`. A peer that never closes
  its side is disconnected after 5 s. The same goes for a client cut off for an invalid frame.

- **A Colibri 1.x Unity client is named in the log.** The refusal cannot reach it - it cannot
  decode the new framing, and its own handshake fails to parse before its version is read. The
  server now recognises the 1.x framing and logs one warning naming the client's address, the
  protocol version the server speaks and the Unity package to upgrade, at most once a minute per
  address, instead of an anonymous `Invalid frame length: 1744830464` every time it reconnected.

- **The server announces its protocol version on connect**, as `colibri` /
  `protocol::accepted` with `{ serverVersion }`, to every Socket.IO client it accepts. The version
  check runs on the server, so it can only ever catch a stale *client*; this is what lets a client
  catch a stale *server*, which otherwise neither refuses it nor says what it speaks.

  It has to be an explicit message. The obvious alternative (inferring from the 100 ms `latency`
  broadcast, which only a "current" server sends) is wrong: that broadcast was added in
  colibri-server **1.2.0**, so every 1.2.x and 1.3.x server sends it while still speaking the old
  protocol. Checked against the published `hcikn/colibri:1.1.1` and `hcikn/colibri:1.3.1` images
  rather than assumed, after the repo's own `v1.1.2` tag turned out to predate both. Nothing else a
  web client can observe separates them. Written up under
  [Detecting an out-of-date server](./protocol.md#detecting-an-out-of-date-server).

  TCP clients are sent no announcement and need none: the framing changed incompatibly in 2.0.0, so
  an old server is already unmistakable to them.

- **Nothing is sent to a TCP client before its handshake is accepted.** The 100 ms heartbeat
  went to every connection, so a client the server was about to refuse could get a heartbeat
  first and count itself connected: colibri-unity reported a connection and then the protocol
  mismatch. Now a refused client's first frame is the refusal.

- **A TCP client that handshakes again leaves its old app properly.** It is reported as
  disconnected from the old app and connected to the new one, the old app's synchronized models
  are cleared if it was the last client there, and the admin UI no longer lists it twice.

- `npm run test:tcpclient` takes an optional version argument (`-- 1`) so the refusal can be
  driven by hand against a live server. It prints the server's reason and exits with code 2 on a
  refusal, instead of blaming missing heartbeats, and with code 1 when the server sends a frame it
  cannot decode, even after a heartbeat.

- `npm run test:vectors`, which CI runs, fails when colibri-web, the Unity package or the admin UI
  announce a protocol version different from the server's.

### TLS

- **Optional TLS.** With `TLS_CERT` and `TLS_KEY` set to PEM files, the Unity TCP port accepts only
  TLS, and the web port serves only HTTPS and WSS, both with the same certificate. RSA and EC
  certificates both work. The v3 framing inside TLS is unchanged, so the protocol version stays the
  same. With both unset, nothing changes. See [TLS](./guide.md#tls) in the guide.
- **The certificate's SHA-256 fingerprint is logged at startup**, for pinning in Unity, and for a
  self-signed certificate the line says how a Unity app and a browser come to accept it. A renewed
  certificate in the same files is used within about 20 s, without a restart; open connections
  keep the certificate they started with. The server warns when the certificate is not valid yet,
  expires soon, or has expired.
- **TLS mismatches are named in the log**, each at most once a minute per address. A Unity client
  without TLS on a TLS port is named with its app, and is sent nothing. A TLS client on an
  unencrypted port is named too; it used to hang silently until the idle timeout. A failed TLS
  handshake is logged at info level, with a hint about the certificate.
- **TLS files the server cannot use stop it at startup**, with a message naming the variable, the
  file and the fix: only one of the two set, a file missing or unreadable, certificate and key
  swapped, a key with a passphrase, or a key that is not the certificate's, including an RSA key
  with an EC certificate or the other way round. A renewal with the same problems is not used: the
  server warns once and keeps the old certificate.

### Docker

- The Dockerfile is multi-stage: the builder runs `npm ci` and the full build (admin UI and
  server); the runtime image ships `dist/` and the production `node_modules` only, and has a
  `HEALTHCHECK`. The admin UI's build-only packages (Angular, PrimeNG, d3, zone.js,
  socket.io-client, fonts) are dev dependencies now and stay out of it, which shrinks the image
  from 338 MB to 189 MB.
- The `HEALTHCHECK` asks `/api/store` on the `WEBSERVER_HOST` and `WEBSERVER_PORT` the server is
  configured with, read like the server reads them: from the environment, else from a `.env` in
  `/srv/colibri`. A container with another web port, with `WEBSERVER_HOST=localhost` (which Node
  binds to `::1` there) or with a `BASE_URL` is healthy, where a check of a fixed
  `127.0.0.1:9011/` would leave it unhealthy for good, and restarted over and over by anything
  that acts on health.
- The server runs as the non-root `node` user (uid 1000). The image starts as root only long
  enough to give `/srv/colibri/data` to `node` - when something in it belongs to someone else, and
  never following a symlink - and then runs the server as `node`. So a bind-mounted directory that
  Docker creates, or a root-owned `data/` left by 1.x, works as it is; before, writing
  `store.json` failed with `EACCES` while `PUT /api/store` kept answering 201. Started with
  `--user`, the container cannot do this, and the server's own startup check reports that it
  cannot write there (see [Logging](#logging)). When `chown` fails - on a read-only mount, a file
  system without Unix owners, or without `CAP_CHOWN` - the entrypoint says so and starts the
  server anyway, which then checks whether it can write there. A `DATA_ROOT` outside
  `/srv/colibri/data` is not touched, and `docker exec` opens a root shell by default.
- Only `/srv/colibri/data` belongs to `node`. The server's own code stays root's, so the user the
  server runs as cannot change it, and `node_modules` and `dist` are no longer copied into a
  second layer by a `chown` of the whole directory, which saves about 17 MB.
- `node` itself is PID 1 (`CMD` is `node --enable-source-maps dist/server/main.js`, not
  `npm start`), so `docker stop`'s `SIGTERM` reaches the server and it shuts down cleanly.
- The image sets `NODE_ENV=production`.
- `docker-compose.yml` caps the container log at 5 × 10 MB, since client log lines now reach
  `docker logs` and Docker's default log never rotates.
- New `npm run test:docker` runs the image against a fresh bind mount, a root-owned 1.x data
  directory, a named volume, as `--user 1000:1000`, with the 1.x data mounted read-only, without
  `CAP_CHOWN`, and with a changed `WEBSERVER_PORT` or `WEBSERVER_HOST`.
- With [TLS](#tls) on, the health check asks over HTTPS without checking the certificate, so a
  container with a self-signed certificate is still reported healthy. `docker-compose.yml` has the
  TLS lines, commented out.

### Logging

- **Service log messages are printed to stdout and stderr**, one line each
  (`<ISO time> <LEVEL> [group/service] message`, errors and warnings on stderr), so they appear
  in `docker logs`: refused clients, `store.json` write failures, TCP worker crashes and restarts,
  and client log lines at their level. Before, they reached only the admin UI's in-memory log. New
  `CONSOLE_LOG_LEVEL` (`error`, `warn`, `info` or `debug`; default `info`, and an invalid value
  stops startup) and `CONSOLE_LOG_BROADCAST_TRAFFIC` (default `false`). Control characters are
  escaped and continuation lines indented, so text from a client cannot pass for a server line,
  and a message over 8 KiB is cut.
- **The server checks at startup that `DATA_ROOT` is writable.** If it is not, it prints a
  banner on stderr naming the path, the error and its uid, with a fix for that error - `chown`
  or a named volume for missing permissions, dropping `:ro` for a read-only mount, moving a file
  that is in the way, freeing space on a full disk - and logs an error in the admin UI. It keeps
  running without persistence, but no longer silently: before, `PUT /api/store` answered 201 and
  the only sign that nothing was saved was an `EACCES` in the admin UI's log.
- **`broadcast::` traffic is logged**, at Debug level and tagged `broadcastTraffic`, so the
  admin UI can show sync traffic between clients when asked to; see [Admin UI](#admin-ui).
- The shutdown and crash lines (`Received SIGTERM, shutting down...`, a shutdown step that
  failed, an uncaught exception, an unhandled rejection, a failed startup) are printed in the same
  format, as `[core/Server]`, and appear in the admin UI's log too.
- dotenv no longer prints its `injected env ... // tip` line on every start.
- The `Web server listening on` startup line is printed once the web server is listening. It used
  to be printed before the server had even tried its port, so it appeared when the port was taken
  too.

### Runtime, build & tooling

- Migrated `src/server` to native ESM (`"type": "module"`, explicit `.js` import extensions,
  `fileURLToPath` in place of `__filename`); the Angular UI build keeps working unaffected.
  `publish.js` → `publish.mjs`.
- `src/server/tsconfig.json` is now self-contained instead of extending the Angular root config:
  `strict`, `noUncheckedIndexedAccess`, `nodenext` module resolution, Node 24 target.
- Runtime bumped from `node:20-alpine` (EOL) to `node:24-alpine`; `@types/node` refreshed;
  `source-map-support/register` replaced with `--enable-source-maps`.
- Dependencies updated: Angular 17 → 22.1, Express 4 → 5, dotenv 16 → 17. engine.io 6.6.11 and
  qs 6.16.0 fix the advisories `npm audit` reported against them (GHSA-2gc4-cqfq-p2gv,
  GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g), and proxy-addr 2.0.8, which Express uses, fixes
  GHSA-jqcg-44mw-7w3h. That one concerns trusted proxy addresses, and the server trusts no
  proxy, so it could not be exploited here.
- `package-lock.json` un-ignored and committed; Docker build uses `npm ci` instead of `npm install`.
- Added Vitest (`test`/`bench` scripts), a `test/` unit suite, and a `bench/` harness
  (`connection-pool.bench.ts`, `data-store.bench.ts`, `framing.bench.ts`). Benchmark results are
  not committed: they depend on the machine and the Node version, so they belong in the pull
  request that claims them.
- Added `.github/workflows/lint-server.yml` (Node 24: build, lint, unit tests, admin UI tests and
  `test:vectors`), path-filtered on `colibri-server/**` and on the files `test:vectors` checks in
  colibri-unity and colibri-web.
- Removed `body-parser` (→ `express.json()`/`express.urlencoded()`), `uuid` (→
  `crypto.randomUUID()`), `source-map-support`, `flatbuffers` (removed once the v3 TCP protocol
  landed) and `lodash` (also from the admin UI, see [Admin UI](#admin-ui)).
- Version bumped `1.3.1` → `2.0.0`; dropped the blanket `eslint-disable no-unused-vars` in `main.ts`
  and cleaned up its unused imports.

### Hot-path performance

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
- **Apps without recipients cost nothing**: both the TCP and Socket.IO sides check whether an app
  has any client on that transport before touching the payload, instead of paying a full
  parse/stringify and encode for apps with zero clients there.
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
  20,000).
- **Log fan-out early-out**: `redirectLogMessage` skips `JSON.stringify` entirely when no `colibri`-app
  client is connected; the log bus is now a shared `Service`-level publish target instead of an
  init-time snapshot of the service list, so coverage no longer depends on construction order.

### v3 TCP protocol (breaking change)

- Replaced the v1 ASCII-length-delimited FlatBuffer framing with a fixed binary header (`u32` length +
  `u8` type + body), removing per-packet `toString('utf8')` and `indexOf('\0', …)` scanning and
  replacing the loose `Number.isFinite` length check with a real bounds check.
- Replaced per-`data`-event `Buffer.concat` with a persistent, growable read buffer with read/write
  cursors, which removes the O(n²) copy cost on fragmented streams. A frame over 5 MiB still ends
  the connection. See [Known limits](#known-limits) for what the buffer does not do.
- TCP payloads relay as raw bytes; `toString('utf8')` only happens where a hook actually needs the
  string, so TCP→TCP `broadcast::` traffic never becomes a JS string.
- A payload crosses between the TCP thread and the main thread, in either direction, in a buffer
  of exactly its own size. A small `Buffer` is usually a view into Node's shared 64 KiB pool, and
  `postMessage` copies the whole pool behind a view, so without this a 30-byte update would cross,
  and be kept alive on the other side, as 64 KiB.
- Egress now writes the header in place into one pre-sized `Buffer`: no separate `TextEncoder`, no
  merged `Uint8Array`, no FlatBuffer builder. The `flatbuffers` dependency and
  `modules/networking/message.ts` were deleted. Egress is bounds-checked like ingress: a message
  whose channel or command exceeds 64 KiB, or whose frame would exceed 5 MiB, is dropped and logged
  instead of throwing inside the TCP worker.
- Backpressure: writes are checked against `socket.writableLength`/a high-water mark, and a stale
  update is dropped rather than buffered without bound for a client that can't keep up. Only the
  start and the end of a dropping spell are logged, with the number dropped. Heartbeats and the
  answers to a client's own requests are not dropped; see
  [Load and lost connections](#load-and-lost-connections).
- Heartbeat and latency ping merged into a single 100 ms frame (the ping timestamp rides in the type
  `0x00` heartbeat), halving idle TCP packet rate. colibri-unity 2.0.0 echoes it, so the admin UI
  shows the latency of Unity clients too.
- A handshake body with more than three `::`-separated fields is rejected rather than silently
  truncated, and so is one with a field that starts or ends with `:`. App `app:` and name `name`
  make the body `2::app:::name`, which split back into app `app` and name `:name`, so the client
  joined another app than the one it announced without an error anywhere.
- Web clients may send messages as large as TCP clients: the Socket.IO server accepts packets of
  about 5.13 MiB (a 5 MiB payload plus channel and command), where engine.io's 1 MB default used to
  disconnect them.

Checked end to end against colibri-unity 2.0.0, with a decoding proxy in front of the TCP port:

- **Framing.** The handshake arrived as the documented `version::app::name` body with client
  version `2`. Message frames carried all 17 payload shapes in both directions, relayed
  **byte-verbatim**: a `broadcast::string` payload arrives as `"hello from unity round 1"`, 26 bytes
  for 24 characters, while the `log` channel's `verification log line 1` stays unquoted at 23 bytes
  for 23 characters. What a client sends is what the other side receives, quoting included, with
  no re-serialization in between - which is what `Payload` was meant to achieve.
- **Heartbeat/latency merge.** The 100 ms server heartbeat was echoed continuously by the Unity
  client; a raw client counted 369 heartbeats in one 40 s session, and the client-side 2 s watchdog
  never fired across many minutes of connected time.
- **Reconnect.** Killing the transport mid-session produced exactly one connection-reset message
  on the client, then a reconnect, a fresh handshake, and queued messages resuming with no gap in
  their numbering. No `FrameException` reached the client console and there was no retry spin, so
  neither side was left mid-frame by the drop.

The C# codec stays pinned to this server's encoder by byte-for-byte vectors in colibri-unity's
EditMode tests, which `npm run test:vectors` checks in CI.

### Load and lost connections

- **An overloaded server no longer queues TCP messages without bound.** The TCP thread passed
  every message to the main thread as fast as clients sent it, so a server taking in more than it
  could process kept a growing queue of them in memory, logged nothing, and relayed state that was
  older and older. Once the main thread is `TCP_INBOUND_BACKLOG_LIMIT` messages behind (default
  2000, `0` turns it off), `model::update` messages are held back per client and merged per
  object, so intermediate states are skipped but the latest value of every field still arrives,
  and `broadcast::` messages are dropped. Nothing else is ever held back or dropped, and a
  client's held updates are passed on before anything else it sends, and before it disconnects.
- **One client can no longer flood the server for everyone.** Each client, Unity or web, may send
  `CLIENT_MESSAGE_RATE_LIMIT` `model::update` and `broadcast::` messages a second (default 1000,
  `0` turns it off), in bursts of up to `CLIENT_MESSAGE_RATE_BURST` (default 2000, at least 1).
  Beyond that its messages are treated as above. A client syncing 10 objects 72 times a second
  sends 720, so this only catches a runaway send loop.
- An episode over either limit that lasts a second is one warning a second in, naming the setting
  (and the client), and one when it is over, with the number of updates held back and messages
  dropped. A shorter one is summed up in one line at debug level, unless it lost model updates:
  one client can have updates for at most 1000 objects held back at once, and an update for a
  further object is lost for good. Then the summary is a warning, however short the burst, and
  says `lost N model::update(s) for good`. See [Inbound limits](./protocol.md#inbound-limits).
- **A warning when one app has more clients than a typical app has.** Every message is
  relayed to every other client of the same app, so the server's work grows with the square of an
  app's size, and separate projects that all kept the same app name become one big app with
  nothing saying so.
  The server now logs a warning naming the app each time it grows past
  `APP_CLIENT_WARNING_THRESHOLD` clients (default 8, `0` turns it off), Unity and web together,
  the admin UI not counted.
- **A TCP client that has gone silent is disconnected.** A headset that leaves the Wi-Fi or goes
  to sleep sends no FIN, so its connection stayed open, listed as connected and keeping its app's
  synchronized models alive, until the operating system gave up on it many minutes later. A TCP
  client that has sent nothing at all for `TCP_IDLE_TIMEOUT_SECONDS` (default 10, `0` turns it
  off) is now disconnected as if it had closed the connection, with a warning naming it, and a
  connection that never handshakes is closed after the same time. Echoing the 100 ms heartbeat
  keeps a client connected. Every TCP connection also has keepalive switched on.
- **A client still reading a backlog is not taken for gone.** A TCP client that sends nothing of
  its own can only echo the heartbeats it has read, so one reading a large backlog stayed silent
  long enough to be disconnected by `TCP_IDLE_TIMEOUT_SECONDS`. The server now writes a heartbeat
  after every 64 KiB it sends, and never drops a heartbeat for a client that is behind. It queues
  at most one 100 ms heartbeat at a time for a client that is not reading, so a client that sends
  but never reads does not grow the server's memory.
- **A late joiner gets the whole store.** The 1 MiB backpressure drop applies to what is relayed
  from other clients, not to the server's answers to a TCP client's own requests: the models a
  `model::request` asks for, the client list, a `model::delete` answer. Those are queued however
  far behind the client is, up to 64 MiB per client, with a warning past that. Without this, a
  client joining on a link slower than loopback got only about the first MiB of a larger store,
  and nothing told it the rest was missing.

### Model synchronization

- **A deleted model stays deleted.** For `MODEL_TOMBSTONE_SECONDS` after a `model::delete`
  (default 600, `0` turns it off) the server keeps a tombstone for the id, per app and channel, at
  most 10,000 per app. An update for that id is meanwhile neither stored nor relayed, so an update
  another client sent just before the delete, or queued while it was offline, cannot create the
  object again for everyone.
- **Three forms of `model::request`.** `{}` asks for every model of the channel, as before. A
  fresh `{ id }`, from a client that has the object in its scene now or is creating it, lifts the
  tombstone and is answered with the bare `{ id }`. So any client can load a scene with placed
  objects of fixed ids again within that time, the client that unloaded it too, and also after a
  reconnect. A re-request after a reconnect, `{ id, again: true }`, is answered with
  `model::delete`, to the requester only, for a model that was deleted while the client was away,
  and the tombstone stays. colibri-unity and colibri-web 2.0.0 send the re-request form. See
  [Deleted models](./protocol.md#deleted-models).

### Correctness & robustness

- **Graceful shutdown**: `SIGTERM`/`SIGINT` now close the HTTP/Socket.IO/UDP servers, terminate the TCP
  worker thread, flush the REST store, and exit 0; `startup()` is awaited with a `.catch`, and
  `unhandledRejection`/`uncaughtException` handlers log, flush the REST store and exit non-zero.
- **One bad message costs one message.** A command hook that throws on a malformed message logs an
  error and drops that message; the throw used to shut the whole server down. A Socket.IO event
  without a `payload` key no longer crashes the process on its way to a TCP client, and one
  without a `command` is logged and ignored.
- **The TCP transport recovers.** A TCP worker thread that exits unexpectedly has its clients
  reported as disconnected and is restarted, up to five times; before, HTTP and Socket.IO kept
  serving while every TCP client was silently gone.
- **VoiceServer hardening**:
  - A datagram shorter than the 7-byte voice header, or one from UDP source port 0, used to crash
    the server; both are dropped now.
  - The `throw err` inside the UDP send callback that crashed the whole process on a transient send
    failure is gone, and a peer that cannot be sent to no longer stops the relay to the others.
  - Malformed packets and relay failures are logged at most once per source or peer every 10 s.
  - The client key is computed once per packet instead of up to four times; the peer list is
    precomputed instead of re-scanning the client `Map` per packet; recordings are stored in a
    growable `Int16Array` instead of a boxed-number array, and saved with `fs/promises` and a
    recursive `mkdir`. A recording is no longer saved twice when saving takes longer than the
    disconnect check's 1 s tick.
  - With `VOICE_RECORDING=true`, stopping the server (`docker stop`, a restart, a crash) saves
    every recording still in progress and logs each save. A recording used to be written only
    once its client had been quiet for 2 s, so stopping the server while anyone was talking lost
    their audio without a word. Saves are logged at info level with the client, the length and
    the file path.
  - Saving a recording does not block the server: the `.wav` header is written directly and the
    samples are written asynchronously, so relaying is not held up for seconds when a long
    recording is saved.
- **Admin log**: a malformed `colibri::log` `requestLog` payload (e.g. `{ levels: 1 }`) from any
  client no longer crashes the server; invalid fields fall back to their defaults. The index that
  merges repeated log lines is bounded by the 20,000-entry history instead of growing forever.
- **Latency**: a `latency` message without a timestamp is skipped instead of being recorded as a
  sample of several million milliseconds.
- **TCP disconnect handling**: `'close'` is now subscribed, and `handleSocketDisconnect` is guarded so
  `clientDisconnected$` fires exactly once per client instead of twice.
- **Config validation**: startup now fails fast on `NaN`/out-of-range environment values instead of
  silently coercing to `NaN`. An absolute `DATA_ROOT` or `WEBSERVER_ROOT` is used as given; it used
  to end up nested under `dist/server`.
- **Stack traces**: `Error.stackTraceLimit` is configurable (`STACK_TRACE_LIMIT`, default 30)
  instead of `Infinity`, and `Service.logError` no longer defaults `printStacktrace` to `true` at
  call sites that already carry context.

### REST store

- **Any JSON value up to 5 MiB.** `PUT /api/store/:app/:name` takes numbers, strings, booleans and
  `null` as well as objects and arrays, and bodies up to 5 MiB. colibri-unity's
  `Store.Put(name, 42)` and colibri-web's `setRestObject(key, 'text')` used to get HTTP 400, and
  anything over 100 kB got 413.
- **Any name is an ordinary name.** The store is keyed by `Map`s, so app and value names like
  `__proto__`, `constructor` or `toString` are stored like any other. Before,
  `DELETE /api/store/constructor/keys` broke every HTTP route until a restart, and
  `PUT /api/store/__proto__/x` wrote onto `Object.prototype`. The `store.json` format is unchanged.
- **Errors are JSON**, `{ "error": … }`, with no stack trace or file path, and are logged. `400`
  (malformed JSON) and `413` (too large) keep their status, and every response, errors included,
  carries the CORS headers, so a browser client sees the error rather than a network failure.
- Overwriting an existing value answers 200 for a falsy value (`0`, `false`, `''`, `null`) too;
  it used to answer 201.
- **A request under `/api` that no API route handles gets 404**, with a JSON error, instead of 200
  and the admin UI page. A wrong method or path, such as `POST /api/store/app/name`, stored nothing
  and looked successful.
- **A `PUT` without a JSON body is refused.** With no body, an empty one, or a `Content-Type`
  other than JSON or form data (`text/plain`, say), `PUT /api/store/:app/:name` answers 400 with
  an error that names `Content-Type: application/json`, and stores nothing. It used to store
  `undefined` - a name listed under its app that `GET` and `DELETE` then answered 404 for - or,
  for an empty JSON body, `{}`. colibri-unity's `Store` and colibri-web's `setRestObject` send a
  JSON body for every value, `null` included, except that `setRestObject(key, undefined)` sends
  none: it now gets `false` back and stores nothing, where it used to store `{}`. Store `null`
  instead. Form data (`application/x-www-form-urlencoded`) is still parsed into an object of its
  fields and stored, up to 100 kB, as in 1.3.1. That is what `curl -d` sends without
  `-H 'Content-Type: application/json'`, so `curl -X PUT -d '{"x":1}'` stores
  `{"{\"x\":1}": ""}` rather than answering 400.
- Saving `store.json` is debounced (~250 ms) and atomic (write `store.json.tmp`, then rename), and
  a save waits for the one still in flight, so two quick writes cannot interleave into a partial
  file. The store is flushed on crash paths as well as on a clean shutdown, but only when it holds
  something `store.json` does not, so stopping a server that cannot write its `DATA_ROOT` no
  longer logs an `EACCES` when nothing changed. A save that failed is tried again at the latest
  at shutdown.
- The store is loaded in `Service.init()` via `fs/promises`, so requests can no longer be served
  before it has loaded. A `store.json` whose top level, or one of whose apps, is not a JSON
  object is skipped with an error instead of breaking every request.

The endpoints are documented under [REST store](./protocol.md#rest-store).

### Admin UI

- The Log page filters by level (Error, Warn, Info, Debug) as well as by app, and has a separate
  *Sync traffic* switch, off by default, for the `broadcast::` messages. The server applies both
  filters, so the page is only sent what it shows.
- Repeated log lines are merged into one entry with a count however much other traffic arrives in
  between, and a merged entry updates on screen.
- The SPA fallback no longer adds a log entry every time an admin UI page is loaded.
- The admin UI keeps its dark theme whatever colour scheme the visitor's system prefers.
- Replaced the dead Karma/Protractor `test`/`server-app-e2e` targets in `angular.json` (both pointed
  at files that never existed) with Angular's first-party `@angular/build:unit-test` builder
  (Vitest runner); specs for `LogService`, `ClientService` and the log filters run in CI as
  `npm run gui:test`.
- Replaced `socketio.service.ts`'s `_.throttle` NgZone-batching with RxJS `throttleTime`; `lodash`
  and `@types/lodash` are removed from `package.json`.
- Fixed the services barrel (`src/ui/app/services/index.ts`) to re-export `ClientService`, matching
  `SocketIOService`/`LogService`.
- Replaced `RootComponent`'s direct `location.pathname` read with the Angular `Router`, fixing the
  tab-underline indicator not updating on browser back/forward navigation.
- Self-hosted fonts via `@fontsource/roboto` and `@fontsource/fira-mono`, and dropped the Material
  Icons webfont in favor of the already-loaded `primeicons`; the UI no longer loads anything from
  `fonts.googleapis.com`/`fonts.gstatic.com` at runtime.
- Migrated `LogService`/`ClientService`'s materialized state (message list, client list, filter,
  broadcast-traffic toggle) from `BehaviorSubject` to Angular signals/`computed()`, and converted
  `@Input()`/`@ViewChild` to `input()`/`viewChild()` across the log and latency-chart components,
  applying `OnPush` app-wide. Socket.IO's streaming ingestion layer (`SocketIOService`) stayed RxJS
  deliberately: it's a better fit for multiplexed async event streams than for synchronous snapshot
  state. Zoneless change detection was evaluated and deliberately deferred (the D3 latency chart
  renders entirely outside Angular's template bindings, and the zone-throttle mechanism above only
  exists because zone.js CD is expensive on this app's bursty socket traffic). This makes a future
  zoneless flip cheaper and safer, but doesn't attempt it.

### Deprecations (kept, not deleted)

- Added `@deprecated` JSDoc to `modules/core/serializable.ts`, `modules/core/error-handler.ts`,
  `modules/core/redirect-console.ts`, and `DataStore.addModel`/`DataStore.clear`.

### Tests added

- Unit tests (`npm test`) for the v3 frame parser and encoder (byte-by-byte and split
  fragmentation, coalescing, oversized and malformed frames, the 1.x framing), `DataStore`
  (including both original key bugs), `ConnectionPool`, `Payload` (memoization and the
  `undefined`/`null`/empty-string/invalid-JSON edge cases), the TCP worker and its proxy, the
  Socket.IO server against real `socket.io-client` sockets, the REST store and web server, the
  voice server, `WebLog`, `ClientLogger`, `BroadcastLogger`, the console log, the `DATA_ROOT`
  check, the configuration, the ring buffer, the deprecated serialization helpers, and the inbound
  limits: the backlog count, the rate limit and the merging of held updates, on both transports.
- `npm run test:vectors` checks the cross-implementation protocol vectors in colibri-unity's
  `ProtocolVectorTests.cs` against this server's encoder.
- `test/tcp-client-test.ts` (`npm run test:tcpclient`) speaks the v3 framing, decodes frames and
  echoes heartbeats; a unit test runs it against a stand-in server for each of its exit codes, and
  checks that no script under `test/` hard-codes the protocol version it handshakes with. Manual
  probes for end-to-end runs: `test/tcp-wire-tap.ts` (a proxy that decodes every frame in both
  directions), `test/tcp-crosstalk-check.ts`, `test/model-inject.ts`, `test/broadcast-inject.ts`
  and `test/stress-echo-peer.ts` (`npm run test:stressecho`).
- `npm run test:tcpclient` and `test/tcp-crosstalk-check.ts` take `--tls`, `--insecure` and
  `--host`, and print the fingerprint of the server's certificate. `npm run test:docker` has a TLS
  deployment. The TLS tests make their certificates with `openssl`, which has to be on `PATH`.

### Documentation

- Added `docs/protocol.md`: which messages the server relays, the v3 framing, version checking and
  detecting an out-of-date server, the payload shape of every `broadcast::` command, size limits,
  the inbound limits with the warnings as the server prints them, the server's own channels,
  model synchronization and the REST store. For models it covers the three `model::request` forms
  (`{}`, a fresh `{ id }`, a re-request `{ id, again: true }`), tombstones, and what each client
  does after a reconnect; under backpressure, that answers and heartbeats are not dropped at the
  1 MiB mark, and that the 100 ms heartbeat is skipped while one still waits. Its known limits
  say that a colibri-unity object that changed during an outage reaches a server that forgot it
  with only the changed fields.
- README updated for the Node 24 requirement, the v3 protocol, a Docker setup that works outside a
  checkout, the configuration variables (`MODEL_TOMBSTONE_SECONDS` included), where logs go, the
  load limits, and the npm scripts. Its Docker example does not set `tty: true`, which left
  `docker logs` without stderr, and it says to mount data at `/srv/colibri/data` rather than move
  `DATA_ROOT`.

### Known limits

- The TCP read buffer compacts after every `data` event that leaves a partial frame behind (a copy
  of that partial frame), rather than only past a threshold, and it never shrinks: a connection
  that once received a large frame keeps a buffer of up to 8 MiB until it closes.
- A client that falls more than 1 MB behind on TCP misses messages relayed from other clients
  without being told; see [Backpressure](./protocol.md#backpressure).
- A client over an inbound limit is not told either that its updates were held back or its
  broadcasts dropped; only the server's log says so. See
  [Inbound limits](./protocol.md#inbound-limits).
- After a reconnect, clients catch up on deletions only within `MODEL_TOMBSTONE_SECONDS` of the
  delete, and colibri-web only for the models it registered itself; see
  [Known limits](./protocol.md#known-limits) in the protocol docs.

### Deferred work

Not part of this release:

- **Batched `model::request` reply.** Left as one `model::update` per model (`model-sync.ts` still
  loops `connectionPool.emit(...)`), to avoid a coordinated breaking change with colibri-web's
  `ModelSynchronization.ts` and colibri-unity. The unbatched path is exercised against a Unity
  client: in the end-to-end run a late joiner re-created a model from stored state via
  `model::request` with every synced member applied, as exactly one instance.
- **Security hardening**, by design: Colibri is meant for local networks you trust and
  authenticates nobody. There is no handshake token, the app name `colibri` is what makes a client
  the admin UI, CORS allows any origin, there are no connection caps, and [TLS](#tls) is off
  unless `TLS_CERT` and `TLS_KEY` are set; the per-client message rate limit is there to catch a
  runaway send loop, not a hostile client, which can open as many connections as it likes. Model objects are plain objects, not null-prototype ones. The
  voice relay forwards every voice packet to every other voice client, whatever its app. The
  structural changes that would have come first (Socket.IO rooms, `Map` keying in `DataStore` and
  the REST store, bounds checks on TCP ingress and egress) landed anyway, on performance and
  robustness grounds.
