# Upgrading to Colibri 2.0

For anyone with a project built on Colibri 1.x. It covers all three components — the server, the
web client and the Unity client — and concentrates on what you have to change and what changes
underneath you.

Each component has its own changelog with the full detail:
[`colibri-server/docs/v2-changelog.md`](colibri-server/docs/v2-changelog.md),
[`colibri-web/CHANGELOG.md`](colibri-web/CHANGELOG.md),
[`colibri-unity/CHANGELOG.md`](colibri-unity/CHANGELOG.md).

---

## Read this first: the server and Unity move together

colibri-unity 2.0.0 speaks a [new binary TCP protocol](colibri-server/docs/protocol.md) and
**requires colibri-server ≥ 2.0.0**. There is no version negotiation — both sides have to be
upgraded together. A 1.x Unity client cannot talk to a 2.0.0 server, and a 2.0.0 Unity client
cannot talk to a 1.x server.

The failure is at least diagnosable now. The server's log — the admin UI's log page, and since 2.0
also the server's console output, so `docker logs` for a container — says what is wrong:

- **A 1.x Unity client** cannot even send the server a handshake it can read, so the server cannot
  check its version or tell it anything. It recognizes the 1.x wire format instead and logs a
  warning that names the client's address and says to upgrade the Colibri Unity package
  (`de.uni.kn.colibri`) to 2.x. A 1.x client retries about once a second, so the warning is repeated
  at most once a minute per address. The client is never told why; it just keeps reconnecting.
- **A client whose handshake the server can read, but whose protocol version it does not speak**,
  is refused: the server logs the client and both versions, and tells the client why on the
  `colibri` channel. A 2.0.0 Unity client logs that, shows it in `Window → Colibri Status`, and
  stops reconnecting.

See [Version checking](colibri-server/docs/protocol.md#version-checking).

**Web clients are covered by the same check**, even though Socket.IO itself did not change.
`colibri-web` 1.x announces `version: '1'` in its handshake query, so a 2.0.0 server refuses it —
this is the one place the version check is a breaking change for web.

The symptom on a stale web client is quiet, because no 1.x release of `colibri-web` (the last is
1.3.2) knows `protocol::rejected`. It receives the rejection as an ordinary message on
`Colibri.messages`, which nothing is listening for, and is then disconnected; Socket.IO does not
reconnect after a server-side disconnect, so **it connects once and then stops, with no error on the
client at all**. The server's log line — which names the client, its address and both versions — is
the diagnostic. `colibri-web` 2.0.0 logs a refusal itself and exposes it on
`Colibri.protocolMismatch`.

Upgrading in the other order — clients first, server later — is now noticed too, though only ever
as a suspicion. Neither client can be *told* it is talking to a 1.x server, because the version
check lives on the server and a 1.x server has none. A 2.0.0+ server therefore announces itself to
web clients on connect, and its silence is the signal: a current web client warns after five
seconds and **stays connected** (it works — the Socket.IO envelope did not change, verified against
real 1.1.1 and 1.3.1 servers with traffic flowing both ways). A current Unity client cannot connect
to a 1.x server at all; it reports a likely protocol mismatch after three connections that were
accepted and then ended before a frame could be read, and keeps retrying. Details in
[Detecting an out-of-date server](colibri-server/docs/protocol.md#detecting-an-out-of-date-server).

So the safe order is: **upgrade the server first** — from then on its log names every client that is
still on 1.x — then Unity, then the web clients. A 2.0.0 server refuses 1.x web clients, so they
have to be upgraded too; they cannot be left running.

---

## The short version

- [ ] Server: Node 24, and it is ESM now
- [ ] Unity: 2022.3 LTS or newer, and delete your vendored `Newtonsoft.Json.dll`
- [ ] Unity: replace every `IObservable` subscription with `+=` / `-=`, and unsubscribe yourself
- [ ] Unity: `ObservableModel<T>` / `ObservableManager<T>` are gone — use `SyncBehaviour<T>` /
      `SyncBehaviourManager<T>`
- [ ] Unity: import any sample you were relying on from the Package Manager; sample types are no
      longer compiled into your project
- [ ] Web: `@Synced() private x = 0` → `@Synced() accessor x = 0`, and drop `experimentalDecorators`
- [ ] Web: add `rxjs` to your own dependencies
- [ ] Web: `receiveColor` / `receiveColorArray` callbacks get a `ColorValue`, not a `string`
- [ ] Everywhere: read [Behaviour changes that will not fail to
      compile](#behaviour-changes-that-will-not-fail-to-compile) — that is where the surprises are

---

## colibri-server

### Breaking

**Node 24.** The runtime moved from `node:20-alpine` (end of life) to `node:24-alpine`, and
`src/server` is native ESM: `"type": "module"`, explicit `.js` import extensions, no `__filename`.
If you have forked or patched the server, that is the change that will touch every file.

**The v3 TCP protocol.** The old FlatBuffers framing with its ASCII length header is gone,
replaced by a fixed binary format:

```
[u32 LE totalLength][u8 type][body]        totalLength = 1 (type) + body.length
  0x00 heartbeat   [u64 LE pingTimestamp]
  0x01 handshake   utf8 "version::app::name"
  0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
```

Anything you wrote that speaks TCP to Colibri has to be rewritten against
[`docs/protocol.md`](colibri-server/docs/protocol.md). Socket.IO clients are unaffected.

**The `flatbuffers` dependency is gone**, along with `body-parser`, `uuid` and
`source-map-support`.

### Worth knowing

**If you run the published image without a version tag** (`hcikn/colibri`, which means `latest`),
the next pull can take a 1.x server to 2.x — and that cuts off every 1.x client. Pin the version
you run, and change it when you upgrade the clients.

**The Docker image is multi-stage now.** It ships only `dist/` and production dependencies, sets
`NODE_ENV=production`, starts `node` directly instead of `npm start` (so the server is PID 1 and
shuts down cleanly on `docker stop`), and has a `HEALTHCHECK` on the web port.

**The server no longer runs as root.** The container starts as root only long enough to hand
`/srv/colibri/data` to the image's `node` user (uid 1000), then runs the server as `node`. A
`./data` that Docker creates, or the root-owned one 1.x left behind, therefore works without any
manual step — but on the host it now belongs to uid 1000. Started with `docker run --user …` (or
`user:` in compose), the container cannot change ownership: give the directory to that user
yourself, or use a named volume. If the server cannot write its data directory, it says so on
stderr at startup, with the fix, and keeps running without saving anything.

**The server's log reaches `docker logs`.** In 1.x its log messages only appeared on the admin
UI's log page. They are now also printed to stdout, errors and warnings to stderr — the refusals
and the 1.x-client warning above included, and so are the log lines clients send through Unity's
`[RemoteLogger]` prefab or colibri-web's `RemoteLogger`. `CONSOLE_LOG_LEVEL` (`error`, `warn`,
`info` or `debug`; default `info`) sets how much is printed, and broadcast traffic is only printed
with `CONSOLE_LOG_BROADCAST_TRAFFIC=true`. The bundled `docker-compose.yml` caps the container log
at five files of 10 MB.

**New limits keep one client, or one class, from overloading the server.** Each is an environment
variable, described in [`.env.example`](colibri-server/.env.example):

- `CLIENT_MESSAGE_RATE_LIMIT` (default 1000, `0` for none) and `CLIENT_MESSAGE_RATE_BURST`
  (default 2000): how many broadcasts and model updates a second one client, Unity or web, may
  send. Beyond that its broadcasts are dropped, and its model updates are held back and merged per
  object, so the latest value of every field still arrives.
- `TCP_INBOUND_BACKLOG_LIMIT` (default 2000, `0` for none): how many messages from Unity clients
  may be waiting for the server's main thread before it treats their broadcasts and model updates
  the same way.
- `TCP_IDLE_TIMEOUT_SECONDS` (default 10, `0` for never): a Unity client that sends nothing for
  this long is disconnected. A headset that drops off the Wi-Fi or goes to sleep does not close
  its connection, and used to count as connected, keeping its app's synced objects alive, until
  the operating system gave up on it many minutes later.
- `APP_CLIENT_WARNING_THRESHOLD` (default 8, `0` for never): a warning when one app has more
  clients than this. Every message goes to each of an app's other clients, so the server's work
  grows with the square of an app's size; a class whose groups all kept the same app name is the
  usual way to get there.

Each stretch of dropping or holding back is logged as one warning when it starts, naming the client
for the rate limit, and one summary with the counts once it is over. The rate limit's default is
far above what a lab group sends: even ten objects each sending in every frame at 72 Hz make 720
updates a second.

---

## colibri-web

### Breaking: `@Synced()` needs standard decorators

`@Synced()` now uses TypeScript's standard TC39 `accessor` decorators instead of the legacy
`experimentalDecorators` ones. Remove `experimentalDecorators` from your `tsconfig.json`, and turn
every synced member into an `accessor`:

```ts
// 1.x
class Player extends SyncModel<Player> {
    @Synced() private age = 0;
}

// 2.0
class Player extends SyncModel<Player> {
    @Synced() accessor age = 0;
}
```

This is not only a syntax change: field synchronization never worked correctly under the legacy
decorator in frameworks that re-create instances, React among them. Those bugs go away with it.

### Breaking: TypeScript, and `rxjs` is yours now

Colibri targets TypeScript 5.0+. The plain-JavaScript sample ports were removed; a project tied to
plain JavaScript can use the workaround in `colibri-web/docs/js-workaround`.

`rxjs` moved from a dependency to a **peer dependency**, because its types are part of the public
API (`SyncModel`, `RegisterModelSync`, `Colibri.messages`). Add it to your own `package.json`:

```sh
npm install rxjs
```

### Breaking: colour callbacks get a `ColorValue`

A colour reaches a web client as the string `"#RRGGBBAA"` from Unity, but as an `[r, g, b, a]`
array from another web client. 1.x typed the `receiveColor` callback as `string` either way, so a
web-to-web colour was an array passed off as a string. The callbacks of `receiveColor` and
`receiveColorArray` now get a `ColorValue` (either form), and the new `toHexColor()` and
`toRgbaColor()` turn one into the shape you want:

```ts
// 1.x
Sync.receiveColor('tint', (hex: string) => setTint(hex));

// 2.0
import { toHexColor } from '@hcikn/colibri';
Sync.receiveColor('tint', colour => setTint(toHexColor(colour)));
```

Under `strict`, a callback typed `string` no longer compiles; without it, it compiles and goes on
receiving arrays from web peers. A value that is not a colour makes both functions warn and return
opaque black instead of throwing. `sendColor` accepts either form too; what goes on the wire is
unchanged.

### Fixed

`import { ColibriError } from '@hcikn/colibri'` works — it was a default export, which `export *`
does not re-export, so it silently imported `undefined`. `require()` consumers now get their own
`.d.cts` declarations. A stray `console.log` on every model registration is gone, which for anyone
using `RemoteLogger` was also a stream of pointless network traffic.

The server address can be written the way a browser shows it:
`new Colibri('my-app', 'http://192.168.0.10:9011')` works, as do `https://`, `ws://` and `wss://`,
a port in the address and a trailing slash. The port is the one in the address, else the third
argument, else 9011 — for `https://` too. An address that 1.x turned into a URL that could never
connect now throws a `ColibriError` instead: a path after the host (the admin UI's own `…/log`,
say), an unknown scheme, a port that is not a whole number, or a port in the address that disagrees
with the port argument.

`Sync.receive*`, `RegisterChannel`, `RegisterModelSync` and `new RemoteLogger()` may come before
`new Colibri()`; they take effect once it is constructed.

`RegisterModelSync` names its channel after the class unless you pass `name`, and a minifier
renames classes — so a minified build can end up on a different channel from Unity and from other
builds, without any error. It now warns when the class name looks minified. Pass `name` for
anything you bundle: `RegisterModelSync({ name: 'player', type: Player })`.

---

## colibri-unity

This is where most of the work is.

### Breaking: Unity 2022.3 LTS

The manifest previously claimed 2019.4 while using APIs that were never available there. It now
says what it means.

### Breaking: UniRx is gone, and was not replaced

There is no reactive layer any more. `SyncBehaviour<T>.ModelCreated()` and `ModelDestroyed()` were
methods returning `IObservable<>`; they are now plain static events:

```csharp
// 1.x
SyncBehaviour<Player>.ModelCreated()
    .Subscribe(model => Register(model))
    .AddTo(this);

// 2.0
private void OnEnable() => SyncBehaviour<Player>.ModelCreated += Register;
private void OnDisable() => SyncBehaviour<Player>.ModelCreated -= Register;
```

**Read that second half carefully.** A UniRx subscription with `AddTo(this)` unsubscribed itself
when the component was destroyed. A static event does not. Miss the `-=` and you leak the handler
and the destroyed object behind it — and with *Enter Play Mode Options → Disable Domain Reload* on,
the leak survives into the next Play session and everything fires twice.

`this.ObserveEveryValueChanged(...)` has no replacement either. Colibri's own change detection now
runs in one `Update` for the whole application; if you were using UniRx for your own polling, that
is now your own dependency to add.

### Breaking: `WebServerConnection.Connected` is a `Task`

```csharp
// unchanged
await WebServerConnection.Instance.Connected;

// 1.x only
WebServerConnection.Instance.Connected.Subscribe(isConnected => ...);
```

For the subscription form, use the `OnConnected` / `OnDisconnected` events instead.
`OnDisconnected` is raised exactly once for every `OnConnected`, and never for an attempt that did
not connect.

"Connected" now means the server has spoken: the task completes, and `OnConnected` fires, once the
first frame from the server arrives, not as soon as the TCP connection is accepted. While
disconnected, `Connected` is a fresh task that waits for the next connection. It is cancelled when
the component is disabled and when the server refuses this client's protocol version, so an `await`
on it can throw `TaskCanceledException`.

### Breaking: `ObservableModel<T>` and `ObservableManager<T>` are deleted

They spoke `channel::register`, `channel::deregister` and bare `add`/`update`/`request`/`remove`. A
2.0 server registers none of those commands, so the API was already dead against the server it
targeted. Port to `SyncBehaviour<T>` and `SyncBehaviourManager<T>`, which cover the same ground:

```csharp
public class Player : SyncBehaviour<Player>
{
    [Sync] public string Name = "";
    [Sync] public int Score;
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Put `PlayerManager` in the scene with a prefab in its `Template` field, and a `Player` created by
any client appears on all of them.

### Breaking: no more vendored Newtonsoft

`Assets/Colibri/Plugins/Newtonsoft.Json.dll` is gone, replaced by the
`com.unity.nuget.newtonsoft-json` package, declared as a real dependency. **Delete your own copy if
you have one** — two Newtonsoft assemblies in one project is a compile error, not a warning.

Installing Colibri is now one git URL and nothing else: no UniRx, no UniTask, no NuGetForUnity.

### Breaking: the samples are no longer compiled into your project

`Samples/` was a live package folder, so every consumer compiled `HCIKonstanz.Colibri.Samples.*`
into the Colibri assembly whether they wanted it or not — and *Package Manager → Import Sample*
then made a second copy of the same types.

Samples now live in `Samples~`, which Unity does not compile. Those types exist only after you
import the sample, and then they are yours, in `Assets/Samples/`, in `Assembly-CSharp`. **Code that
referenced a sample type without importing the sample no longer compiles**; import the sample, or
copy the two files you actually wanted.

Prefabs are unaffected. `[RemoteLogger]` and `[SyncTransformManager]` are still draggable straight
out of `Packages/Colibri/Prefabs`.

---

## Behaviour changes that will not fail to compile

These are the ones to watch: your project builds, and then behaves differently.

**Strings finally round-trip.** 1.x wrote string payloads *unquoted*, which is not valid JSON, so
the server fell back to a different reader. A Unity `Sync.Send(channel, "hello")` and a web client's
version of the same message did not arrive identically. Both now go out as JSON. If you had a
workaround for that asymmetry, it is now the bug.

The `log` channel is the deliberate exception and still carries raw text, because the admin UI reads
it as a string.

**Colours cross between Unity and the web in both directions.** Unity writes `#RRGGBBAA`;
colibri-web's `sendColor` writes `[r, g, b, a]` when given an array. Unity used to throw an
`InvalidCastException` on the array form — out of the frame's single dispatch loop, taking every
message queued behind it that frame with it. It now accepts both, and so does colibri-web (see
[colour callbacks](#breaking-colour-callbacks-get-a-colorvalue)).

**Integers from Unity reach web clients.** Unity distinguishes `int` from `float` and tags the
message accordingly, so `Sync.Send(channel, 5)` arrives as `broadcast::int`. `receiveNumber` only
listened for `broadcast::float` and dropped every one of them in silence. It now listens for both.

**`Store` gives up after 10 seconds.** `UnityWebRequest` defaults to no timeout at all, so a wrong
server address left `Get`/`Put`/`Delete` outstanding forever: no result, no error, nothing in the
console. Calls that used to hang now fail, and say what failed, at which URL, with the HTTP status.

**The store takes any JSON value.** 1.x answered `400` to anything but an object or an array, and
`413` above 100 kB. A plain number, string, boolean or `null` is now stored too — Unity's
`Store.Put("score", 42)`, colibri-web's `setRestObject('note', 'text')` — up to 5 MiB.

**Clients catch up after a reconnect.** Both clients used to ask for the synced models' state only
when a listener registered, so whatever other clients changed during an outage was missed until the
next change. Unity and web clients now ask again every time they reconnect, and update the objects
they have rather than creating duplicates. A model deleted during the outage is not removed, and the
server still forgets an app's models once its last client disconnects. While a Unity client is
disconnected, what it sends waits in one queue and goes out in order when the connection is back;
past 256 broadcasts and log lines the oldest are dropped, with one warning per outage, while model
updates are never dropped.

**Voice chat binds to an ephemeral port.** The receive socket used to bind port 9014, which capped a
machine at one Unity client. The server replies to the datagram's source port, so the fixed port
bought nothing.

**The latency echo is gone.** The old `colibri` / `latency` message round trip was removed; TCP
latency comes from the 100 ms heartbeat the client echoes back verbatim. Nothing sends `latency` to
a TCP client any more.

**An unconfigured project says so.** `ColibriConfig.Load()` used to return `null` without a config
asset, which made `GetWebUrl` throw an NRE and the connection loop poll forever in silence. It now
returns defaults and reports the missing configuration once, naming the menu item that fixes it.

**New warnings in the console.** Colibri routes messages on the channel *and* the type, so a `float`
sent to a `string` listener was previously dropped without a word. That mismatch is now reported —
once per (channel, type), not once per message — and it names both types and the fix. If new
warnings appear after upgrading, they were always happening; you just could not see them.

**`Sync` listeners now unregister themselves with their component.** `Sync.Receive` records which
Unity object the listener belongs to — the component for a method group, the component the closure
captured for a lambda — and drops the listener once that object is destroyed. A listener with no
such object stays registered until `Sync.Unregister`, as in 1.x: a static method, or a lambda that
uses nothing of its component (only its parameter, `Debug.Log` or a static), because that lambda
captures nothing. Registering does not check for duplicates, so if `Start` adds one of those, a
scene reload adds it again and each message then reaches it twice.

Your existing `Sync.Unregister` calls in `OnDestroy` are still correct and still worth keeping; for
listeners that belong to a component they are simply no longer the difference between working and
not. What changes silently is the failure they used to cause: a forgotten `Unregister` meant the
destroyed component kept being called, `MissingReferenceException` came out of
`WebServerConnection.Update`, and every message queued behind it that frame was lost. If your
project had unexplained gaps in delivery, this is a strong candidate.

Note the asymmetry with the point above: **this covers `Sync.Receive` only.** `SyncBehaviour<T>`'s
static `ModelCreated` / `ModelDestroyed` events are plain C# events and still need their `-=`.

**Two server-side data bugs are fixed structurally.** `DataStore` keyed on `group + channel`
concatenated, so app `ab` + channel `c` collided with app `a` + channel `bc`. And `clearApp`
matched on a `startsWith` prefix, so the last client of app `test` disconnecting wiped app `test2`'s
store as well.

---

## After upgrading, check these

1. **Every `[Sync]` member still has a supported type.** They are validated when the model type is
   first initialized, and an unsupported type, a property missing an accessor, or two members whose
   lowercased names collide are now reported at startup rather than on the first message.
2. **Every static event you subscribe to is unsubscribed** in `OnDisable` or `OnDestroy`. This is
   `SyncBehaviour<T>.ModelCreated` and `ModelDestroyed`. `Sync.Receive` listeners mostly look after
   themselves now; a static method or a lambda that uses nothing of its component still needs its
   `Sync.Unregister` (see [above](#behaviour-changes-that-will-not-fail-to-compile)).
3. **Turn on *Run In Background*** (Project Settings → Player). With it off, an unfocused Editor
   stops running the player loop, so the client silently stops sending and receiving — while the
   socket stays up and everything still reports itself connected. This is not new in 2.0, but it is
   the single most common way to lose an afternoon.
4. **Open *Window → Colibri Status*** while connected. It shows the app name, and a typo there
   produces a perfectly healthy connection on which no other client is ever seen.

---

## What is tested, and what is not

Honest about the edges. The test suites:

- `npm test` in `colibri-server` and in `colibri-web` — unit tests. Both run in CI, together with a
  check that the server's frame encoding matches the vectors the Unity tests use, and that every
  client announces the protocol version the server speaks.
- `npm run test:e2e` in `colibri-web` — against a running server. Not run in CI.
- `node colibri-unity/run-tests.mjs` — the Unity client's EditMode tests, and its PlayMode tests
  against a real server (started with Docker, unless one is already running). It needs a local
  Unity installation and does not run in CI. See
  [colibri-unity/README.md](colibri-unity/README.md#for-maintainers).
- `npm run test:docker` in `colibri-server` — runs the image against a fresh, a root-owned and a
  named-volume data directory. Needs Docker; not run in CI.

What none of them covers:

- **Voice chat**, beyond the server's relay and the Unity client's choice of server address. The
  rest needs a microphone; the client's socket and its shutdown were reviewed and compiled, not
  exercised.
- **Android and Meta Quest.** No suite builds for Android or runs on a headset. The code that only
  runs there — the IL2CPP `[Sync]` accessors — and the Android settings check are tested in the
  Editor.
- **Two Unity clients following each other.** The PlayMode tests talk to a scripted peer, not to a
  second Unity client; an object following its copy between two Unity players is a manual check.
- **The samples** are not compiled or run by any suite.

Batched `model::request` replies were deliberately left for later; see the server changelog. And
Colibri has no access control, by design: anyone who can reach the server's ports can join any app
and read or change its store. Run it on a network you trust.
