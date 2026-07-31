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
> negotiation - both sides must agree on the framing out of band (i.e. by matching client/server
> versions).

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

### Heartbeat / latency

The server sends a `heartbeat` frame to every connected client (handshaked or not) every 100ms,
carrying `process.hrtime.bigint()` as the ping timestamp. A client is expected to echo the frame
back verbatim. The server relays an echoed heartbeat into the normal message pipeline as a
synthetic `colibri`/`latency` message so `MeasureLatency`'s round-trip accounting handles it the
same way it handles a web client's latency ping - this is the only place a `heartbeat` frame
travels client→server. Merging the heartbeat and the latency ping into one frame halves the idle
per-client packet rate compared to running them as two independent 100ms timers.

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
