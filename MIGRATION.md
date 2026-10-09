# Upgrading to Colibri 2.0

For projects built on Colibri 1.x: what you have to change in the server, the web client and the
Unity client, and what changes underneath you. Each checklist item links to its detail below; each
component's changelog has the full detail:
[`colibri-server/docs/v2-changelog.md`](colibri-server/docs/v2-changelog.md),
[`colibri-web/CHANGELOG.md`](colibri-web/CHANGELOG.md),
[`colibri-unity/CHANGELOG.md`](colibri-unity/CHANGELOG.md).

## The short version

**Upgrade the server first, then Unity, then the web clients.** No 1.x client, Unity or web, works
with a 2.0 server, and from the moment it runs, the server's log names every client still on 1.x
([why, and what each side shows](#why-the-server-and-unity-move-together)).

**Server**

- [ ] [Node 24; the server is native ESM now](#breaking)
- [ ] [Rewrite anything of your own that speaks TCP to Colibri against the new protocol](#breaking)
- [ ] [Docker: pin the image version you run](#worth-knowing)
- [ ] [Docker: remove `tty: true` if your compose file came from the 1.x README](#worth-knowing)
- [ ] [Docker with `--user` (or `user:` in compose): give the data directory to that user](#worth-knowing)

**Web**

- [ ] [`npm install @hcikn/colibri@^2`: a 1.x web client is refused, with no error on the client](#why-the-server-and-unity-move-together)
- [ ] [TypeScript 5.0 or newer](#breaking-typescript-and-rxjs-is-yours-now); plain JavaScript: [`colibri-web/docs/js-workaround`](colibri-web/docs/js-workaround)
- [ ] [Add `rxjs` to your own dependencies](#breaking-typescript-and-rxjs-is-yours-now)
- [ ] [`@Synced() private x = 0` → `@Synced() accessor x = 0`; drop `experimentalDecorators`](#breaking-synced-needs-standard-decorators)
- [ ] [`receiveColor` / `receiveColorArray` callbacks get a `ColorValue`, not a `string`](#breaking-colour-callbacks-get-a-colorvalue)
- [ ] [Pass `name` to `RegisterModelSync` for anything you bundle](#fixed)

**Unity**

- [ ] [Unity 2022.3 LTS or newer](#breaking-unity-20223-lts)
- [ ] [Delete your vendored `Newtonsoft.Json.dll`](#breaking-no-more-vendored-newtonsoft)
- [ ] [Replace every `IObservable` subscription with `+=` / `-=`, and unsubscribe yourself](#breaking-unirx-is-gone-and-was-not-replaced)
- [ ] [Replace `Connected.Subscribe(...)` with the `OnConnected` / `OnDisconnected` events](#breaking-webserverconnectionconnected-is-a-task)
- [ ] [Port `ObservableModel<T>` / `ObservableManager<T>` to `SyncBehaviour<T>` / `SyncBehaviourManager<T>`](#breaking-observablemodelt-and-observablemanagert-are-deleted)
- [ ] [Import any sample your code uses; samples are no longer compiled into your project](#breaking-the-samples-are-no-longer-compiled-into-your-project)
- [ ] [Replace `LockFreeQueue<T>` with `ConcurrentQueue<T>`](#breaking-lockfreequeue-is-gone)
- [ ] [*Server supports SSL/TLS?* ticked: the server's TCP port needs TLS now too](#optional-tls)

**Everywhere**

- [ ] Read [Behaviour changes that will not fail to compile](#behaviour-changes-that-will-not-fail-to-compile): that is where the surprises are
- [ ] Go through [After upgrading, check these](#after-upgrading-check-these)

---

## Why the server and Unity move together

colibri-unity 2.0.0 speaks a [new binary TCP protocol](colibri-server/docs/protocol.md) and
**requires colibri-server ≥ 2.0.0**. There is no version negotiation: a 1.x Unity client cannot
talk to a 2.0.0 server, nor a 2.0.0 Unity client to a 1.x server, so both sides have to be upgraded
together.

The failure is at least diagnosable now. The server's log (the admin UI's log page, and since 2.0
also the server's console output, so `docker logs` for a container) says what is wrong:

- **A 1.x Unity client** cannot even send a handshake the server can read, so the server can
  neither check its version nor tell it anything. It recognizes the 1.x wire format instead and
  logs a warning, at most once a minute per address, that names the client's address and says to
  upgrade the Colibri Unity package (`de.uni.kn.colibri`) to 2.x. The client is never told why: a
  1.3.1 client typically shows no error at all, so the server's log is where to look.
- **A client whose handshake the server can read, but whose protocol version it does not speak**,
  is refused: the server logs the client and both versions, and tells the client why on the
  `colibri` channel. A 2.0.0 Unity client logs that, shows it in `Window → Colibri Status`, and
  stops reconnecting.

See [Version checking](colibri-server/docs/protocol.md#version-checking).

**Web clients are covered by the same check**, even though Socket.IO itself did not change.
`colibri-web` 1.x announces `version: '1'` in its handshake query, so a 2.0.0 server refuses it.
This is the one place the version check is a breaking change for web, and the symptom is quiet:

- No 1.x release of `colibri-web` (the last is 1.3.2) knows `protocol::rejected`. The client
  receives the rejection as an ordinary message on `Colibri.messages`, which nothing is listening
  for, and is then disconnected.
- Socket.IO does not reconnect after a server-side disconnect, so **it connects once and then
  stops, with no error on the client at all**.
- The server's log line, which names the client, its address and both versions, is the diagnostic.
- `colibri-web` 2.0.0 logs a refusal itself and exposes it on `Colibri.protocolMismatch`.

**Upgrading in the other order (clients first) is noticed too, though only as a suspicion.** The
version check lives on the server, and a 1.x server has none, so neither client can be *told* it is
talking to one. A 2.0.0+ server therefore announces itself to web clients on connect, and its
silence is the signal:

- A current web client warns after five seconds and **stays connected**. It works: the Socket.IO
  envelope did not change, verified against real 1.1.1 and 1.3.1 servers with traffic flowing both
  ways.
- A current Unity client cannot connect to a 1.x server at all. It reports a likely protocol
  mismatch after three connections that were accepted and then ended before a frame could be read,
  and keeps retrying.

Details: [Detecting an out-of-date server](colibri-server/docs/protocol.md#detecting-an-out-of-date-server).

So the safe order is: **upgrade the server first** (from then on its log names every client that is
still on 1.x), then Unity, then the web clients, which cannot be left on 1.x either.

---

## colibri-server

### Breaking

**Node 24.** The runtime moved from `node:20-alpine` (end of life) to `node:24-alpine`, and
`src/server` is native ESM: `"type": "module"`, explicit `.js` import extensions, no `__filename`.
If you have forked or patched the server, that is the change that touches every file.

**The v3 TCP protocol.** The old FlatBuffers framing with its ASCII length header is gone,
replaced by a fixed binary format:

```
[u32 LE totalLength][u8 type][body]        totalLength = 1 (type) + body.length
  0x00 heartbeat   [u64 LE pingTimestamp]
  0x01 handshake   utf8 "version::app::name"
  0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
```

Anything you wrote that speaks TCP to Colibri has to be rewritten against
[`docs/protocol.md`](colibri-server/docs/protocol.md). Socket.IO clients are unaffected. Two of
the server's rules matter to such a client:

- It sends nothing, not even a heartbeat, until it has accepted the handshake, so the client has to
  send its handshake first. A refused client gets the refusal and nothing else.
- It disconnects a TCP client that has sent nothing for 10 seconds (`TCP_IDLE_TIMEOUT_SECONDS`),
  one that never handshakes included. Echoing every heartbeat, as colibri-unity does, keeps a
  client well inside that.

**The `flatbuffers` dependency is gone**, along with `body-parser`, `uuid` and
`source-map-support`.

### Worth knowing

**If you run the published image without a version tag** (`hcikn/colibri`, which means `latest`),
the next pull can take a 1.x server to 2.x, and that cuts off every 1.x client. Pin the version
you run, and change it when you upgrade the clients.

**The Docker image is multi-stage now.** It ships only `dist/` and production dependencies, sets
`NODE_ENV=production`, starts `node` directly instead of `npm start` (so the server is PID 1 and
shuts down cleanly on `docker stop`), and has a `HEALTHCHECK` on the web port.

**The server no longer runs as root.** The container starts as root only long enough to hand
`/srv/colibri/data` to the image's `node` user (uid 1000), then runs the server as `node`. A
`./data` that Docker creates, or the root-owned one 1.x left behind, therefore works without any
manual step, but on the host it now belongs to uid 1000. That is the only directory it hands over,
so keep mounting your data there rather than pointing `DATA_ROOT` somewhere else.

- Started with `docker run --user …` (or `user:` in compose), the container cannot change
  ownership, so the data directory has to belong to that user already: give a host directory to
  it yourself, e.g. `sudo chown -R 1001:1001 ./data` for `--user 1001:1001`. A new named volume
  belongs to uid 1000, so it only works as it is with `--user 1000:1000`.
- If the server cannot write its data directory, it says so on stderr at startup, with the fix,
  and keeps running without saving anything.

**The server's log reaches `docker logs`.** In 1.x its log messages only appeared on the admin
UI's log page. They are now also printed to stdout, errors and warnings to stderr, including the
refusals and the 1.x-client warning above and the log lines clients send through Unity's
`[RemoteLogger]` prefab or colibri-web's `RemoteLogger`.

- `CONSOLE_LOG_LEVEL` (`error`, `warn`, `info` or `debug`; default `info`) sets how much is
  printed, and broadcast traffic is only printed with `CONSOLE_LOG_BROADCAST_TRAFFIC=true`.
- The bundled `docker-compose.yml` caps the container log at five files of 10 MB.
- If your compose file came from the 1.x README, remove its `tty: true`: with a TTY, `docker logs`
  has no stderr, and the warnings and errors are mixed into stdout with CRLF line endings.

**New limits keep one client, or many clients together, from overloading the server.** Each is an
environment variable, described in [`.env.example`](colibri-server/.env.example):

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
  grows with the square of an app's size; this usually happens when several projects on one server
  use the same app name, such as `test` or the one from an example.

A stretch of dropping or holding back that goes on for a second is logged as one warning then,
naming the client for the rate limit, and one summary with the counts once it is over. A shorter
one is only a debug line, unless it lost model updates: one client can have updates held back for
at most 1000 objects, and an update for one more is lost, which is a warning however short the
stretch. The rate limit's default is far above what one client of a typical prototype sends: even
ten objects each sending in every frame at 72 Hz make 720 updates a second.

**The server remembers deleted models for ten minutes** (`MODEL_TOMBSTONE_SECONDS`, default 600,
`0` for not at all). Meanwhile it ignores updates for a deleted id, so an update another client
sent before the delete reached it no longer brings the object back for everyone, and it tells a
client asking for the object again after a reconnect to delete its copy. colibri-unity and
colibri-web 2.x do their part by themselves.

A client of your own that speaks the protocol directly has to tell the server which kind of
request it sends: `model::request { id }` for an object it has in its scene now or is creating,
which lifts such a tombstone (without it, the updates for an id deleted a moment ago are ignored),
and `{ id, again: true }` when it asks again after a reconnect for an object it held before. See
[Deleted models](colibri-server/docs/protocol.md#deleted-models).

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

- `import { ColibriError } from '@hcikn/colibri'` works. It was a default export, which `export *`
  does not re-export, so it silently imported `undefined`.
- `require()` consumers now get their own `.d.cts` declarations.
- A stray `console.log` on every model registration is gone, which for anyone using
  `RemoteLogger` was also a stream of pointless network traffic.
- The server address can be written the way a browser shows it:
  `new Colibri('my-app', 'http://192.168.0.10:9011')` works, as do `https://`, `ws://` and
  `wss://`, a port in the address and a trailing slash. The port is the one in the address, else
  the third argument, else 9011, for `https://` too. An address that 1.x turned into a URL that
  could never connect now throws a `ColibriError` instead: a path after the host (the admin UI's
  own `…/log`, say), an unknown scheme, a port that is not a whole number, or a port in the address
  that disagrees with the port argument.
- `Sync.receive*`, `RegisterChannel`, `RegisterModelSync` and `new RemoteLogger()` may come before
  `new Colibri()`; they take effect once it is constructed.
- `RegisterModelSync` names its channel after the class unless you pass `name`, and a minifier
  renames classes, so a minified build can end up on a different channel from Unity and from other
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
and the destroyed object behind it, and with *Enter Play Mode Options → Disable Domain Reload* on,
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
you have one**: two Newtonsoft assemblies in one project is a compile error, not a warning.

Installing Colibri is now one git URL and nothing else: no UniRx, no UniTask, no NuGetForUnity.

### Breaking: the samples are no longer compiled into your project

`Samples/` was a live package folder, so every consumer compiled `HCIKonstanz.Colibri.Samples.*`
into the Colibri assembly whether they wanted it or not, and *Package Manager → Import Sample*
then made a second copy of the same types.

Samples now live in `Samples~`, which Unity does not compile. Those types exist only after you
import the sample, and then they are yours, in `Assets/Samples/`, in `Assembly-CSharp`. **Code that
referenced a sample type without importing the sample no longer compiles**; import the sample, or
copy the two files you actually wanted.

Prefabs are unaffected. `[RemoteLogger]` and `[SyncTransformManager]` are still draggable straight
out of `Packages/Colibri/Prefabs`.

### Breaking: `LockFreeQueue` is gone

`LockFreeQueue<T>`, `LockFreeLinkPool<T>`, `SingleLinkNode<T>` and `SyncMethods` were public in
`HCIKonstanz.Colibri.Networking`. Colibri no longer uses them, and they were only safe with a single
producer, so they were deleted. If your code used them, use
`System.Collections.Concurrent.ConcurrentQueue<T>`, which is safe with any number of producers and
consumers.

---

## Optional TLS

TLS is optional in 2.0. To turn it on, set `TLS_CERT` and `TLS_KEY` on the server and tick *Server
supports SSL/TLS?* in each Unity app (see TLS in the [server](colibri-server/docs/guide.md#tls) and
[Unity](colibri-unity/docs/guide.md#tls) guides). That setting (`ColibriConfig.IsSSL`) now covers
the TCP connection too, not only the Store. A deployment with only the web port behind a TLS proxy,
such as nginx on 443, and a plain TCP port 9012 therefore needs TLS for 9012 as well once the
setting is ticked: `TLS_CERT` and `TLS_KEY`, or TLS termination for 9012 in the proxy. Otherwise
the client reports that the server did not answer the TLS handshake. Existing `ColibriConfig`
assets load unchanged, with both new certificate settings off or empty. 1.x clients cannot use
TLS. The protocol version does not change.

---

## Behaviour changes that will not fail to compile

These are the ones to watch: your project builds, and then behaves differently.

**Synced objects send at most 30 updates a second.** In 1.x a `SyncTransform`, like any other
`SyncBehaviour<T>`, sent an update in every frame in which one of its values changed: 72 to 120 a
second for each moving object on a headset, a rate that one server and one Wi-Fi network cannot
sustain for dozens of headsets. Each synced object now sends at most *Max Send Rate* updates a
second, 30 by default, projects configured with 1.x included.

- The first change after a quiet spell goes out at once. Later changes within the interval are
  merged, and their latest values go out when it is up, so only the values in between are skipped.
- Switching an object off or on, and destroying it, go out at once.
- Other clients therefore see a moving object take 30 steps a second rather than one per frame.
- *Window → Colibri Configuration → Optional Config → Max Send Rate* sets the limit,
  `SyncSettings.MaxSendRate` changes it from code for the running app, and `0` brings back the 1.x
  behaviour. `Sync.Send` is not limited.

**Strings finally round-trip.** 1.x wrote string payloads *unquoted*, which is not valid JSON, so
the server fell back to a different reader. A Unity `Sync.Send(channel, "hello")` and a web client's
version of the same message did not arrive identically. Both now go out as JSON. If you had a
workaround for that asymmetry, it is now the bug. The `log` channel is the deliberate exception and
still carries raw text, because the admin UI reads it as a string.

**Colours cross between Unity and the web in both directions.** Unity writes `#RRGGBBAA`;
colibri-web's `sendColor` writes `[r, g, b, a]` when given an array. Unity used to throw an
`InvalidCastException` on the array form, out of the frame's single dispatch loop, taking every
message queued behind it that frame with it. It now accepts both, and so does colibri-web (see
[colour callbacks](#breaking-colour-callbacks-get-a-colorvalue)).

**Integers from Unity reach web clients.** Unity distinguishes `int` from `float` and tags the
message accordingly, so `Sync.Send(channel, 5)` arrives as `broadcast::int`. `receiveNumber` only
listened for `broadcast::float` and dropped every one of them in silence. It now listens for both.

**`Store` gives up after 10 seconds.** `UnityWebRequest` defaults to no timeout at all, so a wrong
server address left `Get`/`Put`/`Delete` outstanding forever: no result, no error, nothing in the
console. Calls that used to hang now fail, and say what failed, at which URL, with the HTTP status.

**The store takes any JSON value.** 1.x answered `400` to anything but an object or an array, and
`413` above 100 kB. A plain number, string, boolean or `null` is now stored too (Unity's
`Store.Put("score", 42)`, colibri-web's `setRestObject('note', 'text')`), up to 5 MiB.

**Unity's `Store` converts with Newtonsoft JSON instead of `JsonUtility`.**

- Newtonsoft saves public fields and properties, so a private `[SerializeField]` field of a saved
  class is no longer saved or loaded: make it public, or add `[JsonProperty]`.
- A `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Color` inside the class is saved as an array
  of its components now, and values that 1.x saved as `{"x": …}` still load.
- A value that cannot be converted, or a saved value that does not fit the type asked for, makes
  `Put` return `false` and `Get` return `default`, with the reason in the console.

**Clients catch up after a reconnect.** Both clients used to ask for the synced models' state only
when a listener registered, so whatever other clients changed during an outage was missed until the
next change. Unity and web clients now ask again every time they reconnect, and update the objects
they have rather than creating duplicates.

- The server still forgets an app's models once its last client disconnects, which is what a lone
  client's outage looks like to it, and when it restarts. A client that finds its objects gone sends
  them again in full (colibri-web: the models it registered itself). A Unity object that changed
  during the outage is the exception: its changes reach the server first, and until its other
  members change, the server and every client that joins later have only those (see
  [Known limits](colibri-server/docs/protocol.md#known-limits)).
- An object another client deleted during the outage is deleted on the reconnecting client too, if
  the delete is no more than `MODEL_TOMBSTONE_SECONDS` (ten minutes) old (colibri-web: again only
  for the models it registered; one it got from another client stays).
- A change made as the connection dies without closing (a Wi-Fi drop) goes into the dead link and
  is lost. The answer after the reconnect no longer undoes it: the client keeps its value and sends
  it again (colibri-web: for the models it registered). A value another client set during the
  outage still wins, unless it is one this client had in the 10 s before the outage: set back to
  such a value, the member or field looks like a lost change, and the other client's change is
  undone (see [Known limits](colibri-server/docs/protocol.md#known-limits)). A Unity object
  destroyed at the drop has its delete sent again. After their re-requests, both clients send one
  more `model::request`, on the channel `colibri::reconnect`, to tell when the answers are over. A
  Unity client does so after every reconnect, and also when an object's first answer arrives
  outside that round after the object changed members of its own (see below); colibri-web also does
  so after asking for every model and after asking for one of its models once more.
  See [After a reconnect](colibri-server/docs/protocol.md#after-a-reconnect).
- While a Unity client is disconnected, what it sends waits in one queue and goes out in order when
  the connection is back. Past 256 broadcasts and log lines the oldest are dropped, with one
  warning per outage, while the model updates for one object are merged into one instead. Behind
  that, the whole queue is capped at 10,000 messages, connected or not: past it the oldest
  broadcasts and log lines go first, then the oldest model messages, with a warning.

**A Unity object keeps what changed before the server's state arrived.** A `SyncBehaviour` or
`SyncTransform` asks the server for its state when it wakes up. In 1.x a change made before the
answer arrived, in `Start` say, was dropped, and the answer put the server's values back. Such a
change now replaces the server's value, on every client, as colibri-web's `registerModel` does
(below). A script that sets a `[Sync]` member or moves a `SyncTransform` in `Start` therefore does
so for everyone each time a client starts. Set starting values in the scene or the prefab, or in a
model's `Awake` before `base.Awake()`, to have the object take the server's state instead. Set up
whatever a `[Sync]` getter reads there too, such as a cached component: a getter that reads its
fallback in `base.Awake()` and the real value later counts as changed. A placed `SyncTransform`
whose `PhysicsAuthority` is ticked stays kinematic until the answer.

**colibri-web's `registerModel` takes what the server has.** It used to send the new instance in
full at once. When the server already held that id (a fixed id such as `'session'`, kept while
another client stayed connected and the page was reloaded), that overwrote the copy everyone else
had, while the answer to the request for every model put the old values back on this client only.
`registerModel` now asks the server for the id first: if the server has the model, its values
replace the instance's, and changes made after `registerModel` are sent on top of them; if not,
the instance is sent in full, one round trip later than before. Registering an id that is already
in the list replaces the listed instance instead of listing the id twice.

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
sent to a `string` listener was previously dropped without a word. That mismatch is now reported
once per (channel, type), not once per message, and it names both types and the fix. If new warnings
appear after upgrading, they were always happening; you just could not see them.

**`Sync` listeners now unregister themselves with their component.** `Sync.Receive` records which
Unity object the listener belongs to (the component for a method group, the component the closure
captured for a lambda) and drops the listener once that object is destroyed. A listener with no such
object stays registered until `Sync.Unregister`, as in 1.x: a static method, or a lambda that uses
nothing of its component (only its parameter, `Debug.Log` or a static), because that lambda captures
nothing. Registering the same one again on the same channel adds nothing, so a `Start` that runs
again after a scene reload does not make each message reach it twice.

Your existing `Sync.Unregister` calls in `OnDestroy` are still correct and worth keeping; for
listeners that belong to a component they are just no longer the difference between working and
not. What changes silently is the failure a forgotten one used to cause: the destroyed component
kept being called, `MissingReferenceException` came out of `WebServerConnection.Update`, and every
message queued behind it that frame was lost. If your project had unexplained gaps in delivery,
this is a strong candidate.

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
   stops running the player loop, so the client silently stops sending and receiving, while the
   socket stays up and everything still reports itself connected. This is not new in 2.0, but it is
   the most common source of lost debugging time.
4. **Open *Window → Colibri Status*** while connected. It shows the app name, and a typo there
   produces a perfectly healthy connection on which no other client is ever seen. The opposite
   mistake, a name others use too, puts strangers in your app: *Window → Colibri Configuration*
   now warns about names such as `test` or `myAppName`, and the server logs a warning when one app
   has more than 8 clients.

---

## What is tested, and what is not

The test suites:

- `npm test` in `colibri-server` and in `colibri-web`: unit tests. Both run in CI, together with a
  check that the server's frame encoding matches the vectors the Unity tests use, and that every
  client announces the protocol version the server speaks.
- `npm run test:e2e` in `colibri-web`: against a running server. Not run in CI.
- `node colibri-unity/run-tests.mjs`: the Unity client's EditMode tests, and its PlayMode tests
  against a real server (started with Docker, unless one is already running). It needs a local
  Unity installation and does not run in CI. See
  [Running the tests](colibri-unity/docs/guide.md#running-the-tests).
- `npm run test:docker` in `colibri-server`: runs the image against a fresh, a root-owned and a
  named-volume data directory. Needs Docker; not run in CI.

What none of them covers:

- **Voice chat**, beyond the server's relay, the Unity client's choice of server address, and the
  queue that hands received packets to the main thread. The rest needs a microphone; the client's
  socket and its shutdown were reviewed and compiled, not exercised.
- **Android and Meta Quest.** No suite builds for Android or runs on a headset. The code that only
  runs there (the IL2CPP `[Sync]` accessors) and the Android settings check are tested in the
  Editor.
- **Two Unity clients following each other.** The PlayMode tests talk to a scripted peer, not to a
  second Unity client; an object following its copy between two Unity players is a manual check.
- **The samples** are not compiled or run by any suite.

Batched `model::request` replies were deliberately left for later; see the server changelog. And
Colibri has no access control, by design: anyone who can reach the server's ports can join any app
and read or change its store. Run it on a network you trust.
