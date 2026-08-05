# colibri-unity v2.0.0 — Change Log

Summary of everything that changed in the `1.3.1` → `2.0.0` modernization, closing out the v2
release across all three packages. `colibri-server` 2.0.0 replaced the v1 TCP framing with a fixed
binary v3 protocol and its changelog listed the Unity client rewrite as
[deferred work](../colibri-server/docs/v2-changelog.md#deferred-work); this release is that work.

---

## Breaking changes

- **Protocol.** colibri-unity 2.0.0 speaks the [v3 binary TCP
  protocol](../colibri-server/docs/protocol.md) and **requires colibri-server ≥ 2.0.0**. It cannot
  talk to a 1.x server, and a 1.x client cannot talk to a 2.0.0 server. There is no version
  negotiation — both sides must agree on the framing out of band, i.e. by matching versions.
- **Minimum Unity is 2022.3 LTS** (the package manifest previously claimed 2019.4 while using APIs
  that were never available there).
- **UniRx → R3.** `SyncBehaviour<T>.ModelCreated()` and `ModelDestroyed()` now return
  `R3.Observable<SyncBehaviour<T>>` instead of `IObservable<>`.
- **`WebServerConnection.Connected`** is a `UniTask` gate instead of an `IObservable<bool>`.
  `await connection.Connected` is unchanged; anything that subscribed to it is not.
- **`ObservableModel<T>`, `ObservableManager<T>` and `Samples/ObservableModel` are deleted.**
- **Vendored `Newtonsoft.Json.dll` is gone**, replaced by the `com.unity.nuget.newtonsoft-json`
  package. See the README for the install steps — R3 in particular needs both a UPM package and a
  NuGetForUnity package.

## v3 wire protocol

- New `Assets/Colibri/Networking/Protocol/` — `FrameCodec`, `FrameReader`, `DecodedFrame`,
  `FrameType`, `FrameException`. Pure C# with no `UnityEngine` dependency, so it is directly
  unit-testable, and a mirror of `colibri-server/src/server/modules/networking/protocol.ts`:

  ```
  [u32 LE totalLength][u8 type][body]      totalLength = 1 (type) + body.length
    0x00 heartbeat   [u64 LE pingTimestamp]
    0x01 handshake   utf8 "version::app::name"
    0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
  ```

- Encoding is one pre-sized `byte[]` per frame written with `BinaryPrimitives`, replacing the
  FlatBuffer builder plus a separately-encoded ASCII length header. Egress is bounds-checked with
  the same guards the server uses (channel/command ≤ 64 KiB utf8, whole frame ≤ 5 MiB), so this
  client can never emit a frame the server's own parser would reject.
- `FrameReader` is a growable buffer with read/write cursors: both cursors reset when it is fully
  drained (no copy), and only a trailing partial frame is ever compacted. This replaces
  `HasPacketHeader`/`GetPacketHeader` and their `\0`-scanning, which on an unrecognized byte would
  skip forward looking for the next `\0\0\0` and could resynchronize onto payload data.
- **Heartbeat/latency merge.** The server heartbeats every 100 ms and derives TCP latency purely
  from the client echoing that frame back verbatim. The client now does exactly that — the `u64`
  goes in and comes back out, never interpreted. The old `colibri`/`latency` message echo is
  removed; nothing sends that to a TCP client any more (`MeasureLatency`'s message-level ping is
  Socket.IO-only).
- **Handshake** is sent immediately after connect with `version = "2"`, matching colibri-web's
  `query: { app, version: '2' }`. The server does not validate it — it is client-library metadata
  shown on the admin UI's Clients page. A device or app name containing the `::` field separator is
  sanitized rather than producing a frame the server drops the connection over.
- `Assets/Colibri/FlatBuffers/` (10 files) and `Networking/Message.cs` are deleted, mirroring the
  server dropping its own `flatbuffers` dependency.

## Correctness

- **String payloads now round-trip.** `SendCommandAsync` used to special-case `JTokenType.String`
  and write the string *unquoted*, which is not valid JSON. Against a 2.0 server that reaches web
  clients via `Payload.asValue()`, which threw and fell back to `asString()` — so a Unity
  `Sync.Send(channel, "hello")` and a web client's version of the same message did not arrive
  identically. Payloads now always go out as `ToString(Formatting.None)` and are always parsed back
  with `JToken.Parse`, falling back to a raw `JValue` for a non-JSON body. The `log` channel is the
  documented exception: it keeps sending raw text, because `ClientLogger` reads it with
  `asString()` and quoting would put stray quotes in the admin UI.
- **Interleaved sends.** Concurrent `SendCommandAsync` calls could interleave their bytes on the
  socket and corrupt the framing for everything that followed. All writes are serialized behind a
  `SemaphoreSlim(1, 1)`, and a partial send is now completed instead of silently truncating the
  frame.
- **Send that hung forever.** `_socket.SendAsync(SocketAsyncEventArgs)` returning `false` (completed
  synchronously) never raises `Completed`, so `await signal.WaitAsync()` never returned. Replaced
  with `Socket.SendAsync(ArraySegment<byte>, SocketFlags)`, which also drops a
  `SocketAsyncEventArgs` + `SemaphoreSlim` allocation per send.
- **Unsynchronized retry queue.** `_msgQueue` was written from the send path and drained from the
  connect path with no synchronization. It is now locked, and bounded — for a last-write-wins sync
  client, buffering an unbounded backlog during an outage only preserves updates that are already
  superseded.
- **Receive loop that died silently.** The `BeginReceive`/`AsyncCallback` machinery ended in
  `catch (Exception) { /* ignore */ }`, so any hiccup killed reception permanently while the client
  still looked connected. Replaced with an `await socket.ReceiveAsync(...)` loop feeding
  `FrameReader`, which logs and reconnects.
- **Static connection state.** `_socket`, `_receiveBuffer`, `_expectedPacketSize` and friends were
  `static`, which breaks under Enter Play Mode Options with domain reload disabled. All instance
  fields now.
- **Reconnect.** A single connection task with exponential backoff (0.5 s → 10 s), cancelled by a
  `CancellationTokenSource` in `OnDisable`, replaces `Update()` re-entering `Connect()` every frame
  while disconnected.
- **Main-thread config reads.** `ColibriConfig.Load()` goes through `Resources.Load`; the connection
  path used to call it from a worker thread. It is now snapshotted on the main thread.
- **Voice chat.** `udpThread.Abort()` (unsupported on .NET Core / IL2CPP) is replaced with a
  `CancellationToken` plus `udpClient.Close()`, which is what actually unblocks the blocking
  `Receive()`. `OnDisable` no longer NREs when `Connect()` bailed out. The receive socket binds to
  port **0** instead of the hardcoded 9014 — the server replies to the datagram's source port
  (`voice-server.ts`), so the fixed port bought nothing and capped a machine at one Unity client.
- **`Store`** serializes with Newtonsoft instead of `JsonUtility`, which cannot handle dictionaries,
  properties, or top-level arrays and so silently disagreed with what `Sync` can carry.

## Dependencies and API modernization

- **UniRx → R3** (Cysharp, actively maintained, pairs with the UniTask dependency already present).
  `IObservable<T>` → `Observable<T>`, `this.ObserveEveryValueChanged(f)` →
  `Observable.EveryValueChanged(this, f)`, `Sample()` → `ThrottleLast()`,
  `TakeUntilDestroy`/`TakeUntilDisable` → `.AddTo(this)` on the subscription.
  `RemoteLogging.SendLog`'s `Observable.Start` + `Observable.WhenAll` + `ObserveOnMainThread` is now
  plain UniTask; its retry is also re-armed only after clearing the in-flight flag, which the
  `Where()` gate in front of the throttle previously swallowed.
- **Legacy observable API deleted.** `ObservableModel<T>`/`ObservableManager<T>` speak
  `channel::register`/`deregister` plus bare `add`, `update`, `request` and `remove`. A 2.0 server
  registers only `broadcast::*`, `model::request`, `model::update`, `model::delete`,
  `client::request` and `latency`, so none of those commands are handled — the API was provably dead
  against the server it targets. `SyncBehaviour`/`SyncBehaviourManager` cover the same use case.
- **Deprecated Unity APIs**: `FindObjectOfType` → `FindFirstObjectByType`, `FindObjectsOfType` →
  `FindObjectsByType(..., FindObjectsSortMode.None)`. `SyncBehaviour.Awake` also scanned the whole
  scene twice per `Awake` and threw one of the results away.
- Vendored `Newtonsoft.Json.dll` replaced by `com.unity.nuget.newtonsoft-json`, declared as a real
  `dependencies` entry in `package.json` (which previously declared none at all).

## Tests

- New EditMode assembly `HCIKonstanz.Colibri.Tests` (`Assets/Colibri/Tests/Editor/`). The frame
  codec has no Unity dependency, so this is plain NUnit.
- `FrameReaderTests`/`FrameCodecTests` port `colibri-server/test/unit/protocol.test.ts`
  case-for-case: round trips for all three frame types, byte-by-byte fragmentation, a frame split
  across two segments, multiple frames coalesced into one segment, a complete frame plus a trailing
  partial, growth and compaction, and the malformed variants (`totalLength <= 0`, oversized, unknown
  type, channel/command length overrunning the body, handshake field-count violations).
- `ProtocolVectorTests` asserts frames hex-dumped from the server's own encoder byte-for-byte
  against `FrameCodec`. This is what catches an endianness or off-by-one drift between the two
  implementations; the round-trip tests alone would pass just as happily with both C# sides wrong in
  the same direction.
- No GameCI workflow: the EditMode suite is run from Unity's Test Runner, and the end-to-end round
  trip against a live server is documented rather than automated.

## Known residuals

- `.AddTo(this)` ties subscriptions to destruction, where UniRx's `TakeUntilDisable` tied them to
  disabling. `SyncBehaviourManager` only ever subscribed in `Start()`, so in practice this only
  matters for a component that is disabled and re-enabled — it will not double-subscribe, but its
  subscriptions do stay live while disabled.
- The R3 install needs two steps (UPM package + NuGetForUnity) because a UPM `dependencies` entry
  cannot express the NuGet half. This is documented in the README rather than worked around by
  vendoring `R3.dll`, which is the pattern this release removes.
