# Upgrading to Colibri 2.0

Upgrade steps for a Colibri 1.x project, per component, and behaviour that differs afterwards. Full
details are in the changelogs:
[`colibri-server/docs/v2-changelog.md`](colibri-server/docs/v2-changelog.md),
[`colibri-web/CHANGELOG.md`](colibri-web/CHANGELOG.md),
[`colibri-unity/CHANGELOG.md`](colibri-unity/CHANGELOG.md).

## Checklist

**Upgrade the server first, then Unity, then the web clients.** No 1.x client, Unity or web, works
with a 2.0 server. A 2.0 server logs every client still on 1.x ([upgrade order](#upgrade-order)).

**Server**

- [ ] [Node 24, native ESM](#breaking)
- [ ] [Port your own TCP clients to the new protocol](#breaking)
- [ ] [Port your own voice code to the new packet format](#breaking)
- [ ] [Docker: pin the image version](#other-changes)
- [ ] [Docker: remove `tty: true` from a compose file based on the 1.x README](#other-changes)
- [ ] [Docker with `--user` (or `user:` in compose): give the data directory to that
      user](#other-changes)

**Web**

- [ ] [`npm install @hcikn/colibri@^2`. The server refuses 1.x web clients without a client-side
      error.](#upgrade-order)
- [ ] [TypeScript 5.0 or newer](#breaking-typescript-and-rxjs). Plain JavaScript:
      [`colibri-web/docs/js-workaround`](colibri-web/docs/js-workaround)
- [ ] [Add `rxjs` to your dependencies](#breaking-typescript-and-rxjs)
- [ ] [`@Synced() private x = 0` becomes `@Synced() accessor x = 0`, without
      `experimentalDecorators`](#breaking-synced-needs-standard-decorators)
- [ ] [Colour callbacks get a `ColorValue`, not a
      `string`](#breaking-colour-callbacks-get-a-colorvalue)
- [ ] [Pass `name` to `RegisterModelSync` in bundled code](#fixed)

**Unity**

- [ ] [Unity 2022.3 LTS or newer](#breaking-unity-20223-lts)
- [ ] [Delete your vendored `Newtonsoft.Json.dll`](#breaking-newtonsoftjson-is-a-package-dependency)
- [ ] [Replace `IObservable` subscriptions with `+=` and `-=`, and unsubscribe
      yourself](#breaking-unirx-removed)
- [ ] [Replace `Connected.Subscribe(...)` with `OnConnected` and
      `OnDisconnected`](#breaking-webserverconnectionconnected-is-a-task)
- [ ] [Port `ObservableModel<T>` and `ObservableManager<T>` to `SyncBehaviour<T>` and
      `SyncBehaviourManager<T>`](#breaking-observablemodelt-and-observablemanagert-removed)
- [ ] [Import the samples your code uses](#breaking-samples-are-not-compiled-into-your-project)
- [ ] [Replace `LockFreeQueue<T>` with `ConcurrentQueue<T>`](#breaking-lockfreequeue-removed)
- [ ] [With *Server supports SSL/TLS?* ticked, enable TLS on the server's TCP port too](#tls)

**All components**

- [ ] Read [Behaviour changes that will not fail to compile](#behaviour-changes-that-will-not-fail-to-compile)
- [ ] Go through [After upgrading, check these](#after-upgrading-check-these)

---

## Upgrade order

colibri-unity 2.0.0 uses a [new binary TCP protocol](colibri-server/docs/protocol.md) and **requires
colibri-server 2.0.0 or newer**. There is no version negotiation, so upgrade both together.

The server log names clients on the wrong version. It is on the admin UI's log page and, since 2.0,
in the console output (`docker logs` for a container).

| Client | Server | Client side |
| --- | --- | --- |
| Unity 1.x | Cannot read the handshake, so it cannot check the version or reply. Recognizes the 1.x wire format and logs a warning with the client's address and the fix, upgrading the Colibri Unity package (`de.uni.kn.colibri`) to 2.x. At most once a minute per address. | No reason given. A 1.3.1 client typically shows no error. |
| Readable handshake, other protocol version | Refuses the client, logs it with both versions, and sends the reason on the `colibri` channel. | A 2.0.0 Unity client logs the reason, shows it in `Window → Colibri Status` and stops reconnecting. |
| colibri-web 1.x | Refuses it, since it announces `version: '1'` in the handshake query. Logs the client, its address and both versions. | No 1.x release (the last is 1.3.2) handles `protocol::rejected`. The rejection arrives as an ordinary message on `Colibri.messages`, which nothing listens to. Socket.IO does not reconnect after a server-side disconnect. **The client connects once and stops, with no error.** |

For web clients, this refusal is the only break, since Socket.IO did not change. colibri-web 2.0.0
logs a refusal and reports it on `Colibri.protocolMismatch`. See
[Version checking](colibri-server/docs/protocol.md#version-checking).

**Clients upgraded first** can only suspect an old server, since a 1.x server has no version check.
A 2.0.0 or newer server announces itself to web clients on connect.

- A current web client warns if that announcement is missing after 5 seconds, and **stays
  connected**. The connection works, since the Socket.IO envelope did not change (verified against
  real 1.1.1 and 1.3.1 servers, with traffic in both directions).
- A current Unity client cannot connect to a 1.x server. After three connections in a row that were
  accepted and ended before a frame could be read, it reports a likely protocol mismatch, and keeps
  retrying.

Details:
[Detecting an out-of-date server](colibri-server/docs/protocol.md#detecting-an-out-of-date-server).

---

## colibri-server

### Breaking

**Node 24.** The runtime moved from `node:20-alpine` (end of life) to `node:24-alpine`. `src/server`
is native ESM: `"type": "module"`, explicit `.js` import extensions, no `__filename`. In a fork or
patched server, this touches every file.

**v3 TCP protocol.** A fixed binary format replaces the FlatBuffers framing with its ASCII length
header:

```
[u32 LE totalLength][u8 type][body]        totalLength = 1 (type) + body.length
  0x00 heartbeat   [u64 LE pingTimestamp]
  0x01 handshake   utf8 "version::app::name"
  0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
```

Port your own TCP clients using [`docs/protocol.md`](colibri-server/docs/protocol.md). Socket.IO
clients are not affected. For TCP clients:

- The server sends nothing, not even a heartbeat, before it accepts the handshake. Send the
  handshake first. A refused client receives only the refusal.
- The server disconnects a TCP client that sends nothing for 10 seconds
  (`TCP_IDLE_TIMEOUT_SECONDS`), including one that never sends a handshake. Echoing every heartbeat,
  as colibri-unity does, stays well within this.

**Voice packet format.** The header grew to 11 bytes: the 7 bytes of 1.x, with a header version in
the high 4 bits of the codec byte, then an app id, the 32-bit FNV-1a hash of the app name. The
server forwards a packet only to voice clients with the same app id. It drops 1.x voice packets,
which have no app id, and logs a warning with the client's address. Colibri 1.x voice clients
therefore work neither with a 2.0 server nor with 2.0 clients. Port your own voice code to
[Voice packets](colibri-server/docs/protocol.md#voice-packets-udp).

**Removed dependencies:** `flatbuffers`, `body-parser`, `uuid` and `source-map-support`.

### Other changes

**Pin the image version.** Untagged, `hcikn/colibri` means `latest`, and the next pull can move a
1.x server to 2.x and cut off every 1.x client. Pin the version you run, and change it when you
upgrade the clients.

**Multi-stage image.** The image ships only `dist/` and production dependencies, sets
`NODE_ENV=production` and has a `HEALTHCHECK` on the web port. It starts `node` directly instead of
`npm start`, so the server is PID 1 and shuts down cleanly on `docker stop`.

**Non-root server.** The container starts as root only to hand `/srv/colibri/data` to the image's
`node` user (uid 1000), then runs the server as `node`. A `./data` created by Docker, or the
root-owned one from 1.x, works without manual steps, but on the host it now belongs to uid 1000.
Only this directory is handed over, so mount your data there rather than pointing `DATA_ROOT`
elsewhere.

- With `docker run --user …` (or `user:` in compose), the container cannot change ownership. Give
  the data directory to that user first, for example `sudo chown -R 1001:1001 ./data` for
  `--user 1001:1001`. A new named volume belongs to uid 1000, so it works unchanged only with
  `--user 1000:1000`.
- If the server cannot write its data directory, it prints the problem and the fix on stderr at
  startup, and runs on without saving anything.

**Console log.** The server log, in 1.x only on the admin UI's log page, now also goes to stdout,
errors and warnings to stderr, and so to `docker logs`. This includes the refusals, the 1.x client
warning, and the lines clients send through Unity's `[RemoteLogger]` prefab or colibri-web's
`RemoteLogger`.

- The bundled `docker-compose.yml` caps the container log at five files of 10 MB.
- Remove `tty: true` from a compose file based on the 1.x README. With a TTY, `docker logs` has no
  stderr, and warnings and errors are mixed into stdout with CRLF line endings.

**New settings**, described in [`.env.example`](colibri-server/.env.example):

| Variable | Default | Description |
| --- | --- | --- |
| `CONSOLE_LOG_LEVEL` | `info` | Least severe level printed: `error`, `warn`, `info` or `debug`. |
| `CONSOLE_LOG_BROADCAST_TRAFFIC` | `false` | Print broadcast traffic. |
| `CLIENT_MESSAGE_RATE_LIMIT` | `1000` | Broadcasts and model updates a second per client, Unity or web. Above it, broadcasts are dropped, and model updates are held back and merged per object, so the latest value of every field still arrives. `0`: no limit. |
| `CLIENT_MESSAGE_RATE_BURST` | `2000` | Burst size of the rate limit. |
| `TCP_INBOUND_BACKLOG_LIMIT` | `2000` | Messages from Unity clients that may wait for the server's main thread before their broadcasts and model updates are handled the same way. `0`: no limit. |
| `TCP_IDLE_TIMEOUT_SECONDS` | `10` | Disconnect a Unity client that sends nothing for this long. `0`: never. |
| `APP_CLIENT_WARNING_THRESHOLD` | `8` | Log a warning when an app has more clients than this. `0`: never. |
| `MODEL_TOMBSTONE_SECONDS` | `600` | How long the server remembers a deleted model. `0`: not at all. |

The load limits keep one client, or many clients together, from overloading the server.

- A headset that leaves the Wi-Fi or goes to sleep does not close its connection. Before the idle
  timeout, it counted as connected, and kept its app's synced objects alive, until the operating
  system gave up on it many minutes later.
- The server's work grows with the square of an app's size, since every message goes to each of the
  app's other clients. A large app usually means that several projects on one server use the same
  app name, such as `test` or one from an example.
- Dropping or holding back that lasts a second is logged then as one warning, naming the client for
  the rate limit, and as one summary with the counts when it ends. A shorter stretch is only a debug
  line, unless it lost model updates.
- One client can have updates held back for at most 1000 objects. An update for one more is lost and
  logged as a warning, however short the stretch.
- The default rate limit is far above typical traffic. Ten objects sending in every frame at 72 Hz
  make 720 updates a second.

**Deleted models.** For `MODEL_TOMBSTONE_SECONDS`, the server ignores updates for a deleted id, so
an update another client sent before it received the delete no longer brings the object back for
everyone. A client that asks for the object again after a reconnect is told to delete its copy.
colibri-unity and colibri-web 2.x handle this. Your own client of the protocol must send:

- `model::request { id }` for an object it has in its scene or is creating. This lifts the
  tombstone. Without it, updates for an id deleted a moment ago are ignored.
- `{ id, again: true }` when it asks again after a reconnect for an object it held before.

See [Deleted models](colibri-server/docs/protocol.md#deleted-models).

**Voice recording file name** (`VOICE_RECORDING=true`): `rec_<start time>_app_<app id>_ID_<voice
id>_port_<source port>.wav` instead of `rec_<start time>_ID_<voice id>.wav`. Update anything that
finds recordings by name. See [Voice packets](colibri-server/docs/protocol.md#voice-packets-udp).

---

## colibri-web

### Breaking: `@Synced()` needs standard decorators

`@Synced()` uses TypeScript's standard TC39 `accessor` decorators instead of the legacy
`experimentalDecorators` ones. Remove `experimentalDecorators` from `tsconfig.json`, and make every
synced member an `accessor`:

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

This also fixes field synchronization in frameworks that re-create instances, such as React, which
never worked correctly with the legacy decorator.

### Breaking: TypeScript and `rxjs`

Colibri targets TypeScript 5.0 or newer. The plain JavaScript sample ports were removed. For
projects tied to plain JavaScript, `colibri-web/docs/js-workaround` documents a workaround.

`rxjs` is now a **peer dependency**, because its types are part of the public API (`SyncModel`,
`RegisterModelSync`, `Colibri.messages`):

```sh
npm install rxjs
```

### Breaking: colour callbacks get a `ColorValue`

A colour arrives from Unity as the string `"#RRGGBBAA"` and from another web client as an
`[r, g, b, a]` array. 1.x typed the `receiveColor` callback as `string` in both cases. Callbacks of
`receiveColor` and `receiveColorArray` now get a `ColorValue`, which is either form. The new
`toHexColor()` and `toRgbaColor()` convert it:

```ts
// 1.x
Sync.receiveColor('tint', (hex: string) => setTint(hex));

// 2.0
import { toHexColor } from '@hcikn/colibri';
Sync.receiveColor('tint', colour => setTint(toHexColor(colour)));
```

- With `strict`, a callback typed `string` no longer compiles. Without `strict`, it compiles and
  still receives arrays from web clients.
- For a value that is not a colour, both functions warn and return opaque black instead of throwing.
- `sendColor` accepts either form. The wire format is unchanged.

### Fixed

- `import { ColibriError } from '@hcikn/colibri'` works. As a default export, which `export *` does
  not re-export, it used to import as `undefined`.
- `require()` consumers get their own `.d.cts` declarations.
- The `console.log` on every model registration is gone. With `RemoteLogger`, it also caused
  needless network traffic.
- The server address can be written as a browser shows it, such as `'http://192.168.0.10:9011'`.
  `https://`, `ws://`, `wss://`, a port in the address and a trailing slash work too. The port is
  the one in the address, else the third argument, else 9011, also for `https://`.
- An address that 1.x turned into a URL that could never connect now throws a `ColibriError`: a path
  after the host (such as the admin UI's `…/log`), an unknown scheme, a port that is not a whole
  number, or a port in the address that differs from the port argument.
- `Sync.receive*`, `RegisterChannel`, `RegisterModelSync` and `new RemoteLogger()` may come before
  `new Colibri()`. They take effect once it exists.
- Without `name`, `RegisterModelSync` names its channel after the class. A minifier renames classes,
  so a minified build could end up on a different channel than Unity and other builds, without an
  error. Colibri now warns when the class name looks minified. Pass `name` in bundled code:
  `RegisterModelSync({ name: 'player', type: Player })`.

---

## colibri-unity

### Breaking: Unity 2022.3 LTS

The manifest declared 2019.4 but used APIs that were never available there. It now declares 2022.3
LTS.

### Breaking: UniRx removed

UniRx was removed without a replacement. `SyncBehaviour<T>.ModelCreated()` and `ModelDestroyed()`
returned `IObservable<>`. They are now static events:

```csharp
// 1.x
SyncBehaviour<Player>.ModelCreated()
    .Subscribe(model => Register(model))
    .AddTo(this);

// 2.0
private void OnEnable() => SyncBehaviour<Player>.ModelCreated += Register;
private void OnDisable() => SyncBehaviour<Player>.ModelCreated -= Register;
```

**Unsubscribe yourself.** A UniRx subscription with `AddTo(this)` ended with the component. A static
event subscription does not. A missing `-=` leaks the handler and the destroyed object behind it.
With *Enter Play Mode Options → Disable Domain Reload* on, the leak survives into the next Play
session and everything fires twice.

`this.ObserveEveryValueChanged(...)` has no replacement either. Colibri's own change detection runs
in one `Update` for the whole application. For your own polling with UniRx, add UniRx as your own
dependency.

### Breaking: `WebServerConnection.Connected` is a `Task`

```csharp
// unchanged
await WebServerConnection.Instance.Connected;

// 1.x only
WebServerConnection.Instance.Connected.Subscribe(isConnected => ...);
```

Replace the subscription with the `OnConnected` and `OnDisconnected` events. `OnDisconnected` is
raised exactly once for every `OnConnected`, and never for an attempt that did not connect.

The task completes, and `OnConnected` fires, when the first frame from the server arrives, not when
the TCP connection is accepted. While disconnected, `Connected` is a new task that waits for the
next connection. It is cancelled when the component is disabled and when the server refuses this
client's protocol version, so an `await` on it can throw `TaskCanceledException`.

### Breaking: `ObservableModel<T>` and `ObservableManager<T>` removed

They used commands a 2.0 server does not register: `channel::register`, `channel::deregister` and
the bare `add`, `update`, `request` and `remove`. Port to `SyncBehaviour<T>` and
`SyncBehaviourManager<T>`, which cover the same ground:

```csharp
public class Player : SyncBehaviour<Player>
{
    [Sync] public string Name = "";
    [Sync] public int Score;
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Put `PlayerManager` in the scene with a prefab in its `Template` field. A `Player` created by any
client then appears on all clients.

### Breaking: Newtonsoft.Json is a package dependency

The `com.unity.nuget.newtonsoft-json` package, declared as a dependency, replaces
`Assets/Colibri/Plugins/Newtonsoft.Json.dll`. **Delete your own copy if you have one.** Two
Newtonsoft assemblies in one project are a compile error, not a warning.

Installing Colibri now takes one git URL, without UniRx, UniTask or NuGetForUnity.

### Breaking: samples are not compiled into your project

In 1.x, every project compiled `Samples/` (`HCIKonstanz.Colibri.Samples.*`) into the Colibri
assembly, and *Package Manager → Import Sample* added a second copy of the same types. Samples now
live in `Samples~`, which Unity does not compile. Their types exist only after you import the
sample, and then belong to your project, in `Assets/Samples/` and `Assembly-CSharp`.

**Code that uses a sample type without importing the sample no longer compiles.** Import the sample,
or copy the files you need. Prefabs are unaffected. `[RemoteLogger]` and `[SyncTransformManager]`
can still be dragged from `Packages/Colibri/Prefabs`.

### Breaking: `LockFreeQueue` removed

The public types `LockFreeQueue<T>`, `LockFreeLinkPool<T>`, `SingleLinkNode<T>` and `SyncMethods` in
`HCIKonstanz.Colibri.Networking` were removed. Colibri no longer used them, and they were safe only
with a single producer. Use `System.Collections.Concurrent.ConcurrentQueue<T>`, which is safe with
any number of producers and consumers.

---

## TLS

TLS is optional in 2.0. To turn it on, set `TLS_CERT` and `TLS_KEY` on the server, and tick
*Server supports SSL/TLS?* in each Unity app (see TLS in the
[server](colibri-server/docs/guide.md#tls) and [Unity](colibri-unity/docs/guide.md#tls) guides).

- The setting (`ColibriConfig.IsSSL`) now covers the TCP connection too, not only the Store.
- With the setting ticked, a deployment with only the web port behind a TLS proxy, such as nginx on
  443, and a plain TCP port 9012 needs TLS on 9012 as well. Set `TLS_CERT` and `TLS_KEY`, or
  terminate TLS for 9012 in the proxy. Otherwise the client reports that the server
  `did not answer the TLS handshake`.
- Existing `ColibriConfig` assets load unchanged, with both new certificate settings off or empty.
- 1.x clients cannot use TLS. The protocol version does not change.

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
  so after asking for every model, after asking for one of its models once more, and after the first
  update for a model it registers when it does neither.
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

**Voice stays within the app.** In 1.x every voice packet went to every client on the server that
was sending voice, and a `VoiceReceiver` played the voice id it was given, from whichever app it
came. Now only clients with the same *App Name* hear each other, so two apps on one server can use
the same voice ids, and a project without an App Name sends no voice. This keeps apps apart but is
not access control: anyone who knows the App Name can listen, and voice is not encrypted.

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

- **Voice chat**, beyond the server's relay, the packet format on both sides, the Unity client's
  choice of server address, and the queue that hands received packets to the main thread. The
  rest needs a microphone; the client's socket and its shutdown were reviewed and compiled, not
  exercised.
- **Android and Meta Quest.** No suite builds for Android or runs on a headset. The code that only
  runs there (the IL2CPP `[Sync]` accessors) and the Android settings check are tested in the
  Editor.
- **Two Unity clients following each other.** The PlayMode tests talk to a scripted peer, not to a
  second Unity client; an object following its copy between two Unity players is a manual check.
- **The samples** are not compiled or run by any suite.

Batched `model::request` replies were deliberately left for later; see the server changelog. And
Colibri has no access control, by design: anyone who can reach the server's ports can join any app
and read or change its store. Run it on a network you trust.
