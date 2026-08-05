# colibri-unity 2.0.0 — ease of use and the sync loop

Companion to [`CHANGELOG.md`](../CHANGELOG.md), covering the last pass over colibri-unity 2.0.0 in
the depth a change log cannot carry: what changed, why, how the replacements work, and what the
Editor verification showed — including the two numbers that were only ever argued before it.

Two goals, and they turned out not to conflict:

1. **A student with some C# and almost no Unity should get a prototype running in their first
   hour.** Colibri is used in university courses; every silent failure and every manual install
   step is an hour not spent on the prototype.
2. **Synchronization stays real-time.** Under good network conditions the client must not be the
   thing that adds latency or frame-time cost.

The first goal was pursued by deleting both third-party runtime dependencies. That could have cost
the second one. It did the opposite: the libraries were paying for abstractions on the per-frame
path, and removing them made the sync loop allocation-free while idle.

---

## Contents

- [Why](#why)
- [1. Installation: three packages to one URL](#1-installation-three-packages-to-one-url)
- [What a student actually writes](#what-a-student-actually-writes)
- [2. The sync loop](#2-the-sync-loop)
- [3. Removing UniTask](#3-removing-unitask)
- [4. Four silent failures, made loud](#4-four-silent-failures-made-loud)
- [5. `Window → Colibri Status`](#5-window--colibri-status)
- [6. API changes](#6-api-changes)
- [7. Migrating an existing project](#7-migrating-an-existing-project)
- [8. Verification status](#8-verification-status)
- [9. Decisions, and what was deliberately not done](#9-decisions-and-what-was-deliberately-not-done)
- [Appendix: file map and commits](#appendix-file-map-and-commits)

---

## Why

The 2.0.0 protocol work fixed the wire format but made onboarding *worse*. Installing Colibri had
grown to three packages, one of which (R3) ships in two halves and additionally needs NuGetForUnity.
Miss half of it and Unity produces a wall of `The type or namespace name 'R3' could not be found`
with nothing pointing at the cause.

On top of that, four things failed in complete silence — and all four are things a beginner hits in
their first hour:

| Situation | What happened before |
|---|---|
| `Send("ch", 5f)` with `Receive("ch", (Action<string>)H)` | No listener list matched. Returned. **No log, ever.** |
| `Sync.Receive("ch", MyHandler)` without a cast | Compile error: 17 overloads make the method group ambiguous |
| No `Resources/ColibriConfig.asset` | The connect loop polled forever without a word, and `ColibriConfig.GetWebUrl` threw a `NullReferenceException` |
| "Am I even connected?" | Only answerable by reading Console logs |

A student cannot debug what does not say anything. The whole point of this pass is that the common
mistakes now name themselves.

---

## 1. Installation: three packages to one URL

**Before** — `com.unity.nuget.newtonsoft-json`, UniTask via git URL, NuGetForUnity via git URL, R3
core via the NuGet window, R3's Unity layer via git URL, then Colibri. Six steps, four of which had
to be done by hand because a UPM `dependencies` entry cannot express a NuGet package.

**After** — one URL:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

`com.unity.nuget.newtonsoft-json` is the only remaining dependency, and it is declared in
`Assets/Colibri/package.json`, so the Package Manager resolves it automatically.

What was removed along the way:

- `com.cysharp.r3` and `com.cysharp.unitask` from `Packages/manifest.json` and `packages-lock.json`
- `"R3.Unity"`, `"UniTask"` from `Colibri.asmdef` `references`, and `"R3.dll"` from
  `precompiledReferences`
- `"Unity.TextMeshPro"` from `references` — nothing in Colibri used it. It resolved only because
  `com.unity.ugui` happens to ship that assembly, so it was a latent failure in any project without
  ugui, in exchange for nothing.
- The R3 and UniTask entries in `THIRD_PARTY_NOTICES.txt`

Total call sites removed: eight. That is what the two dependencies were buying.

---

## What a student actually writes

Everything below this section is internals. This is the surface — and the surface is the point, so
it is worth seeing before the machinery.

### Level 0 — no code at all

Add `SyncTransform` to a GameObject and drop one `SyncTransformManager` in the scene. Position,
rotation, scale and active state now follow every other client. Nothing to write, nothing to
register, nothing to unregister.

### Level 1 — send a value to everyone

```csharp
// Ping.cs
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Ping : MonoBehaviour
{
    void OnEnable()  => Sync.Receive<Vector3>("ping", OnPing);
    void OnDisable() => Sync.Unregister<Vector3>("ping", OnPing);

    // Hook this up to a UI Button.
    public void SendPing() => Sync.Send("ping", transform.position);

    void OnPing(Vector3 where) => Debug.Log($"Someone pinged at {where}");
}
```

That is the whole thing. No connection to open, no server object to find, no coroutine: the first
call to `Sync.Receive` brings the connection up by itself.

The `<Vector3>` is the change. The same script before:

```csharp
//                              vvvvvvvvvvvvvvvvv  and you had to know to write this
Sync.Receive("ping", (Action<Vector3>)OnPing);
Sync.Unregister("ping", (Action<Vector3>)OnPing);
```

Without the cast, `Sync.Receive("ping", OnPing)` failed to compile against 17 overloads with an
error message that pointed at overload resolution rather than at anything the student had done. It
is the single most common wall people hit in the first ten minutes.

### Level 2 — a shared object

```csharp
// Player.cs — every client sees the same Players, with these two values kept in step.
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Player : SyncBehaviour<Player>
{
    [Sync] public int Score;
    [Sync] public Color Colour;
}
```

```csharp
// PlayerManager.cs — one in the scene, so clients can create Players for each other.
using HCIKonstanz.Colibri.Synchronization;

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Assign `Score` from anywhere and every other client's `Player` has the new value on its next frame.
There is no `SendScore()` and nothing to call — §2 is the machinery that makes plain field
assignment enough, and it is why that machinery has to be cheap.

> Two `MonoBehaviour`s cannot share one `.cs` file in Unity — only the class matching the filename
> can be added to a GameObject. Hence two files.

### What it looks like when you get it wrong

This is the part that did not exist before. Send a `float` on a channel whose listener expects an
`int`, and the message used to vanish without a word. Now:

```
Colibri: a float arrived on channel 'score', but the listener registered there expects int.
The message was dropped, because Colibri matches messages on the channel *and* the type.
Either send it as int, or listen for it with Sync.Receive<float>("score", MyHandler).
```

Forget to configure the project, and instead of a `NullReferenceException` from whichever call site
happened to touch the config first:

```
Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name,
and press Save Config. (Every client that should see each other has to use the same App Name.)
```

Get connected but see nobody, and the connect log already names the reason:

```
Colibri: connected to colibri.hci.uni-konstanz.de:9012 as app 'my-seminar-project'.
Only clients using the same App Name can see each other.
```

Put a type Colibri cannot serialize behind `[Sync]`, and it is reported when the scene loads rather
than on the first message that happens to arrive:

```
Colibri: cannot synchronize 'Player.Inventory' - [Sync] does not support Dictionary`2.
Supported types are bool, int, float, string, Vector2, Vector3, Quaternion, Color, JObject
and arrays of those. For your own classes, sync a JObject built with JToken.FromObject(...).
```

---

## 2. The sync loop

### What it looked like

`SyncBehaviour<T>.Awake` subscribed once **per synced attribute**:

```csharp
Observable.EveryValueChanged(this, _ => attribute.Value.Getter(this as T))
    .Where(_ => _hasReceivedFirstUpdate)
    .Subscribe(_ => AddUpdate(attribute.Key, attribute.Value.Getter(this as T)))
    .AddTo(this);
```

with the getter typed as `Func<T, object>`, built from an expression tree that ends in
`Expression.Convert(exBody, typeof(object))`.

`GenericSyncTransform` declares five `[Sync]` members — `Active` (bool), `Position` (Vector3),
`Rotation` (Quaternion), `Scale` (Vector3), `PhysicsId` (string). So every `SyncTransform` in the
scene meant:

- **five** R3 frame-provider work items, each running a `Where` → `Subscribe` chain every frame;
- **four boxes per frame**, every frame, whether or not anything moved (`string` is already a
  reference type, so it does not box);
- one `async void` state machine allocated per change, because `SendUpdate()` coalesced a frame's
  changes with `await UniTask.Yield(PlayerLoopTiming.PostLateUpdate)`;
- one Unity `Update`/`LateUpdate` message dispatch per `WebServerConnection`, plus R3's own player
  loop injection.

The garbage figure, as arithmetic rather than a measurement — 100 synced objects at 60 fps, nothing
moving:

```
  100 objects x 4 boxed attributes x 60 fps  =  24,000 boxes / second

  per object per frame, on 64-bit:
      Vector3   12 B payload + 16 B object header  =  24 B  (x2, Position and Scale)
      Quaternion 16 B payload + 16 B object header =  32 B
      bool       1 B payload + 16 B header, min 24 =  24 B
                                              total  104 B

  104 B x 100 objects x 60 fps  =  ~610 KB / second
```

That is the cost of an *idle* scene, before anything moves. It is not catastrophic — Unity's GC
absorbs it — but it is a recurring collection pressure with nothing to show for it, and it scales
linearly with the number of synced objects, which is precisely the axis a course project grows on.

### What it looks like now

**One ticker for the whole application.** `Synchronization/Code/SyncTicker.cs` is an internal,
auto-created, `DontDestroyOnLoad` MonoBehaviour and the only thing in Colibri with a per-frame Unity
message:

```csharp
private void Update()
{
    for (var i = 0; i < _tickables.Count; i++)
        _tickables[i]?.PollChanges();
}

private void LateUpdate()
{
    for (var i = 0; i < _tickables.Count; i++)
        _tickables[i]?.FlushUpdate();

    if (_hasEmptySlots)
        Compact();
}
```

An index loop over the raw `List<>`, so no enumerator and no defensive copy. Registration is
`Awake`, deregistration `OnDestroy`. Deregistration is **O(1)**: each tickable stores its own slot
index, `Deregister` nulls that slot, and the list is compacted once per frame if anything was
removed — removing entries during iteration would otherwise shift indices under the running loop.
Statics are reset from a `[RuntimeInitializeOnLoadMethod(SubsystemRegistration)]` hook, so entering
Play mode with domain reload disabled does not inherit destroyed components from the last session.

**Typed change detection.** `SyncedAttribute` went from a struct holding `Func<T, object>` to an
abstract class with a generic subclass, so the comparison happens on the concrete type:

```csharp
private sealed class ChangeTracker<TValue> : IChangeTracker
{
    private readonly Func<T, TValue> _getter;
    private TValue _lastValue;

    public bool CaptureChange(T target)
    {
        var current = _getter(target);
        if (EqualityComparer<TValue>.Default.Equals(current, _lastValue))
            return false;

        _lastValue = current;
        return true;
    }
}
```

`EqualityComparer<Vector3>.Default` resolves to `GenericEqualityComparer<Vector3>`, because
`Vector3` implements `IEquatable<Vector3>` — so the comparison calls `Vector3.Equals(Vector3)`
directly, with no boxing on either side. Same for `Quaternion`. A value is boxed only on the frame
it actually changed, in order to hand it to `AddUpdate`.

> **Comparison semantics are unchanged.** Both the old and the new path compare with `Equals`, not
> with `operator ==`. Unity's `Vector3 == Vector3` is an approximate comparison (`sqrMagnitude` of
> the difference below `1e-10`), while `Vector3.Equals` is an exact field-by-field float
> comparison. The old code boxed and called `object.Equals`, which dispatches to
> `Vector3.Equals(object)` — the same exact comparison. So this change does not alter which frames
> count as "changed".

**Poll and flush are separate phases.** `AddUpdate` now only fills `_nextUpdate`, and the ticker's
`LateUpdate` sends it:

```csharp
void SyncTicker.ITickable.FlushUpdate()
{
    if (_nextUpdate == null)
        return;

    Sync.SendModelUpdate(Channel, _nextUpdate);
    _nextUpdate = null;
}
```

This preserves the previous behaviour — all of one frame's attribute changes travel in a single
message — while removing the `async void` state machine that used to implement it. It also makes
the ordering explicit rather than a side effect of a player-loop timing constant: every
`PollChanges` runs, then every `FlushUpdate`.

### Cost, before and after

Per `SyncTransform`, idle:

| | Before | After |
|---|---|---|
| Reactive frame-provider work items | **5** (one per attribute) | 0 |
| Unity per-frame messages | R3's player-loop injection | **1 `Update` + 1 `LateUpdate`, total** — not per object |
| Boxes per frame | **4** | **0** |
| Allocation per change | 1 `async void` state machine | 0 |
| Allocation per message | 1 `JObject` | 1 `JObject` (unchanged) |

**Free of garbage is not free of time.** The profiler run in §8 puts one `SyncTicker.Update()` at
**0.335 ms for 100 idle `SyncTransform`s**, against a `PlayerLoop` total of 0.786 ms in the same
frame — a little under half the player loop, spent establishing that nothing changed. The poll is
O(objects × attributes) whether or not anything moves, because that is what change detection by
polling *is*; what the rewrite removed is the allocation and the per-attribute machinery around it,
not the comparison itself. At 100 objects × 5 attributes that is 500 typed comparisons a frame. It
is a fixed, predictable cost rather than a growing one, but a scene with thousands of synced objects
would want an explicit dirty flag instead of a poll, and that is a different design.

### What did *not* change

**The network path never touched either library.** `WebServerConnection` is raw `Socket`, `Task`,
`SemaphoreSlim`, `LockFreeQueue` and `FrameCodec`: receive → `LockFreeQueue` → drained on the main
thread in `Update`; send → `SemaphoreSlim` → `Socket.SendAsync`. Not one R3 or UniTask call in the
whole file. Latency and throughput are therefore untouched by everything above — this work moved
per-frame CPU and allocation, not wire time.

---

## 3. Removing UniTask

Three call sites, none of them on the sync hot path.

**`SyncBehaviour._isReady`** — `UniTaskCompletionSource<bool>` → `TaskCompletionSource<bool>`.
`UniTaskCompletionSource` is pooled where `TaskCompletionSource` allocates, but this happens once
per synced object for its entire lifetime. In exchange it removes a real hazard:
`UniTaskCompletionSource` throws *"can not await twice"* on a second **pending** awaiter, and
`TriggerSync()` is awaited both from `SyncBehaviourManager.Start()` and from its `ModelCreated`
handler. `TriggerSync` also now catches the cancellation raised when an object is destroyed before
the server ever sent its state, instead of letting it escape an `async void`.

**`Store`** — `await request.SendWebRequest()` is a UniTask extension method. Replaced with:

```csharp
private static Task SendAsync(UnityWebRequest request)
{
    var tcs = new TaskCompletionSource<bool>();
    request.SendWebRequest().completed += _ => tcs.TrySetResult(true);
    return tcs.Task;
}
```

Deliberately **not** `TaskCreationOptions.RunContinuationsAsynchronously`:
`UnityWebRequestAsyncOperation` raises `completed` on the main thread, and completing the task
inline is what keeps the caller's code after `await` on the main thread too. (`AsyncOperation`
invokes a handler immediately if the operation has already finished, so there is no lost-race
window.)

The plain awaiter never throws, so `catch (UnityWebRequestException)` — a UniTask type — is gone,
replaced by an explicit result check. This is strictly better for a beginner: instead of an
exception message, they get the operation, the object name, the URL, the transport error, the HTTP
status, and a pointer at the configuration window.

**`RemoteLogging`** — `Subject<int>` + `.Where(!_isSending)` + `.ThrottleLast(1s)` became a
`volatile bool` set from Unity's threaded log callback (which fires on arbitrary threads) and
drained by a one-second timer in `Update`. The in-flight gate and the retry re-arm behave exactly as
before. A send that throws is now caught and reported **once** — logging from inside the log sender
feeds straight back into this queue, so an unconditional report would spam the console forever.
`UniTask.Yield`'s allocation-free await does not apply anywhere here, because §2 removed the await
rather than swapping it for `Task.Yield`.

---

## 4. Four silent failures, made loud

### Type mismatch

Colibri routes on **(channel, type)**. `Sync.Invoke<T>` used to find no listener list and return.
`Synchronization/Code/ChannelListenerRegistry.cs` now tracks which types each channel has listeners
for, updated from `AddListener`/`RemoveListener`, and the miss branch says:

```
Colibri: a float arrived on channel 'chat', but the listener registered there expects string.
The message was dropped, because Colibri matches messages on the channel *and* the type.
Either send it as string, or listen for it with Sync.Receive<float>("chat", MyHandler).
```

Three deliberate restrictions on when it speaks:

- **Only on a mismatch.** A channel with *no* listeners is normal — every client sees every channel
  its app uses, including ones it does not care about. Warning there would train people to ignore
  the console.
- **Once per `(channel, receivedType)`.** A mismatch on a channel receiving at 60 Hz would otherwise
  produce 60 identical errors a second. The pair is re-armed if a matching listener is later
  registered and removed again.
- **Off the hot path.** The check costs one dictionary lookup, on a message that already missed.

Model channels (`model::update` / `model::delete`) are registered with `track: false`. They are
Colibri's own `SyncBehaviour` plumbing, never go through `Invoke<T>`, and listing them would bury
the channels the student actually wrote.

The registry has **no `UnityEngine` dependency**, which is the reason it is a separate file: `Sync`
itself cannot be unit-tested, because registering a listener reaches
`WebServerConnection.Instance`, which spawns a GameObject. Splitting the registry out made the
interesting part testable — see `Tests/Editor/ChannelListenerRegistryTests.cs`.

### The cast on every `Receive`

17 overloads made `Sync.Receive("ch", MyHandler)` ambiguous. Naming the type is not:

```csharp
Sync.Receive<float>("MyChannel", MyHandler);
Sync.Unregister<float>("MyChannel", MyHandler);
```

Supplying type arguments rules the non-generic overloads out of consideration entirely. Dispatch is
a pattern match on the delegate — no reflection — and forwards to the existing typed overload, which
still wins overload resolution inside the switch because a non-generic method is preferred over a
generic one:

```csharp
public static void Receive<T>(string channel, Action<T> listener)
{
    switch (listener)
    {
        case Action<bool> l: Receive(channel, l); break;
        case Action<int> l: Receive(channel, l); break;
        /* … one line per supported type … */
        case Action<JToken> l: Receive(channel, l); break;
        default: LogUnsupportedType<T>(channel); break;
    }
}
```

Every existing call site keeps compiling. An unsupported `T` names the supported set and shows the
`JToken` route.

### Missing configuration

`ColibriConfig.Load()` returned `null` when `Resources/ColibriConfig.asset` did not exist, so
`GetWebUrl` dereferenced it and threw. It now returns a shared defaults instance, and the connection
loop reports the cause once instead of polling silently twice a second:

```
Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name,
and press Save Config. (Every client that should see each other has to use the same App Name.)
```

The defaults object is created **once** and cached separately from `_instance`. The obvious
implementation — `return CreateInstance<ColibriConfig>()` on every call — leaks, because
`WebServerConnection.Update` calls `Load()` every frame and a `ScriptableObject` created that way is
not garbage collected. `_instance` itself is still left unset, so the real asset is picked up the
moment it appears, which in the editor is as soon as the setup window saves it.

### "Which app am I?"

The connect log used to read `Colibri: connection to web server established`. A typo in the app name
produces a perfectly healthy connection on which no other client is ever seen — indistinguishable
from a working setup. It now reads:

```
Colibri: connected to colibri.hci.uni-konstanz.de:9012 as app 'my-seminar-project'.
Only clients using the same App Name can see each other.
```

### And one more, at startup

`[Sync]` members are validated when the model type is first initialized, rather than failing on the
first message that arrives. An unsupported type, a property missing a getter or setter, and two
members whose lowercased names collide are each reported by name with the fix.

---

## 5. `Window → Colibri Status`

`Setup/ColibriStatusWindow.cs`, next to the existing `SetupWindow` that owns
`Window → Colibri Configuration`. It shows:

- connection state, colour-coded; server `host:port`; the app name actually in use; protocol version
- **time since the last server heartbeat** — deliberately not called latency. The server's heartbeat
  carries the *server's* clock, so the client genuinely cannot derive a round trip from it; real
  latency figures live on the server's admin UI. What it does tell you is whether the server is
  still talking to you.
- every channel with listeners, and the type each one expects, from the registry above
- the last 20 messages in and out
- buttons for the configuration window and the server's web UI

Two constraints shaped the implementation:

- **It never touches `WebServerConnection.Instance`.** `SingletonBehaviour.Instance` *creates* a
  GameObject when none exists, so an editor window reading it would quietly add
  `[WebServerConnection]` to the open scene outside Play mode. The window uses
  `FindFirstObjectByType` and renders a hint when nothing is running.
- **Release builds pay nothing.** The traffic ring buffer and the calls that fill it are behind
  `#if UNITY_EDITOR || DEVELOPMENT_BUILD`, and `RecordTraffic` carries `[Conditional("UNITY_EDITOR")]`
  plus `[Conditional("DEVELOPMENT_BUILD")]`, so the call sites are removed by the compiler rather
  than merely doing nothing.

Repaints are throttled to 10 Hz and only while playing.

---

## 6. API changes

### Added

| API | Notes |
|---|---|
| `Sync.Receive<T>(string, Action<T>)` | No cast needed |
| `Sync.Unregister<T>(string, Action<T>)` | No cast needed |
| `Sync.RecentTraffic` | Editor/development builds only |
| `ChannelListenerRegistry` | Channels, expected types, mismatch messages |
| `ColibriConfig.NOT_CONFIGURED_MESSAGE` | One wording, used everywhere |
| `ColibriConfig.IsConfigured` | True once an app name is set |
| `WebServerConnection.MillisSinceLastHeartbeat()` | Was private |
| `WebServerConnection.ServerAddress` / `.TcpPort` / `.AppName` | Read-only, snapshot of the live config |
| `WebServerConnection.ClientVersion` | Static; the handshake's protocol version |

### Changed

| Before | After |
|---|---|
| `static Observable<SyncBehaviour<T>> ModelCreated()` | `static event Action<SyncBehaviour<T>> ModelCreated` |
| `static Observable<SyncBehaviour<T>> ModelDestroyed()` | `static event Action<SyncBehaviour<T>> ModelDestroyed` |
| `ColibriConfig.Load()` may return `null` | Never returns `null` |
| `Store.*` may throw `UnityWebRequestException` | Never throws; logs and returns `default`/`false` |

### Unchanged

All 17 `Sync.Receive` / `Sync.Unregister` overloads, every `Sync.Send` overload, `SyncBehaviour`'s
`[Sync]` attribute and the set of types it supports, `SyncBehaviourManager`, `SyncTransform`, the v3
wire protocol, and `WebServerConnection.Connected`.

---

## 7. Migrating an existing project

1. **Remove R3 and UniTask** from your own `Packages/manifest.json` if nothing else in your project
   uses them, and delete `Assets/Packages/R3.dll` if NuGetForUnity put it there.

2. **`ModelCreated()` / `ModelDestroyed()` subscribers** become `+=` / `-=`:

   ```csharp
   // before
   SyncBehaviour<MyModel>.ModelCreated().Where(m => …).Subscribe(OnCreated).AddTo(this);

   // after
   private void Start()     => SyncBehaviour<MyModel>.ModelCreated += OnCreated;
   private void OnDestroy() => SyncBehaviour<MyModel>.ModelCreated -= OnCreated;   // required
   ```

   > ⚠ A static event does **not** unsubscribe itself. Forgetting the `-=` leaks the handler — and
   > the destroyed component it belongs to — into the next Play session whenever *Enter Play Mode
   > Options* has domain reload disabled. `Where(…)` predicates become early-return guards.

3. **If you override `Awake` or `OnDestroy` in a `SyncBehaviour` subclass, call `base`.** That was
   already true, but it now also drives ticker registration, so skipping it means the object never
   polls for changes.

4. **`Sync.Receive` casts still compile.** Migrate at your own pace; the generic form is what the
   samples and README now use.

5. **`if (ColibriConfig.Load() == null)` is dead code** — use `.IsConfigured` if you want to know
   whether an app name has been set.

6. **`try { await Store.Get… } catch (UnityWebRequestException)`** can be deleted; check the return
   value instead (`null` / `false`).

---

## 8. Verification status

### Done without the Editor

- **Both assemblies compile clean.** The 43 runtime sources and the 4 EditMode test sources were
  compiled with Roslyn against Unity 6000.2's managed assemblies at `langversion:9.0`
  (C# 9 = the Unity 2022.3 level), with `UNITY_EDITOR` defined so the editor windows are included.
  Zero errors, zero warnings.
- **The registry logic runs green.** `ChannelListenerRegistry` has no Unity dependency, so its
  behaviour was executed standalone: 19 checks covering silence with no listeners, silence on a
  match, the mismatch message content, once-per-pair suppression, re-arming, plural wording,
  listener ref-counting, channel cleanup, and the friendly type names.

### The Editor pass, 2026-08-05

The ten items below were the acceptance criteria for this work, and they have now been run. The
environment was Unity **6000.5.7f1** with a URP-template project (`ColibriTest`) that has Colibri
added as a `file:` UPM package, against `colibri-server` 2.0.0 built and run locally on Node 26.5.1
(ports 9011 web/REST/Socket.IO, 9012 TCP v3). Two of the criteria ask for a *second Unity instance*,
and they were answered in two stages. The message-level checks were run against three non-Unity
endpoints — a non-interactive Socket.IO peer written against colibri-web, a raw v3 TCP client, and a
pass-through proxy in front of the TCP port that decodes every frame in both directions — because
those are what make the wire observable; the proxy is why several claims below can be quoted at the
byte level rather than inferred from behaviour. Separately, a standalone player *was* built and run
alongside the Editor, so the two-Unity-clients configuration itself is covered too. What that does
not cover is the visual half; see the subsection after the ten.

Ten of the problems the run turned up were fixed; they are listed in
[`CHANGELOG.md`](../CHANGELOG.md), and the full record of the pass is in
`colibri-unity-v2-verification-findings.md` at the repository root. Two more were diagnoses rather
than defects, and both are worth knowing before teaching with this:

- Unity 6's *Insecure HTTP Option* defaults to *Not allowed*, and the `Store` round trip over
  `http://localhost:9011` worked anyway, because Unity exempts loopback. It only bites when the
  server is remote and not on HTTPS.
- Unity's `Run In Background` also defaults to off, and with it off the Editor suspends the player
  loop as soon as its window loses focus. The socket stays up and heartbeats keep being echoed,
  because that happens off the main thread, so the client looks perfectly healthy — but `Update`
  never runs, so nothing is sent and nothing the receive thread queued is ever delivered. It lands
  squarely on the two-client recipe: the unfocused instance goes silent while looking connected.

1. **Done, with a narrower claim than the item asks for.** `ColibriTest` resolved
   `de.uni.kn.colibri` 2.0.0 with **zero compile errors** and with no R3 and no UniTask anywhere in
   the manifest, which is the point of §1. `com.unity.nuget.newtonsoft-json` resolved automatically
   from the package's own `dependencies`, and the lock file's 3.2.2 satisfied the requested 3.2.1
   with no conflict. What was *not* tested is the wording of the item: the project is Unity
   6000.5.7f1 rather than 2022.3, and Colibri was added as a local `file:` reference rather than
   through the git URL the README hands out, so the URL itself is still unexercised.
2. **Not covered, and it wants rephrasing rather than running.** The whole pass happened inside
   `ColibriTest`; the `colibri-unity` project was never opened. After the samples moved to `Samples~`
   (see the change log) that project can no longer open the sample scenes in place anyway, which is
   most of what opening it was for — `ColibriTest` is where they are opened now. What the item was
   really asking, namely that the package compiles with R3 and UniTask out of the manifest, is
   covered by item 1.
3. **Done. 52 passed, 0 failed.** `FrameCodecTests`, `FrameReaderTests`, `ProtocolVectorTests` and
   `ChannelListenerRegistryTests`, run through `TestRunnerApi` against the package's
   `HCIKonstanz.Colibri.Tests` assembly. `colibri-server`'s own suite was green at the same time —
   102 passed — which matters for `ProtocolVectorTests`, since those vectors are only meaningful
   against a server encoder that is itself behaving.
4. **Done — the headline claim, measured.** 100 `SyncTransform`s in an otherwise empty scene, all
   idle, Deep Profile off, Editor Play mode, sampled through `ProfilerDriver`. Over a 231-frame
   window the **median frame allocated 0 bytes**:

   ```
   Frame Time Summary for the frame range [21001; 21231]:
     4 frames out of 231 (1.7 %) exceeding target frame GC Allocation of 8192 bytes
     Frame with Median GC Allocation (50th percentile):
       Frame 21138: 0 bytes of GC Allocation
   ```

   The four outliers are not the sync path: breaking the worst one down puts its allocations on
   background threads (`Thread Index: 134` for 2093 bytes, `128` for 537, `4` for 56), not on the
   main thread. And the main thread's individual samples for a median frame show one ticker entry,
   not N:

   ```
   Top 3 Individual Samples in Frame 21139 on Main Thread by Total Time:
     EditorLoop                                                     3.282ms (73.4 %)
     HCIKonstanz.Colibri.dll!...::SyncTicker.Update() [Invoke]      0.335ms  (7.5 %)
        Object Name: [Colibri SyncTicker]
     Profiler.FlushMemoryCounters                                   0.248ms  (5.6 %)
   ```

   Exactly one `SyncTicker.Update()`, attributed to the single `[Colibri SyncTicker]` object rather
   than one frame-provider item per synced attribute. Both halves of the claim hold. Two things to
   keep with the number, though. It only means anything **because item 9's leak was fixed first**:
   before that, the n-th Play session had n ticker objects and this frame would have shown n
   `SyncTicker.Update` entries, which is how the leak and the claim contradicted each other. And
   polling costs time even when it allocates nothing — 0.335 ms for 100 idle objects against a
   `PlayerLoop` total of 0.786 ms in the same frame, a little under half the player loop spent
   discovering that nothing changed. §2 now says so.
5. **Done, against a web peer rather than a second Editor** — deliberately, since a web peer is what
   makes the payload bytes readable. Every supported type crossed Unity → web and web → Unity: bool,
   int, float, string, Vector3, Quaternion, Color, the
   bool/int/float/string/Vector3 arrays, and `JToken`. All 17 payload shapes, both directions. The
   string fix from the protocol pass is directly visible in the frame bytes: a `broadcast::string`
   payload goes out as `"hello from unity round 1"`, 26 bytes for 24 characters, i.e. quoted. The
   run also found the `SendData` sample itself broken — it sent its `JObject` on `"myJson"` while
   listening on `Channel` — and that is fixed.
6. **Done.** A second client sent **60** `broadcast::float` messages on `verification`, a channel
   where Unity had registered only a `string` listener. The console got **exactly one** warning:

   ```
   Colibri: a float arrived on channel 'verification', but the listener registered there
   expects string. The message was dropped, because Colibri matches messages on the channel
   *and* the type. Either send it as string, or listen for it with
   Sync.Receive<float>("verification", MyHandler).
   ```

   Channel, both types, and both routes out of the mistake — and the once-per-`(channel,
   receivedType)` suppression from §4 holding against 60 messages rather than against the unit
   tests' synthetic ones.
7. **Done for the message; the `Store` half found a bug instead.** With no `ColibriConfig.asset` in
   the project at all, a ~60 s Play session logged `NOT_CONFIGURED_MESSAGE` **exactly once**, not
   once per frame — the fallback in §4 behaves. `Store.Get`, however, neither threw *nor* logged:
   the default `ServerAddress` points at the public `colibri.hci.uni-konstanz.de`, and the request
   was still outstanding after ~60 s, because `UnityWebRequest.timeout` defaults to no timeout at
   all. §3's promise that a `Store` failure surfaces as a detailed log only holds if the request
   ever finishes, so the requests now carry a ten-second timeout.
8. **Done for both halves, and the live half produced a fix.** Opening *Window → Colibri Status* in
   edit mode rendered the "press Play" hint and created **no** `[WebServerConnection]` and **no**
   `[Colibri SyncTicker]` GameObject — the scene still contained only what was already in it, which
   is what the `FindFirstObjectByType` constraint in §5 is for. During Play the readout tracked the
   connection over many minutes and stayed in the 7-99 ms band, and the 2 s watchdog never fired.
   Watching it is also what exposed the readout itself: sampling `MillisSinceLastHeartbeat()` raw at
   the window's 10 Hz repaint beats against the server's 100 ms heartbeat and reads like a number
   counting down. The window now peak-holds the worst gap over one second, which is both steady and
   the figure that actually matters.
9. **Done, and it failed before it passed.** This is the one item that found a defect rather than
   confirming a claim. With `EnterPlayModeOptions.DisableDomainReload` on, three enter/exit cycles of
   the `SyncBehaviour` sample left one extra `[Colibri SyncTicker]` GameObject behind *each time*.
   Measured outside Play mode, the Editor had accumulated seven, all still enabled:

   ```
   live SyncTicker components (outside Play mode): 7
     go='[Colibri SyncTicker]' hideFlags=DontSave activeSelf=True enabled=True scene='' valid=False
     ... x7
   ```

   They belong to no scene (`scene=''`), which is why item 8's edit-mode check could truthfully
   report an untouched scene while these were sitting in the Editor.

   The cause is one flag. `HideFlags.DontSave` does not only keep an object out of the saved scene,
   it also exempts it from being destroyed when Play mode ends — and `DontDestroyOnLoad` was already
   covering the "not saved" half on its own, so the flag was buying nothing and costing this. The
   consequence is worse than a stale object in the hierarchy: every ticker drives the same *static*
   `_tickables` list, so the n-th Play session ran `PollChanges` and `FlushUpdate` **n times per
   frame** — duplicate `model::update` messages on the wire, and a sync cost that grew every time
   someone pressed Play. The flag is removed, and `ResetState` now destroys strays first, so an
   Editor that already collected a pile of them recovers on the next Play. After the fix: zero
   tickers alive outside Play mode, and three cycles that hold steady —

   ```
   LEAK syncedBehaviours=4 connections=1 tickerObjects=1 tickables=4
   LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
   LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
   ```

   — the first cycle counting four only because the late-joined remote model had already arrived by
   the time the probe ran. The 52 EditMode tests still pass afterwards, and item 4's profiler run was
   taken after this fix, which is why it sees the one ticker entry the design intends rather than one
   per Play session so far. Note that `ColibriTest` was
   left with *Enter Play Mode Options → Disable Domain Reload* enabled, since that is the
   configuration this check requires.
10. **Done, against injected traffic rather than a second instance.** On connect, each
    `SyncTransform` broadcast its full state on `synctransform` (`active`, `position`, `rotation`,
    `scale`, `physicsid`). Selective sync holds: with position *and* rotation *and* scale changed on
    both objects, `CubePosOnly` sent `{"id":...,"position":[5,1,2]}` and `CubeRotOnly` sent
    `{"id":...,"rotation":[...]}` — each only its own axis. Injecting a `model::update` for an
    unknown id on `synctransform_cube` made `[SyncTransformManager] (Cube)` instantiate
    `CubeModelTemplate(Clone)` at exactly the injected `[3,4,5]`. Idle objects sent nothing at all,
    which is what the sync-loop rewrite intends. `[RemoteLogger]`, dragged in from
    `Packages/de.uni.kn.colibri/Prefabs/[RemoteLogger].prefab`, put one line per second on the wire
    for 25+ seconds with no storm and no stuck in-flight gate, so the `Subject` + `ThrottleLast` →
    `volatile bool` + 1 s timer rewrite in §3 behaves. Its payload is **unquoted** —
    `payload(23B)="verification log line 1"`, 23 bytes for 23 characters, against the quoted
    `broadcast::string` in item 5 — which is exactly the `log`-channel exception the protocol pass
    documented. What this does not cover is how two Unity clients *look* while syncing: the next
    subsection has two of them connected at once, but nobody watched a cube in one follow a cube in
    the other.

### Beyond the ten: the standalone player, and two Unity clients at once

A development Windows 64-bit player was built from `ColibriTest` with the `SyncTransform` and
`SyncBehaviour` sample scenes in it: `result=Succeeded errors=0 warnings=13 time=00:01:59`. That on
its own is worth having: it says the package compiles and links for a real player target and not
only for the Editor, which a clean Editor compile does not imply.

Run alongside the Editor, both clients were connected to the same app at the same time:

```
State        LocalPort  OwningProcess
Established      53594          12476   <- standalone player
Established      49539           6976   <- Unity Editor
```

and the player's own log shows a clean session with no `FrameException`:

```
Colibri: connecting to localhost:9012
Colibri: connected to localhost:9012 as app 'myAppName'. Only clients using the same App Name can see each other.
```

Two Unity clients on one machine is the configuration the two-client recipe asks for, and the one
the old hardcoded voice port and the old `static` socket fields would have broken. What it still
does **not** show is the visual half: that moving a cube in one client moves it in the other was
never confirmed, because the player's scene state is not observable from outside its process. Every
message path underneath it was verified separately, but "both connected" is not "sync confirmed".

Two incidental observations from the player run, both of which matter to anyone following the
two-client recipe:

- **TextMeshPro is missing from a fresh project.** The sample scenes' `Instructions` object raised
  `NullReferenceException at TMPro.TMP_Settings.get_defaultFontAsset` in the player, because a new
  project has no TMP Essentials imported. Not a Colibri fault, but it is the first thing a student
  building this recipe will hit.
- **One orphaned socket, unexplained.** A single Editor connection created at 21:14 was still
  `Established` nearly an hour later with **zero** `WebServerConnection` components alive — a socket
  whose owner was gone. It did not reproduce: a clean enter/exit Play cycle afterwards added no new
  connection and left that one alone. It also appeared during a stretch where the configured TCP port
  was being edited while Play mode ran and proxies were being killed underneath the connection, so
  this is recorded as an observation and not as a diagnosed defect — nothing was changed in response
  to it. It is worth a deliberate look, because a phantom client stays in the server's client list.

### Beyond the ten: the `SyncBehaviour` sample

The ten items are silent about `SyncBehaviour` itself — they cover `SyncTransform`, which is one
particular subclass — so the sample was run as well, and it is the thing that exercises §2's typed
change tracking on members a student actually declares. On connect, each of the three scene models
broadcast its full `[Sync]` state on `samplesyncedbehaviour` (the channel is
`typeof(T).Name.ToLower()`), e.g.
`{"id":"nonrandom_id","position":[...],"scale":[...],"rotation":[...],"color":"#00000000","randomvalue":0,"editorteststring":"1234"}`.
All three member kinds propagate: `randomvalue` is a `[Sync, SerializeField]` *private field*,
`editorteststring` a public field, and `position` / `scale` / `rotation` / `color` are properties —
so the `Expression.Compile()` accessors reach non-public state as intended. Injecting a
`model::update` for `remote-model-1` produced a `SampleSyncedBehaviourTemplate(Clone)` whose
component read back `RandomValue: 99`, `EditorTestString: "from the injector"`, `Scale: (2,2,2)`,
`Color: RGBA(1,0,0,1)` (parsed from `#FF0000FF`) and `Id: remote-model-1` — every synced member
applied, colour included. Finally, after a full exit and re-enter of Play with no other client
running, Unity re-created that model from the server's stored state via `model::request`, at the
injected position `[7,1,3]` and scale `[2,2,2]`, as exactly **one** instance rather than a
duplicate — which is the late-joiner path, and the one where a double-registration bug would show
up as a second copy.

### Still not covered

All ten of the original criteria have now been addressed. Nine came back as results; the tenth, item
2, is a question about the criterion rather than a run still owed — opening the `colibri-unity`
project can no longer mean what it meant before the samples moved to `Samples~`, and what it was
really asking is covered by item 1. Beyond the ten, this pass did not touch:

- **Voice chat.** It needs a microphone, so neither the port-0 bind nor the `CancellationToken`
  shutdown that replaced `Thread.Abort` has been exercised. It is the one sample with no coverage at
  all.
- **The visual half of Unity ↔ Unity.** The player was built and both clients were connected
  concurrently, but object-follows-object between them was not confirmed.
- **The `colibri-unity` dev project itself.** Only `ColibriTest` was opened — see item 2.

---

## 9. Decisions, and what was deliberately not done

**No `Sync.Send<T>`.** `Sync.Send("ch", value)` already resolves without a cast, because the
argument is a value rather than a method group — there is no ambiguity to fix. Adding a generic
version would turn today's *compile error* on an unsupported type into a runtime `Debug.LogError`,
trading a mistake caught instantly for one caught at 2am.

**No warning for channels with no listeners.** Every client sees every channel its app uses. A
console that cries wolf is a console nobody reads.

**Explicit per-type dispatch instead of `MakeGenericMethod`.** `SyncBehaviour.BuildAttribute` is a
17-line `if` chain over the supported types rather than reflection over an open generic. It keeps
every generic instantiation visible to the AOT compiler (IL2CPP), and it doubles as the place that
can tell a student their `[Sync]` member has a type Colibri cannot put on the wire.

**Registration in `Awake`/`OnDestroy`, not `OnEnable`/`OnDisable`.** The base class already declares
`Awake` and `OnDestroy` as `protected virtual`, so subclasses that shadow them get a compiler
warning. Introducing `OnEnable`/`OnDisable` as *new* virtuals would create a fresh trap: a subclass
writing `private void OnEnable()` would silently take over the Unity message and the object would
never register. Polling is instead gated on `isActiveAndEnabled` inside the tick.

**Known limitation, unchanged from before:** a `[Sync]` array mutated **in place** is not detected.
`EqualityComparer<float[]>.Default` falls back to reference equality, exactly as `object.Equals` on
a boxed array did. Assign a new array to trigger a sync.

---

## Appendix: file map and commits

### New files

| File | Purpose |
|---|---|
| `Synchronization/Code/SyncTicker.cs` | The single per-frame driver |
| `Synchronization/Code/ChannelListenerRegistry.cs` | Channel→type registry and mismatch messages |
| `Setup/ColibriStatusWindow.cs` | `Window → Colibri Status` |
| `Tests/Editor/ChannelListenerRegistryTests.cs` | 11 EditMode tests |

### Modified

`Synchronization/Code/SyncBehaviour.cs` (typed attributes, ticker, static events),
`SyncBehaviourManager.cs` (event handlers + unsubscribe), `Sync.cs` (generics, mismatch reporting,
traffic log), `Networking/WebServerConnection.cs` (config reporting, status accessors),
`Networking/RemoteLogging.cs` (timer instead of throttle), `Store/Store.cs` (awaiter, error
reporting), `Setup/ColibriConfig.cs` (non-null defaults), `Setup/SetupWindow.cs`,
`Samples/SendMessages/SendMessages.cs`, `Samples/VoiceChat/VoiceManager.cs`, `Colibri.asmdef`,
`Packages/manifest.json`, `Packages/packages-lock.json`, `THIRD_PARTY_NOTICES.txt`, `README.md`,
`CHANGELOG.md`.

### Commits

```
a9010ed  perf(unity): drive sync change detection from one central ticker
9cbc0b9  refactor(unity): drop UniTask from Store and RemoteLogging
5c33fc7  build(unity): remove the R3 and UniTask dependencies
2d83436  feat(unity): report type mismatches and drop the casts from Sync.Receive
30c00f7  fix(unity): say what is wrong when Colibri is not configured
8906b6e  feat(unity): add a Window -> Colibri Status panel
e9c9be4  fix(unity): keep the mismatch key separator as a source escape
1a4678d  docs(unity): rewrite the install and lead with the cast-free API
eb71408  fix(unity): stop the unconfigured fallback allocating a config per frame
```

24 files, +1405 / −429.
