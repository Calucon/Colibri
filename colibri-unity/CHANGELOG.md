# colibri-unity v2.0.0 — Change Log

Summary of everything that changed in the `1.3.1` → `2.0.0` modernization, closing out the v2
release across all three packages. `colibri-server` 2.0.0 replaced the v1 TCP framing with a fixed
binary v3 protocol and its changelog listed the Unity client rewrite as
[deferred work](../colibri-server/docs/v2-changelog.md#deferred-work); this release is that work.

The ease-of-use and sync-loop pass that closes the release is written up in more depth — mechanism,
rationale, migration steps, and what the Editor verification did and did not cover — in
[`docs/v2-ease-of-use-and-performance.md`](docs/v2-ease-of-use-and-performance.md).

---

## Breaking changes

- **Protocol.** colibri-unity 2.0.0 speaks the [v3 binary TCP
  protocol](../colibri-server/docs/protocol.md) and **requires colibri-server ≥ 2.0.0**. It cannot
  talk to a 1.x server, and a 1.x client cannot talk to a 2.0.0 server. There is no version
  negotiation — both sides must agree on the framing out of band, i.e. by matching versions.
- **Minimum Unity is 2022.3 LTS** (the package manifest previously claimed 2019.4 while using APIs
  that were never available there).
- **No more third-party runtime dependencies.** UniRx is gone and was not replaced;
  `SyncBehaviour<T>.ModelCreated()` and `ModelDestroyed()` are now plain
  `static event Action<SyncBehaviour<T>>` instead of observables. Anything that subscribed to them
  as `IObservable<>` has to be rewritten as `+=` / `-=` — and, unlike a UniRx subscription, a static
  event does **not** unsubscribe itself when the component is destroyed.
- **`WebServerConnection.Connected`** is a `Task` gate instead of an `IObservable<bool>`.
  `await connection.Connected` is unchanged; anything that subscribed to it is not.
- **`ObservableModel<T>`, `ObservableManager<T>` and `Samples/ObservableModel` are deleted.**
- **Vendored `Newtonsoft.Json.dll` is gone**, replaced by the `com.unity.nuget.newtonsoft-json`
  package, which is declared as a real dependency — so installing Colibri is one git URL and
  nothing else.
- **The samples are no longer compiled into your project.** `Samples/` was a live package folder, so
  every consumer built `HCIKonstanz.Colibri.Samples.*` into the Colibri assembly whether it wanted
  them or not. They now live in `Samples~`, which Unity does not compile, so those types exist only
  after the sample is imported from the Package Manager — and then they are yours, in
  `Assets/Samples/`, in `Assembly-CSharp`. Code that referenced a sample type without importing the
  sample no longer compiles. The `Prefabs` folder is unaffected and stays live: `[RemoteLogger]` and
  `[SyncTransformManager]` are still draggable straight out of `Packages/Colibri/Prefabs`.

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

- **The socket no longer waits for the frame.** `RunConnectionLoop` is started from `OnEnable`, so
  its first `await` captured Unity's `SynchronizationContext` — and with no `ConfigureAwait(false)`
  anywhere in the file, so did every continuation after it. Connect, receive, heartbeat echo and
  send were all posted back to the main thread and pumped once per frame: inbound bytes sat in the
  kernel buffer until the next frame, echoing a heartbeat cost two further frame-pumps *inside* the
  receive loop, and `StampLiveness` — the watchdog's proof of life — only ran when the main thread
  ran. Two editors side by side on one machine showed it plainly: Unity throttles whichever one is
  in the background, so a cube moved in the focused editor arrived in the other visibly late and its
  Status window reported missed heartbeats, all of it over localhost. Every await on the connection
  path now carries `ConfigureAwait(false)`. The `volatile` fields, `Interlocked`, `LockFreeQueue`
  and `_msgQueueLock` this file already had were written for exactly this threading; the missing
  `ConfigureAwait` had quietly been preventing it. `_socket`, `_status` and the connected gate join
  them, and the `Status` setter — a read-modify-write over four fields now genuinely reachable from
  the connection loop and `Update`'s watchdog at once — is serialized. The main-thread handoff user
  code depends on is unchanged: received messages still arrive via `_queuedCommands` and are
  delivered from `Update`.
- **"Recent messages" stops counting up forever.** The Status window's traffic log was a static
  buffer with no expiry and no reset, timestamped with `realtimeSinceStartup` — a clock that keeps
  running after Play stops. Entries therefore aged indefinitely on screen, and with domain reload
  disabled the next session opened showing the last one's messages, dated from before it started.
  The log is cleared at `SubsystemRegistration`, entries older than ten seconds are dropped, and the
  window shows "(nothing sent or received yet)" outside Play mode.
- **The second Play session connects again.** With *Enter Play Mode Options* enabled and domain
  reload disabled — which this release recommends, so it is the configuration most projects run —
  ending a Play session destroyed the connection's GameObject but left `SingletonBehaviour<T>`'s
  "already created one" flag latched in a static that the session did not reset. Every later press
  of Play was handed back the *destroyed* connection: no object in the scene, no `Update`, no
  socket, and — because reading a destroyed reference throws nothing — not one line in the console
  to say so. The Colibri Status window's "No Colibri connection in the scene yet" was the only
  visible symptom, and it reads like an explanation rather than a fault. Liveness is now decided by
  the instance itself rather than by a flag, so a destroyed one is replaced; creation is still
  suppressed while the application is quitting, so nothing is resurrected during teardown. Affects
  `WebServerConnection` and `VoiceServerConnection` alike.
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

## Getting started

Colibri is used to teach, by people who know some C# and almost no Unity. Every silent failure is
an hour they do not spend on their prototype, so:

- **Installing is one git URL.** No UniRx, no R3, no UniTask, no NuGetForUnity — the only
  dependency is `com.unity.nuget.newtonsoft-json`, resolved automatically from `package.json`.
- **`Sync.Receive<float>("ch", MyHandler)`.** `Receive` is overloaded once per supported type,
  which made `Sync.Receive("ch", MyHandler)` ambiguous and forced a cast onto every call site. The
  generic version dispatches by pattern-matching the delegate — no reflection — and the existing
  overloads still work. Same for `Unregister<T>`. There is deliberately no `Send<T>`:
  `Sync.Send("ch", value)` already resolves, and a generic version would demote today's compile
  error on an unsupported type to a runtime message.
- **Listeners clean themselves up.** `Sync.Receive` had to be paired with a `Sync.Unregister` in
  `OnDestroy`, and forgetting it was the most expensive mistake in the API: the delegate keeps
  calling into a destroyed `MonoBehaviour`, the first line touching `transform` throws
  `MissingReferenceException`, and that exception surfaces out of `WebServerConnection.Update` —
  discarding every message still queued behind it that frame. Colibri now records which Unity object
  each listener belongs to and drops the listener once that object is destroyed. It works for a
  method group (the delegate's target *is* the component) and for a lambda written inside one (the
  component is a field of the compiler-generated closure), resolved once at registration, never per
  message. `Unregister` is unchanged and still needed to stop listening while the object lives on,
  or for a `static` listener, which has no Unity lifetime to follow.
- **Type mismatches are reported.** Colibri routes on (channel, type), so a `float` sent to a
  `string` listener used to be dropped without a word (`Sync.cs`, the missing-listener branch). The
  new `ChannelListenerRegistry` tracks which types each channel has listeners for, and the warning
  names the channel, both types, and the fix. It stays quiet for a channel with *no* listeners,
  which is normal traffic, and reports each `(channel, type)` mistake once rather than per message.
- **A missing configuration says so.** `ColibriConfig.Load()` returned `null` without
  `Resources/ColibriConfig.asset`, so `GetWebUrl` threw an NRE and the connection loop polled
  forever in silence. It now returns the defaults and reports the missing config once, pointing at
  the menu item that fixes it. The "connected" log names the host, port and **app name**, because a
  typo there produces a healthy connection on which no other client is ever seen.
- **`Window → Colibri Status`** — connection state, server, app name, protocol version, time since
  the last server heartbeat (not a latency: the heartbeat carries the *server's* clock), the
  channels with listeners and the type each expects, and the last 20 messages in and out. It uses
  `FindFirstObjectByType`, never `WebServerConnection.Instance`, which *creates* a GameObject.
- **Status reports the delivery rate, not just the connection.** With the socket off the main
  thread, what is left between a message arriving and user code seeing it is one frame of *this*
  client's. So the window states it: the rate `Update` is running at, the delay that implies per
  message, and below 20 fps a warning naming the usual cause — an Editor in the background, which
  Unity throttles. Without it, a client delivering at 4 fps is indistinguishable from a slow server,
  and the search goes looking on the wrong side of the wire.
- **`[Sync]` members are validated at startup** — an unsupported type, a property missing an
  accessor, or two members whose lowercased names collide are reported when the model type is first
  initialized instead of failing on the first message.
- Samples and README lead with the cast-free form.

## Performance

- **The sync tick allocates nothing while idle.** `Observable.EveryValueChanged` registered one
  frame-provider work item per synced attribute per object — five for every `SyncTransform` — and
  polled through a `Func<T, object>` getter, boxing four values per object per frame. On 100 idle
  synced objects at 60 fps that is roughly 24,000 allocations and 575 KB of garbage per second
  before anything moves.
- `SyncTicker` replaces it with **one `Update` and one `LateUpdate` for the whole application**,
  iterating an index loop over its registrations. `SyncedAttribute` became a typed hierarchy whose
  per-instance tracker compares with `EqualityComparer<TValue>.Default` — the `IEquatable<>` path
  for `Vector3`/`Quaternion` — so an unchanged attribute costs a comparison and nothing else. A
  value is boxed only on the frame it actually changes, to hand it to `AddUpdate`.
- Poll (`Update`) and flush (`LateUpdate`) are separate phases, which keeps the existing
  one-message-per-frame coalescing while removing the `async void` + `UniTask.Yield(PostLateUpdate)`
  state machine that used to allocate once per change.
- Neither library was ever on the network path: `WebServerConnection` used raw `Socket`, `Task`,
  `SemaphoreSlim` and `FrameCodec` throughout, so removing them changed nothing there. What did
  change latency is the `ConfigureAwait(false)` work above — the socket no longer waits for the
  player loop, which is worth far more than anything on this list to a client that is not running
  at full frame rate.

## Dependencies and API modernization

- **UniRx removed, not replaced.** `IObservable<T>` subscriptions became plain methods and static
  events; `this.ObserveEveryValueChanged(f)` became the typed change tracking above;
  `RemoteLogging`'s `Observable.Start` + `WhenAll` + `ObserveOnMainThread` + `Sample()` became a
  volatile flag set from Unity's threaded log callback and a one-second timer in `Update`. Its retry
  is still re-armed only after clearing the in-flight flag, and a send that throws is now caught and
  reported once instead of escaping as an unhandled `async void` exception — it cannot be reported
  repeatedly, because logging from inside the log sender feeds back into this queue.
- **UniTask removed.** `UniTaskCompletionSource` → `TaskCompletionSource` (which also tolerates
  several pending awaiters); `await request.SendWebRequest()` → a three-line `TaskCompletionSource`
  wrapper over `UnityWebRequestAsyncOperation.completed`, completing inline so the caller stays on
  the main thread. The plain awaiter never throws, so `Store` now checks `request.result` and
  reports what failed, at which URL, with the HTTP status.
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
- `ChannelListenerRegistryTests` covers the type-mismatch diagnostics — including the cases where a
  message must *not* be reported. `Sync` itself is not directly testable, because registering a
  listener reaches `WebServerConnection.Instance`, which spawns a GameObject; the registry was split
  out as plain C# precisely so the interesting part could be.
- `ListenerOwnerTests` covers which Unity object a listener is judged to belong to, since that is
  what automatic unregistration hangs on: a method group, a lambda written in a component, a lambda
  nested two closures deep, and the cases that must resolve to *nothing* — a static method, a plain
  C# object, a lambda over locals — because pruning one of those would be a new bug in place of the
  old one.
- `JsonExtensionsTests` covers the conversions every inbound message passes through — both wire
  forms of a colour, integer tokens where a float is expected, and every malformed shape, each of
  which has to fall back and warn exactly once rather than throw. This is the file the colour bug
  lived in, and it had no tests at all.
- New PlayMode assembly `HCIKonstanz.Colibri.E2E` (`Assets/Tests/`, in the development project
  rather than the shipped package). A real Unity client, a real colibri-server and a raw v3 peer as
  the second endpoint — the server excludes the sender from its own broadcasts, so one client can
  never observe anything it sends. It covers the handshake and heartbeat, all 17 payload shapes in
  both directions asserting the exact bytes outbound, per-member `SyncBehaviour` updates, a model
  from another client being instantiated exactly once, `SyncTransform`'s per-field switches, the
  once-only mismatch warning, the Store over REST, and the ticker invariants behind the "one
  `Update` for the whole application" claim. Without a reachable server it skips with instructions
  rather than failing.
- `LifecycleTests` additionally pins what a singleton does once the previous Play session's instance
  has been destroyed — it must be rebuilt, not handed back. The bug this replaces produced no
  exception and no log line of any kind, so nothing short of asserting the invariant directly would
  have caught it. The assertions run against a singleton declared for the test rather than against
  `WebServerConnection`, since the statics are per-type and destroying the real connection would
  pull it out from under the rest of the suite.
- `ConnectionTests` pins the threading. The one that matters blocks the main thread outright for a
  second and then asserts the last heartbeat is still under half a second old — proof the socket is
  being serviced by something other than the player loop. It is deliberately the symptom the bug
  report described rather than a check for `ConfigureAwait` in the source, so it stays honest if the
  mechanism ever changes; a companion asserts the receive loop's thread is not the main one, which
  is the same fact stated the other way round. A third covers traffic entries ageing out of the
  Status window's log.
- `node colibri-unity/run-tests.mjs` runs both suites, starting and stopping a server with
  `docker compose` — unless one is already listening, which it uses as it stands. See
  [README.md](README.md#for-maintainers).
- The cross-implementation protocol vectors are checked automatically: `npm run test:vectors` in
  colibri-server re-encodes each one and fails if `ProtocolVectorTests.cs` no longer expects the
  same bytes. It runs in the server's CI workflow, which now also triggers on changes to the C#
  vectors.
- Still no GameCI workflow: the Unity suites run locally, since a Unity container in CI needs a
  licence secret. Voice chat remains uncovered — it needs a microphone.

## End-to-end verification, and what it fixed

The Editor acceptance criteria for the release were run on 2026-08-05: Unity 6000.5.7f1, a
URP-template project with Colibri as a `file:` UPM package, against `colibri-server` 2.0.0 built and
run locally. The EditMode suite came back **52 passed, 0 failed**, and the server's own suite was
green at 102. The other end of every message-level exchange was a Socket.IO peer written against
colibri-web or a raw v3 TCP client, with a pass-through proxy in front of the TCP port decoding every
frame in both directions, because that is what makes the bytes quotable. A development Windows 64-bit
player was also built from the same project (`result=Succeeded errors=0 warnings=13 time=00:01:59`)
and run alongside the Editor with both clients connected to the same app at once and no
`FrameException` in the player log — the configuration the old hardcoded voice port and the old
`static` socket fields would have broken. The visual half of that is still unconfirmed: nobody
watched an object in one client follow an object in the other, since the player's scene state is not
observable from outside its process. The type-mismatch warning fires once for 60 offending
messages rather than once each, and the `SyncBehaviour` sample propagates private `[Sync,
SerializeField]` fields, public fields and properties alike, instantiates its template for a
remote-created model, and recovers that model from server state as a late joiner — one instance, not
a duplicate. The leak check is the one that found a defect rather than confirming a claim; it is the
last fix below. The headline performance claim was measured rather than argued: 100 idle
`SyncTransform`s with Deep Profile off gave a median frame of **0 bytes** of GC allocation over a
231-frame window, and exactly one `SyncTicker.Update()` on the main thread attributed to the single
`[Colibri SyncTicker]` object — 0.335 ms of a 0.786 ms `PlayerLoop`, so the idle poll allocates
nothing but is not free of time. All ten criteria are addressed; what the pass did not touch is voice
chat and the visual half of Unity ↔ Unity. Item-by-item results are in §8 of
[`docs/v2-ease-of-use-and-performance.md`](docs/v2-ease-of-use-and-performance.md).

The fixes it produced:

- **The `SendData` sample never round-tripped its JSON.** `SendMessages` sent its `JObject` on the
  literal channel `"myJson"` while listening on `Channel`, so the one payload type that most needs
  demonstrating was the one that appeared not to work. It sends on `Channel` now.
- **Samples moved to `Samples~`, and `Prefabs` left `samples[]`.** As live package folders they were
  compiled into every consumer *and* offered for import, so Package Manager → Import produced a
  second copy of everything: importing `SendData` the way the README says logged a GUID conflict
  against `Packages/de.uni.kn.colibri/Samples/SendMessages/SendMessages.cs`, left two definitions of
  `HCIKonstanz.Colibri.Samples.SendMessages` — one in `Assembly-CSharp`, one in `HCIKonstanz.Colibri`
  — and two copies of every scene. Not a hard compile error, but any user code naming the type was
  ambiguous. After the move: zero sample types in the package assembly, and a re-import yields
  exactly one `SendMessages.unity` with no GUID warnings. See the breaking-change note above. The
  tradeoff, as expected, is that the `colibri-unity` dev project can no longer open the sample scenes
  in place; they are opened from a consuming project now.
- **Stale `SyncTransform` sample assets.** `SyncTransformSample.unity` carried a dead
  `propertyPath: Channel` override (`synctransform_CUBE`) that no longer corresponds to anything, and
  `CubeModelTemplate`/`SphereModelTemplate` predate the `SyncActive` and `UseLocalTransform` fields.
  Both are updated, so the scene demonstrates the component as it currently exists.
- **Colour did not round-trip, and took the frame down with it.** Unity writes a colour as the HTML
  string `#RRGGBBAA` — which is what colibri-web's `receiveColor` is typed for — but colibri-web's
  `sendColor` puts an `[r,g,b,a]` array on the wire. A colour from a web client arrived as
  `InvalidCastException: Cannot cast JObject to JToken` out of `JsonExtensions.ToColor`, and because
  that escaped `WebServerConnection.Update` unhandled it also dropped every message queued behind it
  that frame. `ToColor` accepts either form now, and all of the vector, quaternion and colour
  conversions report a wrong-shaped payload as a warning naming the type and the expected shape
  instead of throwing. A web client's `[1, 0.5, 0.25, 1]` now arrives as
  `RGBA(1.000, 0.500, 0.250, 1.000)`. colibri-web's own `sendColor`/`receiveColor` asymmetry is left
  as it is on purpose: changing the wire format would move behaviour under existing web-only users,
  and Unity copes with both forms.
- **Integers sent from Unity were dropped by web clients.** `Sync.Send(channel, 5)` goes out tagged
  `broadcast::int`, but colibri-web's `receiveNumber` only listened for `broadcast::float`.
  JavaScript has a single number type, so there was nothing to distinguish and every integer a Unity
  client sent vanished without a trace. Fixed in colibri-web: `receiveNumber` and
  `receiveNumberArray` listen for both commands, with its 108 tests still passing.
- **The status window's heartbeat readout counted down.** `MillisSinceLastHeartbeat()` is a 0-100 ms
  sawtooth and the window repaints at 10 Hz, so the raw sample beat against the server's heartbeat
  and read like a timer running out. It now peak-holds the worst gap over a one-second window, which
  is steady and is the number that actually indicates trouble.
- **`Store` waited forever.** `UnityWebRequest.timeout` defaults to no timeout, so on an unconfigured
  project — where `ServerAddress` still points at the public `colibri.hci.uni-konstanz.de` —
  `Store.Get` neither threw nor logged, and was still outstanding after a minute. The detailed
  failure log added in this release only runs when the request finishes, so `Get`/`Put`/`Delete` now
  set a ten-second timeout: long enough for a slow link, short enough that the failure is reported
  while the student is still looking at the console.
- **`SyncTicker` leaked one GameObject per Play session, and they all ticked.** With *Enter Play Mode
  Options → Disable Domain Reload* on, three enter/exit cycles left one extra `[Colibri SyncTicker]`
  behind each time; measured outside Play mode the Editor had collected seven, all still enabled:

  ```
  live SyncTicker components (outside Play mode): 7
    go='[Colibri SyncTicker]' hideFlags=DontSave activeSelf=True enabled=True scene='' valid=False
    ... x7
  ```

  `HideFlags.DontSave` exempts an object from Play-mode teardown as well as from being saved, and
  `DontDestroyOnLoad` was already covering the saving half by itself. The stale object is not the
  real cost: every ticker drives the same static `_tickables` list, so the n-th Play session ran
  `PollChanges` and `FlushUpdate` n times per frame — duplicate `model::update` messages on the wire
  and a sync cost that grew each time someone pressed Play, which is the direct contradiction of the
  one-`Update`-for-the-whole-application claim above. The flag is gone and `ResetState` destroys
  strays first, so an Editor that already accumulated them recovers on the next Play. Afterwards:
  zero tickers alive outside Play mode, three cycles holding steady, and the 52 EditMode tests still
  green.

  ```
  LEAK syncedBehaviours=4 connections=1 tickerObjects=1 tickables=4
  LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
  LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
  ```

  (The first cycle counts four because the late-joined remote model had already arrived when the
  probe ran.) `ColibriTest` was left with *Disable Domain Reload* enabled, since that is the
  configuration this check requires.

## Known residuals

- A disabled `SyncBehaviour` neither polls nor sends, and picks changes made while it was disabled
  up as ordinary changes the frame it comes back. That matches UniRx's original `TakeUntilDisable`
  scoping rather than the `.AddTo(this)` (destroy-scoped) behaviour it had in between.
- `SyncBehaviourManager` must unsubscribe from `SyncBehaviour<T>.ModelCreated` / `ModelDestroyed` in
  `OnDestroy`, since static events do not do it themselves. It does; anything else subscribing to
  them has to as well, or it leaks across Play sessions when domain reload is disabled.
- A `static` listener, or one owned by a plain C# object, stays registered into the next Play session
  when domain reload is disabled — `Sync`'s listener dictionaries are statics, and neither of those
  has a Unity lifetime to be dropped by. Listeners belonging to a Unity object clean themselves up,
  which covers the ordinary case. Clearing the dictionaries at startup would fix it and break a
  listener registered from a `[RuntimeInitializeOnLoadMethod]` hook, so it is left as it is.
- `Expression.Compile()` is still used to build the `[Sync]` accessors, so the model layer depends
  on Unity's expression-tree support on AOT platforms. Attribute construction dispatches through an
  explicit per-type `if` chain rather than `MakeGenericMethod`, which keeps every instantiation
  visible to the AOT compiler.
