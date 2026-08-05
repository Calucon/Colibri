# Verify colibri-unity 2.0.0 samples & prefabs end-to-end

## Context

`colibri-unity` was rewritten for 2.0.0 across two passes: the v3 binary protocol switch
(`colibri-unity-v2-plan.md`) and the ease-of-use / sync-loop pass
(`colibri-unity/docs/v2-ease-of-use-and-performance.md`). Both documents are explicit that the
Editor-side acceptance criteria have **never been run**:

- `v2-ease-of-use-and-performance.md` §8 lists ten "Pending — needs the Unity Editor" items.
- `colibri-unity-v2-plan.md` → *Verification* says the TCP v3 handshake, heartbeat echo and
  byte-verbatim relay "have never been exercised by a real Unity client".

Everything so far was verified by compiling with Roslyn and running the non-Unity logic standalone.
The samples and prefabs in particular have been edited (new `Sync.Receive<T>` form, `SyncTicker`,
static `ModelCreated`/`ModelDestroyed` events) without ever being loaded by Unity.

Meanwhile the intended test bed, `C:\Users\simon\source\repos\ColibriTest`, is a **stock Unity
6000.5.7f1 URP template with no Colibri in it at all** — no package entry, no
`Resources/ColibriConfig.asset`, no Colibri source. It has to be set up first.

**Outcome:** every sample and prefab in `colibri-unity/Assets/Colibri` demonstrably works against a
locally built `colibri-server`, with a `colibri-web` client and a standalone Unity player as the
second endpoints. Anything broken gets fixed in the local repo.

**Local only.** Every component comes from `C:\Users\simon\source\repos\Colibri`. The GitHub
package URL in the README is never used.

---

## Step 0: move this plan into the repo

Plans belong in the repo root, next to `colibri-unity-v2-plan.md`, since you switch machines. First
action on approval: write this to
`C:\Users\simon\source\repos\Colibri\colibri-unity-v2-verification-plan.md`.

## Prerequisite: restart Claude Code first

`unity-mcp` is registered in `~/.claude.json` (`C:\Users\simon\.unity\relay\relay_win.exe --mcp`)
and the relay is live on ports 9001/9002 attached to Unity PID 30188 (ColibriTest), but its tools
were **not loaded into the current session**. Start a new session before executing this plan, and
confirm the Unity tools are present before step 1.

---

## What is already known to be wrong

Found while reading; each is a task below, not a hypothesis to re-derive.

| # | Problem | Where |
|---|---|---|
| A | `SendMessages` registers `Sync.Receive<JToken>` on `"myChannel"` but sends its `JObject` on `"myJson"` — the JSON round trip can never fire from the sample itself | `Samples/SendMessages/SendMessages.cs:106` |
| B | Samples live in `Samples/`, not `Samples~`. They compile into every consumer project, and Package Manager → Import (which the README quickstart tells students to do) makes a second copy | `Assets/Colibri/package.json`, `README.md:29` |
| C | `Prefabs` is declared as an importable sample *and* is a live package folder — importing duplicates `[RemoteLogger]` / `[SyncTransformManager]` | `package.json` samples[5] |
| D | Dead `propertyPath: Channel` prefab override; `Channel` is a private computed property, not a serialized field | `Samples/SyncTransform/SyncTransformSample.unity` ~line 427 |
| E | `CubeModelTemplate.prefab` / `SphereModelTemplate.prefab` predate `SyncActive` and `UseLocalTransform` and lack both keys | `Samples/SyncTransform/` |
| F | Store REST uses `http` when `IsSSL` is off; Unity 6 blocks cleartext by default, so the RestApi sample fails unless Player Settings allow it. The README mentions this only in *Advanced Configuration* | `Store/Store.cs`, `README.md` |

D and E are cosmetic (missing YAML keys fall back to the field initializers, so `SyncActive`
stays `true`) — re-save the assets and move on. A, B, C, F are real.

---

## Phase 1 — Bring up the server and the web client

1. `cd colibri-server && npm run build` — `dist/` is stale (2026-07-30 vs sources at 2026-08-05),
   so both `gui:build` and `server:build` must run. Then `npm start`.
   Ports: **9011** HTTP admin UI + REST + Socket.IO, **9012** TCP (Unity v3), **9013/udp** voice.
   There is no `.env`, so the defaults in `src/server/configuration.ts` apply.
2. `npm test` in `colibri-server` — confirms `test/protocol.test.ts` still passes; it is the
   reference the C# codec is asserted against.
3. Open `http://localhost:9011` — routes are `/log` and `/statistics` only (there is no separate
   Clients page; "Clients" is a heading on `/statistics` above the latency chart).
4. `cd colibri-web && npm run samples/broadcast`, answering `localhost` / `9011`. It hardcodes app
   name **`myAppName`** and channel **`myChannel`** — both match the Unity `SendMessages` sample, so
   use `myAppName` as the Unity app name and neither side needs editing.

## Phase 2 — Install Colibri into ColibriTest via UPM

5. `ColibriTest/Packages/manifest.json`: add
   `"de.uni.kn.colibri": "file:../../Colibri/colibri-unity/Assets/Colibri"`
   (relative to the `Packages` folder) and a root-level
   `"testables": ["de.uni.kn.colibri"]` so Test Runner picks up the package's EditMode assembly.
   Do **not** add `com.cysharp.r3` or `com.cysharp.unitask` — 2.0.0 dropped both, and their absence
   from a clean project is exactly what §8 item 1 is meant to prove.
6. Let the Editor reload and read the console. Acceptance: **zero compile errors**, and
   `com.unity.nuget.newtonsoft-json` resolved automatically from the package's `dependencies`.
   (It is already present transitively via `com.unity.ai.assistant`, so also confirm the explicit
   dependency does not conflict — the lock currently pins 3.2.2 over the requested 3.2.1.)
7. Configure: *Window → Colibri Configuration* → App Name `myAppName`, server `localhost`, ports
   9011/9012/9013, SSL off, Save Config. Confirm `Assets/Resources/ColibriConfig.asset` appears.
8. Player Settings → *Insecure HTTP Option* → **Always allowed** (problem F). If this turns out to
   be required for the RestApi sample, promote it from *Advanced Configuration* to the Quickstart
   in `README.md`.

## Phase 3 — The unconfigured and misconfigured paths (do these before configuring, or on a revert)

Cheap and they cover four of the §8 items:

9. **Missing config** (§8.7): with no `ColibriConfig.asset`, press Play. The
   `NOT_CONFIGURED_MESSAGE` must appear **once**, not once per frame — `WebServerConnection.Update`
   calls `ColibriConfig.Load()` every frame — and `Store.Get` must log rather than throw.
10. **Status window** (§8.8): open *Window → Colibri Status* **outside** Play mode. It must render a
    hint and must **not** create a `[WebServerConnection]` or `[Colibri SyncTicker]` GameObject in
    the open scene. Then open it during Play and confirm connection state, app name, host:port and
    "time since last heartbeat" update live.
11. **Type mismatch** (§8.6): temporarily point one `SendMessages` handler at the wrong type (or
    have the web client send a `float` on a channel where Unity listens for `string`). The console
    must name the channel, both types and the fix, and must say it **once** per
    `(channel, receivedType)` — not 60×/second.

## Phase 4 — EditMode tests

12. Test Runner → EditMode → `HCIKonstanz.Colibri.Tests`. Expect **52 green**:
    `FrameCodecTests` (8), `FrameReaderTests` (22), `ProtocolVectorTests` (11),
    `ChannelListenerRegistryTests` (11). `ProtocolVectorTests` is the one that catches endianness or
    off-by-one drift against the server's encoder.

## Phase 5 — Samples, one at a time

Broadcasts exclude the sender (`connection-pool.ts:124` passes `exceptClientId`), so **every
pub/sub test needs the second client running**.

13. **SendData / `SendMessages`** — import the sample the way the README says
    (*Package Manager → Colibri → Samples → Import*). This is where problem B/C shows itself:
    record whether the import duplicates the always-compiled package copy, and whether that is a
    hard error or just two copies of every scene and script.
    Then Play, tick `SendProperties`, and check **both directions** against
    `npm run samples/broadcast`:
    - all 8 scalar types, all 8 array types, and `JToken`;
    - a **string** payload specifically — plan item 8 changed Unity to always emit
      `ToString(Formatting.None)`, and a bare unquoted string is what used to break `asValue()`;
    - fix problem A so the sample's own `myJson` send is actually observable (either register the
      `JToken` listener on `"myJson"` or send on `Channel`).
14. **Remote Store / `RestApi`** — Play `RestApiExample.unity`; `Store.Put` then `Store.Get` must
    round-trip `ExampleClass`. Cross-check with `cd colibri-web && npm run samples/rest-api`
    against the same app name, and confirm the REST path `/api/store/myAppName/`.
    `Store` now never throws — a failure must surface as the detailed log (operation, object, URL,
    transport error, HTTP status) described in the ease-of-use doc §3.
15. **`[RemoteLogger]` prefab** — drag `Assets/Colibri/Prefabs/[RemoteLogger].prefab` into a scene,
    `Debug.Log` something, and confirm it reaches `http://localhost:9011/log` **unquoted** (the
    `log` channel is the deliberate exception to the always-JSON rule). This also exercises the
    `RemoteLogging` throttle rewrite (`Subject`+`ThrottleLast` → `volatile bool` + 1 s timer in
    `Update`), so watch for a log storm or a stuck in-flight gate.
16. **`SyncBehaviour`** — Play `SyncBehaviourSample.unity`. Second client: a purpose-built
    `colibri-web` script (scratchpad) using
    `RegisterModelSync({ name: 'samplesyncedbehaviour', type: … })` — `name` overrides the default
    channel (`src/ModelSynchronization.ts:18`), and the Unity channel is
    `typeof(T).Name.ToLower()` (`SyncBehaviour.cs:199`). Check: field, property and private-field
    `[Sync]` members all propagate; the `SampleSyncedBehaviourTemplate` prefab is instantiated for a
    remote-created model; a **late joiner** gets current state via `model::request`.
17. **`SyncTransform`** — Play `SyncTransformSample.unity`. Channels are `synctransform`,
    `synctransform_cube`, `synctransform_sphere` (`ChannelPrefix + "_" + Template.ModelId`).
    Verify each of `CubePosOnly` / `CubeRotOnly` / `CubeScaleOnly` / `CubeAll` syncs only its own
    axis, and that `[SyncTransformManager] (Cube)` / `(Sphere)` instantiate their templates.
    Re-save the two template prefabs and the scene to clear problems D and E.
18. **Voice Chat** — needs two real Unity clients and a microphone, so this is the one that requires
    the standalone build (step 20). Confirms the two changes from plan item 13: the receive socket
    binds to port **0** (so two clients on one machine both work — the old hardcoded 9014 allowed
    one), and `OnDisable` shuts the UDP thread down via `CancellationToken` + `udpClient.Close()`
    instead of `Thread.Abort()`. Also confirm `OnDisable` does not NRE when `Connect()` bailed out.

## Phase 6 — Unity ↔ Unity

19. Build ColibriTest to a standalone Windows player (a scene list covering `SyncTransformSample`
    and `VoiceChatSample`). This is the README's own two-client recipe.
20. Run the player alongside the Editor: `SyncTransform` must sync smoothly in both directions, and
    voice chat must connect both ways (step 18).

## Phase 7 — Protocol and lifecycle checks

These are the plan items that have never been exercised by a real client:

21. **Handshake (0x01)** — admin UI shows the Unity client with version `2` and its hostname.
22. **Heartbeat (0x00)** — the `/statistics` latency chart shows a line for the Unity client. This
    is the single best signal that the byte-verbatim echo works; nothing in the repo has produced
    it before.
23. **Message frames (0x02)** — `/log` with *Sync traffic* enabled shows `broadcast::*` rows.
24. **Reconnect** — kill the server mid-session and restart it. The client must reconnect on its own
    backoff rather than spinning, and **no `FrameException` may reach the console**.
25. **Leak check** (§8.9) — enter/exit Play three times with domain reload disabled and a
    `SyncBehaviourManager` in the scene. Object counts must not double (the static
    `ModelCreated`/`ModelDestroyed` events) and `SyncTicker`'s list must not grow.
26. **Performance** (§8.4) — Profiler, 100 `SyncTransform`s, Deep Profile off, objects idle:
    **GC Alloc in the sync path must be 0**, and there must be exactly one `SyncTicker.Update`
    entry rather than N reactive frame-provider items. This is the headline claim of the sync-loop
    rewrite and the only §8 item that is a measurement rather than a yes/no.

## Phase 8 — Fix and document

27. Fix whatever Phases 3–7 turn up, in `C:\Users\simon\source\repos\Colibri` on the current
    `colibri-unity-v2` branch. Problem A is a certain fix. Problems B and C become
    `Samples/` → `Samples~` + updated `package.json` paths + a README note **if** step 13 shows real
    breakage — with the tradeoff that the `colibri-unity` dev project can then no longer open the
    sample scenes in place (that is what ColibriTest is for). Problem F is a README change.
28. Replace §8 of `colibri-unity/docs/v2-ease-of-use-and-performance.md`: the ten "Pending" items
    move to "Done" with what was actually observed (including the profiler numbers from step 26),
    and anything still not covered is named explicitly rather than dropped.
29. Add the results to `colibri-unity/CHANGELOG.md`, and update the *Deferred work* section of
    `colibri-server/docs/v2-changelog.md` to record that the Unity client has now been exercised
    against a live 2.0.0 server (plan item 19).

---

## Verification summary

The work is done when, with `colibri-server` running locally:

- ColibriTest compiles clean with **only** the Colibri `file:` package added (no R3, no UniTask).
- 52 EditMode tests green.
- All five samples run, each verified against a second client.
- The admin UI shows the Unity client's handshake **and a latency line** — the never-before-seen
  signal that the heartbeat echo works.
- Killing and restarting the server produces a clean reconnect and no `FrameException`.
- Idle sync allocates 0 B/frame in the profiler.
- §8 of the ease-of-use doc no longer has a "Pending" list.
