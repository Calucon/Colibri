# Colibri wire protocol

Colibri relays real-time object synchronization between two kinds of clients:

- **Unity clients** connect over raw **TCP** using the binary framing described below.
- **Web clients** connect over **Socket.IO**, using the
  [envelope described further down](#socketio-envelope-web-clients). The framing sections do not
  apply to them; the version check and everything about channels, commands and payloads does.

Both transports carry the same logical `{ channel, command, payload }` message shape into the
server's `ConnectionPool`, which is transport-agnostic - a message the server relays reaches the
clients of the app on both transports. The server never needs to look inside a message's payload
except in a handful of hooks (`ModelSynchronization`, `MeasureLatency`, `WebLog`,
`ClientLogger`) that explicitly parse it via the `Payload` abstraction
(`src/server/modules/core/payload.ts`).

## What the server relays

The server does not forward messages in general. Of what a client sends, it relays exactly two
kinds, to the other clients of the sender's app - Unity and web alike, the sender excluded:

- every message whose `command` starts with `broadcast::`, unchanged (see
  [`broadcast::` commands](#broadcast-commands));
- `model::update` and `model::delete`, which also change the server's copy of the model (see
  [Model synchronization](#model-synchronization)).

It also answers `model::request`, and handles the messages on its own channels (see
[Server messages](#server-messages)). Any other message reaches no other client, and nothing is
logged about it: a command such as `myCommand`, sent with colibri-web's
`SendMessage(channel, 'myCommand', …)` or colibri-unity's `WebServerConnection.SendCommand`, is
dropped. To send the other clients a message of your own, give it a command that starts with
`broadcast::`, e.g. `broadcast::myCommand`, and receive it with colibri-web's `RegisterChannel` or
colibri-unity's `OnMessageReceived`.

Under overload, or from a client that sends too fast, the server holds back and merges
`model::update` messages and drops `broadcast::` messages; see [Inbound limits](#inbound-limits).

## v3 TCP framing (breaking change from v1)

> **This is a breaking protocol change.** A `colibri-unity` client built against the old v1
> flatbuffer framing cannot talk to a v2.0.0+ server, and vice versa. There is no version
> *negotiation* - the server accepts exactly one protocol version and refuses every other one,
> so both sides must be upgraded together. See [Version checking](#version-checking).

This document calls the framing "v3"; the protocol version a client announces for it is `2`.

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
else. `version`, `app`, and `name` are `::`-joined into the body as plain utf8 text. None of the
three may contain `::`, or start or end with `:`, since a body like `"2::app:::name"` cannot be
split back into the fields that were meant. A body that does not split into exactly three fields
closes the connection. colibri-unity replaces a `::` and a colon at either end of its app and
device name with `_`, and warns about a changed app name. The server assigns the connection to
`app` and begins including it in that app's broadcasts; any `message` frame received before the
handshake is ignored and logged.

A client may send another handshake on the same connection. The server then moves it to the new
app: the old app sees `client::disconnected` and loses its models if that was its last client, and
the new app sees `client::connected`. A second handshake into the same app shows up as a
disconnect followed by a connect, and keeps the app's models.

### Version checking

`version` is checked against `PROTOCOL_VERSION` in
[`protocol.ts`](../src/server/modules/networking/protocol.ts), currently `2`. This is a check,
not a negotiation: there is one supported version at a time, and there is no subset a v1 and a
v3 client could both speak, so a client announcing anything else is **refused**, not downgraded.

A refused client is never added to its app's broadcast set and never reaches
`clientConnected$`, so it does not appear in the admin UI. The server logs the refusal as an
error naming the client, its address and both versions, sends the client a normal message frame
explaining why, then closes the connection:

| field | value |
| --- | --- |
| channel | `colibri` |
| command | `protocol::rejected` |
| payload | `{ "reason": string, "serverVersion": string, "clientVersion": string }` |

On TCP the refusal frame is queued ahead of the server's FIN, so it arrives before the close.
From then on the server treats the client as gone: it gets no more heartbeats, and anything it
sends is ignored, including frames that arrived behind the refused handshake in the same packet.
A peer that has not closed its side of the connection 5 s later is disconnected.

The same applies to Socket.IO clients, which announce their version in the handshake query
(`?app=…&version=…`) and receive the identical `colibri` / `protocol::rejected` event before
being disconnected. A client that sends no version is refused with `clientVersion: ""` and a
reason that says `'(none)'`. The one exception is the admin UI (`app === 'colibri'`), which ships
with the server and is warned about rather than refused - a check that can lock you out of your
own console is worse than the mismatch it detects.

**What this cannot do.** Four gaps, all deliberate:

- The refusal only reaches a client whose *framing* the server still speaks. A Colibri 1.x Unity
  client fails before its version is ever read: its first packet, the 1.x handshake, does not
  parse as a v3 frame (see [Reading frames off the wire](#reading-frames-off-the-wire)), and it
  could not decode a refusal anyway. The server recognises the 1.x framing instead, closes the
  connection and logs a warning naming the remote address: it looks like a Colibri 1.x client,
  the server speaks protocol v2, and the Unity package (`de.uni.kn.colibri`) in that app has to
  be upgraded to 2.x. The warning is logged at most once a minute per address; the repeats go to
  debug level. It is the whole diagnostic: the 1.x client cannot tell what happened, and keeps
  reconnecting.
- It only reaches a client that *handles* `protocol::rejected`. colibri-web 1.x surfaces the
  rejection as an ordinary message and is then disconnected for good - Socket.IO does not
  reconnect after a server-side `disconnect()` - with nothing logged on the client. The
  server's log line is the diagnostic. See [MIGRATION.md](../../MIGRATION.md).
- The `app === 'colibri'` exemption is by app name, so any Socket.IO client naming itself `colibri`
  opts out of the check entirely. That app name is reserved for the admin UI and also collides with
  the `colibri` control channel; it is not a name an application should be using.
- It says nothing about a server that is *itself* out of date, since the check only runs on the
  server. Clients infer that separately and can only ever suspect it - see
  [Detecting an out-of-date server](#detecting-an-out-of-date-server).

Clients must keep their announced version in step with this constant:
`CLIENT_VERSION` in `colibri-unity`'s `WebServerConnection.cs`, `PROTOCOL_VERSION` in
`colibri-web`'s `Colibri.ts`, and the `version` query in the admin UI's `socketio.service.ts`.
`npm run test:vectors`, which CI runs, fails when any of them differs from `PROTOCOL_VERSION` or
can no longer be found.

**This is not the release version, and does not move with one.** It names the wire format, and
nothing derives it from a `package.json`. A 2.0.1 bugfix and a 2.1.0 feature release both still
announce `2`, so every combination of 2.x client and 2.x server interoperates - a client is
refused only when the protocol version it *announces* differs, never because the two sides ship
different release numbers.

The one client this refuses although its messages would still work is colibri-web 1.x: the
Socket.IO envelope did not change, but it announces `1`, so it is refused like any other 1.x
client. Upgrade it to colibri-web 2.x along with the server.

| change | `PROTOCOL_VERSION` | effect |
| --- | --- | --- |
| 2.0.0 → 2.0.1, bugfix | `2` | none, freely interoperable |
| 2.0.0 → 2.1.0, new features, same wire format | `2` | none, freely interoperable |
| a frame layout, field or encoding changes | `2` → `3` | **every deployed client is refused at once** |

That last row is the whole cost of bumping it, and the whole point. Bump it only when an existing
client would otherwise misread the bytes on the wire - not to signal that something was added.
Adding a new `command` is not a wire-format change, because no client breaks on a command it does
not know: colibri-unity's `Sync` and colibri-web's `Sync.receive*` listeners ignore it, and a
colibri-web `RegisterModelSync` channel logs `Unknown model command` to the console and otherwise
ignores it. Code that handles raw messages (colibri-web's `RegisterChannel`, colibri-unity's
`OnMessageReceived`) sees every command and has to skip the ones it does not know.

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
| `colibri-web` | no `colibri`/`protocol::accepted` within 5s of connecting | 5s | warns, emits a **non-fatal** `ProtocolMismatchError` (`fatal: false`, `serverVersion: '1'`), **stays connected** |
| `colibri-unity` | 3 sessions in a row that got past the handshake and ended before a frame decoded | about 1.5s against a 1.x server: three sessions, 500ms and then 1000ms apart | logs an error, sets `SuspectedProtocolMismatch`, keeps retrying |

colibri-web reports each kind of mismatch at most once per `Colibri` instance on
`Colibri.protocolMismatch`: this suspicion, and a refusal (`fatal: true`). A suspicion can be
followed by a refusal, but not the other way round.

colibri-unity counts a session as connected only once the server has sent its first frame, so
none of these sessions resets the reconnect backoff, which keeps doubling (0.5s, 1s, 2s, ... up
to 10s). Every session that got past the handshake and ended without a frame counts, however it
ended - a clean close, a reset, an undecodable frame, or 2s without any frame. The first frame a
session decodes clears the count and the suspicion. A server that accepts the connection and then
says nothing takes longer to suspect, since each of those sessions lasts the full 2s.

TCP clients are sent no announcement and need none: the framing itself changed incompatibly in
2.0.0, so a pre-2.0.0 server is already unmistakable to them.

`serverVersion` is a **protocol** version wherever it appears - in the payloads above, in
`ProtocolMismatchError` and in `ProtocolMismatchException` - so it is always comparable with the
client version beside it, and never carries a release version like `1.3.1`. On the old-server path
it is `'1'`: nothing said so, but the announcement is sent by every 2.0.0+ server and every release
before that speaks v1. `'unknown'` appears only when a server refused a client without saying what
it speaks.

**Why an explicit message rather than an inference from existing traffic.** The 100ms `latency`
broadcast is the obvious candidate and is wrong: it was added in colibri-server 1.2.0, so keying on
it silently accepts every 1.2.x and 1.3.x server as current. Verified against the published
`hcikn/colibri:1.1.1` and `hcikn/colibri:1.3.1` images - 1.1.1 sends no beat, 1.3.1 sends it while
still using the old `\0\0\0` framing. Nothing else a web client can observe separates them either:
the Socket.IO envelope, the `colibri::clients` payloads and the relay behaviour are identical.

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

The server sends a `heartbeat` frame every 100ms to each TCP client whose handshake it accepted,
until the connection closes, carrying `process.hrtime.bigint()` as the ping timestamp. A client is
expected to echo the frame back verbatim. The server relays an echoed heartbeat into the normal
message pipeline as a synthetic `colibri`/`latency` message so `MeasureLatency`'s round-trip
accounting handles it the same way it handles a web client's latency ping - this is the only place
a `heartbeat` frame travels client→server. Merging the heartbeat and the latency ping into one
frame halves the idle per-client packet rate compared to running them as two independent 100ms
timers.

Because the server is never silent for long, a client can treat silence as a dead connection:
colibri-unity drops a session after 2s without any frame - including while it waits for the
first one - and reconnects.

Socket.IO clients are not sent that frame - they get a `colibri`/`latency` event directly, also
every 100ms, from the same `MeasureLatency` timer.

**This is not a version signal.** The latency broadcast looks like one - only a current server
sends it, surely? - but it was added in colibri-server **1.2.0**, so every 1.2.x and 1.3.x server
sends it while still speaking the old protocol. Detecting an out-of-date server keys on
`protocol::accepted` instead, for exactly this reason.

### Message

Carries an application message: `channel` and `command` identify the message (e.g. channel
`myApp::position`, command `model::update`), and `payload` is an opaque byte range - when the
server relays the message (see [What the server relays](#what-the-server-relays)), it passes the
payload on verbatim to other TCP clients without ever decoding it as a string, and only decodes it
(via `Payload.fromBytes(...).asValue()`) when a hook needs to inspect it or when relaying
cross-transport to a Socket.IO client. The one exception is a `model::update` that was held back
and merged (see [Inbound limits](#inbound-limits)), which is passed on re-encoded.

### `broadcast::` commands

The `broadcast::` prefix of a `command` is what makes the server relay the message to the other
clients of the sender's app (see [What the server relays](#what-the-server-relays)). Nothing else
on the wire marks such a message: the prefix is part of the `command` string. colibri-unity's
`Sync.Send` and colibri-web's `Sync.send*` use it for state, position and similar continuous
updates, with the commands below. `BroadcastLogger`
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
| `broadcast::json` | any JSON value (colibri-web sends an object) | `Send(ch, JToken)` | `sendJson` |

Every command except `broadcast::json` also has an array form: append `[]`, and the payload is
an array of the above (so `broadcast::vector3[]` is `[[x,y,z], …]`). Two commands need more
than a row:

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
for that connection: it logs the error and closes the connection.

When the bytes that failed are the Colibri 1.x framing - three NUL bytes, then `h` or an ASCII
digit - it throws the subclass `V1FramingError` instead, which is how the server recognises a 1.x
client (see [Version checking](#version-checking)). No v3 frame can start that way, since those
four bytes read as a length of at least 16 MiB. The 1.x handshake starts `\0\0\0h`, which reads
as `Invalid frame length: 1744830464` (`0x68000000`, `'h' << 24`).

### Backpressure

Before writing a frame to a client's socket, the server checks `socket.writableLength` against a
1MB high-water mark. If the client's write buffer already exceeds it, the frame is dropped (not
queued). The server logs a warning when a client starts falling behind, and another, with the
number of frames dropped, once it has caught up. For a last-write-wins synchronization server,
dropping a stale update for a client that cannot keep up is the correct behavior - buffering
without bound would only grow process memory for data that is about to be superseded anyway.

This is the outgoing side. For what the server does when clients send more than it can process,
see [Inbound limits](#inbound-limits).

## Socket.IO envelope (web clients)

A web client connects with the handshake query `?app=<app>&version=2`; a connection without an
`app` is logged and disconnected. A message is a Socket.IO event named after the `channel`, with
a `{ command, payload }` envelope as its data; an event without a string `command` is logged and
ignored. `payload` is a plain JSON value, not a byte buffer - no framing is needed since
Socket.IO already handles message boundaries. The envelope is unchanged from 1.x.
`ConnectionPool.broadcast()` uses a Socket.IO **room per app** so a message to N web clients of
the same app is encoded once, not N times.

## Size limits

Every way into the server takes messages of up to about 5 MiB, so whatever one client can send,
the others can receive:

| path | limit | beyond it |
| --- | --- | --- |
| TCP frame | 5 MiB (5,242,880 bytes) for type and body, so a payload gets that minus its channel, its command and 5 bytes | `FrameError`: the server closes the connection |
| Socket.IO packet | 5 MiB plus room for the largest channel and command, about 5.13 MiB | engine.io drops the connection, and the message with it |
| REST request body | 5 MiB | `413` |

On TCP, channel and command are each at most 65,535 bytes of utf8 (a `u16` length). A message
from a web client that does not fit into a TCP frame is not relayed to TCP clients; the server
logs `Dropping unencodable message` instead.

## Inbound limits

Two limits keep a server that is sent more than it can process responsive, and its memory
bounded:

| limit | counts | setting, default |
| --- | --- | --- |
| backlog | messages from all TCP clients that the server's main thread has not processed yet | `TCP_INBOUND_BACKLOG_LIMIT`, `2000` |
| rate | messages a second from one client, TCP or Socket.IO, with bursts | `CLIENT_MESSAGE_RATE_LIMIT`, `1000`, and `CLIENT_MESSAGE_RATE_BURST`, `2000` |

`0` turns either off. Socket.IO clients are subject to the rate limit only: the server handles
their messages as it reads them, so there is no queue of them to bound.

Both limits only ever touch `model::update` and `broadcast::` messages, the bulk of a sync loop's
traffic, and never on the `colibri` or `log` channel. Everything else - handshakes, heartbeats,
`model::request`, `model::delete`, log lines, anything on the `colibri` channel - always goes
through at once. Past a limit:

- **`model::update` is held back and merged per object** (per channel and `id`): a field in a
  later update replaces the one held, and fields not sent again are kept. As soon as there is
  room - checked with the client's next message and every 100ms - the held updates are passed
  on, oldest object first, one `model::update` per object. A `model::update` may carry only the
  fields that changed, and the server and every client merge it field by field, so the other
  clients and the server's copy skip intermediate states but still get the latest value of every
  field. A held update is re-encoded as JSON, so it is not byte-identical to anything the client
  sent.
- **`broadcast::` messages are dropped.** There is nothing to merge them into.
- An update the server could not apply anyway - not a JSON object with a string `id` - is
  dropped, and so is an update for one more object once 1000 are held for that client.

Nothing a client sends overtakes its held updates: they are passed on before its next message
that is not limited, so a `model::delete` cannot arrive ahead of an update to the same object and
bring it back, before a second handshake, and when it disconnects, before its app sees
`client::disconnected`.

Clients are not told. The other clients of the app receive fewer updates, each possibly carrying
the changes of several, and later; synced objects move less smoothly, and a stream of
`broadcast::` messages has gaps. The server logs each episode as a warning when it starts and
again once nothing has been over the limit for a second, with how many updates were held back and
messages dropped. With the default settings, the warnings read:

| warning | means |
| --- | --- |
| `The main thread has fallen 2000 TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) ...` | the server as a whole is taking in more than it can process; every Unity client is limited |
| `The main thread has caught up with TCP messages again; ...` | that episode is over |
| `Unity client '<name>' (...) is sending more than 1000 ...`, `Web client <id> (...) is sending more than 1000 ...` | one client is over its rate limit |
| `... is back under the message rate limit; ...`, `... disconnected while over the message rate limit; ...` | that client's episode is over |

The rate limit is far above what a client needs - one syncing 10 objects 72 times a second sends
720 updates a second - so it only catches a runaway loop, typically something that sends every
frame without a rate cap. The backlog limit is reached when the server as a whole is overloaded:
fewer synced objects, a lower sync rate or fewer clients per app reduce the load.

## Server messages

Besides relaying (see [What the server relays](#what-the-server-relays)), the server speaks on a
few channels of its own. Applications should not use these channel names, or the app name
`colibri`.

| channel | command | sent | payload |
| --- | --- | --- | --- |
| `colibri` | `protocol::accepted` | to a Socket.IO client, once it is accepted | `{ serverVersion }` |
| `colibri` | `protocol::rejected` | to a refused client, before it is disconnected | `{ reason, serverVersion, clientVersion }` |
| `colibri` | `latency` | to every Socket.IO client every 100ms; the client sends it back unchanged | a number to echo |
| `colibri::clients` | `client::connected`, `client::disconnected` | to every client of the app, and the admin UI, when a client joins or leaves | `{ id, name, app }` |
| `colibri::clients` | `client::request` | by a client, to ask who is connected | the server answers with one `client::connected` per client of the requester's app, with `version` added |
| `log` | `debug`, `info`, `warn` / `warning`, `error` | by a client, to write to the server log at that level (any other command: debug) | text |

`name` is the name from the handshake for a TCP client and the client's IP address for a
Socket.IO client. The admin UI also uses `colibri::log` and `colibri::latency`.

## Model synchronization

colibri-unity's `SyncBehaviour` and colibri-web's `RegisterModelSync` keep shared objects
("models") in step with three commands on the model's channel. Each client names the channel
after the model type: colibri-unity uses the class name in lower case, plus `_<ModelId>` when the
`ModelId` field is set; colibri-web uses the registration's `name`, or else the class name in lower
case, which a minifying build changes - so pass `name`. A Unity and a web client only sync with
each other when the channel names match.

| command | payload | what the server does |
| --- | --- | --- |
| `model::update` | an object with a string `id`, plus the fields that changed (or all of them) | merges it into its copy - each field sent replaces the stored one, fields not sent are kept - and relays the message unchanged to every other client of the app; past an [inbound limit](#inbound-limits), merged with the sender's later updates first. Without a string `id` it logs an error and drops it. |
| `model::delete` | `{ "id": "…" }` | removes its copy and relays the message to every other client of the app. Without an `id` it logs a warning and drops it. |
| `model::request` | `{ "id": "…" }` for one model; anything else (`null`, `{}`) for all of them | answers the requester alone, with one `model::update` per model it has on that channel. Asked for an id it does not have, it answers `{ "id": "…" }`. |

The merge only looks at top-level fields: a nested object sent in an update replaces the stored
one as a whole.

The server keeps the models per app and channel, in memory only. It clears an app's models when
the app's last client disconnects, and has none after a restart. The REST store below is what
persists.

## REST store

A small key-value store over HTTP, on the web port, separate from the model store: values are
kept per app in `store.json` in the server's data directory (`DATA_ROOT`) and survive restarts.
colibri-unity's `Store` and colibri-web's `getRestObject` / `setRestObject` use it.

| request | answer |
| --- | --- |
| `GET /api/store` | `200` with the app names, `["app1", …]` |
| `GET /api/store/:app` | `200` with the value names of that app; `404` if the app is unknown |
| `GET /api/store/:app/:name` | `200` with the stored JSON value; `404` if there is none |
| `PUT /api/store/:app/:name` | stores the request body: any JSON value - an object, an array, a number, a string, `true`, `null` - sent as `Content-Type: application/json`, up to 5 MiB. `201` if it is new, `200` if it replaced a value, each with `{ "result": "…", "data": <the value> }`. `400` for malformed JSON, `413` for a body over 5 MiB. |
| `DELETE /api/store/:app` | `200`, and every value of the app is gone; `404` if the app is unknown |
| `DELETE /api/store/:app/:name` | `200`; `404` if there is no such value |

Errors are JSON, `{ "error": "…" }`, and never carry a stack trace. Any app or value name is
allowed, `__proto__` and `constructor` included. Every response allows any origin (CORS), so a
page served from somewhere else can use the store too.

Writes reach `store.json` within 250ms, together with any made in the meantime, and the file is
replaced atomically (written to `store.json.tmp`, then renamed). When the server shuts down - on
`docker stop`, Ctrl+C or an uncaught error - it writes whatever is still pending.

## Cross-transport relaying

`Payload` (`src/server/modules/core/payload.ts`) holds whichever representation a message
arrived in - a JSON string (TCP/Socket.IO-as-string), a parsed value (Socket.IO), or raw bytes
(TCP) - and lazily computes and memoizes the others only if something actually asks for them.
Relaying TCP→TCP or Socket.IO→Socket.IO therefore does zero JSON/utf8 work; only a genuine
cross-transport relay (or a hook that inspects the payload) pays for a conversion, and only once.

## Known limits

**A reconnect catches up on updates, not on deletions.** Both clients ask for the current models
again after every reconnect: colibri-web for each `RegisterModelSync`, and colibri-unity for each
registered listener - a `SyncBehaviour` for its own id, a `SyncBehaviourManager` or a listener
without an id for the whole channel - behind the messages it queued during the outage. Two gaps
remain. A model deleted while a client was away
stays in that client, since the answer only lists the models that exist. And a model the server no
longer has - after a restart, or once the app's last client has left - comes back only when a
client sends an update for it: clients do not send their local models again on reconnect.

**Nobody is authenticated.** Any client that can reach the server can join any app under any name,
and read and change its models and its REST store. The version check is not access control.
Colibri is meant for a local network you trust.
