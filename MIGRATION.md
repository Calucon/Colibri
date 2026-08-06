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

The failure is at least diagnosable now. The server checks the handshake's version field and
refuses anything it does not speak, naming both versions in its log and telling the client why on
the `colibri` channel; the Unity client logs that, shows it in `Window → Colibri Status`, and stops
reconnecting. Where the framing itself differs the refusal cannot be decoded, so the client falls
back to reporting a likely protocol mismatch after three sessions that fail before a single frame
is read. See [Version checking](colibri-server/docs/protocol.md#version-checking).

**Web clients are covered by the same check**, even though Socket.IO itself did not change.
`colibri-web` 1.x announces `version: '1'` in its handshake query, so a 2.0.0 server refuses it —
this is the one place the version check is a breaking change for web, which was previously told
its version field was only ever displayed.

The symptom on a stale web client is quiet, because `colibri-web` only learned to recognize
`protocol::rejected` after 2.0.0 was published. An older client receives the rejection as an
ordinary message on `Colibri.messages`, which nothing is listening for, and is then disconnected;
Socket.IO does not reconnect after a server-side disconnect, so **it connects once and then stops,
with no error on the client at all**. The server's log line — which names the client, its address
and both versions — is the diagnostic. A client built against a `colibri-web` that has the check
logs the mismatch itself and exposes it on `Colibri.protocolMismatch`.

So the safe order is: **upgrade the server first**, then Unity, then the web clients — but do
upgrade the web clients, rather than leaving 1.x ones running against a 2.0.0 server.

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

The Docker image is multi-stage now: it runs as the non-root `node` user, ships only `dist/` and
production dependencies, and has a `HEALTHCHECK` on the web port. If you mount volumes or run
commands inside the container, check they still work as a non-root user.

---

## colibri-web

### Breaking: `@Synced()` needs standard decorators

`@Synced()` now uses TypeScript's standard TC39 `accessor` decorators instead of the legacy
`experimentalDecorators` ones. Remove `experimentalDecorators` from your `tsconfig.json`, and turn
every synced member into an `accessor`:

```ts
// 1.x
class Player extends SyncModel {
    @Synced() private age = 0;
}

// 2.0
class Player extends SyncModel {
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

### Fixed

`import { ColibriError } from '@hcikn/colibri'` works — it was a default export, which `export *`
does not re-export, so it silently imported `undefined`. `require()` consumers now get their own
`.d.cts` declarations. A stray `console.log` on every model registration is gone, which for anyone
using `RemoteLogger` was also a stream of pointless network traffic.

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
colibri-web's `sendColor` writes `[r, g, b, a]`. Unity used to throw an `InvalidCastException` on
the array form — out of the frame's single dispatch loop, taking every message queued behind it that
frame with it. It now accepts both.

**Integers from Unity reach web clients.** Unity distinguishes `int` from `float` and tags the
message accordingly, so `Sync.Send(channel, 5)` arrives as `broadcast::int`. `receiveNumber` only
listened for `broadcast::float` and dropped every one of them in silence. It now listens for both.

**`Store` gives up after 10 seconds.** `UnityWebRequest` defaults to no timeout at all, so a wrong
server address left `Get`/`Put`/`Delete` outstanding forever: no result, no error, nothing in the
console. Calls that used to hang now fail, and say what failed, at which URL, with the HTTP status.

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

**`Sync` listeners now unregister themselves.** `Sync.Receive` records which Unity object the
listener belongs to — the component for a method group, the component the closure captured for a
lambda — and drops the listener once that object is destroyed. Your existing `Sync.Unregister` calls
in `OnDestroy` are still correct and still worth keeping; they are simply no longer the difference
between working and not. What changes silently is the failure they used to cause: a forgotten
`Unregister` meant the destroyed component kept being called, `MissingReferenceException` came out
of `WebServerConnection.Update`, and every message queued behind it that frame was lost. If your
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
   `SyncBehaviour<T>.ModelCreated` and `ModelDestroyed`; `Sync.Receive` listeners look after
   themselves now.
3. **Turn on *Run In Background*** (Project Settings → Player). With it off, an unfocused Editor
   stops running the player loop, so the client silently stops sending and receiving — while the
   socket stays up and everything still reports itself connected. This is not new in 2.0, but it is
   the single most common way to lose an afternoon.
4. **Open *Window → Colibri Status*** while connected. It shows the app name, and a typo there
   produces a perfectly healthy connection on which no other client is ever seen.

---

## What is still not covered

Honest about the edges:

- **Voice chat has no automated tests.** It needs a microphone. The port-0 bind and the
  cancellation-token shutdown were reviewed and compiled, not exercised.
- **Two Unity clients following each other** was confirmed as far as both connecting concurrently;
  object-follows-object between two *players* is still a manual check.
- Batched `model::request` replies and the server's security hardening phase were deliberately
  deferred — see *Deferred work* in the server changelog.

Everything else is covered by the test suites: `npm test` in `colibri-server` and `colibri-web`, and
`node colibri-unity/run-tests.mjs` for the Unity client, which runs the whole thing against a real
server. See [colibri-unity/README.md](colibri-unity/README.md#for-maintainers).
