# colibri-unity 2.0.0 — ease of use and the sync loop

Companion to [`CHANGELOG.md`](../CHANGELOG.md), covering the last pass over colibri-unity 2.0.0 in
the depth a change log cannot carry: what changed, why, how the replacements work, and what still
has to be checked in the Editor.

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
Either send a string instead, or listen for it with Sync.Receive<float>("chat", MyHandler).
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

### Done

- **Both assemblies compile clean.** The 43 runtime sources and the 4 EditMode test sources were
  compiled with Roslyn against Unity 6000.2's managed assemblies at `langversion:9.0`
  (C# 9 = the Unity 2022.3 level), with `UNITY_EDITOR` defined so the editor windows are included.
  Zero errors, zero warnings.
- **The registry logic runs green.** `ChannelListenerRegistry` has no Unity dependency, so its
  behaviour was executed standalone: 19 checks covering silence with no listeners, silence on a
  match, the mismatch message content, once-per-pair suppression, re-arming, plural wording,
  listener ref-counting, channel cleanup, and the friendly type names.

### Pending — needs the Unity Editor

These cannot be run headlessly and are the acceptance criteria for this work:

1. **The point of the whole dependency removal:** a *fresh* Unity 2022.3 project with only the
   Colibri git URL added, and nothing else, compiles clean.
2. `colibri-unity` itself opens with zero compile errors now that R3/UniTask are out of the manifest.
3. Test Runner → EditMode → `HCIKonstanz.Colibri.Tests`: the 41 existing codec tests stay green,
   plus the 11 new `ChannelListenerRegistryTests`.
4. **Performance, measured rather than derived.** 100 `SyncTransform`s, Deep Profile off, Play mode:
   - *GC Alloc per frame in the sync path must be 0 while objects are idle.* This is the headline
     number; it was ~4 boxes × 100 objects before.
   - `SyncBehaviour` total ms/frame before vs after — expect a decrease.
   - One `SyncTicker.Update` entry in the profiler rather than N frame-provider items.
5. `SendMessages` sample between two Editor instances against a running colibri-server — every type
   arrives.
6. **Type mismatch:** point one sample handler at the wrong type; the console must name the channel,
   both types, and the fix.
7. **Missing config:** delete `Assets/Resources/ColibriConfig.asset` and press Play. The message
   must appear *once*, not per frame, and `Store.Get` must log rather than throw.
8. **Status window:** open it during play and confirm the fields update live — and that opening it
   *outside* Play mode does not create a `[WebServerConnection]` or `[Colibri SyncTicker]` GameObject.
9. **Leak check:** enter/exit Play mode three times with domain reload disabled and a
   `SyncBehaviourManager` in the scene. Object counts must not double (static events) and
   `SyncTicker`'s list must not grow.
10. `SyncTransform` between two instances still syncs smoothly, and `[RemoteLogger]` still reaches
    the server web UI (this is what covers the throttle rewrite).

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
