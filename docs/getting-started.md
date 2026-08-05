# Getting started with Colibri

Colibri connects several running programs so they share data. One person moves a cube in Unity, and
it moves on everyone else's screen. That is the whole idea; everything below is detail.

This guide is written for Unity, because that is where most prototypes start. There is a short
section at the end on [talking to a browser](#talking-to-a-browser), which works the same way.

**You need two things before you start:** the address of a Colibri server, and an app name. Your
supervisor will give you the server; the app name you choose yourself.

---

## Install it

*Window → Package Manager → + → Install package from git URL*, and paste:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

That is the whole installation. Unity pulls in the one library Colibri needs by itself.

You need **Unity 2022.3 or newer**, and the server has to be **version 2.0 or newer** — a 2.0
client and a 1.x server cannot talk to each other at all.

---

## Two settings decide whether anything works

A configuration window opens by itself after installing. You can reopen it any time from
*Window → Colibri Configuration*.

### 1. The app name must be identical everywhere

Enter an **App Name** and press *Save Config*. Any word you like — but **every client that should
see each other has to use exactly the same one.**

This is the single most common reason two clients ignore each other. Both say *Connected*, both
look perfectly healthy, and nothing crosses between them, because the server keeps each app name
completely separate. If you are working in a shared lab, pick something nobody else will:
`ana-thesis-prototype`, not `test`.

### 2. Turn on Run In Background

*Project Settings → Player → Resolution and Presentation → **Run In Background***.

Unity leaves this **off** by default, and with it off the Editor stops running your game the moment
its window loses focus. The connection stays up. The status window still says *Connected*. But
nothing is sent and nothing that arrived is delivered, because none of that happens until `Update`
runs again.

If you are testing two clients on one machine — and you will be — one of them is always in the
background. Turn it on now.

---

## Your first message

Sending is one line, from anywhere in your code:

```csharp
using HCIKonstanz.Colibri.Synchronization;

float temperature = 21.5f;
Sync.Send("Temperature", temperature);
```

Receiving means registering a listener, and saying what type you expect:

```csharp
private void Start()
{
    Sync.Receive<float>("Temperature", OnTemperature);
}

private void OnTemperature(float value)
{
    Debug.Log($"It is {value} degrees somewhere else");
}
```

That is the whole thing — there is no matching line to write in `OnDestroy`. Colibri notices when
the object that registered a listener is destroyed and stops calling it.

Three things worth knowing straight away:

- **The channel *and* the type both have to match.** `"Temperature"` sent as a `float` will not
  reach a listener registered for `string` on the same channel. Colibri says so in the console when
  it happens, so watch for that warning rather than assuming the network is broken.
- **Register before anyone sends.** A message that arrives with no listener is gone; there is no
  replay.
- **You never receive your own messages.** Only the other clients do.

If you want to stop listening while the object is still alive — say, only while a menu is open —
`Sync.Unregister<float>("Temperature", OnTemperature)` does exactly that.

### What you can send

`bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color` — and arrays of all of
them.

For anything else, send JSON:

```csharp
using Newtonsoft.Json.Linq;

[System.Serializable]
public class Reading
{
    public string Sensor;
    public int Value;
}

Sync.Send("Readings", JToken.FromObject(new Reading { Sensor = "left", Value = 7 }));

Sync.Receive<JToken>("Readings", token =>
{
    Reading reading = token.ToObject<Reading>();
});
```

---

## Move an object on every client, with no code

Drop the **`SyncTransform`** component onto any GameObject. Its position, rotation, scale and
active state now follow the same object on every other client.

The server remembers where things are, so a client that joins later gets the current positions
rather than starting from the scene's defaults.

Each of the four is a separate tick box on the component. Turning off the ones you do not need is
worth doing — a `SyncTransform` that only sends position is a quarter of the traffic, and it stops
a stray rotation from fighting with someone else's.

For objects you create at runtime, drag the **`[SyncTransformManager]`** prefab out of
`Packages/Colibri/Prefabs/` into your scene and give it a prefab in its `Template` field. When any
client spawns one, everyone else builds a copy from that template.

> One rule: only one client should be moving a given object at a time. Two clients dragging the
> same cube will fight, and the cube will jitter between them.

---

## Sync your own fields

Same idea, for your own data. Derive from `SyncBehaviour<T>` — where `T` is the class itself — and
mark the fields you want shared:

```csharp
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Player : SyncBehaviour<Player>
{
    [Sync] public string Name = "";
    [Sync] public int Score;
    [Sync] public Color Team;
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Put `PlayerManager` in the scene with a `Player` prefab in its `Template` field. Now `Score = 10` on
one client is `Score == 10` on all of them, and a `Player` created anywhere appears everywhere.

`[Sync]` works on public fields, private fields marked `[SerializeField]`, and properties. Only the
members that actually changed are sent, once per frame — assigning a field in `Update` every frame
does not flood anything unless the value really is changing.

---

## Keep data between sessions

The **Store** saves objects on the server, so they survive everyone closing Unity:

```csharp
using HCIKonstanz.Colibri.Store;

await Store.Put("highscores", myScores);

var scores = await Store.Get<ScoreTable>("highscores");
```

If the server cannot be reached, the call fails after ten seconds and the console says what went
wrong, at which URL. It will not hang forever waiting.

---

## See the console on a device without one

Building to a headset or a phone, where there is no console to read? Drag the **`[RemoteLogger]`**
prefab out of `Packages/Colibri/Prefabs/` into your scene, then open `http://<your-server>:9011` in
a browser. Your `Debug.Log` output appears there.

---

## The samples

*Window → Package Manager → Colibri → Samples → Import*. Each one lands in `Assets/Samples/` and is
yours to edit and break.

They are not in your project until you import them — that is deliberate, so you do not ship code you
never asked for.

| Sample | Shows |
| --- | --- |
| **SendData** | `Sync.Send` and `Sync.Receive` for every supported type |
| **SyncTransform** | Objects following each other, including spawning from a template |
| **SyncBehaviour** | `[Sync]` on your own class |
| **Remote Store** | Saving and loading data on the server |
| **Voice Chat** | Talking to the other clients |

The `[RemoteLogger]` and `[SyncTransformManager]` prefabs are *not* samples — they are always there,
in `Packages/Colibri/Prefabs/`.

---

## Talking to a browser

A web page can join the same app as your Unity clients and exchange the same messages:

```sh
npm install @hcikn/colibri
```

```ts
import { Colibri, Sync } from '@hcikn/colibri';

new Colibri('your-app-name', 'your-server-address');

Sync.sendNumber('Temperature', 21.5);
Sync.receiveNumber('Temperature', value => console.log(value));
```

Same app name, same channel names, same rules. Two differences to watch:

- **Vectors and colours are plain arrays in TypeScript**, not objects: `Sync.sendVector3('pos', [1,
  2, 3])` and `Sync.sendColor('tint', [1, 0, 0, 1])`, where Unity would use a `Vector3` and a
  `Color`.
- **JavaScript has one number type.** A web client sending `5` reaches Unity as a `float`, so listen
  for it with `Sync.Receive<float>` on the Unity side, not `int`.

The web client needs TypeScript 5 or newer. Full details in
[colibri-web/README.md](../colibri-web/README.md).

---

## When nothing happens

**Open *Window → Colibri Status* while the game is running.** It answers most of it at a glance:
whether you are connected, to which server, **as which app name**, which channels have listeners and
what type each expects, and the last twenty messages in and out.

| What you see | What it usually is |
| --- | --- |
| Two clients ignore each other, both connected | Different app names. The Status window shows the one in use — compare them. |
| A message never arrives, no errors | The listener expects a different type than the sender sent. Check the console; Colibri names both. |
| One client goes quiet when you click away | *Run In Background* is off on that client. |
| Nothing connects at all | Console says `Colibri is not configured yet` — open *Window → Colibri Configuration* and set an app name. |
| A `[Sync]` field never syncs | Its type is not one Colibri can send. It is reported in the console when the game starts. |
| `Store.Get` or `Put` fails | The log names the object, the URL, and the HTTP status. Usually the server address. |

If the console is empty and the Status window says *Connected* with the right app name, the message
really is being sent — so the problem is at the receiving end. That is nearly always the channel
name or the type.

---

## Rules of thumb

1. **Same app name everywhere.** Check it in the Status window before debugging anything else.
2. **Register listeners in `Start`, unregister in `OnDestroy`.** Colibri will not do it for you.
3. **One client owns each object.** Shared control of the same thing fights with itself.
4. **Watch the console.** Colibri reports the common mistakes by name instead of failing quietly —
   but only if you are looking.

---

Full reference: [colibri-unity/README.md](../colibri-unity/README.md). Upgrading a project from
Colibri 1.x: [MIGRATION.md](../MIGRATION.md).
