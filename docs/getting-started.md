# Getting started with Colibri

## Prerequisites

- Unity 2022.3 or newer
- A colibri-server 2.x, [self-hosted](../colibri-server/README.md#installation) or shared. Colibri
  Unity 2.x cannot connect to a 1.x server.

## Installation

In *Window → Package Manager → + → Install package from git URL*, enter:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

The Package Manager must list **Colibri 2.0.0** or newer. Version 1.x requires UniRx and UniTask
and cannot connect to a 2.x server. Remove it and install again with a
[release tag](https://github.com/hcigroupkonstanz/Colibri/releases) appended to the URL, e.g.
`#v2.0.0`.

## Configuration

The configuration window opens after installation. Reopen it with *Window → Colibri
Configuration*. Set **Server Address** and **App Name**, then click *Save Config*.

- **Server Address** is a host name or IP address without `http://`. The preset public test server
  `colibri.hci.uni-konstanz.de` works only while it runs colibri-server 2.x.
- **App Name** must be identical on all clients that exchange data. A mismatch is the most common
  reason why two connected clients do not see each other.
- Use an app name that no other project on the server uses, e.g. `museum-ar-prototype` instead of
  `test`. Projects with the same name share one app and receive each other's objects and messages.

Enable *Project Settings → Player → Resolution and Presentation → **Run In Background***. Otherwise
the Editor pauses the game when its window loses focus. The status stays *Connected*, but nothing
is sent or delivered until `Update` runs again. With two clients on one machine, one is always in
the background.

## Sending messages

```csharp
using HCIKonstanz.Colibri.Synchronization;

// Sender
Sync.Send("Temperature", 21.5f);

// Receiver
private void Start() => Sync.Receive<float>("Temperature", OnTemperature);
private void OnTemperature(float value) => Debug.Log($"Temperature: {value}");
```

- Channel and type must match. A `float` sent on `"Temperature"` does not reach a `string`
  listener. The console logs the mismatch.
- Register listeners before anything is sent. A message without a listener is dropped and not
  replayed.
- A client does not receive its own messages. To test, run a second client, either a build of the
  scene next to the Editor or a copy of the project's `Assets`, `Packages` and `ProjectSettings`
  folders opened from Unity Hub. Unity does not open the same project twice.
- A listener that is a method of your component, or a lambda that uses its members, is removed
  with the component. A static method, or a lambda that uses only its parameter or static members,
  stays registered until `Sync.Unregister`. Registering the same listener twice has no effect.
- `Sync.Unregister<float>("Temperature", OnTemperature)` stops listening earlier.

### Supported types

`bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color` and arrays of these.
Send other data, such as an instance of your own class `Reading`, as JSON:

```csharp
using Newtonsoft.Json.Linq;

Sync.Send("Readings", JToken.FromObject(new Reading { Sensor = "left", Value = 7 }));
Sync.Receive<JToken>("Readings", token => Debug.Log(token.ToObject<Reading>().Sensor));
```

## Synchronizing transforms

Add the **`SyncTransform`** component to a GameObject. Its position, rotation, scale and active
state are synchronized with all other clients.

- Clients that join later receive the current state while at least one client of the app is
  connected. When the last client leaves, the server discards it. Use the
  [Store](#storing-data-on-the-server) for data that must persist.
- `SyncPosition`, `SyncRotation`, `SyncScale` and `SyncActive` select the synchronized values.
  Turning one off saves little traffic, because only changes are sent. It prevents this client
  from sending or applying that value, so it cannot overwrite another client's changes.
- Destroying a synchronized object or unloading its scene deletes it on all clients. Leaving Play
  mode or quitting does not.
- For objects instantiated at runtime, add the **`[SyncTransformManager]`** prefab from
  `Packages/Colibri/Prefabs/` to the scene and set its `Template` to the object's prefab. The other
  clients create their copies from this template.
- Only one client should move an object at a time. Concurrent updates from two clients make it
  jitter.

## Synchronizing your own data

Derive from `SyncBehaviour<T>`, where `T` is the class itself, and mark synchronized members with
`[Sync]`:

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

Add `PlayerManager` to the scene and set its `Template` to a `Player` prefab. `Score = 10` on one
client then sets `Score` on all clients, and a `Player` created on any client appears on all of
them.

- `[Sync]` works on public and private fields and properties of the
  [supported types](#supported-types). Use a `JObject` for your own classes.
- Only changed members are sent. Assigning an unchanged value every frame costs nothing.
- To use `Awake` or `OnDestroy`, declare them `protected override` and call the base method. A
  plain `void Awake()` compiles with warning CS0114, but the object never syncs.

## Storing data on the server

`Store` saves values on the server. They persist after all clients disconnect.

```csharp
using HCIKonstanz.Colibri.Store;

await Store.Put("highscores", myScores);
var scores = await Store.Get<ScoreTable>("highscores");
```

- Any value Json.NET can serialize works, including plain numbers and strings, up to 5 MiB.
- If the server is unreachable, the call fails after 10 s. The console logs the error and the URL.
- There is no access control. Anyone who can reach the server can read, change and delete stored
  data. Do not store personal data, such as recordings of study participants.

## Remote logging

Add the **`[RemoteLogger]`** prefab from `Packages/Colibri/Prefabs/` to the scene. `Debug.Log`
output then appears at `http://<your-server>:9011`, also from headsets and phones.

## Meta Quest

Switch the platform to Android in *File → Build Settings* (*File → Build Profiles* in Unity 6).
Quest builds use IL2CPP and ARM64 (*Project Settings → Player → Other Settings*). Colibri supports
both, and `[Sync]` members survive code stripping.

With the Android target active, *Window → Colibri Configuration* checks two Player settings and
offers a fix for each. The console warns about them too. With a wrong value, the build installs and
starts but fails on the headset:

- **Internet Access** must be *Require*. With *Auto*, the app may lack the network permission and
  never connects.
- **Allow downloads over HTTP** must be *Always allowed* unless the server uses TLS. Otherwise
  `Store` calls fail with "Insecure connection not allowed".

Not checked by the window:

- The server address must be reachable from the headset. On a headset, `localhost` is the headset.
- *Run In Background* has no effect on Android. While the app is paused, nothing is sent or
  delivered.

## Samples

*Window → Package Manager → Colibri → Samples → Import* copies a sample into `Assets/Samples/` for
editing.

| Sample | Content |
| --- | --- |
| **SendData** | `Sync.Send` and `Sync.Receive` for every supported type |
| **SyncTransform** | Synchronized transforms, including instantiation from a template |
| **SyncBehaviour** | `[Sync]` on your own class |
| **Remote Store** | Saving and loading data on the server |
| **Voice Chat** | Voice chat between clients |
| **Network Stress** | Load test measuring throughput, latency and dropped messages |

SendData, SyncTransform, Remote Store and Voice Chat need the *TMP Essential Resources*. If Unity
does not offer to import them, use *Window → TextMeshPro → Import TMP Essential Resources*. On
Unity 2022.3, install the *TextMeshPro* package first if the menu is missing.

## Web client

Web clients join the same apps as Unity clients. The web client requires TypeScript 5 or newer.

```sh
npm install @hcikn/colibri@^2
```

Keep the `@^2`. A 2.x server refuses 1.x web clients, which connect once and then stop without an
error.

```ts
import { Colibri, Sync } from '@hcikn/colibri';

new Colibri('your-app-name', 'your-server-address');

Sync.sendNumber('Temperature', 21.5);
Sync.receiveNumber('Temperature', value => console.log(value));
```

The server address is a host (`'192.168.0.10'`), a host and port (`'192.168.0.10:9011'`) or a URL
(`'http://192.168.0.10:9011'`). Use `https://` only for a server with TLS. The default port is 9011.
A path such as `/log` or a query throws a `ColibriError`.

App names, channels and the rules above are the same. Differences from Unity:

- Vectors and colours are arrays: `Sync.sendVector3('pos', [1, 2, 3])`,
  `Sync.sendColor('tint', [1, 0, 0, 1])`. A colour arrives as `"#RRGGBBAA"` from Unity and as
  `[r, g, b, a]` from web clients. `toHexColor()` and `toRgbaColor()` accept both forms, and so does
  Unity's `ToColor`.
- JavaScript has one number type. Numbers from web clients arrive in Unity as `float`. Receive them
  with `Sync.Receive<float>`, not `Sync.Receive<int>`.

## TLS

If the network blocks unencrypted TCP, enable [TLS](../colibri-server/docs/guide.md#tls) on the
server with `TLS_CERT` and `TLS_KEY`. In *Window → Colibri Configuration*, tick *Server supports
SSL/TLS?* under *Optional Config*. For a self-signed certificate, also paste the fingerprint from
the server log into *Server certificate SHA-256*, which appears once TLS is ticked. Web clients
connect to `https://<your-server>:9011`.

## Troubleshooting

Open *Window → Colibri Status* while the game runs. It shows the connection, server, app name,
channels with listeners and their types, and recent messages.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Two connected clients do not see each other | Different app names | Compare the app names in the Status window |
| Objects or messages you did not create | Another project uses your app name | Choose an app name nobody else uses |
| Works in the Editor, not on the Quest | Android Player settings or server address | See [Meta Quest](#meta-quest) |
| A message never arrives | The listener expects a different type | Use the same type. The console names both types. |
| One client stops when its window loses focus | *Run In Background* is off | Enable it on that client |
| `Colibri is not configured yet` | No app name | Set one in *Window → Colibri Configuration* |
| Status: *did not answer within 5 s* | Wrong server address, or the device is on another network | Check the address and the network |
| Status: *ended before a single frame could be read* | The server runs Colibri 1.x, or the port is not Colibri's | Use colibri-server 2.x and check the TCP port |
| A `[Sync]` field never syncs | Unsupported type | Check the console at startup |
| `Store.Get` or `Store.Put` fails | Usually the server address | Check the URL and HTTP status in the log |

If the console is empty and the Status window shows *Connected* with the correct app name, the
message was sent. Check the channel name and type on the receiving client.

## Next steps

- [Unity guide](../colibri-unity/docs/guide.md)
- [Web guide](../colibri-web/docs/guide.md)
- [MIGRATION.md](../MIGRATION.md) for projects on Colibri 1.x
