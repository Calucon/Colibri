# Getting started with Colibri

Colibri connects running programs so they share data: move a cube in Unity, and it moves on
everyone else's screen. This guide uses Unity; [talking to a browser](#talking-to-a-browser) works
the same way.

**You need** Unity 2022.3 or newer, an app name you choose, and a running colibri-server 2.x, your
own ([setup](../colibri-server/README.md#setup)) or a shared one. A 2.0 client and a 1.x server
cannot talk to each other at all.

## Install it

*Window → Package Manager → + → Install package from git URL*, and paste:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

Unity pulls in the one library Colibri needs. Package Manager should now list **Colibri 2.0.0** or
newer. A 1.x version is the old Colibri (needs UniRx and UniTask, cannot talk to a 2.0 server):
remove it and install again with a
[release tag](https://github.com/hcigroupkonstanz/Colibri/releases) appended to the URL, e.g.
`#v2.0.0`.

## Two settings decide whether anything works

A configuration window opens after installing; reopen it from *Window → Colibri Configuration*.

### 1. The app name must be identical everywhere

Enter the **Server Address** (host name or IP, no `http://`; preset to the public test server
`colibri.hci.uni-konstanz.de`, usable only while it runs 2.x) and an **App Name**, then press
*Save Config*.

- **Every client that should see each other needs exactly the same app name.** The server keeps
  app names apart, so a mismatch is the most common reason two clients ignore each other while
  both say *Connected*.
- **Every project needs its own.** Projects on one server with the same name (`test`, or an
  example's) share one app: they see each other's objects and messages, and every message goes to
  the clients of both, slowing the server for everyone. Pick `museum-ar-prototype`, not `test`.
  The window warns about common picks (`test`, `demo`, `myAppName`) but cannot know what other
  projects use.

### 2. Turn on Run In Background

*Project Settings → Player → Resolution and Presentation → **Run In Background***: turn it on.
Otherwise the Editor stops running your game whenever its window loses focus: the connection stays
up and the status says *Connected*, but nothing is sent or delivered until `Update` runs again.
With two clients on one machine, one is always in the background. (No effect on a Quest; see
[Building for Meta Quest](#building-for-meta-quest).)

## Your first message

Sending is one line, from anywhere in your code:

```csharp
using HCIKonstanz.Colibri.Synchronization;

float temperature = 21.5f;
Sync.Send("Temperature", temperature);
```

Receiving means registering a listener for the type you expect:

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

There is nothing to write in `OnDestroy`: a listener that is a method of your component, or a
lambda using something of it (a field, a method, `transform`), is dropped with the component. A
static method, or a lambda using only its parameter or statics such as `Debug.Log`, stays until
`Sync.Unregister`. Registering the same listener twice (`Start` after a scene reload) adds nothing.

- **Channel *and* type must match.** `"Temperature"` sent as a `float` does not reach a `string`
  listener. The console says so; look there before blaming the network.
- **Register before anyone sends.** A message with no listener is gone; there is no replay.
- **You never receive your own messages.** To see one arrive, run a second client: build the scene
  and run the build next to the Editor, or open the project a second time from the Unity Hub.
- **To stop listening early** (say, while a menu is open):
  `Sync.Unregister<float>("Temperature", OnTemperature)`.

### What you can send

`bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color`, and arrays of all of
them. For anything else, send JSON:

```csharp
using Newtonsoft.Json.Linq;

[System.Serializable]
public class Reading
{
    public string Sensor;
    public int Value;
}

Sync.Send("Readings", JToken.FromObject(new Reading { Sensor = "left", Value = 7 }));

Sync.Receive<JToken>("Readings", OnReading);

private void OnReading(JToken token)
{
    Reading reading = token.ToObject<Reading>();
}
```

## Move an object on every client, with no code

Drop the **`SyncTransform`** component onto a GameObject: its position, rotation, scale and active
state follow on every other client.

- **Late joiners** get the current positions, not the scene's defaults, while any client of your
  app is connected. After the last one leaves, the server forgets them; use the
  [Store](#keep-data-between-sessions) for anything that must outlast that.
- **Each of the four has a tick box.** Only changes are sent, so unticking saves little traffic;
  it stops this client reading that value from its transform or applying one that arrives, so a
  stray rotation cannot fight someone else's.
- **Destroying** a synced object, or unloading its scene, removes it on every client. Leaving Play
  mode or quitting does not: the object stays on the server for the others.
- **Objects created at runtime:** put the **`[SyncTransformManager]`** prefab from
  `Packages/Colibri/Prefabs/` in your scene, with a prefab in its `Template` field. When any client
  spawns one, the others build a copy from that template.

> Only one client should move an object at a time. Two dragging the same cube make it jitter.

## Sync your own fields

Derive from `SyncBehaviour<T>` (`T` is the class itself) and mark the fields to share:

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

`[Sync]` works on public or private fields and properties of the types in
[What you can send](#what-you-can-send) (a `JObject` for your own classes). Only changed members are
sent, so assigning an unchanged value every frame costs nothing.

## Keep data between sessions

The **Store** keeps objects on the server, so they survive everyone closing Unity:

```csharp
using HCIKonstanz.Colibri.Store;

await Store.Put("highscores", myScores);
var scores = await Store.Get<ScoreTable>("highscores");
```

- Anything Json.NET can serialize works, plain numbers and strings included, up to 5 MiB.
- If the server cannot be reached, the call fails after ten seconds; the console says what went
  wrong, at which URL.
- No passwords: anyone who can reach the server can read, change and delete what is stored. Keep
  personal data, such as what you record from study participants, out of it.

## See the console on a device without one

Put the **`[RemoteLogger]`** prefab from `Packages/Colibri/Prefabs/` in your scene and open
`http://<your-server>:9011` in a browser: your `Debug.Log` output appears there, from a headset or
a phone too.

## Building for Meta Quest

A Quest app is an Android build: *File → Build Settings* (*Build Profiles* in Unity 6) *→ Android →
Switch Platform*. Colibri works with the IL2CPP backend and ARM64 that Quest builds use (*Project
Settings → Player → Other Settings*), and `[Sync]` members survive code stripping.

Two settings let a build install and start, then fail on the headset, with no console to tell you.
With the Android target active, *Window → Colibri Configuration* has an **Android / Meta Quest**
section with a button that fixes each, and the console warns about them too:

- **Internet Access** has to be *Require*. On *Auto* the app may be built without network
  permission, and never connects.
- **Allow downloads over HTTP** has to let plain HTTP through (the button sets *Always allowed*)
  unless your server uses SSL. Otherwise every `Store` call fails on the headset with "Insecure
  connection not allowed".

The window cannot check two more:

- **The server address has to be reachable from the headset**: its IP address or host name on your
  network. `localhost` on a headset is the headset itself.
- ***Run In Background* has no effect on Android.** While the app is paused none of your scripts
  run, so nothing is sent or delivered until it resumes.

## The samples

*Window → Package Manager → Colibri → Samples → Import* copies a sample into `Assets/Samples/`,
yours to edit. None is in your project until you import it.

| Sample | Shows |
| --- | --- |
| **SendData** | `Sync.Send` and `Sync.Receive` for every supported type |
| **SyncTransform** | Objects following each other, including spawning from a template |
| **SyncBehaviour** | `[Sync]` on your own class |
| **Remote Store** | Saving and loading data on the server |
| **Voice Chat** | Talking to the other clients |
| **Network Stress** | Putting Colibri under load and measuring throughput, latency and dropped messages |

SendData, SyncTransform, Remote Store and Voice Chat show their instructions as TextMeshPro text,
invisible without the *TMP Essential Resources*. Unity usually offers them when you first open such
a scene; if not, use *Window → TextMeshPro → Import TMP Essential Resources* (on Unity 2022.3,
install the *TextMeshPro* package first if that menu is missing).

The `[RemoteLogger]` and `[SyncTransformManager]` prefabs are *not* samples: they are always in
`Packages/Colibri/Prefabs/`.

## Talking to a browser

A web page can join the same app as your Unity clients (the web client needs TypeScript 5 or
newer):

```sh
npm install @hcikn/colibri@^2
```

The `@^2` matters: a 2.0 server refuses a 1.x web client, which connects once, then goes quiet
with no error.

```ts
import { Colibri, Sync } from '@hcikn/colibri';

new Colibri('your-app-name', 'your-server-address');

Sync.sendNumber('Temperature', 21.5);
Sync.receiveNumber('Temperature', value => console.log(value));
```

The server address can be:

- the host, `'192.168.0.10'`,
- host and port, `'192.168.0.10:9011'`,
- or the `http://<your-server>:9011` you open to see the log; `https://…` only if your server is
  reached over HTTPS.

Without a port it is 9011. Anything after the host and port, such as a path (`/log`) or a query,
is refused with a `ColibriError`.

Same app name, channel names and rules, with two differences:

- **Vectors and colours are plain arrays**: `Sync.sendVector3('pos', [1, 2, 3])`,
  `Sync.sendColor('tint', [1, 0, 0, 1])`. So a colour reaches a web listener as `"#RRGGBBAA"` from
  Unity but as `[r, g, b, a]` from another web client; `toHexColor()` or `toRgbaColor()` gives one
  form either way. (Unity's `ToColor` takes both.)
- **JavaScript has one number type.** A `5` from a web client reaches Unity as a `float`: listen
  with `Sync.Receive<float>`, not `int`.

## When nothing happens

**Open *Window → Colibri Status* while the game runs.** It shows the connection, the server, **the
app name**, the channels with listeners and their types, and the latest messages in and out.

| What you see | What it usually is |
| --- | --- |
| Two clients ignore each other, both connected | Different app names. Compare them in the Status window. |
| Objects or messages you did not create show up | Another project on the server uses your app name. Pick one nobody else uses. |
| Works in the Editor, nothing happens on the Quest | [Building for Meta Quest](#building-for-meta-quest): Internet Access, plain HTTP, the server address. |
| A message never arrives, no errors | The listener expects a different type than was sent. The console names both. |
| One client goes quiet when you click away | *Run In Background* is off on that client. |
| Nothing connects at all | Console says `Colibri is not configured yet`. Set an app name in *Window → Colibri Configuration*. |
| Status window says *did not answer within 5 s* | Wrong server address, or this device is on another network than the server. |
| Status window says *ended before a single frame could be read* | The server runs Colibri 1.x (this client needs 2.0 or newer), or the TCP port is not Colibri's. |
| A `[Sync]` field never syncs | Its type is not one Colibri can send. The console says so when the game starts. |
| `Store.Get` or `Put` fails | The log names the object, the URL and the HTTP status. Usually the server address. |

Console empty, and the Status window says *Connected* with the right app name? Then the message is
sent, and the problem is at the receiving end: nearly always the channel name or the type.

## Rules of thumb

1. **Same app name everywhere, and one nobody else uses.** Check it in the Status window first.
2. **Register listeners in `Start`, before anyone sends.**
3. **One client owns each object.**
4. **Watch the console.** Colibri reports the common mistakes by name instead of failing quietly.

Next: [colibri-unity/README.md](../colibri-unity/README.md) for everything else about the Unity
client, [colibri-web/README.md](../colibri-web/README.md) for the web client, and
[MIGRATION.md](../MIGRATION.md) for upgrading a project from Colibri 1.x.
