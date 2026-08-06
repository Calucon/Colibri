# Colibri wire protocol

Colibri relays real-time object synchronization between two kinds of clients:

- **Unity clients** connect over raw **TCP** using the binary framing described below.
- **Web clients** connect over **Socket.IO** and are unaffected by anything in this document.

Both transports carry the same logical `{ channel, command, payload }` message shape into the
server's `ConnectionPool`, which is transport-agnostic - a message received on one transport can be
broadcast to clients on the other. The server never needs to look inside a message's payload
except in a handful of hooks (`ModelSynchronization`, `MeasureLatency`, `WebLog`,
`ClientLogger`) that explicitly parse it via the `Payload` abstraction
(`src/server/modules/core/payload.ts`).

## v3 TCP framing (breaking change from v1)

> **This is a breaking protocol change.** A `colibri-unity` client built against the old v1
> flatbuffer framing cannot talk to a v2.0.0+ server, and vice versa. There is no version
> *negotiation* - the server accepts exactly one protocol version and refuses every other one,
> so both sides must be upgraded together. See [Version checking](#version-checking).

Every frame on the wire has a fixed-size header followed by a type-specific body:

```
[u32 LE totalLength][u8 type][body]
```

- `totalLength` is the number of bytes **after the length field itself** - i.e. `1 (type) +
  body.length`. A reader knows a full frame is available as soon as it has buffered
  `4 + totalLength` bytes.
- `type` is one of the three values below.

| type | name      | body |
| ---- | --------- | ---- |
| `0x00` | heartbeat | `[u64 LE pingTimestamp]` |
| `0x01` | handshake | utf8 `"version::app::name"` |
| `0x02` | message   | `[u16 LE channelLen][channel utf8][u16 LE commandLen][command utf8][payload bytes]` |

All integers are little-endian. Strings inside a body are length-prefixed, not
null-terminated - there is no delimiter scanning anywhere in the parser.

### Handshake

A client must send a `handshake` frame immediately after connecting, before sending anything
else. `version`, `app`, and `name` are `::`-joined into the body as plain utf8 text (none of the
three may themselves contain `::`). The server assigns the connection to `app` and begins
including it in that app's broadcasts; any `message` frame received before the handshake is
rejected and logged.

### Version checking

`version` is checked against `PROTOCOL_VERSION` in
[`protocol.ts`](../src/server/modules/networking/protocol.ts), currently `2`. This is a check,
not a negotiation: there is one supported version at a time, and there is no subset a v1 and a
v3 client could both speak, so a client announcing anything else is **refused**, not downgraded.

A refused client is never added to its app's broadcast set and never reaches
`clientConnected$`, so it does not appear in the admin UI. The server first sends it a normal
message frame explaining why, then closes the connection:

| field | value |
| --- | --- |
| channel | `colibri` |
| command | `protocol::rejected` |
| payload | `{ "reason": string, "serverVersion": string, "clientVersion": string }` |

The same applies to Socket.IO clients, which announce their version in the handshake query
(`?app=…&version=…`) and receive the identical `colibri` / `protocol::rejected` event before
being disconnected. The one exception is the admin UI (`app === 'colibri'`), which ships with
the server and is warned about rather than refused - a check that can lock you out of your own
console is worse than the mismatch it detects.

**What this cannot do.** Three gaps, all deliberate:

- The refusal only reaches a client whose *framing* the server still speaks. A genuine v1 client
  cannot decode the frame at all, so for that case the server-side error log - which names the peer
  and both versions - is the whole diagnostic. Clients cover the remaining gap heuristically:
  `colibri-unity` reports a likely protocol mismatch after three consecutive sessions that fault
  before a single frame could be read, instead of reconnecting silently forever.
- It only reaches a client that *handles* `protocol::rejected`. Any colibri-web published before
  this check existed surfaces the rejection as an ordinary message and is then disconnected for
  good - Socket.IO does not reconnect after a server-side `disconnect()` - with nothing logged on
  the client. See [MIGRATION.md](../../MIGRATION.md).
- The `app === 'colibri'` exemption is by app name, so any Socket.IO client naming itself `colibri`
  opts out of the check entirely. That app name is reserved for the admin UI and also collides with
  the `colibri` control channel; it is not a name an application should be using.
- It says nothing about a server that is *itself* out of date, since the check only runs on the
  server. Clients infer that separately and can only ever suspect it - see
  [Detecting an out-of-date server](#detecting-an-out-of-date-server).

Clients must keep their announced version in step with this constant:
`CLIENT_VERSION` in `colibri-unity`'s `WebServerConnection.cs`, `PROTOCOL_VERSION` in
`colibri-web`'s `Colibri.ts`, and the `version` query in the admin UI's `socketio.service.ts`.

**This is not the release version, and does not move with one.** It names the wire format, and
nothing derives it from a `package.json`. A 2.0.1 bugfix and a 2.1.0 feature release both still
announce `2`, so every combination of 2.x client and 2.x server interoperates - a client is
refused only when the *wire format* it speaks differs, never because the two sides ship different
release numbers.

| change | `PROTOCOL_VERSION` | effect |
| --- | --- | --- |
| 2.0.0 → 2.0.1, bugfix | `2` | none, freely interoperable |
| 2.0.0 → 2.1.0, new features, same wire format | `2` | none, freely interoperable |
| a frame layout, field or encoding changes | `2` → `3` | **every deployed client is refused at once** |

That last row is the whole cost of bumping it, and the whole point. Bump it only when an existing
client would otherwise misread the bytes on the wire - not to signal that something was added.
Adding a new `command` is not a wire-format change: unknown commands are ignored by every client
(Unity's `Sync` switch has no default case, and colibri-web dispatches per registered channel).

### Detecting an out-of-date server

Everything above is server-side, which leaves the mirror image uncovered: a server predating the
check has no check to run, so it never refuses anyone and never says what it speaks. A client
facing one has only inference from absence to work with.

So a current server **announces itself**. Immediately after accepting a Socket.IO client - before
any application traffic - it sends:

| field | value |
| --- | --- |
| channel | `colibri` |
| command | `protocol::accepted` |
| payload | `{ "serverVersion": string }` |

| | how it notices | how long it takes | what it does |
| --- | --- | --- | --- |
| `colibri-web` | no `colibri`/`protocol::accepted` within 5s of connecting | 5s | warns, emits a **non-fatal** `ProtocolMismatchError` (`fatal: false`, `serverVersion: '<2.0.0'`), **stays connected** |
| `colibri-unity` | 3 consecutive sessions accepted but ended before a frame decoded | ~4s (500/1000/2000ms backoff) | warns, sets `SuspectedProtocolMismatch`, keeps retrying |

TCP clients are sent no announcement and need none: the framing itself changed incompatibly in
2.0.0, so a pre-2.0.0 server is already unmistakable to them.

**Why an explicit message rather than an inference from existing traffic.** The 100ms `latency`
broadcast is the obvious candidate and is wrong: it was added in colibri-server 1.2.0, so keying on
it silently accepts every 1.2.x and 1.3.x server as current. Verified against the published
`hcikn/colibri:1.1.1` and `hcikn/colibri:1.3.1` images - 1.1.1 sends no beat, 1.3.1 sends it while
still using the old `\0\0\0` framing. Nothing else a web client can observe separates them either:
the Socket.IO envelope, the `client::connected` payload (both carry `version`) and the relay
behaviour are identical.

Two things follow from this being a guess rather than something the server said, and both are
deliberate:

- **Neither is terminal.** `colibri-web` does not disconnect, because the Socket.IO envelope did
  not change between v1 and v2 - a current web client against a 1.x server genuinely works, and
  tearing that down over a version suspicion would turn a warning into an outage. `colibri-unity`
  keeps retrying and leaves `Status` alone; `ConnectionStatus.ProtocolMismatch` and
  `ProtocolMismatchReason` stay reserved for a refusal that was actually received and decoded.
- **Neither can be certain.** `colibri-unity`'s symptom reads identically if the address points at
  a TCP port that is not Colibri at all, which is why it is scoped to sessions that got past the
  handshake - "connection refused" is a server that is switched off, not a version problem, and
  must never be reported as one. `colibri-web`'s can in principle be tripped by a server whose
  event loop stalls for five seconds; it re-arms rather than reporting while the browser tab is
  hidden, since a frozen tab is the likeliest way to see that without a real stall.

A web client facing an old server is warned, not cut off, because it genuinely still works -
confirmed by running a current client against both images, with traffic relayed in both directions
each time. Unity against the same servers cannot work at all, which is why its side of this is
about naming the cause rather than deciding whether to continue.

### Heartbeat / latency

The server sends a `heartbeat` frame to every connected client (handshaked or not) every 100ms,
carrying `process.hrtime.bigint()` as the ping timestamp. A client is expected to echo the frame
back verbatim. The server relays an echoed heartbeat into the normal message pipeline as a
synthetic `colibri`/`latency` message so `MeasureLatency`'s round-trip accounting handles it the
same way it handles a web client's latency ping - this is the only place a `heartbeat` frame
travels client→server. Merging the heartbeat and the latency ping into one frame halves the idle
per-client packet rate compared to running them as two independent 100ms timers.

Socket.IO clients are not sent that frame - they get a `colibri`/`latency` event directly, also
every 100ms, from the same `MeasureLatency` timer.

**This is not a version signal.** The latency broadcast looks like one - only a current server
sends it, surely? - but it was added in colibri-server **1.2.0**, so every 1.2.x and 1.3.x server
sends it while still speaking the old protocol. Detecting an out-of-date server keys on
`protocol::accepted` instead, for exactly this reason.

### Message

Carries an application message: `channel` and `command` identify the message (e.g. channel
`myApp::position`, command `model::update`), and `payload` is an opaque byte range - the server
relays it verbatim to other TCP clients without ever decoding it as a string, and only decodes it
(via `Payload.fromBytes(...).asValue()`) when a hook needs to inspect it or when relaying
cross-transport to a Socket.IO client.

### `broadcast::` commands

`command`s prefixed `broadcast::` are a convention, not a protocol-level concept: they identify
app-to-its-own-clients sync traffic (state/position ticks and similar) relayed through the server,
as opposed to one-off application messages. `BroadcastLogger`
(`src/server/modules/command-hooks/broadcast-logger.ts`) matches on that prefix and logs each one
at Debug level, tagged `metadata.broadcastTraffic = true`. The admin log page's "Sync traffic"
toggle filters on that tag specifically - independent of the Error/Warn/Info/Debug level
checkboxes - since this traffic is typically continuous and would otherwise drown out everything
else; see `WebLog.isVisibleToClient` (`src/server/modules/web/web-log.ts`).

#### Payload shapes

The server never inspects a `broadcast::` payload, so the shape is an agreement between the
clients alone. It went unwritten through v1 and v2, and each implementation duly invented its own
for colour. This is the agreement:

| command | JSON payload | colibri-unity | colibri-web |
| --- | --- | --- | --- |
| `broadcast::bool` | `true` | `Send(ch, bool)` | `sendBool` |
| `broadcast::int` | `5` | `Send(ch, int)` | – (see below) |
| `broadcast::float` | `1.5` | `Send(ch, float)` | `sendNumber` / `sendFloat` / `sendInt` |
| `broadcast::string` | `"text"` | `Send(ch, string)` | `sendString` |
| `broadcast::vector2` | `[x, y]` | `Send(ch, Vector2)` | `sendVector2` |
| `broadcast::vector3` | `[x, y, z]` | `Send(ch, Vector3)` | `sendVector3` |
| `broadcast::quaternion` | `[x, y, z, w]` | `Send(ch, Quaternion)` | `sendQuaternion` |
| `broadcast::color` | `"#RRGGBBAA"` **or** `[r, g, b, a]` | `Send(ch, Color)` → string | `sendColor` → array |
| `broadcast::json` | any object | `Send(ch, JToken)` | `sendJson` |

Append `[]` to any command for the array form, whose payload is an array of the above (so
`broadcast::vector3[]` is `[[x,y,z], …]`). Two commands need more than a row:

**Colour has two forms on the wire, and receivers must accept both.** Unity writes the HTML string
`ColorUtility.ToHtmlStringRGBA` produces; colibri-web writes `[r, g, b, a]` with each component
0-1. Neither can be changed now without breaking the peers already sending it, so both clients
take either form on receive - `JsonExtensions.ToColor` in colibri-unity, `ColorValue` plus the
exported `toHexColor`/`toRgbaColor` in colibri-web - and a wrong-shaped payload warns and falls
back to opaque black rather than throwing. A `[Sync] Color` model field is subject to the same
split, since it serializes through the same conversions.

**`broadcast::int` is send-side Unity-only.** JavaScript has one number type, so colibri-web
cannot tell `5` from `5.0` and always emits `broadcast::float`; `sendInt` is an alias kept for
API symmetry with Unity. Unity routes the two commands to separate listener lists, so a Unity
client must receive web-sent numbers with `Sync.Receive<float>`. The reverse works: colibri-web's
`receiveNumber` listens for both commands.

**`log` is the one channel that is not JSON.** `ClientLogger` treats a payload on it as human
readable text, so colibri-unity sends it as raw utf8 (`WebServerConnection.EncodePayload`) and the
server unwraps a JSON string value before logging it - otherwise a web client's log line reaches
the admin UI with the JSON quotes still around it.

### Reading frames off the wire

`FrameReader` (`src/server/modules/networking/protocol.ts`) is a growable buffer with read/write
cursors that TCP data events are appended into. It yields every complete frame currently
buffered and only copies the trailing partial frame (never the whole stream) when compacting -
this is what keeps a long-lived, frequently-fragmented connection from paying an
O(streamLength²) `Buffer.concat` cost. A malformed or oversized frame (declared length `<= 0` or
greater than the reader's configured max) throws `FrameError`, which the caller treats as fatal
for that connection - the same behavior as the old `maxBufferSize` kill-switch.

### Backpressure

Before writing a frame to a client's socket, the server checks `socket.writableLength` against a
1MB high-water mark. If the client's write buffer already exceeds it, the frame is dropped (not
queued) and a warning is logged. For a last-write-wins synchronization server, dropping a stale
update for a client that cannot keep up is the correct behavior - buffering without bound would
only grow process memory for data that is about to be superseded anyway.

## Socket.IO envelope (web clients, unchanged)

A web client's message is a Socket.IO event named after the `channel`, with an `{ command,
payload }` envelope as its data. `payload` is a plain JSON value, not a byte buffer - no framing
is needed since Socket.IO already handles message boundaries. `ConnectionPool.broadcast()` uses a
Socket.IO **room per app** so a message to N web clients of the same app is encoded once, not N
times.

## Cross-transport relaying

`Payload` (`src/server/modules/core/payload.ts`) holds whichever representation a message
arrived in - a JSON string (TCP/Socket.IO-as-string), a parsed value (Socket.IO), or raw bytes
(TCP) - and lazily computes and memoizes the others only if something actually asks for them.
Relaying TCP→TCP or Socket.IO→Socket.IO therefore does zero JSON/utf8 work; only a genuine
cross-transport relay (or a hook that inspects the payload) pays for a conversion, and only once.

## Known limits

**No client re-requests model state after a reconnect.** `model::request` is sent once, when a
model listener is registered - `Sync.AddModelUpdateListener` in colibri-unity, `RegisterModelSync`
in colibri-web. The server clears an app's store when its last client disconnects
(`model-sync.ts`), so after a server restart a client that reconnects keeps whatever models it
had locally and is never told they are gone. Re-registering the listener is the only way to
resynchronize today.
