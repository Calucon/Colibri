# A network stress scene for Colibri

## Context

The sync delay reported with two editors side by side turned out to be the socket running on the
main thread; that is fixed and committed. What the episode exposed is that **Colibri has no way to
put itself under load and say what happened.** The bug was found by eye, from a cube that looked
late, and the numbers that would have settled it in a minute — throughput, round-trip latency,
whether anything was being dropped — did not exist anywhere.

The automated suite now guards the specific regression (`ConnectionTests`, the blocked-main-thread
heartbeat test), but a pass/fail test cannot answer "how many objects can this carry before it
falls over", which is the question that actually matters when teaching with it. That needs
something driven by hand, with the knobs exposed and the numbers on screen.

Two things found while reading are worth stating up front, because the harness is likely to
demonstrate both and the plan should not pretend to be surprised:

- **Inbound model dispatch is O(N) per message.** Every `SyncBehaviour<T>` instance registers its
  own `OnModelUpdate` on the *same* channel (`SyncBehaviour.cs:235`, channel is just the type name),
  and each one compares `id == Id` and returns on a miss (`SyncBehaviour.cs:309`). So one inbound
  update is handed to all N models. With N objects each sending, that is **O(N²) per frame** —
  10,000 comparisons a frame at 100 objects, 250,000 at 500. `SyncBehaviourManager.OnModelUpdate`
  adds a second linear scan (`_existingObjects.Any(t => t.Id == id)`).
- **The server silently drops to a backed-up client.** `tcp-server-worker.ts:194` — past a 1 MB
  writable high-water mark, writes are discarded, not queued. The server logs the transition; the
  client is never told. The probe channel below is what will make that visible from inside Unity.

Neither is in scope to fix here. The point of this work is to be able to see them.

## What gets built

A new sample, following the established layout (`Samples~/<Name>/` + an entry in the package's
`samples` array), so it ships with Colibri and imports into `ColibriTest` the same way
`SyncTransform` already does.

```
colibri-unity/Assets/Colibri/Samples~/NetworkStress/
    StressModel.cs              the synced object under load
    StressModelManager.cs       SyncBehaviourManager<StressModel>, template wiring
    NetworkStressHarness.cs     load generation, measurement, on-screen panel
    StressCubeTemplate.prefab   cube + StressModel, the manager's Template
    NetworkStressSample.unity   camera, manager, harness
```

plus one entry in `colibri-unity/Assets/Colibri/package.json`.

**No changes to Colibri itself.** Everything measured is measured by code the sample owns, or read
from public API that already exists (`WebServerConnection.Status`,
`.DeliveryFramesPerSecond`, `.MillisSinceLastHeartbeat()`).

### `StressModel`

```csharp
public class StressModel : SyncBehaviour<StressModel>
{
    [Sync] public Vector3 Position { get; set; }   // drives transform.localPosition
    [Sync] public int     Seq;                     // per-object sequence, for gap detection
    [Sync] public string  Padding;                 // payload size knob, empty by default
}
```

The harness owns the type, so both directions are counted exactly rather than inferred: sends are
counted where the harness mutates the model, receives in the `Position`/`Seq` setters. `Seq` makes
per-object staleness and gaps visible — with the honest caveat below.

### `NetworkStressHarness`

IMGUI (`OnGUI`), deliberately: no prefabs, no uGUI or TextMeshPro dependency, and it renders in the
Game view of an unfocused editor, which is exactly where the numbers are needed. Inspector fields
carry the same knobs so they can be set before pressing Play.

**Role**, chosen at runtime, because inbound load can only come from another client — the server
excludes the sender from its own broadcasts:

| Role | Behaviour |
|---|---|
| `Idle` | Connected, measuring, generating nothing. The receiving end of someone else's flood. |
| `Drive` | Spawns and moves N objects. |
| `Both` | Drives and echoes; what you run in both editors for a symmetric load. |

`Echo` behaviour is always on regardless of role: any probe ping received is mirrored straight back.
That costs nothing when nobody is probing and means a single instance never has to be configured to
be useful as the far end.

**Knobs**: object count (0–500), fraction of objects moving per frame (0–100 %), probe rate (Hz),
padding size (bytes). Buttons: *Apply / respawn*, *Drop connection*, *Reset stats*.

**Readouts**: connection status and reconnect count; delivery fps and frame ms; out and in
messages/s; RTT p50 / p95 / p99 / max; probe loss and reorder counts; heartbeat gap.

### The two instruments, and why they are separate

- **Load** is the synced objects: N `StressModel`s, a configurable fraction of them moved each
  frame. `SyncTicker` flushes one message per changed object per frame, so messages/frame is the
  moving count and the rate scales with the frame rate — realistic, because that is how a real
  scene generates traffic.
- **Latency and loss** ride on a *separate* low-rate probe channel (`Sync.Send` / `Sync.Receive`,
  sequence-numbered, echoed back by the far side). Round-trip, so it needs no shared clock and
  stays valid across machines. Deliberately low-rate (default 20 Hz) so it measures the delay
  *under* the load instead of contributing to it.

Keeping them separate is what makes loss measurable at all. **Gaps in `Seq` on the model channel
are not loss** — state sync is last-write-wins and coalesces per frame, so skipped values are
correct behaviour. The panel labels the model-channel figure *coalesced*, not *lost*. Only the
probe channel, where every message is meant to arrive exactly once, can honestly report drops —
and that is the channel that will show the server's high-water-mark discard.

Percentiles come from a ring buffer of the last 2000 RTT samples, sorted on a copy at the panel's
10 Hz repaint.

### Coverage of the four cases

| Case | How |
|---|---|
| Many synced objects | Object count and moving-fraction sliders; watch frame ms and delivery fps against N. This is where the O(N²) dispatch should appear as a knee. |
| Sustained latency percentiles | Probe channel held at a fixed rate while the object load is raised. |
| Inbound flood | Second editor in `Drive` with a high count; this one in `Idle`. Measures what arrives, what the frame cost is, and whether the probe channel starts dropping. |
| Reconnect under load | *Drop connection* toggles `WebServerConnection.enabled` off and on — its `OnDisable`/`OnEnable` already cancel the lifetime, close the socket and start a fresh loop, so no library change is needed. Measures time to reconnect and probe messages lost across it. Stopping the Docker server by hand exercises the same path with a real outage and the backoff. |

## Verification

1. **Compiles.** `Samples~` is hidden from Unity by the tilde, so the sample is *not* built by
   `run-tests.mjs` — the existing samples have the same gap. Copy the folder to
   `ColibriTest/Assets/Samples/Colibri/2.0.0/NetworkStress/` (which is exactly what a Package
   Manager import does) and compile that project in batchmode; check the console via the Unity MCP
   tools.
2. **Existing suites stay green.** `node colibri-unity/run-tests.mjs` — EditMode 91, PlayMode 72.
   Nothing here should touch them, and if it does, that is the finding.
3. **End-to-end without a second editor.** Add `colibri-server/test/stress-echo-peer.ts`, a ~40-line
   raw v3 client modelled on the existing `tcp-crosstalk-check.ts` that mirrors the probe channel
   back. That closes the RTT loop with one editor, which is what makes the harness smoke-testable
   from here rather than only on your machine. It is also genuinely useful on its own — a known-good
   far end to measure against when a second Unity is not worth starting.
4. **Report real numbers**, not "it seems to work": a table of frame ms, throughput and RTT
   percentiles at 0 / 50 / 100 / 250 / 500 objects, and the point at which the probe channel starts
   losing messages. If the O(N²) knee shows up, name where it is.
5. **The two-editor run is yours.** Both editors in `Both`, one focused and one not — the
   configuration that started this. I cannot drive two interactive editors from here.

## Documentation

A short section in `colibri-unity/docs/v2-ease-of-use-and-performance.md` (§5 is the natural
neighbour, since Status is the other diagnostic surface), the sample listed in `CHANGELOG.md`, and
whatever the numbers from step 4 turn out to say — including the O(N²) dispatch, written up as a
known scaling limit with the measurement behind it rather than as a claim.

## Commits

`feat(unity)` for the sample, `test` or `chore` for the echo peer, `docs` for the write-up and the
measured numbers.
