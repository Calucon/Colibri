# colibri-unity v2 Modernization

## Context

`colibri-web` (2.0.0) and `colibri-server` (2.0.0) are done. `colibri-unity` is the last piece
and it is currently **broken against the modernized server**: `colibri-server` 2.0.0 replaced the
v1 `\0\0\0{ascii length}\0{flatbuffer}` TCP framing with a fixed binary **v3 protocol**, and the
Unity client still speaks v1. No Unity client can connect to a 2.0.0 server at all.

The server's own changelog names this explicitly as deferred client work
(`colibri-server/docs/v2-changelog.md` → *Deferred work*): the v3 framing, heartbeat/latency merge
and byte-verbatim relay (plan items 17–22) have **never been exercised by a real Unity client**.
Landing this is what closes out the v2 release across all three packages.

Beyond the protocol, the package carries the same kind of drift the other two had: an archived
reactive dependency (UniRx), a vendored `Newtonsoft.Json.dll`, a UPM manifest claiming Unity 2019.4,
dead code targeting server commands that no longer exist, no tests, and several latent networking
bugs in the send path.

**Outcome:** `colibri-unity` 2.0.0 — a Unity client that talks v3 to a 2.0.0 server, on maintained
dependencies, with the frame codec under test.

## Decisions taken

| Question | Decision |
| --- | --- |
| Branch | New branch off the current `colibri-server-v2` branch |
| Reactive library | **UniRx → R3** (Cysharp, actively maintained, pairs with UniTask) |
| `ObservableModel` / `ObservableManager` | **Delete** — provably dead against a 2.0 server |
| Minimum Unity | **2022.3 LTS** (package manifest currently lies at 2019.4) |
| Testing | **EditMode tests for the frame codec** + a documented live round-trip against the server. No GameCI workflow. |

---

## Phase 0 — Branch and package baseline

1. `git checkout -b colibri-unity-v2` from `colibri-server-v2`.
2. `Assets/Colibri/package.json`: version `1.3.1` → `2.0.0`, `"unity": "2019.4"` → `"2022.3"`,
   declare real `dependencies` (`com.unity.nuget.newtonsoft-json`), and drop the
   `Samples/ObservableModel` entry.
3. `Packages/manifest.json`: remove `com.neuecc.unirx`, add `com.cysharp.r3` (git URL,
   `path=src/R3.Unity/Assets/R3.Unity`) and `com.unity.nuget.newtonsoft-json`.
4. Delete the vendored `Assets/Colibri/Plugins/Newtonsoft.Json.dll` (+ `.meta`) in favour of the
   UPM package.
5. `Assets/Colibri/Colibri.asmdef`: `UniRx` → `R3`/`R3.Unity`, add the Newtonsoft assembly
   reference, keep `UniTask` and `Unity.TextMeshPro`.

> ⚠ **R3 install friction to handle in the README.** R3's Unity package needs the core `R3`
> assembly from NuGet (via NuGetForUnity) alongside the git UPM package — a UPM `dependencies`
> entry cannot express that. The README install section must spell out both steps. If that proves
> too heavy for a research toolkit, the fallback is vendoring `R3.dll` under `Plugins/` the way
> `Newtonsoft.Json.dll` is today — but that is the pattern this phase is removing, so treat it as
> a last resort and flag it rather than doing it silently.

## Phase 1 — v3 wire protocol (the blocking work)

The authority is `colibri-server/src/server/modules/networking/protocol.ts` and
`colibri-server/docs/protocol.md`. Mirror them exactly; every constant below comes from there.

```
[u32 LE totalLength][u8 type][body]      totalLength = 1 (type) + body.length
  0x00 heartbeat   [u64 LE pingTimestamp]
  0x01 handshake   utf8 "version::app::name"
  0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
```

6. **New `Assets/Colibri/Networking/Protocol/`** — pure C#, no `UnityEngine` dependency so it is
   directly unit-testable:
   - `FrameType.cs` — `Heartbeat = 0x00, Handshake = 0x01, Message = 0x02`.
   - `FrameCodec.cs` — `EncodeHeartbeat(ulong)`, `EncodeHandshake(string, string, string)`,
     `EncodeMessage(string channel, string command, ReadOnlySpan<byte> payload)`. One pre-sized
     `byte[]` per frame, written with `BinaryPrimitives.WriteUInt32LittleEndian` /
     `WriteUInt16LittleEndian`. Enforce the same guards the server does: channel/command
     ≤ `0xFFFF` bytes, total ≤ `MAX_FRAME_LENGTH` (5 MiB), else `FrameException`.
   - `FrameReader.cs` — growable buffer with read/write cursors, `Append(ReadOnlySpan<byte>)`
     returning every complete frame. Same semantics as the server's `FrameReader`: reset both
     cursors when fully drained (no copy), compact only a trailing partial frame, throw
     `FrameException` on `totalLength <= 0`, oversized, unknown type, or a body that overruns.
     This replaces `HasPacketHeader` / `GetPacketHeader` / the `\0`-scan entirely.
   - `DecodedFrame.cs`, `FrameException.cs`.

7. **Rewrite `Assets/Colibri/Networking/WebServerConnection.cs`.** Keep the public surface
   (`SendCommand`, `SendCommandAsync`, `OnMessageReceived`, `OnConnected`, `OnDisconnected`,
   `Status`, `Connected`) so `Sync.cs` and downstream user code are unaffected. Changes:
   - **Handshake**: send a `0x01` frame immediately after connect, `version = "2"` to match
     `colibri-web`'s `query: { app, version: '2' }` (`colibri-web/src/Colibri.ts:50`). The server
     does not validate it (`tcp-server-worker.ts` `assignApp`) — it is client-library metadata
     shown in the admin UI.
   - **Heartbeat**: on a `0x00` frame, echo the frame back **verbatim** (`ulong` in, `ulong` out,
     never interpreted) and stamp the liveness timer. The server derives TCP latency purely from
     this echo now — `MeasureLatency`'s 100 ms `colibri`/`latency` broadcast is Socket.IO-only.
     **Delete** the old `if (channel == "colibri" && command == "latency") SendCommandAsync(...)`
     echo at `WebServerConnection.cs:299`; nothing sends that to a TCP client any more.
   - **Send path** — three real bugs to fix while rewriting `SendDataAsync`:
     - Concurrent `SendCommandAsync` calls can interleave bytes on the socket and corrupt framing.
       Serialize all writes behind a `SemaphoreSlim(1, 1)`.
     - `_socket.SendAsync(args)` returning `false` (completed synchronously) never fires
       `Completed`, so `await signal.WaitAsync()` hangs forever. Move to
       `Socket.SendAsync(ArraySegment<byte>, SocketFlags)` and drop the
       `SocketAsyncEventArgs`+`SemaphoreSlim`-per-send allocation.
     - `_msgQueue` is written from the send path and drained from the connect path with no
       synchronization.
   - **Receive path**: `await socket.ReceiveAsync(...)` loop feeding `FrameReader`, replacing the
     `BeginReceive`/`AsyncCallback` machinery and its `catch (Exception) { /* ignore */ }`
     (`WebServerConnection.cs:341`) that silently kills the receive loop. Log and reconnect instead.
   - **State**: make `_socket`, `_receiveBuffer` and friends instance fields. They are `static`
     today, which breaks under Enter Play Mode Options with domain reload disabled.
   - **Lifecycle**: a `CancellationTokenSource` cancelled in `OnDisable`, reconnect with backoff
     instead of `Update()` re-entering `Connect()`.
   - **`await Connected`**: replace the UniRx `IObservable<bool>` awaiter with a
     `UniTaskCompletionSource` gate — clearer, and keeps Rx off the send hot path.

8. **Payload encoding — fix the string case.** `SendCommandAsync` currently special-cases
   `JTokenType.String` and writes the string *unquoted* (`WebServerConnection.cs:491-494`), which
   is not valid JSON. Against a 2.0 server that reaches web clients via `Payload.asValue()`, which
   throws and falls back to `asString()` — so a Unity `Sync.Send(channel, "hello")` and a web
   client's version of the same message do not round-trip identically. Always emit
   `payload.ToString(Formatting.None)`, and on receive always `JToken.Parse` with a fallback to a
   raw `JValue` for a non-JSON body. **Exception:** keep the `log` channel sending raw text —
   `ClientLogger` (`client-logger.ts`) reads it with `asString()`, and quoting it would put stray
   quotes in the admin UI.

9. **Delete** `Assets/Colibri/FlatBuffers/` (10 files + metas) and
   `Assets/Colibri/Networking/Message.cs`, mirroring the server dropping its `flatbuffers`
   dependency. Update `THIRD_PARTY_NOTICES.txt` accordingly.

## Phase 2 — Dependency and API modernization

10. **UniRx → R3** across the four remaining files after the Phase 3 deletions:
    `SyncBehaviour.cs`, `SyncBehaviourManager.cs`, `RemoteLogging.cs`, `WebServerConnection.cs`.
    Mapping: `IObservable<T>` → `R3.Observable<T>`; `BehaviorSubject<T>` → `ReactiveProperty<T>`;
    `this.ObserveEveryValueChanged(f)` → `Observable.EveryValueChanged(this, f)`;
    `TakeUntilDestroy/TakeUntilDisable(this)` → `.AddTo(this)`; `Sample(TimeSpan)` →
    `.ThrottleLast(TimeSpan)`; `Observable.Start` + `WhenAll` in `RemoteLogging.SendLog` →
    plain UniTask. `SyncBehaviour<T>.ModelCreated()/ModelDestroyed()` change return type from
    `IObservable<>` to `Observable<>` — a deliberate breaking change for a 2.0.0 major.
11. **Delete the legacy observable API**: `Synchronization/Code/ObservableModel.cs`,
    `ObservableManager.cs`, and `Samples/ObservableModel/` (4 files). These speak `channel::register`,
    `add`, `update`, `request`, `remove` — the 2.0 server registers only `broadcast::*`,
    `model::request/update/delete`, `client::request` and `latency`
    (`grep onCommand src/server/`), so this code cannot function. `SyncBehaviour` /
    `SyncBehaviourManager` cover the same use case.
12. **Deprecated Unity APIs**: `FindObjectOfType` → `FindFirstObjectByType`, `FindObjectsOfType` →
    `FindObjectsByType(..., FindObjectsSortMode.None)` in `SingletonBehaviour.cs:21`,
    `SyncBehaviour.cs:153-154`, `SyncBehaviourManager.cs:23,54`, `SyncTransformEditor.cs:16`.
    While there: `SyncBehaviour.cs:153` assigns `var managers = …` and never uses it — a duplicate
    scene scan every `Awake`.
13. **`VoiceServerConnection.cs`**: replace `udpThread.Abort()` (`OnDisable`) with a
    `CancellationToken` + `udpClient.Close()`; and bind the receive socket to port **0** instead of
    the hardcoded 9014 — the server replies to the datagram's source port
    (`voice-server.ts:136`), so a fixed port only prevents two Unity clients per machine.
    `OnDisable` also NREs when `Connect()` bailed out.
14. **`Store.cs`**: `JsonUtility` → Newtonsoft, matching the rest of the package. `JsonUtility`
    cannot serialize dictionaries, properties, or top-level arrays, so `Store.Get<T>`/`Put`
    silently disagree with what `Sync` can carry.

## Phase 3 — Tests

15. **`Assets/Colibri/Tests/Editor/Colibri.Tests.asmdef`** (EditMode, references `Colibri` +
    `UnityEngine.TestRunner`/`nunit.framework`). The frame codec has no Unity dependency, so this
    is plain NUnit. Port the server's `colibri-server/test/protocol.test.ts` case-for-case:
    encode/decode round-trip for all three frame types; byte-by-byte fragmentation; a frame split
    across two segments; multiple frames coalesced in one segment; complete-frame-plus-trailing-
    partial; oversized frame; and the malformed variants (`totalLength <= 0`, unknown type,
    channel/command length overrunning the body).
16. Add one **cross-implementation vector test**: a handful of frames hex-encoded from the server's
    encoder, asserted byte-for-byte against `FrameCodec`. This is what actually catches an
    endianness or off-by-one drift between the two implementations.

## Phase 4 — Documentation

17. **`colibri-unity/README.md`**: Unity 2022.3+ requirement; install instructions for R3 (both
    the UPM git URL and the NuGetForUnity step) and `com.unity.nuget.newtonsoft-json` replacing the
    bundled DLL; remove the UniRx URL; a compatibility note that **colibri-unity 2.0.0 requires
    colibri-server ≥ 2.0.0 and cannot talk to a 1.x server**; and remove the `ObservableModel`
    references.
18. **`colibri-unity/CHANGELOG.md`** (new), in the style of `colibri-server/docs/v2-changelog.md`:
    the v3 protocol switch, the R3 migration, the deleted legacy API, and the bug fixes — with the
    breaking changes called out at the top.
19. Cross-reference `colibri-server/docs/v2-changelog.md`'s *Deferred work* section to record that
    the `colibri-unity` client rewrite has landed.

---

## Verification

**Unit** — Unity Test Runner → EditMode → `Colibri.Tests` all green. Also run
`cd colibri-server && npm test` to confirm the server-side `protocol.test.ts` still passes
unchanged (the C# side is the thing under test; the server is the reference).

**End-to-end round trip** — this is the part that has never been exercised, so do it explicitly:

1. `cd colibri-server && npm run build && npm start` (or `docker compose up`).
2. Open the admin UI at `http://localhost:9011`.
3. Play the Unity `SendMessages` sample with a matching app name.
   - Admin UI **Clients** page shows the Unity client with `v2` and its hostname → handshake frame OK.
   - Admin UI **Latency** chart shows a line for the Unity client → heartbeat echo OK (this is the
     single best signal that items 17–22 work; nothing in the repo has produced it before).
   - Admin UI **Log** page with *Sync traffic* enabled shows `broadcast::*` rows → message frames OK.
4. Run `npm run samples/broadcast` in `colibri-web` against the same app name and confirm values
   cross the transport boundary **in both directions**, including a `string` payload — that is the
   Phase 1 item 8 fix.
5. Play the `SyncTransform` sample in two Unity editor instances (or one Unity + the web
   `samples/model-sync`): moving an object in one moves it in the other; a late joiner receives the
   current state via `model::request`.
6. Add the `[RemoteLogger]` prefab, `Debug.Log` something, confirm it appears **unquoted** in the
   admin log page.
7. Voice chat sample between two clients — confirms the UDP path still works after the port-0 and
   thread-shutdown changes, and that two clients on one machine now both connect.

**Regression** — kill the server mid-session and restart it: the Unity client should reconnect on
its own backoff rather than spinning, and no `FrameException` should reach the console.
