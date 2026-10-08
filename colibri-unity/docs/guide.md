# Colibri Unity guide

Everything about the Colibri Unity package in one place: every option, limit and console message.
For installing it and getting two clients to talk, the [README](../README.md) is enough.

## Contents

- Setting up
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Quickstart](#quickstart)
  - [Configuration](#configuration)
  - [Meta Quest and Android](#meta-quest-and-android)
  - [Samples](#samples)
  - [Troubleshooting](#troubleshooting)
- Using Colibri
  - [Sending Data between Clients](#sending-data-between-clients)
  - [SyncTransform](#synctransform)
  - [SyncBehaviour](#syncbehaviour)
  - [How often synced objects send](#how-often-synced-objects-send)
  - [Remote Store](#remote-store)
  - [Connection and outages](#connection-and-outages)
  - [Web Interface for Logging](#web-interface-for-logging)
  - [Voice Chat](#voice-chat)
- [Other documents](#other-documents)
- [For maintainers](#for-maintainers)

## Requirements

- Unity 2022.3 LTS or higher
- **colibri-server 2.0.0 or higher.** Colibri Unity 2.0.0 speaks the [v3 binary TCP
  protocol](../../colibri-server/docs/protocol.md) and **cannot talk to a 1.x server**: there is no
  version negotiation, both sides have to be upgraded together. Colibri Unity 1.x likewise cannot
  talk to a 2.0.0 server. What a mismatch looks like depends on which side is old:
  - **This package against a 1.x server.** Neither side can read the other's framing, so no
    refusal can be sent. After three connections in a row that end before the server has sent
    anything this client can read, the console reports a *suspected* protocol mismatch and
    `Window → Colibri Status` shows it as a yellow warning. The client keeps retrying, waiting
    longer each time (up to 10 s), because the same symptom also fits an address that is not a
    Colibri server at all.
  - **Colibri Unity 1.x against a 2.0.0 server.** The old client cannot be told either. The
    server's log names the client's address and says it looks like a Colibri 1.x client.
  - **Same framing, different protocol version** (a future server). The server refuses the
    connection and says why, `Window → Colibri Status` shows the refusal in red, and the client
    stops reconnecting: `Status` becomes `ConnectionStatus.ProtocolMismatch`.

## Installation

One URL. In Unity, open *Window → Package Manager → + → Install package from git URL* and paste:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

The Package Manager should then list **Colibri 2.0.0** or newer. Errors about UniRx or UniTask mean
it installed a Colibri 1.x, which could not talk to a 2.x server anyway. To stay on one exact
version, append a release tag from the [Releases
page](https://github.com/hcigroupkonstanz/Colibri/releases) to the URL, e.g. `#v2.0.0`.
The Package Manager also records the commit it installed, so a project only moves to a newer
Colibri when you update it there.

Colibri's only dependency is `com.unity.nuget.newtonsoft-json`, which the Package Manager
installs by itself.

### UnityPackage

Alternatively, import the `.unitypackage` attached to the 2.0.0 release on the [Releases page](https://github.com/hcigroupkonstanz/Colibri/releases). Check the version number: a Colibri 1.x release cannot talk to a 2.x server. Installed this way, Newtonsoft JSON has to be added by hand from the Package Manager (`com.unity.nuget.newtonsoft-json`): a `.unitypackage` cannot declare dependencies.

## Quickstart

1. Install Colibri (above). A configuration window opens on its own.
2. Enter an **App Name** (every client that should see each other has to use the *same* one, and
   nobody else on the server should use it) and the **Server Address** of your colibri-server,
   then press *Save Config*. The window warns about names many people pick, such as `test` or
   `myAppName`. The server can be a shared colibri-server 2.x instance or one you run yourself
   ([Docker setup](../../colibri-server/README.md#docker-recommended)). The address is preset to the
   public test server `colibri.hci.uni-konstanz.de`, which this package can only use while it runs
   colibri-server 2.x: against a 1.x server, *Window → Colibri Status* reports a suspected protocol
   mismatch (see [Requirements](#requirements)).
3. Import the **SendData** sample: *Window → Package Manager → Colibri → Samples → Import*.
4. Open the sample scene and press Play. Tick `SendProperties` on the `SendMessages` object and
   watch the console. (The scene needs TextMeshPro's essential resources; see
   [Samples](#samples).)
5. Turn on *Project Settings → Player → Resolution and Presentation → **Run In Background***.
   Unity leaves this off by default, and with it off the Editor stops running your game the
   moment its window loses focus. The connection stays up and the status window still says
   *Connected*, but nothing is sent and nothing that arrived is delivered, because none of that
   happens until `Update` runs again. It is the single most confusing way for two clients on one
   machine to appear broken. (Unity ignores this setting on Android, so it does not matter for
   the Quest build itself.)
6. To see two clients talk to each other, build the scene and run the build alongside the Editor, or
   open the project a second time from the Unity Hub.

Stuck? Open **Window → Colibri Status**. It shows whether you are connected, which app name you
are connected as, which channels have listeners, and the last messages in and out.

## Configuration

Upon installation, a configuration window should show up:

<img src="../img/config.png" alt="Config Screen" width=400/>

- Enter the address of your (shared) [server](../../colibri-server): a host name or an IP address, without `http://`. The preset is the public test server `colibri.hci.uni-konstanz.de`, which this package can only use while it runs colibri-server 2.x (see [Requirements](#requirements)). Otherwise run your own colibri-server 2.x, or connect to another 2.x instance you have access to.
- On a headset or phone, `localhost` is the device itself. Enter the IPv4 address of the machine running the server on your local network instead.
- Choose a unique *app name*. Though a server supports multiple clients, data is only synchronized between clients with identical *app names*!
- Unique means that nobody else on the server uses it. Everyone with the same app name is in one app: they see each other's objects and messages, and since every update goes to every other client in the app, the server's work grows with the square of their number. The window warns about names many people use: `myAppName`, which the web client's samples use, and names such as `test`, `demo`, `app` or `colibri`.
- To adjust the Colibri Configuration you can reopen the window in Unity under "Window" -> "Colibri Configuration" 
- All changes are saved to `Resources/ColibriConfig`

### Advanced Configuration

If your server is running a non-default configuration, the advanced configuration allows you to modify server ports.
The ports must match the server's, so change them only if the server does not use the defaults.

The Remote Store talks to the server over REST. With the `SSL/TLS` toggle off those requests go
out as plain `http`, and Unity blocks cleartext HTTP by default. **Loopback is exempt**, so a
server on `localhost` needs no change at all; this only comes up once the server is a real
remote host that is not on HTTPS (and from a headset, every server is a remote host). In that case
set *Project Settings → Player → Other Settings → **Allow downloads over HTTP*** to *Always
allowed*, or put the server behind HTTPS and turn `SSL/TLS` back on. With the Android target
active, Colibri checks this for you (see [Meta Quest and Android](#meta-quest-and-android)).

When using the voice chat, Colibri allows to adjust the sampling rate on the server. In this case, clients need to manually set the `Voice Sampling Rate` setting in the configuration.

`Max Send Rate (Hz)` caps how many updates per second each synced object sends (see [How often synced objects send](#how-often-synced-objects-send)).

Default values:

- Web server Port: `9011`
- TCP server Port: `9012`
- Voice server Port: `9013`
- Voice Sampling Rate: `48000`
- Max Send Rate: `30` (updates per second per synced object; `0` = no limit)

## Meta Quest and Android

A Meta Quest app is an Android build: switch the platform to Android under *File → Build
Settings* (*File → Build Profiles* on Unity 6). Quest needs the ARM64 architecture, which on
Android requires the IL2CPP scripting backend.

With the Android target active, Colibri checks two Player settings that otherwise only fail on the
headset, where there is no console to say why. It warns in the console after every script reload,
and *Window → Colibri Configuration* lists the problems in an **Android / Meta Quest** section, each
with a button that fixes it:

- **Internet Access** must be *Require* (*Player → Other Settings*). Colibri connects with plain
  sockets, and with *Auto* the build may lack Android's INTERNET permission: the app starts and
  never connects.
- **Allow downloads over HTTP** must be *Always allowed* while the `SSL/TLS` toggle is off and the
  server is not `localhost`. Otherwise every `Store` call fails with "Insecure connection not
  allowed".

Also worth knowing:

- **Server address.** On the headset, `localhost` is the headset. Enter the IPv4 address of the
  machine running the server on your local network; voice chat only works over IPv4 anyway. A
  headset that cannot reach that address keeps retrying, and
  `WebServerConnection.Instance.LastConnectFailure` says why, for example `… did not answer within
  5 s` (see [Troubleshooting](#troubleshooting)).
- **Run In Background** has no effect on Android.
- **Managed code stripping.** `[Sync]` members are kept by Unity's managed code stripping on
  their own. Your own classes that only Newtonsoft JSON touches (sent with `JToken.FromObject`, read
  with `ToObject<T>`, or saved with `Store`) are only reached through reflection, so
  stripping may remove their members once *Managed Stripping Level* is above *Minimal*. Keep it
  at *Minimal*, or preserve those classes yourself with `[Preserve]` or a `link.xml`.
- **`[Sync]` fields on IL2CPP.** A `[Sync]` property is read through a direct delegate, but a
  `[Sync]` field is read through reflection, which allocates for a value type (`int`, `float`,
  `Vector3`, …) every frame. With many synced objects, make such members properties.
  `SyncTransform` only uses properties.

## Samples

Samples live in the `Samples` tab of the Package Manager: select Colibri, then *Samples →
Import*. Importing copies a sample into `Assets/Samples/Colibri/`, which is yours to edit. The
package's own copy is not compiled into your project until you import it, so nothing you never
asked for ends up in your build.

The `Remote Store`, `SendData`, `SyncTransform` and `Voice Chat` sample scenes show their
instructions with **TextMeshPro**, which Colibri does not install for you. Without TextMeshPro's
essential resources, the instructions text throws a `NullReferenceException` in
`TMP_Settings`. Before opening one of those scenes:

- **Unity 2022.3:** install *TextMeshPro* (`com.unity.textmeshpro`) from the Package Manager if
  the project does not have it yet, then run *Window → TextMeshPro → Import TMP Essential
  Resources*.
- **Unity 6:** TextMeshPro is part of `com.unity.ugui`, so only the import is needed: *Window →
  TextMeshPro → Import TMP Essential Resources*.

The `[RemoteLogger]` and `[SyncTransformManager]` prefabs are **not** samples: they are part of
the package proper. Drag them straight out of `Packages/Colibri/Prefabs/` in the Project window.

## Troubleshooting

Open **Window → Colibri Status** while the game is running. It shows, at a glance:

- whether you are connected, to which server, and **as which app name** (a typo there gives a
  perfectly healthy connection on which no other client is ever seen)
- whether the server's heartbeat is still arriving, and how long the silence has been if not
- while not connected, why the last attempt failed
- every channel that has listeners, and the type each one expects
- the last 20 messages sent and received

Colibri also reports the common mistakes in the console rather than failing quietly:

| Symptom | What Colibri tells you |
|---|---|
| Nothing arrives, no errors | `a float arrived on channel 'chat', but the listener registered there expects string…`: the channel *and* the type have to match |
| Nothing connects, no errors | `Colibri is not configured yet. Open Window → Colibri Configuration…` |
| Never connects, and nothing answers at all | `Colibri: 192.168.0.10:9012 did not answer within 5 s. Check the server address, and that this device is on the same network as the server.` A wrong IP, a server on another network or subnet, a Wi-Fi with client isolation, or a firewall dropping the packets: fix the address or the network |
| Never connects, and the connection is refused | `Colibri: connection to 192.168.0.10 failed (ConnectionRefused), retrying...` The machine is reachable, but nothing listens on that TCP port: start colibri-server, or check the *TCP server Port* |
| Two clients don't see each other | The connect log names the app name in use; both clients must show the same one |
| Objects or messages you did not create show up | Nothing in Unity at runtime: someone else uses the same app name. *Window → Colibri Configuration* warns when it is a name many people use, such as `myAppName` or `test`, and the server's log warns, naming the app, once it has more than 8 clients (by default) |
| A `[Sync]` field never syncs | Its type is reported at startup if Colibri cannot put it on the wire |
| Connected, but one client is silent | That client's Editor window is in the background and *Run In Background* is off (see step 5 of the Quickstart) |
| `Store.Get`/`Put` reports a failure | The log names the operation, the object, the URL, the transport error and the HTTP status; requests give up after 10 s rather than hanging |
| Never connects, although something answers on the port | `invalid frame from server` errors if the server sends anything, then `3 connections in a row were accepted but ended before a single frame could be read. This usually means a protocol mismatch…`: the server is probably 1.x, or the address is not a colibri-server |
| Works in the Editor, not on the Quest | With the Android target active: `Colibri (Android build): …` in the console, and the *Android / Meta Quest* section of *Window → Colibri Configuration* |

Other failures to connect name their socket error the same way, such as `failed (HostUnreachable)`
or `failed (NetworkUnreachable)`; like the timeout, they point at the address or the network.

On a headset there is no Status window, and while it is not connected the `[RemoteLogger]` cannot
forward the console either. For a status display in your app,
`WebServerConnection.Instance.LastConnectFailure` holds why the last attempt to connect failed (such
as the timeout or the refusal above) and is `null` once a connection has opened.

## Sending Data between Clients

Colibri supports simple data transmission via pub/sub communication. Data can be published from anywhere in
the executed code, as illustrated with the following simple example of sending a float value `myNumber` on a `MyChannel` channel:

```c#
float myNumber = 5;
Sync.Send("MyChannel", myNumber);
```

The sent data can then be received anywhere within Unity by registering a listener. Name the type
you expect in the angle brackets:

```c#
void Start() {
    Sync.Receive<float>("MyChannel", MyListener);
}

private void MyListener(float myNumber) {
    // This code that will be executed whenever
    // a float is received on "MyChannel"
}
```

There is no matching cleanup call to remember. A listener registered by a `MonoBehaviour`, as a
method or as a lambda written inside it, is dropped automatically once that component or its
GameObject is destroyed, so a destroyed object never gets called and never throws
`MissingReferenceException` out of the middle of Colibri's message loop.

`Sync.Unregister` is still there for when you want to stop listening while the object lives on:

```c#
private void OnMenuClosed() {
    Sync.Unregister<float>("MyChannel", MyListener);
}
```

It is also the only way to remove a listener that is a `static` method, or that belongs to a plain
C# object rather than a Unity one: neither has a lifetime Colibri can follow.

The following types (including arrays) are available for sync: 
- `bool`
- `int`
- `float`
- `string`
- `Vector2`
- `Vector3`
- `Quaternion`
- `Color`

For custom types, Colibri supports JSON (via Newtonsoft.JSON): 

```c#
Sync.Send("myJson", new JObject
{
    { "attribute1", "example" },
    { "attribute2", 5 }
});

Sync.Receive<JToken>("myJson", MyListener);

private void MyListener(JToken jtoken) {
    string attribute1 = jtoken["attribute1"].Value<string>(); 
    int attribute2 = jtoken["attribute2"].Value<int>();
}
```

Your own classes can be serialized and deserialized automatically (by Newtonsoft JSON, so `[Serializable]` is optional):

```c#
using System;

[Serializable]
public class ExampleClass
{
    public int Id;
    public string Name;
}
```

```c#
ExampleClass exampleObject = new ExampleClass();
exampleObject.Id = 1234;
exampleObject.Name = "Charly Sharp";

Sync.Send("example", JToken.FromObject(exampleObject));
```

```c#
Sync.Receive<JToken>("example", MyListener);

private void MyListener(JToken jtoken) {
    ExampleClass exampleObject = jtoken.ToObject<ExampleClass>();
}
```

Unity's own types need Colibri's help: Newtonsoft on its own cannot convert a `Vector3`,
`Quaternion` or `Color` inside your class, so a plain `JToken.FromObject` throws a
`JsonSerializationException` (for a `Vector3`: `Self referencing loop detected for property
'normalized'`). Pass `ColibriJson.Serializer`, which converts a `Vector2`, `Vector3`, `Vector4`,
`Quaternion` or `Color` to an array of its components and back:

```c#
using HCIKonstanz.Colibri.Synchronization; // ColibriJson

Sync.Send("example", JToken.FromObject(exampleObject, ColibriJson.Serializer));

private void MyListener(JToken jtoken) {
    ExampleClass exampleObject = jtoken.ToObject<ExampleClass>(ColibriJson.Serializer);
}
```

Or build the `JObject` yourself with Colibri's conversions:

```c#
using HCIKonstanz.Colibri.Synchronization; // ToJson(), ToVector3(), ToQuaternion(), ToColor()

Sync.Send("spawn", new JObject
{
    { "Id", 1234 },
    { "Position", transform.position.ToJson() }
});

private void OnSpawn(JToken jtoken) {
    Vector3 position = jtoken["Position"].ToVector3();
}
```

Sending a `Vector3`, `Quaternion` or `Color` on its own, and a `[Sync]` member of one of these
types, is not affected: Colibri converts those itself.

Limitations:

- You have to register the listener *before* sending out data
- Type and channel *must* match between listener and sender. If they don't, Colibri says so in the
  console, naming the channel, both types, and how to fix it.



## SyncTransform

For synchronizing the location of an object, Colibri provides a `SyncTransform` script. Simply attach the script to an object, and its active state, position, rotation, and scale will be synchronized between all clients. Set `UseLocalTransform` to `true` to synchronize the local coordinates of the object. See SyncTransform samples for more information.

Information about the object's state is stored on the server. When a new client connects, the location is automatically updated to its current state.

A moving object sends at most 30 updates a second by default (see [How often synced objects send](#how-often-synced-objects-send)).

Showing, hiding and deleting:

- Deactivating the GameObject (`SetActive(false)`) hides its copies on the other clients, and reactivating it shows them again. Only the object's own active flag (`activeSelf`) is synced: deactivating a parent changes nothing elsewhere. Turn `SyncActive` off to keep the active state local.
- Disabling only the `SyncTransform` component pauses its syncing without hiding anything. Changes made meanwhile are sent once it is enabled again.
- Destroying the object, or unloading its scene (including loading another scene in its place), deletes it on the server and on every client. It stays deleted: an update another client sent just before the delete reached it is ignored, by the server and by this client, and does not bring it back.
- Loading the scene again, on this client or any other, lets its placed objects sync again, between every client that loads the scene from then on: the server no longer treats them as deleted. A client that still had the scene open lost its copies with the delete. It gets them back only by loading the scene again, or from a manager with a `Template` for them, which builds them from the next update.
- Leaving Play mode, quitting the app, or the app being killed deletes nothing, whether the object is shown or hidden. It stays on the server for the other clients, until the app's last client disconnects (see [Connection and outages](#connection-and-outages)).

`SyncTransform` also supports physics. `PhysicsAuthority` defines which client is currently controlling the physics. Only one client can control the physics of an object at a time. If the `PhysicsAuthority` is set to `true` on one client it is automatically set to `false` on all other clients. If the `PhysicsAuthority` is checked by default, the first client receives the physics authority. The `isKinematic` field of the attached `Rigidbody` will be overwritten by the `isKinematic` field of the `SyncTransform`. Therefore, if you want to change this field, always (additionally) set the `isKinematic` field of the `SyncTransform`.

For dynamically created objects, add a `[SyncTransformManager]` prefab to the scene. Create a prefab of the object you'll dynamically instantiate and add it to the `Template` attribute. Set the `ModelId` (in the `SyncTransform`) of the prefab to a custom value that identifies the prefab. When a client instantiates an object with `SyncTransform` and the same `ModelId`, the Manager will automatically create an object using this prefab and synchronize it. Make sure to leave the `Id` field of the prefab blank! Instead of a prefab, the `Template` can also be an object in the scene that you keep switched off (see [SyncBehaviour](#syncbehaviour)).

<img src="../img/synctransformmanager.png" alt="SyncTransformManager" width=400/>

Limitations:

- Only one client can update each attribute of the object simultaneously
- Scene will be reset once all clients disconnect

## SyncBehaviour

For more complex scenarios, Colibri supports synchronization of data models (e.g., for use in model-view-controller architectures). For this, we need a model script and a manager script.

The model script has to inherit from `SyncBehaviour<T>` instead of `MonoBehaviour`. Afterward, just add `[Sync]` to the property or field you want to synchronize:

```c#
public class MyClass : SyncBehaviour<MyClass>
{
    [Sync]
    public string MyString = "123";

    [Sync]
    private Vector3 Position
    {
        get { return transform.localPosition; }
        set { transform.localPosition = value; }
    }
}
```

The manager just requires a declaration matching the model script:

```c#
public class MyClassManager : SyncBehaviourManager<MyClass>
{
    // No code necessary: just add this script
    // to your scene (e.g., on an empty GameObject)
}
```

The manager should be added to your scene (e.g., on an empty GameObject), and the manager requires a Prefab with the model script for synchronizing different objects. 

The manager's `Template` can be a prefab, or an object in the scene that you keep switched off (an
active one would also be synced as an object in its own right). Every copy the manager builds is
switched on, so its scripts run `Awake`, and then takes the synced state. A `SyncTransform` copy of
an object that is hidden elsewhere is therefore switched off again at once, and shown as soon as
the original is.

By the way: `SyncTransform` is also a `SyncBehaviour`. What it says above about disabling, destroying and quitting applies to every `SyncBehaviour`; only the active state is specific to `SyncTransform`.

`Awake` and `OnDestroy` are where a `SyncBehaviour` registers and unregisters itself. If you need them in your model script, override them and call the base method:

```c#
protected override void Awake()
{
    base.Awake();
    // your code
}
```

Limitations:

- Only one client can update each attribute of the object simultaneously
- Scene will be reset once all clients disconnect

## How often synced objects send

A synced object (a `SyncTransform` or any other `SyncBehaviour`) sends at most **30 updates a
second** by default, however fast the app runs. A headset renders 72 to 120 frames a second, and
without a limit every moving object sends that many messages: dozens of headsets, each moving a
few objects, produce more traffic than one server and one Wi-Fi network can keep up with.

What the limit holds back, and what it does not:

- A single change goes out in the frame it is made, as without a limit.
- Changes that come quicker are collected, and their latest values go out together as soon as the
  interval (1/30 s) is up, even if nothing changes afterwards. The values in between are never sent:
  a synced object shares its current state, not every step on the way there, so a `[Sync]`
  setter on another client does not see every value either. Use `Sync.Send` for events that must
  each arrive.
- Switching the object off or on (`SetActive`) sends whatever is waiting at once; for a
  `SyncTransform`, that includes being hidden or shown.
- Destroying the object sends its delete at once; a change still waiting is dropped with it.
- When the app pauses or loses focus (on a Quest: taking the headset off, opening the system
  menu, leaving the app), whatever is waiting goes out at once. When the app quits or Play mode
  ends it is sent too, but only as a best effort, because the connection closes in the same
  teardown.
- A value that arrives from another client replaces a local change of the same member that has
  not gone out yet, so every copy ends up with the same value.

Change the limit under *Optional Config → Max Send Rate (Hz)* in *Window → Colibri
Configuration*, or from code while the app runs:

```c#
using HCIKonstanz.Colibri.Synchronization;

SyncSettings.MaxSendRate = 60; // updates per second per synced object; 0 = no limit
```

Set from code, it applies to this run of the app only (in the Editor: this Play session) and leaves
the configuration alone; a negative value throws an `ArgumentOutOfRangeException`. `0` turns the
limit off (an update in every frame in which something changed, as in Colibri 1.x) and the
configuration window warns about it. A configuration saved before this setting existed uses 30.

## Remote Store

Colibri offers persistent data storage on the server, so that data can be saved easily between sessions. Anything Newtonsoft JSON can serialize, such as an object of your own class (with `Vector3`, `Quaternion` or `Color` fields in it too), a list, or a plain number or string, can be uploaded via a RESTful interface of the `Store` object, up to 5 MiB of JSON per name. Data is kept per *app name*:

```c#
// Create example object
ExampleClass exampleObject = new ExampleClass();
exampleObject.Id = 1234;
exampleObject.Name = "Charly Sharp";

// Save example object using REST API
bool putSuccess = await Store.Put("exampleObject", exampleObject);
Debug.Log($"Success: {putSuccess}");
```

or retrieved again:

```c#
ExampleClass exampleObject = await Store.Get<ExampleClass>("exampleObject");
if (exampleObject != null)
{
    // Use fetched "exampleObject"
}
else
{
    Debug.LogError("Get Example Object failed!");
}
```

`await Store.Delete("exampleObject")` removes it again.

Limitations:

- Data fetching happens manually (data won’t be automatically updated!)
- Values are converted with Newtonsoft JSON, which saves the public fields and properties of your class; `[Serializable]` is not needed, and a private `[SerializeField]` field is not saved
- A `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Color` inside your class is converted with [`ColibriJson`](#sending-data-between-clients) and saved as an array of its components. Values Colibri 1.x saved as `{"x": …}` still load
- Neither call throws for a failure: `await Store.Put(…)` returns `false` when the value cannot be converted or the server did not store it, and `await Store.Get<T>(…)` returns `default` when the request fails, when nothing is saved under that name, or when the saved value does not fit `T`. Each logs why. A saved `null` also comes back as `null`, and an exception your own class throws, from its constructor for example, still comes through
- The app name and the name you save under are URL-encoded, so a name with `/`, `#`, `?`, `%` or a space in it works, and addresses the same value as in colibri-web

## Connection and outages

Colibri opens the connection by itself the first time anything calls `Sync.Send` or
`Sync.Receive`, or a `SyncBehaviour` wakes up. When the connection drops, it reconnects on its
own, waiting 0.5 s, then 1 s, 2 s and so on, up to 10 s, between attempts. An attempt that nothing
answers is given up after 5 s. `WebServerConnection.Instance` tells you where it stands:

- `Status` is `Connecting`, `Connected`, `Reconnecting`, `Disconnected` or `ProtocolMismatch`.
- `OnConnected` is raised on the main thread once the server has actually sent something: an
  accepted TCP connection is not enough. `OnDisconnected` is raised exactly once for every
  `OnConnected`, when that connection ends. An attempt that never got connected raises neither.
  Both are raised in the order things happened, so the last one raised is the current state: a
  connection that drops and comes back between two frames raises `OnDisconnected`, then
  `OnConnected`.
- `LastConnectFailure` says why the last attempt to open the connection failed (for example
  `… did not answer within 5 s`, or a refusal) and is `null` once one has opened.
- `await connection.Connected` waits until the connection is up. It is cancelled when the server
  refuses this client's protocol version or the component is disabled, so the `await` then throws
  a `TaskCanceledException`.

While the connection is down, whatever you send waits, and goes out in the order it was sent as
soon as the connection is back, ahead of anything sent afterwards:

- Broadcasts (`Sync.Send`): at most 256 are kept. Past that the oldest are dropped, with one
  warning per outage. Log lines wait in `[RemoteLogger]` instead, which keeps the newest 1000 (see
  [Web Interface for Logging](#web-interface-for-logging)); only lines it had already handed over
  when the connection dropped count towards the 256.
- Changes to synced objects (`SyncBehaviour`, `SyncTransform`) are not dropped by that bound.
  Several changes to the same object during one outage are merged into one update, newer values
  winning.
- Behind both, at most **10 000 messages** wait in all: during an outage, or while connected over
  a link too slow for what is sent. Past that the oldest broadcasts and log lines go first, and then
  the oldest synced-object messages (requests, updates and deletes), which other clients then never
  see. The console says so once per connection: `Colibri: more than 10000 messages are waiting to be
  sent…`.

What arrives waits for `Update`. While `Update` does not run (the app is paused, such as a Quest
with the headset off, or the Editor is in the background without *Run In Background*), Colibri
keeps reading, so that the server does not take the client for gone. Past 1000 waiting messages,
each update for an object is merged into the one already waiting for it, newer values winning, so
a listener sees only the newest state of each object for that stretch; past 10 000, the oldest are
dropped, broadcasts first. The console then says so once per connection: `Colibri: … received
messages waited for Update, which did not run for a while…`.

After reconnecting, Colibri asks the server again for every synced object in the scene, and for
everything on the channels of its `SyncBehaviourManager`s, so what other clients changed in the
meantime arrives. For each object, the server's answer is one of:

- **The object's current state**, which is applied.
- **Nothing for it.** The server forgets an app's synced objects when the app's last client
  disconnects, and when it restarts, and a single client whose connection drops is that last
  client. Colibri then sends the object's full state again, so the server has it back, and clients
  that join later see it.
- **A delete**: another client deleted the object during the outage. It is deleted on this client
  too.

An object that changed during the outage does not get its full state sent again. Its merged update
goes out ahead of the request, so a server that had forgotten the object creates it from that
update, with only the members that changed, and answers the request with those. The other members
reach the server only when they change. Until then, a client that joins later builds the object
with the template's values for them, shown even if it is hidden here; a placed object keeps its
values from the scene.

The server remembers a delete for `MODEL_TOMBSTONE_SECONDS`, 10 minutes by default. An object
that another client deleted longer ago than that, while this client was away, is answered with
nothing, so this client sends it again, and it is back as if this client had just created it. See
[After a reconnect](../../colibri-server/docs/protocol.md#after-a-reconnect) in the protocol docs.

A refused protocol version is final: `Status` becomes `ProtocolMismatch`, the client stops
reconnecting, and whatever was queued or is sent afterwards is dropped, with a one-time warning.
`ServerVersion` and `ProtocolMismatchReason` say what the server answered. Disabling and
re-enabling the `WebServerConnection` component tries again. A mismatch the server could not
report (see [Requirements](#requirements)) shows up in `SuspectedProtocolMismatch` instead, while
the client keeps retrying.

## Web Interface for Logging

<img src="../img/weblogger.png" alt="WebLogger" width=400/>

Colibri provides a *web logger* with web interface to send diagnostic data (currently: console logs) to the server. This may be useful for devices (e.g., VR devices, smartphones) where access to the console is not easily available.

To setup, add the `[RemoteLogger]` prefab to your scene. The Unity log output should be redirect to your server's webinterface, which can be accessed via `http://<your-server-ip>:9011`.

Log lines are sent once a second, and identical lines in one batch are sent once. At most the newest 1000 lines are kept between two sends (while the connection is down, that is the whole outage) and sent once it is back. Where older lines had to be dropped, the server's log shows one line in their place, `Colibri: N log lines are missing here …`; the device's own log keeps everything. If the server refuses the client's protocol version, the kept lines are discarded.

## Voice Chat

Colibri also offers a voice chat for remote scenarios. The voice chat consists of two scripts `VoiceBroadcast` and `VoiceReceiver`.

`VoiceBroadcast` records the microphone audio and streams it over the network. Simply attach the script to an empty `GameObject`. To start broadcasting, call `StartBroadcast` on that component with any (`short`) voice id except `0`; `StopBroadcast` stops it again:

```c#
// The VoiceBroadcast component, assigned in the Inspector
public VoiceBroadcast Broadcast;

void Start()
{
    // Create random voice id
    short voiceId = (short)UnityEngine.Random.Range(1, 32000);
    Broadcast.StartBroadcast(voiceId);
}
```

On Android (Meta Quest), `VoiceBroadcast` asks for the microphone permission when it starts. If the permission is refused, it logs an error and does not broadcast.

`VoiceReceiver` receives and playbacks the voice data of a specific voice id. Attach the script to a `GameObject` of your choice. This is usually a user representation, such as an avatar. When attaching the script, an `AudioSource` is automatically added. To support mulitple `VoiceReceiver` create a prefab of the object. To start receiving voice data, call the `StartPlayback` method with the specific voice id of the client. For the distribution of active voice ids of other clients, `Sync.Send` can be used:

```c#
void Start()
{
    Sync.Receive<int>("VoiceChat", OnIdArrived);
}

private void OnIdArrived(int id) 
{
    GameObject voiceReceiverPrefab = Instantiate(VoiceReceiverPrefab);
    voiceReceiverPrefab.GetComponent<VoiceReceiver>().StartPlayback((short)id);
}
```

See `Samples/VoiceChat` for a fully working voice chat example with a `VoiceManager` handling voice ids and the instantiation of `VoiceReceiver` prefabs.

By default, the voice chat transmits audio as raw PCM data. However, to reduce throughput, the Colibri voice chat also supports Opus codec compression on Windows, Linux, and Android. In order to use the Opus codec, enable the `Use Opus Codec` toggle on both the `VoiceBroadcast` and `VoiceReceiver`.

Colibri voice chat also supports spatial audio. The `VoiceReceiver` position in the scene defines the playback location of the voice. Make sure that `Spatialize` is enabled on the `AudioSource` and that `Spatial Blend` is set to `1` (3D). This also works with a spatializer plugin set in the audio settings. 

The voice server only listens on IPv4. Colibri sends voice to an IPv4 address of the configured server, so `localhost` works on Windows, where it resolves to the IPv6 address `::1` first. If the server address has no IPv4 address, or cannot be resolved, Colibri logs an error and turns voice chat off.

Limitations:

- Only limited scalability, because voice data is distributed to all active clients on the server using `VoiceBroadcast`
- Only limited security, as voice data can be received by knowing the voice ID, regardless of the app name set in the Colibri configuration.
- Without enabling Opus high throughput

## Other documents

- [MIGRATION.md](../../MIGRATION.md): upgrading a Colibri 1.x project, for all three components;
  read it together with the change log's [Breaking changes](../CHANGELOG.md#breaking-changes)
- [CHANGELOG.md](../CHANGELOG.md): everything that changed in `1.3.1` → `2.0.0`
- [v2-ease-of-use-and-performance.md](v2-ease-of-use-and-performance.md): how the sync
  loop and the diagnostics work, why they were built that way, and how to migrate an existing project
- [colibri-server/docs/protocol.md](../../colibri-server/docs/protocol.md): the v3 wire protocol

## For maintainers

### Running the tests

```sh
node colibri-unity/run-tests.mjs              # both suites
node colibri-unity/run-tests.mjs --editmode   # unit tests only, no server needed
node colibri-unity/run-tests.mjs --playmode   # end-to-end only
```

Two suites, and they need different things:

- **EditMode** (`Assets/Colibri/Tests/Editor/`) is plain NUnit over the framing, the JSON
  conversions, the diagnostics, the outage queue, message dispatch, the `[Sync]` accessors
  (including the IL2CPP path), the send-rate limit, the connect timeout, the Android build check,
  the app-name warning, and the voice server address and packet queue. No server needed, runs
  anywhere Unity does.
- **PlayMode** (`Assets/Tests/`) is the real thing: a Unity client and a raw v3 peer talking to a
  running `colibri-server`. The script starts one with `docker compose` and stops it again, unless
  something is already listening on the port, which it uses as it stands and leaves running.
  Reconnects go through a proxy the test can cut, and the mismatch detection runs against a
  scripted stand-in server.

Results land in `TestResults/` as NUnit XML plus the editor log. Without a reachable server the
end-to-end tests report as *skipped* with the command that fixes it, rather than failing.

The connect-timeout tests that need a port that never answers are skipped on Windows, which
refuses a connection to a full listen backlog instead of leaving it unanswered:
`ConnectTimeoutTests.AnAttemptNothingAnswersIsGivenUpAfterTheTimeout` and
`.CancellingGivesUpTheAttemptAtOnce`, and
`ProtocolMismatchDetectionTests.AnAttemptNothingAnswersIsGivenUpAfterFiveSecondsAndRetried`. Check
the timeout there by hand: with an unreachable server address, the client should leave
*Connecting* after 5 s.

| Variable | Meaning |
| --- | --- |
| `COLIBRI_E2E_SERVER` | Host of a server to use instead of starting one. Setting it means the script never starts or stops anything. |
| `COLIBRI_E2E_PORT` | Web/Socket.IO port, default `9011` |
| `COLIBRI_E2E_TCP_PORT` | Binary v3 port, default `9012` |
| `COLIBRI_E2E_NO_BUILD` | Skip `docker compose --build` |
| `UNITY_PATH` | The editor to use, if it is not where Unity Hub puts it |

The script insists on the exact editor version in `ProjectSettings/ProjectVersion.txt` unless
`UNITY_PATH` says otherwise: opening the project with a different one upgrades it in place, which
turns a test run into a diff across the manifest and half of `ProjectSettings`. If that version is
not installed it lists the ones that are, with the `UNITY_PATH` to use; the upgrade is then yours to
commit deliberately, rather than something that arrives attached to an unrelated change.

The package itself supports **2022.3 LTS and newer**; the version pinned here is only what the
development project is opened with.

Both suites can also be run from **Window → General → Test Runner** in the editor. The end-to-end
ones need *Run In Background* on, which they set for themselves.

Voice chat has no end-to-end coverage: it needs a microphone. Only the choice of the server's
address and the queue that hands received packets to the main thread are unit-tested.
