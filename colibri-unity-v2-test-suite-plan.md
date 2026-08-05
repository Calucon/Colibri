# Automated test suite + two hand-out documents

## Context

colibri-unity 2.0.0 was verified end-to-end for the first time in the previous session, and that
pass found twelve real problems (A–L in `colibri-unity-v2-verification-findings.md`) — a colour
that threw instead of converting, integers silently dropped by web clients, a `SyncTicker` that
leaked one live GameObject per Play session, a `Store` that hung forever. Every one of them was
found **by hand**, driving the Unity Editor through MCP. None of it is repeatable by anyone else,
and none of it guards against regression.

The three suites that do exist cover pure logic only: colibri-server 102 tests, colibri-web 112
tests + a real e2e suite (`colibri-web/e2e/`, which already boots the server with
`docker compose` and talks to it over Socket.IO), and colibri-unity's 52 EditMode tests, which
never open a socket. The entire Unity runtime path — handshake, heartbeat, the 17 payload shapes,
model sync, reconnect — has zero automated coverage.

Two outcomes:

1. **An automated suite anyone can run with one command**, which converts the manual verification
   into PlayMode tests against a real server, plus EditMode tests for the untested logic that
   produced the colour bug.
2. **Two markdown documents in the repo**: `MIGRATION.md` for developers upgrading from 1.x, and
   `docs/getting-started.md` as a student hand-out.

Decisions already taken: Unity PlayMode e2e (not the no-license shortcut); a local runner script,
no Unity GitHub Action; markdown in the repo for both documents; student guide is Unity-first with
the web client as a sidebar.

---

## Part 1 — Test suite

### 1.1 EditMode unit tests for the untested logic

`colibri-unity/Assets/Colibri/Tests/Editor/JsonExtensionsTests.cs` (new). `JsonExtensions`
(`Synchronization/Code/JsonHelper.cs`) has **zero** tests and is where problem G lived — a bad
payload threw `InvalidCastException` out of `WebServerConnection.Update`, which also discarded
every message queued behind it that frame. Cover:

- `ToJson` for `Vector2/3`, `Quaternion` (arrays) and `Color` (`#RRGGBBAA`).
- `ToColor` accepting **both** wire forms — the `#RRGGBBAA` string Unity writes and the
  `[r,g,b]` / `[r,g,b,a]` array `colibri-web`'s `sendColor` writes. This is the G regression guard.
- Malformed input for every converter — not an array, too-short array, non-numeric element,
  unparseable colour string — asserting the documented fallback (`Vector3.zero`,
  `Quaternion.identity`, `Color.black`) **and exactly one warning** via `LogAssert.Expect`, and
  that nothing throws.
- `ToJson(object)` dispatch across all 16 supported types plus the `"UNKNOWN TYPE"` fallback.

Follow the existing style in `Tests/Editor/FrameCodecTests.cs` (NUnit, `[TestCase]` tables).

### 1.2 Make the ticker's state assertable

Add `colibri-unity/Assets/Colibri/AssemblyInfo.cs`:

```csharp
[assembly: InternalsVisibleTo("HCIKonstanz.Colibri.Tests")]
[assembly: InternalsVisibleTo("HCIKonstanz.Colibri.E2E")]
```

`SyncTicker` is `internal sealed`, so today the only way to check its registration list is
reflection (what the throwaway `LeakProbe.cs` did). One line makes `_tickables` and
`ITickable` directly assertable.

### 1.3 PlayMode e2e assembly

New folder `colibri-unity/Assets/Tests/` — **in the dev project, outside the package**.
`Assets/Colibri` is what ships (`Assets/Colibri/package.json`), and students should not receive
tests that demand a running server. The package's own `Tests/Editor` stays pure logic.

`Colibri.E2E.asmdef`: name `HCIKonstanz.Colibri.E2E`, references `HCIKonstanz.Colibri`,
`UnityEngine.TestRunner`, `UnityEditor.TestRunner`, `Unity.Newtonsoft.Json`; `includePlatforms: []`;
`precompiledReferences: ["nunit.framework.dll"]`; `defineConstraints: ["UNITY_INCLUDE_TESTS"]`
— mirroring `Assets/Colibri/Tests/Editor/Colibri.Tests.asmdef`.

**`E2EServer.cs`** — the fixture-level rig, and the piece every test depends on:

- Reads `COLIBRI_E2E_SERVER` / `COLIBRI_E2E_PORT` (defaults `127.0.0.1` / `9012`), the same
  environment contract as `colibri-web/e2e/globalSetup.ts`.
- Probes the TCP port; if nothing is listening, `Assert.Ignore` with the exact command to fix it
  (`docker compose up -d` in `colibri-server`). Tests that cannot run must say so, not fail.
- Mutates the instance returned by `ColibriConfig.Load()` in place **before** anything touches
  `WebServerConnection.Instance`: a per-run unique `AppName` (`colibri-unity-e2e-<ticks>`, the
  same anti-crosstalk trick as `uniqueApp()` in `colibri-web/e2e/helpers.ts`), plus address and
  ports. Requires a checked-in `colibri-unity/Assets/Resources/ColibriConfig.asset` so
  `Resources.Load` finds something to mutate.
- Sets `Application.runInBackground = true`. Problem I — with it off the Editor suspends the
  player loop and the client silently stops while still looking connected.

**`TcpPeer.cs`** — the second endpoint. The server excludes the sender from its own broadcasts, so
a single Unity client **cannot** observe what it sends; a peer is not optional. A raw `TcpClient`
speaking v3 with the package's own `public` `FrameCodec` / `FrameReader`: handshake as
`("2", app, "e2e-peer")`, a read loop that echoes heartbeats, and
`Task<DecodedFrame> Expect(channel, command, timeout)` / `Send(channel, command, payload)`.
Port `colibri-server/test/tcp-crosstalk-check.ts` — it already proves this exact flow works, and
confirms the channel goes on the wire unprefixed, with the app coming from the handshake.

### 1.4 The tests

| File | What it locks in |
|---|---|
| `ConnectionTests.cs` | `await WebServerConnection.Instance.Connected` resolves; `Status == Connected`; `MillisSinceLastHeartbeat()` stays under the 2 s watchdog across many frames |
| `BroadcastTests.cs` | All 17 `Sync.Send` shapes reach the peer with the right command and JSON; peer→Unity for all 17 fires the right `Sync.Receive` callback. Locks in G (colour) and H (`broadcast::int`) at the wire level |
| `SyncBehaviourTests.cs` | `[Sync]` on a private `[SerializeField]`, a public field and a property all propagate; a late joiner recovers a model via `model::request` as **exactly one** instance |
| `SyncTransformTests.cs` | Selective per-field sync — move only the position and assert the emitted `model::update` carries only `position` |
| `MismatchWarningTests.cs` | 60 mismatched messages produce exactly one warning (`LogAssert`), the §8.6 claim |
| `LifecycleTests.cs` | Exactly one `[Colibri SyncTicker]` GameObject and one registration per tickable — the problem L guard; `Store` fails within its 10 s timeout against a dead port instead of hanging (problem K) |
| `ReconnectTests.cs` | Most involved, do last. Run an in-process pass-through proxy (port `colibri-server/test/tcp-wire-tap.ts`), point Unity at it, drop the sockets mid-session, assert one `ConnectionReset` log, a fresh handshake, queued messages resuming in order, and **no `FrameException`** |

**Verify while implementing:** `SingletonBehaviour<T>` (`Core/SingletonBehaviour.cs`) has no
`[RuntimeInitializeOnLoadMethod]` static reset, unlike `SyncTicker`, and it latches
`_createdInstance = true` permanently. With *Disable Domain Reload* on — which the v2 docs now
recommend — the second Play session looks likely to get a destroyed `_instance` back and never
recreate it. Confirm with a PlayMode test before fixing; if confirmed, add the same
`SubsystemRegistration` reset `SyncTicker` already has.

### 1.5 One-command runner

`colibri-unity/run-tests.mjs` (Node, cross-platform — Node is already a repo dependency):

1. Unless `COLIBRI_E2E_SERVER` is set, `docker compose up -d --build` in `colibri-server` and wait
   for the port. Reuse the `waitForPort` shape from `colibri-web/e2e/globalSetup.ts`, and honour
   `COLIBRI_E2E_NO_BUILD` the same way.
2. Resolve the Editor: `UNITY_PATH`, else the Unity Hub default for the platform, else fail with
   instructions rather than a stack trace.
3. `Unity -batchmode -nographics -projectPath colibri-unity -runTests -testPlatform EditMode|PlayMode
   -testResults <file> -logFile -`, both platforms.
4. Parse the NUnit XML, print `N passed / M failed / K ignored`, list failures with their messages,
   exit non-zero on failure.
5. `docker compose down` — unless the server was external, which the script must not tear down.

### 1.6 Kill the manual regeneration step

`ProtocolVectorTests.cs` carries hardcoded hex with the instruction *"To regenerate, run the
encoders from colibri-server and hex-dump the buffers"* — a manual step nobody will do, on the one
file that guards C#/TypeScript wire drift. Add `colibri-server/test/emit-protocol-vectors.ts`
(script + `npm run test:vectors`) that prints the table ready to paste, and point the doc comment
at the command.

### 1.7 Documentation

Extend the existing `## For maintainers` section of `colibri-unity/README.md` with how to run the
suite, the environment variables, and the fact that the e2e tests self-ignore without a server.
One pointer from the root `README.md`.

---

## Part 2 — The two documents

### `MIGRATION.md` (repo root)

For developers with a 1.x project. Source material already exists and should be consolidated, not
rewritten: `colibri-unity/CHANGELOG.md` (323 lines), `colibri-server/docs/v2-changelog.md`,
`colibri-web/CHANGELOG.md`, `colibri-unity/docs/v2-ease-of-use-and-performance.md`.

- **Read this first**: v3 framing has no version negotiation — server and every client must move
  together. A 1.x client cannot talk to a 2.0.0 server.
- Per component, the breaking changes with before/after code: UniRx gone (`IObservable` →
  `+=`/`-=`, and static events no longer unsubscribe themselves on destroy), `Connected` is a
  `Task`, `ObservableModel<T>` deleted, vendored `Newtonsoft.Json.dll` replaced by the UPM package,
  samples moved to `Samples~` so sample types no longer compile into consumer projects, Unity
  minimum now 2022.3.
- **Behaviour changes that are not compile errors** — the dangerous ones. Colour now round-trips
  both directions; web clients now receive Unity's integers (previously dropped silently); `Store`
  now times out at 10 s instead of hanging; strings are valid JSON on the wire, so a Unity string
  and a web string are finally identical.
- A migration checklist, and the known residuals from §8.

### `docs/getting-started.md` (new repo-root `docs/`)

Student hand-out, Unity-first. Derived from `colibri-unity/README.md` and the `Samples~` samples.

- Install (one git URL), configure — **the app name must match on every client that should see
  each other**, the single most common cause of "nothing happens".
- **Turn on Run In Background.** Problem I: with it off the client silently stops the moment the
  Editor loses focus, while still showing as connected. This belongs near the top, not in
  troubleshooting.
- Send and receive: the cast-free `Sync.Send` / `Sync.Receive` API with a real snippet per common
  type.
- Sync a transform with zero code; `[Sync]` on your own fields.
- Where the samples are and how to import them from Package Manager (they live in `Samples~` now
  and are **not** in the project until imported).
- *Talking to a browser* sidebar: the npm package, and the fact that colibri-web takes tuples
  (`[1,2,3]`) where Unity takes `Vector3`.
- Troubleshooting table: nothing arrives, wrong app name, server unreachable, Run In Background,
  and how to read the **Colibri Status** window.

Link both from the root `README.md`.

---

## Verification

- `node colibri-unity/run-tests.mjs` from a clean checkout: server comes up, EditMode and PlayMode
  both green, server torn down, exit 0.
- Run it **again with the server already up** and `COLIBRI_E2E_SERVER=127.0.0.1` set, to prove the
  external-server path does not tear down someone's running server.
- Run it with **no server at all**: e2e tests must report as ignored with the fix instructions, and
  the EditMode tests must still pass.
- Confirm the new tests actually catch the bugs they guard: temporarily revert the `ToColor` array
  branch, the `broadcast::int` handling, and the `SyncTicker` `HideFlags`/`ResetState` fix, and
  check that a test fails for each. Restore.
- `npm test` in both `colibri-server` (102) and `colibri-web` (112) still green; `npm run
  test:vectors` output matches the hex already in `ProtocolVectorTests.cs`.
- Read both documents end to end against the source changelogs for factual drift; the student guide
  gets walked through literally in a fresh project.

**Still not covered afterwards, and both documents say so**: voice chat needs a microphone, and the
visual half of Unity↔Unity (object-follows-object between two Unity clients) stays manual.

## Commits

Conventional commits, roughly: `test(unity)` for the EditMode gap, `test(unity)` for the e2e
assembly and rig, `test(unity)` per test group, `build(unity)` for the runner,
`test(server)` for the vector emitter, `fix(unity)` if the SingletonBehaviour reset is confirmed,
and `docs` for each of the two documents.
