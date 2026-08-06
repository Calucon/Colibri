# Protocol version check

> **Status: done.** Implemented on the `protocol-version-check` branch; the behaviour is
> documented under `colibri-server/docs/protocol.md#version-checking`.

## Context

**Protocol version mismatch is invisible.** Both transports already put a version string on the
wire, the server stores and logs it, and then nothing compares it to anything. A client built
against the wrong protocol gets an infinite silent reconnect loop with no diagnostic.

Work happens on a dedicated branch off `colibri-unity-v2`, e.g. `protocol-version-check`.

---

## Implementation

### Current state

| Where | Sends | Server does |
|---|---|---|
| Unity | `CLIENT_VERSION = "2"` (`WebServerConnection.cs:33`, sent at `:389`) | parses (`protocol.ts:189-200`), stores (`tcp-server-worker.ts:319-343`), logs at debug, forwards on `clientConnected$` |
| colibri-web | `query: { app, version: '2' }` (`Colibri.ts:50`) | reads `handshake.query.version` (`socket-io-server.ts:133`) |
| Admin UI | `query: { app: 'colibri', version: '1' }` (`src/ui/app/services/socketio.service.ts:18`) | same |

Nothing is ever compared. There is no server-side protocol version constant at all, and
`docs/protocol.md:15-20` states outright that there is no negotiation.

⚠ **The admin UI still declares `version: '1'`.** A naive strict check locks you out of your own
console. Bump it to the shared constant *and* exempt `app === 'colibri'` from rejection (warn only).

### Server (`colibri-server`)

1. `src/server/modules/networking/protocol.ts` — export `PROTOCOL_VERSION = '2'` next to
   `MAX_FRAME_LENGTH`, as the single source of truth for both transports.
2. `src/server/modules/networking/tcp-server-worker.ts` — in `assignApp` (`:319`), compare
   `version` against `PROTOCOL_VERSION` before `addToAppIndex`. On mismatch: `logError` naming
   client name, address and both versions; write the rejection frame (below); `socket.end()`; do
   **not** index the client or post `clientConnected$`, so no half-connected ghost reaches the admin
   UI.
3. `src/server/modules/networking/socket-io-server.ts` — same check in `handleNewClient` (`:128`),
   after the existing empty-`app` guard, skipped for `app === 'colibri'`. `socket.emit` the
   rejection, then `socket.disconnect(true)`.
4. Rejection message: a normal message frame on the `colibri` channel, command
   `protocol::rejected`, payload `{ serverVersion, clientVersion, reason }`. Chosen over a
   server→client `0x01` handshake frame because it works identically on both transports and carries
   a reason string. It is safe for existing 2.0.0 clients: `Sync.cs`'s command switch has no
   `default` case, so an unknown command is silently ignored, and web's `onSocketAny` just surfaces
   it on `messages`.
5. `src/ui/app/services/socketio.service.ts:18` — `version: '2'`.

State plainly in the docs what this cannot do: a client whose *framing* differs (a real v1↔v3
mismatch) cannot be told anything, because it cannot parse the reply. For that case the server-side
log plus the Unity-side heuristic in step 9 is the whole answer.

### Unity (`colibri-unity`)

6. `Assets/Colibri/Networking/WebServerConnection.cs` — intercept `colibri` /`protocol::rejected` in
   the `FrameType.Message` branch (`:442-449`) **before** enqueuing to `_queuedCommands`, so it is
   never user-observable as an ordinary message. Record the server version, `Debug.LogError` naming
   both versions and the required upgrade.
7. Same file, `RunConnectionLoop` (`:302-364`) — a version mismatch is not transient. Break out of
   the retry loop instead of reconnect-storming; surface it as a terminal state rather than
   `Disconnected`.
8. Expose `ServerVersion` alongside the existing `ClientVersion` (`:531`), and render a red mismatch
   line in `Assets/Colibri/Setup/ColibriStatusWindow.cs:125`, which already prints
   `Protocol v{ClientVersion}`.
9. Heuristic for the un-tellable case: count consecutive sessions that fault with `FrameException`
   before a single successful frame. After 3, log "this looks like a protocol mismatch — check your
   server version" instead of continuing to retry silently.

### Web (`colibri-web`)

10. `src/ColibriError.ts` — add `ProtocolMismatchError extends ColibriError`.
11. `src/Colibri.ts` — handle `colibri`/`protocol::rejected` in `onSocketAny` (`:69`): call
    `this.socket.io.reconnection(false)` so socket.io stops retrying, then surface the error.
    Export the new type from `src/index.ts`.

### Docs

12. `colibri-server/docs/protocol.md:15-20` and its Handshake section, `colibri-server/README.md`,
    `colibri-unity/README.md:8`, `MIGRATION.md:17` — replace "there is no version negotiation" with
    what actually happens now: no *negotiation*, but a hard check and a named rejection.
13. CHANGELOG entries in all three packages.

---

## Verification

- `cd colibri-server && npm test` — extend `test/unit/protocol.test.ts` for the constant and
  `test/unit/tcp-server-worker.test.ts` for accept-on-match / reject-and-disconnect-on-mismatch,
  including the `colibri` admin-app exemption.
- Raw-peer end-to-end: adapt `colibri-server/test/stress-echo-peer.ts` (it already builds a
  handshake via `encodeHandshakeFrame`) into a peer that announces a wrong version, and watch the
  rejection frame with `colibri-server/test/tcp-wire-tap.ts`, which already decodes handshakes.
- `cd colibri-web && npm test` and the e2e suite; add a mismatch case to
  `e2e/connection.e2e.test.ts`. `e2e/globalSetup.ts:40` also hardcodes `version: '2'` — keep it
  matching.
- `node colibri-unity/run-tests.mjs` — EditMode 91 / PlayMode 72 must stay green. Add a case to
  `Assets/Tests/ConnectionTests.cs` driving the rejection through the existing `E2EServer.cs` /
  `TcpPeer.cs` harness: assert the error is logged, the status reflects the mismatch, and the
  reconnect loop stops.
- Manual: run the server, open the admin UI, confirm it still connects after the `version: '2'`
  bump, and confirm a deliberately mis-versioned Unity client shows the red line in
  `Window → Colibri Status` instead of retrying forever.

---

# Follow-up: detecting an out-of-date server

> **Status: done.** Same branch; documented under
> `colibri-server/docs/protocol.md#detecting-an-out-of-date-server`.

Everything above is server-side, which leaves the mirror image uncovered. A server predating the
check has no check to run: it never refuses anyone and never says what it speaks, so *old server,
new client* stays silent. On the web side that is invisible — the Socket.IO envelope did not change
between v1 and v2, so the connection genuinely works and simply never gets the newer behaviour.

### What was built

14. `colibri-server` — `protocol.ts` exports `PROTOCOL_ACCEPTED_COMMAND` and
    `protocolAcceptance()`; `socket-io-server.ts` emits `colibri`/`protocol::accepted` with
    `{ serverVersion }` immediately after the version check passes, before the client is indexed.
15. `colibri-web` — `Colibri.ts` arms a 5 s timer on connect, cleared by that announcement; on
    expiry it emits a **non-fatal** `ProtocolMismatchError` and **stays connected**. Guards against
    the two false positives that matter: a socket that is no longer connected, and a hidden browser
    tab (re-arm rather than report — a frozen tab stops draining the socket while timers keep their
    own schedule).
16. `colibri-web` — `ProtocolMismatchError.fatal` separates a refusal (connection gone) from this
    suspicion (connection live). A behavioural change to an API added earlier on this same branch.
17. `colibri-unity` — the step-9 heuristic already fires against a v1 server, so the work was in
    *reporting* it: a separate `SuspectedProtocolMismatch` string rather than `Status`, which the
    retry loop overwrites on the next iteration, plus a `ColibriStatusWindow` warning. Also closed
    the EOF hole, where a session that ended without a frame *reset* the counter.

### The design that was wrong, and why it is worth remembering

The first approach inferred the server's age from the 100 ms `colibri`/`latency` broadcast, on the
basis that v1 has no such hook — true of the `v1.1.2` tag in this repo, which is what was read.

It is false of the servers people actually run. Docker Hub carries `hcikn/colibri` **1.2.0, 1.3.0
and 1.3.1**, all newer than that tag, and `measure-latency` landed in **1.2.0**. So every 1.2.x and
1.3.x server sends the beat while still speaking the old protocol, and the check quietly passed
them as current. Caught only by running against the published images.

No zero-server-change discriminator exists — the envelope and the `client::connected` payload both
carry `version`, and the relay behaviour is identical — so an explicit announcement was the only
way to cover the 1.1.1+ range that was asked for.

**Read tags against what is deployed, not what is in the repo.**

### Verification

- Unit and e2e as above, plus web cases pinning the false positives: a beat inside the window, a
  disconnected socket, a hidden tab, a refusal followed by no second report, and — the case that
  makes the check worth anything — a busy server sending `broadcast::*`, `model::update` *and*
  `latency` with no announcement must still report.
- Unity `ProtocolMismatchDetectionTests.cs`: a fake v1 listener writing `'\0\0\0h\0'` every 100 ms
  must set `SuspectedProtocolMismatch`; a closed port must not, since that is "server not running".
- Live against `hcikn/colibri:1.1.1`, `1.2.0` and `1.3.1`: all three warn, and traffic relays in
  both directions on all three — which is the evidence for warning rather than disconnecting.
