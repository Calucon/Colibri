# colibri-unity 2.0.0 — what the end-to-end verification actually showed

Working notes from executing `colibri-unity-v2-verification-plan.md` on 2026-08-05.
Environment: Unity **6000.5.7f1**, `ColibriTest` (URP template) with Colibri added as a
`file:` UPM package, `colibri-server` 2.0.0 built and run locally from
`C:\Users\simon\source\repos\Colibri\colibri-server` on Node 26.5.1
(ports 9011 web/REST/Socket.IO, 9012 TCP v3, 9013/udp voice).

Second endpoints used:

- `colibri-web/samples/verification-peer.ts` — non-interactive Socket.IO peer, listens for
  every supported type on `myChannel` and sends one of each. (`samples/broadcast.ts` needs
  someone at a prompt, so it is unusable from a script.)
- `colibri-server/test/tcp-crosstalk-check.ts` — raw v3 TCP client in the same app, prints
  every frame it receives.
- `colibri-server/test/tcp-wire-tap.ts` — pass-through proxy in front of the TCP port that
  decodes every frame in both directions. This is what made the handshake bytes and the
  `log`-channel quoting directly observable.
- `colibri-server/test/model-inject.ts` — injects `model::update` frames so a Unity client's
  receive side can be driven without a second Unity instance.

---

## Confirmed working

### Protocol (plan items 21-24, never exercised by a real Unity client before)

- **Handshake (0x01).** Wire tap, verbatim:
  `C->S HANDSHAKE version=2 app=myAppName name=DESKTOP-PUO2MAQ` — the documented
  `version::app::name`, client version `2`, hostname from `SystemInfo.deviceName`.
- **Heartbeat (0x00).** The server heartbeats every 100 ms; a raw client counted 369 in one
  40 s session. Unity echoes them: the 2 s watchdog never fired across many minutes of
  connected time, and the status readout stayed in the 7-99 ms band throughout.
- **Message frames (0x02).** All 17 payload shapes crossed in both directions (below).
- **Reconnect.** Killing the transport mid-session produced exactly one
  `Colibri: connection to localhost failed (ConnectionReset), retrying...`, then
  `Colibri: connecting to localhost:9022`, a fresh handshake, and the queued log lines
  resumed with no gap in their numbering — the retry queue drained in order. **No
  `FrameException` reached the console**, and there was no retry spin.

### EditMode tests (plan item 12)

**52 passed, 0 failed** (`FrameCodecTests`, `FrameReaderTests`, `ProtocolVectorTests`,
`ChannelListenerRegistryTests`), run through `TestRunnerApi` against the package's
`HCIKonstanz.Colibri.Tests` assembly. `colibri-server`'s own suite: 102 passed.

### Package install (plan items 5-6)

`ColibriTest` resolved `de.uni.kn.colibri` 2.0.0 as a Local package with **zero compile
errors** and **no R3 and no UniTask** anywhere in the manifest — §8 item 1 holds.
`com.unity.nuget.newtonsoft-json` resolved automatically; the lock's 3.2.2 satisfied the
package's 3.2.1 request with no conflict.

### SendData / `SendMessages` (plan item 13)

Every type crossed Unity → web and web → Unity: bool, int, float, string, Vector3,
Quaternion, Color, and the bool/int/float/string/Vector3 arrays, plus `JToken`.
The **string payload is quoted on the wire** (`broadcast::string` payload
`"hello from unity round 1"`, 26 bytes for 24 characters) — the Phase 1 item 8 fix, visible
in the frame bytes.

### Remote Store / `RestApi` (plan item 14)

Full round trip against `http://localhost:9011/api/store/myAppName/`:
`Put` → true, `Get` → the object back with a `Dictionary<string,string>`, a `List<float>`
and a computed property intact, `Delete` → true. The dictionary and the property are the
point: `JsonUtility` could not have carried either, so the Newtonsoft switch is doing real
work.

### `[RemoteLogger]` prefab (plan item 15)

Dragged in from `Packages/de.uni.kn.colibri/Prefabs/[RemoteLogger].prefab` — still reachable
now that `Prefabs` is no longer an importable sample. The wire tap shows the payload
**unquoted**, as the `log` channel requires: `payload(23B)="verification log line 1"` — 23
bytes for 23 characters, against the quoted `broadcast::string` above. One line per second
for 25+ seconds with no storm and no stuck in-flight gate, so the `Subject`+`ThrottleLast`
→ `volatile bool` + 1 s timer rewrite behaves.

### `SyncTransform` (plan item 17)

- On connect each `SyncTransform` broadcast its full state on `synctransform`
  (`active`, `position`, `rotation`, `scale`, `physicsid`).
- **Selective sync verified**: with position *and* rotation *and* scale changed on both
  objects, `CubePosOnly` sent `{"id":...,"position":[5,1,2]}` and `CubeRotOnly` sent
  `{"id":...,"rotation":[...]}` — each only its own axis, nothing else.
- **Template instantiation verified**: injecting a `model::update` for a new id on
  `synctransform_cube` made `[SyncTransformManager] (Cube)` instantiate
  `CubeModelTemplate(Clone)` at exactly the injected position `[3,4,5]`.
- Idle objects send nothing at all, which is what the sync-loop rewrite intends.

### `SyncBehaviour` (plan item 16)

- On connect each of the three scene models broadcast its full `[Sync]` state on
  `samplesyncedbehaviour` (the channel is `typeof(T).Name.ToLower()`), e.g.
  `{"id":"nonrandom_id","position":[...],"scale":[...],"rotation":[...],"color":"#00000000","randomvalue":0,"editorteststring":"1234"}`.
- **All three member kinds propagate**: `randomvalue` is a `[Sync, SerializeField]`
  *private field*, `editorteststring` a public field, and `position` / `scale` / `rotation` /
  `color` are properties.
- **Remote-created model instantiates the template**: injecting a `model::update` for
  `remote-model-1` produced `SampleSyncedBehaviourTemplate(Clone)` whose component read back
  `RandomValue: 99`, `EditorTestString: "from the injector"`, `Scale: (2,2,2)`,
  `Color: RGBA(1,0,0,1)` (parsed from `#FF0000FF`), `Id: remote-model-1` — every synced
  member applied.
- **Late joiner verified**: after a full exit and re-enter of Play with no other client
  running, Unity re-created that model from the server's stored state via `model::request`,
  at the injected position `[7,1,3]` and scale `[2,2,2]` — and exactly **one** instance, not
  a duplicate.

### Type mismatch message (§8.6, plan item 11)

A second client sent **60** `broadcast::float` messages on `verification`, a channel where
Unity had registered only a `string` listener. The console got **exactly one** warning:

```
Colibri: a float arrived on channel 'verification', but the listener registered there
expects string. The message was dropped, because Colibri matches messages on the channel
*and* the type. Either send it as string, or listen for it with
Sync.Receive<float>("verification", MyHandler).
```

Channel, both types, and both ways to fix it — once per `(channel, receivedType)`, not once
per message.

### Status window outside Play (§8.8, first half)

Opening *Window → Colibri Status* in edit mode rendered the "press Play" hint and created
**no** `[WebServerConnection]` and **no** `[Colibri SyncTicker]` GameObject — the scene still
contained only what was already in it.

### Missing configuration (§8.7, first half)

With no `ColibriConfig.asset` at all, a ~60 s Play session logged
`NOT_CONFIGURED_MESSAGE` **exactly once**, not once per frame.

---

## Problems found, and what was done about them

| # | Problem | Status |
|---|---------|--------|
| A | `SendMessages` sent its `JObject` on `"myJson"` but listened on `Channel` | **Fixed** — sends on `Channel` |
| B | `Samples/` was a live package folder, so samples compiled into every consumer *and* Package Manager → Import made a second copy | **Fixed** — moved to `Samples~` |
| C | `Prefabs` was both a live package folder and an importable sample | **Fixed** — dropped from `samples[]` |
| D | Dead `propertyPath: Channel` override (`synctransform_CUBE`) in `SyncTransformSample.unity` | **Fixed** |
| E | `CubeModelTemplate` / `SphereModelTemplate` predate `SyncActive` and `UseLocalTransform` | **Fixed** |
| F | Store REST over cleartext `http` vs Unity 6's *Insecure HTTP Option* | **Not the problem it looked like** — see below |
| G | Colour did not round-trip Unity ↔ web, and threw | **Fixed** |
| H | Unity's integers were silently dropped by web clients | **Fixed** |
| I | `Run In Background` off silently stops a Colibri client | **Documented** |
| J | Status window's heartbeat readout aliases into a countdown | **Fixed** |
| K | `Store` hangs indefinitely against an unreachable server | **Fixed** |

### B/C — the import really was broken

Importing `SendData` the way the README quickstart says produced, verbatim:

```
GUID [80ff4769b6565204991ba1655b2c3dec] for asset
  'Assets/Samples/Colibri/2.0.0/SendData/SendMessages.cs' conflicts with:
  'Packages/de.uni.kn.colibri/Samples/SendMessages/SendMessages.cs' (current owner)
Assigning a new guid.
```

and left **two** definitions of `HCIKonstanz.Colibri.Samples.SendMessages` (one in
`Assembly-CSharp`, one in `HCIKonstanz.Colibri`) and two copies of every scene. Not a hard
compile error, but any user code naming the type would be ambiguous.

After the move to `Samples~`: **0** sample types in the package assembly, and a re-import
produces exactly one `SendMessages.unity` with no GUID warnings. The `[RemoteLogger]` and
`[SyncTransformManager]` prefabs remain draggable from `Packages/Colibri/Prefabs`.

Tradeoff, as the plan anticipated: the `colibri-unity` dev project can no longer open the
sample scenes in place. `ColibriTest` is where they are opened now.

### F — cleartext HTTP is not actually blocked for localhost

`ColibriTest` has the Unity 6 default `insecureHttpOption: 0` (*Not allowed*), and the Store
round trip over `http://localhost:9011` **worked anyway** — Unity exempts loopback. So this
does not belong in the quickstart. It only bites when the server is *remote* and not on
HTTPS, which is the case the README's *Advanced Configuration* section already covers; that
section should say explicitly that localhost needs nothing.

### G — colour was broken between Unity and the web

Unity writes a colour as the HTML string `#RRGGBBAA`, which is exactly what colibri-web's
`receiveColor` is typed for — but colibri-web's `sendColor` puts an `[r,g,b,a]` array on the
wire. A colour sent from a web client reached Unity as:

```
InvalidCastException: Cannot cast JObject to JToken
  at JsonExtensions.ToColor (JsonHelper.cs:35)
  at Sync.OnServerMessage (Sync.cs:73)
  at WebServerConnection.Update (WebServerConnection.cs:203)
```

Two faults in one. The wire forms disagree, **and** a wrong-shaped payload escaped as an
unhandled exception out of `Update` — which also dropped every message queued behind it that
frame. `ToColor` now accepts either form, and all the vector/quaternion/colour conversions
report a bad payload as a warning naming the type and the expected shape instead of throwing.
Verified after the fix: a web client's `[1, 0.5, 0.25, 1]` arrives as
`RGBA(1.000, 0.500, 0.250, 1.000)` with no exception.

colibri-web's own `sendColor`/`receiveColor` asymmetry is left alone deliberately — changing
the wire format would alter behaviour for existing web-only users, and Unity now copes with
both. It is worth a colibri-web issue.

### H — integers vanished on the web side

Unity tags `Sync.Send(channel, 5)` as `broadcast::int`, but colibri-web's `receiveNumber`
only listened for `broadcast::float`. JavaScript has one number type, so every integer a
Unity client sent was dropped without a trace. `receiveNumber`/`receiveNumberArray` now
listen for both. colibri-web's 108 tests still pass.

### I — `Run In Background` is a silent killer

`ColibriTest` has Unity's default `runInBackground: 0`. With it off, the Editor suspends the
player loop as soon as its window loses focus. The socket stays up and heartbeats keep being
echoed (that happens off the main thread), so the client looks perfectly healthy — but
`Update` never runs, so nothing is sent and nothing the receive thread queued is ever
delivered. It cost a long detour here, and it lands squarely on the README's own two-client
recipe: the unfocused instance goes silent while looking connected.

### K — `Store` never gave up

On an unconfigured project, `Store.Get` neither threw nor logged: the default
`ServerAddress` points at the public `colibri.hci.uni-konstanz.de`, and the request was still
outstanding after ~60 s, because `UnityWebRequest.timeout` defaults to "no timeout". The
ease-of-use doc's promise that a Store failure surfaces as a detailed log only holds if the
request finishes.

---

## Not covered by this pass

State these plainly rather than implying they passed:

- **Voice chat (plan items 18, 20).** Needs two real clients and a microphone. The port-0
  bind and the `CancellationToken` shutdown were not exercised.
- **Standalone player / Unity ↔ Unity (plan items 19-20).** Not built. Every message path
  was instead verified against a raw v3 TCP client and a colibri-web peer.
- **Leak check (§8.9, plan item 25).** Enter/exit Play three times with domain reload
  disabled was not run.
- **Profiler measurement (§8.4, plan item 26).** The "0 B GC alloc in the idle sync path,
  one `SyncTicker.Update` entry" claim is **unmeasured**. Idle objects were observed to send
  no traffic at all, which is consistent with it, but that is not the measurement.
- **The `colibri-unity` dev project itself.** Only `ColibriTest` was opened. After the
  `Samples~` move that project can no longer open the sample scenes in place anyway, so
  §8 item 2 needs rephrasing rather than re-running.
