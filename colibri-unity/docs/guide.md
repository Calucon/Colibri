# Colibri Unity guide

Everything about the Colibri Unity package in one place: every option, limit and console message.
For installing it and getting two clients to talk, the [README](../README.md) is enough.

## Contents

- Setting up
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [Quickstart](#quickstart)
  - [Configuration](#configuration)
  - [TLS](#tls)
  - [Meta Quest and Android](#meta-quest-and-android)
  - [Samples](#samples)
  - [Troubleshooting](#troubleshooting)
- Using Colibri
  - [Sending Data between Clients](#sending-data-between-clients)
  - [SyncTransform](#synctransform)
  - [SyncBehaviour](#syncbehaviour)
  - [Send rate](#send-rate)
  - [Remote Store](#remote-store)
  - [Connection and outages](#connection-and-outages)
  - [Web Interface for Logging](#web-interface-for-logging)
  - [Voice Chat](#voice-chat)
- [Related documents](#related-documents)
- [Development](#development)

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
   ([Docker setup](../../colibri-server/README.md#docker)). The address is preset to the
   public test server `colibri.hci.uni-konstanz.de`, which this package can only use while it runs
   colibri-server 2.x: against a 1.x server, *Window → Colibri Status* reports a suspected protocol
   mismatch (see [Requirements](#requirements)).
3. Turn on *Project Settings → Player → Resolution and Presentation → **Run In Background***.
   Unity leaves this off by default, and with it off the Editor stops running your game the
   moment its window loses focus. The connection stays up and the status window still says
   *Connected*, but nothing is sent and nothing that arrived is delivered, because none of that
   happens until `Update` runs again. It is the single most confusing way for two clients on one
   machine to appear broken. (Unity ignores this setting on Android, so it does not matter for
   the Quest build itself.)
4. Import the **SendData** sample: *Window → Package Manager → Colibri → Samples → Import*. (The
   scene needs TextMeshPro's essential resources; see [Samples](#samples).)
5. Start a second client. Unity does not open one project twice, so copy the project's `Assets`,
   `Packages` and `ProjectSettings` folders into a new folder and open that from the Unity Hub. The
   copy has the same configuration (`Assets/Resources/ColibriConfig`) and the imported sample. A
   build of the scene is a client too, but it has no Inspector to tick `SendProperties` in, and
   its log goes to a file rather than a console.
6. Open the sample scene in both Editors and press Play. Tick `SendProperties` on the `[ClickMe]`
   object (its `SendMessages` component) in one: the other's console logs `Received message with
   value …` for every value sent. The sender logs none of these lines, because a client never
   receives what it sent itself (see [Sending Data between Clients](#sending-data-between-clients)).

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
- *Save Config* saves the configuration to `Resources/ColibriConfig`. A valid change takes effect at once, so Play mode uses it even before you save. A value the window marks as an error, such as port 0, is neither used nor saved: that setting keeps its last valid value, and the window shows what you typed until you correct it or close the window. Changes made elsewhere, such as in the asset's Inspector, show in the window and are kept.

### Advanced Configuration

If your server is running a non-default configuration, the advanced configuration allows you to modify server ports.
The ports must match the server's, so change them only if the server does not use the defaults.

The Remote Store talks to the server over REST. With *Server supports SSL/TLS?* off those requests
go out as plain `http`, and Unity blocks cleartext HTTP by default. **Loopback is exempt**, so a
server on `localhost` needs no change at all; this only comes up once the server is a real
remote host that is not on HTTPS (and from a headset, every server is a remote host). In that case
set *Project Settings → Player → Other Settings → **Allow downloads over HTTP*** to *Always
allowed*, or turn [TLS](#tls) on at the server and tick *Server supports SSL/TLS?*. Colibri checks
this for every build target (see [Meta Quest and Android](#meta-quest-and-android)).

When using the voice chat, Colibri allows to adjust the sampling rate on the server. In this case, clients need to manually set the `Voice Sampling Rate` setting in the configuration.

`Max Send Rate (Hz)` caps how many updates per second each synced object sends (see [Send rate](#send-rate)).

Default values:

- Web server Port: `9011`
- TCP server Port: `9012`
- Voice server Port: `9013`
- Voice Sampling Rate: `48000`
- Max Send Rate: `30` (updates per second per synced object; `0` = no limit)

## TLS

*Server supports SSL/TLS?* (`ColibriConfig.IsSSL`, under *Optional Config*) encrypts the TCP
connection to colibri-server and switches the Store to `https`. The server needs TLS turned on,
with `TLS_CERT` and `TLS_KEY` (see [TLS](../../colibri-server/docs/guide.md#tls) in the server
guide), and the setting has to match it: a server with TLS accepts only TLS on its TCP port, and
one without TLS accepts none. Inside TLS run the same v3 frames; the protocol version is
unchanged.

- The TLS handshake has to finish within the same 5 s connect timeout.
- Unity's TLS backend negotiates TLS 1.2.
- The client sends the configured *Server Address* as SNI, and checks the certificate against it.
- Voice chat (UDP) stays unencrypted.

The Setup window's labels are *Server supports SSL/TLS?*, *Allow self-signed certificate* and
*Server certificate SHA-256*, and the server's log uses exactly these. Unity's own console messages
call the first one 'Server supports SSL/TLS', without the question mark.

### Which certificates are accepted

- **From a certificate authority** (Let's Encrypt, or your institution's): nothing more to set. The
  device's trust store decides, on Android and the Quest too.
- **Self-signed:** paste the server's fingerprint into *Server certificate SHA-256*
  (`ColibriConfig.ServerCertificateSha256`). Then only that certificate is accepted, trusted or
  not, and its names are ignored, so a certificate for an IP address works too. Case and colons do
  not matter; anything but 64 hexadecimal digits (or nothing) is an error in the Setup window, and
  is neither used nor saved.
- **Self-signed, without a fingerprint:** *Allow self-signed certificate*
  (`ColibriConfig.AllowSelfSignedCertificate`) accepts a certificate the device does not trust.
  The connection is still encrypted, but nothing checks that it goes to your server, and the
  console warns once per session, with the fingerprint to pin instead.

Both settings appear in the Setup window only with *Server supports SSL/TLS?* ticked. A
configuration saved before they existed loads with both off and empty, so only certificates the
device trusts are accepted.

The fingerprint is in the server's startup log (`TLS is on, ... SHA-256 fingerprint AB:CD:...`), in
Colibri's warning or rejection message, and in the *SHA-256* row of *Window → Colibri Status*,
which can be selected and copied. Do not pin a certificate from Let's Encrypt: it changes with
every renewal, and the pin then rejects the server.

The Store's `https` requests follow the same two settings; with neither set, the system checks the
certificate, as before. *Window → Colibri Status* shows TLS next to the server address, how the
certificate was accepted (`trusted by this device`, `matches 'Server certificate SHA-256'`, or
`not trusted, accepted because 'Allow self-signed certificate' is on`), and its fingerprint.

### TLS errors

| Console | What to do |
|---|---|
| `<host:port> did not answer the TLS handshake …` | The server has no TLS: set `TLS_CERT` and `TLS_KEY` there, or untick *Server supports SSL/TLS?* |
| `rejected the certificate of <host:port>: it is self-signed …` | Pin its fingerprint, or tick *Allow self-signed certificate* |
| `… it expired on <date>` | Renew the certificate on the server |
| `… it is not issued for '<address>'` | Connect by a name the certificate covers, or pin it, or allow self-signed certificates |
| `… its SHA-256 fingerprint is <X>, not the one in 'Server certificate SHA-256' …` | The server's certificate was replaced: copy the new fingerprint from the server's log |
| `… This usually means a protocol mismatch … tick 'Server supports SSL/TLS' …` | A client without TLS is talking to a server with TLS: tick the setting |

Each is logged as an error once, and then only noted while the client retries with the usual
backoff, so fixing the server needs no restart of the app. `LastConnectFailure` and the Status
window show the latest one.

## Meta Quest and Android

A Meta Quest app is an Android build: switch the platform to Android under *File → Build
Settings* (*File → Build Profiles* on Unity 6). Quest needs the ARM64 architecture, which on
Android requires the IL2CPP scripting backend.

Colibri checks two Player settings that otherwise only fail in the built app, where there is no
console to say why. It warns in the console after every script reload and at the start of every
player build, and *Window → Colibri Configuration* lists the problems in an **Android / Meta Quest**
section (**Player build** with another target active), each with a button that fixes it:

- **Internet Access** must be *Require* (*Player → Other Settings*), checked with the Android target
  active. Colibri connects with plain sockets, and with *Auto* the build may lack Android's INTERNET
  permission: the app starts and never connects. The warning starts with `Colibri (Android build):`.
- **Allow downloads over HTTP** must be *Always allowed* while *Server supports SSL/TLS?* is off
  and the server is not `localhost`, on every build target. *Allowed in development builds* passes
  for development builds only. Otherwise every `Store` call fails with "Insecure connection not
  allowed". The warning starts with `Colibri (build):`. With [TLS](#tls) on, this does not apply.

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
| Nothing connects, no errors | `Colibri is not configured yet. Open Window -> Colibri Configuration…` |
| Never connects, and nothing answers at all | `Colibri: 192.168.0.10:9012 did not answer within 5 s. Check the server address, and that this device is on the same network as the server.` A wrong IP, a server on another network or subnet, a Wi-Fi with client isolation, or a firewall dropping the packets: fix the address or the network |
| Never connects, and the connection is refused | `Colibri: connection to 192.168.0.10 failed (ConnectionRefused), retrying...` The machine is reachable, but nothing listens on that TCP port: start colibri-server, or check the *TCP server Port* |
| Two clients don't see each other | The connect log names the app name in use; both clients must show the same one |
| Objects or messages you did not create show up | Nothing in Unity at runtime: someone else uses the same app name. *Window → Colibri Configuration* warns when it is a name many people use, such as `myAppName` or `test`, and the server's log warns, naming the app, once it has more than 8 clients (by default) |
| A `[Sync]` field never syncs | Its type is reported at startup if Colibri cannot put it on the wire |
| Connected, but one client is silent | That client's Editor window is in the background and *Run In Background* is off (see step 3 of the [Quickstart](#quickstart)) |
| `Store.Get`/`Put` reports a failure | The log names the operation, the object, the URL, the transport error and the HTTP status; requests give up after 10 s rather than hanging |
| Never connects, although something answers on the port | `invalid frame from server` errors if the server sends anything, then `3 connections in a row were accepted but ended before a single frame could be read. This usually means a protocol mismatch…`: the server is probably 1.x, or the address is not a colibri-server, or the server has [TLS](#tls) on and *Server supports SSL/TLS?* is off. With that setting off, a proxy or port forwarding whose backend is not running ends connections the same way |
| Never connects, although the port accepts the connection | `… accepted the connection but has not sent anything in 2 s, dropping it` (with TLS also `server closed the connection`), then `3 connections in a row to 192.168.0.10:9012 were accepted, but nothing was received on any of them: each was closed by the other end or dropped after 2 s of silence…`: something accepts connections there and then closes them or forwards nothing, such as a proxy or port forwarding whose backend is down, a captive portal or a firewall, or the server does not answer or is not a colibri-server. Check that colibri-server is running and reachable at that address and port |
| Works in the Editor, not on the Quest or in a build | `Colibri (Android build): …` or `Colibri (build): …` in the console, and the *Android / Meta Quest* or *Player build* section of *Window → Colibri Configuration* |
| Never connects, with TLS on either side | `… did not answer the TLS handshake …` or `rejected the certificate of …`: see [TLS errors](#tls-errors) |

Other failures to connect name their socket error the same way, such as `failed (HostUnreachable)`
or `failed (NetworkUnreachable)`; like the timeout, they point at the address or the network.

On a headset there is no Status window, and while it is not connected the `[RemoteLogger]` cannot
forward the console either. For a status display in your app,
`WebServerConnection.Instance.LastConnectFailure` holds why the last attempt to connect failed (such
as the timeout or the refusal above) and is `null` once a connection has opened.

## Sending Data between Clients

`Sync.Send` publishes a value on a channel from anywhere in your code:

```c#
float myNumber = 5;
Sync.Send("MyChannel", myNumber);
```

The server forwards the message to all other clients with the same app name, never to the sender.

`Sync.Receive` registers a listener for a channel and a type:

```c#
void Start() {
    Sync.Receive<float>("MyChannel", MyListener);
}

private void MyListener(float myNumber) {
    // Runs whenever a float
    // arrives on "MyChannel"
}
```

- A listener that is a method of a `MonoBehaviour`, or a lambda written inside one, is removed when
  the component or its GameObject is destroyed. Destroyed objects are never called and cannot throw
  `MissingReferenceException` in Colibri's message loop.
- `Sync.Unregister` removes a listener while its object lives on:

  ```c#
  private void OnMenuClosed() {
      Sync.Unregister<float>("MyChannel", MyListener);
  }
  ```

- Colibri cannot track the lifetime of `static` methods and plain C# objects. Remove such listeners
  with `Sync.Unregister`.

### Supported types

`bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color`, and arrays of these.

### JSON

Send other types as JSON (Newtonsoft JSON):

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

Newtonsoft JSON converts your own classes. `[Serializable]` is optional:

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

Newtonsoft JSON cannot convert a `Vector3`, `Quaternion` or `Color` inside your class. A plain
`JToken.FromObject` throws a `JsonSerializationException`, for a `Vector3` with
`Self referencing loop detected for property 'normalized'`. Pass `ColibriJson.Serializer`, which
converts `Vector2`, `Vector3`, `Vector4`, `Quaternion` and `Color` to arrays of their components and
back:

```c#
using HCIKonstanz.Colibri.Synchronization; // ColibriJson

Sync.Send("example", JToken.FromObject(exampleObject, ColibriJson.Serializer));

private void MyListener(JToken jtoken) {
    ExampleClass exampleObject = jtoken.ToObject<ExampleClass>(ColibriJson.Serializer);
}
```

Or build the `JObject` with Colibri's conversion methods:

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

Colibri converts a `Vector3`, `Quaternion` or `Color` that is sent directly or is a `[Sync]` member,
so these need neither.

### Limitations

- Register the listener before data is sent.
- Channel and type must match on both sides. On a mismatch, the console names the channel, both
  types and the fix.

## SyncTransform

`SyncTransform` syncs an object's active state, position, rotation and scale between all clients.
`SyncActive`, `SyncPosition`, `SyncRotation` and `SyncScale`, all on by default, select what is
synced. `UseLocalTransform` syncs local instead of world coordinates. See the SyncTransform sample.

### Server state

- The server stores each object's state and sends it to clients that connect later.
- The object requests the state in `Awake` and gets it a round trip later, or once connected.
- Members changed before the answer, e.g. in `Start`, in `OnConnected` or right after entering Play
  mode, keep their values. These replace the server's values here, on the server and on all other
  clients.
- All other members take the server's values, so scene and prefab values do not overwrite them. For
  model scripts of your own, see [Awake and OnDestroy](#awake-and-ondestroy).
- A script that moves the object in `Start` therefore moves it for everyone whenever a client
  starts. Set starting positions in the scene.
- Moving objects send at most 30 updates per second by default ([Send rate](#send-rate)).

### Showing, hiding and deleting

- `SetActive(false)` hides the copies on other clients, `SetActive(true)` shows them again. Only the
  object's own flag (`activeSelf`) is synced, so deactivating a parent has no effect elsewhere. With
  `SyncActive` off, the active state stays local.
- Disabling only the `SyncTransform` component pauses syncing without hiding anything. Changes made
  meanwhile are sent when it is enabled again.
- Destroying the object or unloading its scene, also by loading another scene in its place, deletes
  it on the server and all clients for good. An update another client sent before the delete reached
  it is ignored by the server and this client.
- Loading the scene again, on any client, lets its placed objects sync again between all clients
  that load it from then on, because the server no longer treats them as deleted. A client that kept
  the scene open lost its copies with the delete. It gets them back only by loading the scene again,
  or from a manager with a `Template` for them, which builds them from the next update.
- Leaving Play mode, quitting or killing the app deletes nothing, whether the object is shown or
  hidden. It stays on the server until the app's last client disconnects ([Connection and
  outages](#connection-and-outages)).

### Physics

- `PhysicsAuthority` marks the one client that controls the object's physics. Setting it to `true`
  on one client sets it to `false` on all others. If it is ticked by default, the first client gets
  the authority.
- Until the server's state arrives, the `Rigidbody` stays kinematic regardless of
  `PhysicsAuthority`, so a client that joins later starts from the shared position, not from its own
  simulation.
- An object instantiated on this client with an empty `Id` is simulated at once, because the server
  has no state for it.
- If the connection is not up 5 s (the connect timeout) after Colibri opened it or after it dropped,
  the object stops waiting once no connect attempt is running. Attempts also give up after 5 s. The
  object is then simulated according to `PhysicsAuthority`, and the console warns once per session:
  `Colibri: no connection to a server for 5 s, so placed SyncTransforms with a Rigidbody and PhysicsAuthority ticked are simulated without the server's state; …`.
- When a server answers later, the position the object reached replaces the shared one on all
  clients. Start colibri-server before the clients.
- `isKinematic` of the `SyncTransform` overwrites `isKinematic` of the `Rigidbody`. Change it on the
  `SyncTransform`, not only on the `Rigidbody`.

### Objects created at runtime

1. Add the `[SyncTransformManager]` prefab from `Packages/Colibri/Prefabs/` to the scene.
2. Set its `Template` to a prefab of the object.
3. Set the prefab's `ModelId` to a value that identifies the prefab, and leave its `Id` empty.

When a client instantiates an object with a `SyncTransform` and this `ModelId`, the manager on the
other clients creates it from the prefab and syncs it. The `Template` can also be an inactive scene
object ([SyncBehaviour](#syncbehaviour)).

<img src="../img/synctransformmanager.png" alt="SyncTransformManager" width=400/>

### Limitations

These also apply to every `SyncBehaviour`.

- Update each member from one client at a time.
- The scene is reset when all clients disconnect.

## SyncBehaviour

`SyncBehaviour<T>` syncs data models, e.g. in a model-view-controller architecture. It needs a model
script and a manager script.

The model script inherits from `SyncBehaviour<T>` instead of `MonoBehaviour`. `[Sync]` marks the
properties and fields to sync:

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

The manager needs only a matching declaration:

```c#
public class MyClassManager : SyncBehaviourManager<MyClass>
{
    // No code needed. Add this script to the scene,
    // e.g. on an empty GameObject.
}
```

Add the manager to the scene and set its `Template` to a prefab with the model script.

- The `Template` can also be an inactive scene object. An active one would also sync as an object of
  its own.
- The manager activates every copy it builds, so the copy runs `Awake`, and then applies the synced
  state. A `SyncTransform` copy of an object hidden elsewhere is therefore deactivated at once, and
  shown when the original is.
- `SyncTransform` is a `SyncBehaviour`. Its rules for server state, disabling, destroying and
  quitting apply to every `SyncBehaviour`. Only the active state is specific to `SyncTransform`.

### Awake and OnDestroy

A `SyncBehaviour` registers in `Awake` and unregisters in `OnDestroy`. To use them, override them
and call the base method:

```c#
protected override void Awake()
{
    // set up what your [Sync] getters read, such as a cached component
    base.Awake();
    // your code
}
```

A plain `void Awake()` or `void OnDestroy()` hides the base method, and only compiler warning CS0114
reports it. Without `base.Awake()`, the object never syncs. Without `base.OnDestroy()`, destroying
it does not delete it on the other clients.

- On objects placed in the scene or created on this client, a `[Sync]` member set after
  `base.Awake()` counts as a change ([Server state](#server-state)). To take the server's state
  instead, set initial values before `base.Awake()` or in the Inspector.
- A copy that a manager builds from another client's update takes the values of that update,
  whatever its `Awake` sets.
- `base.Awake()` reads every `[Sync]` member once, and the server's first answer is compared with
  these values. Set up whatever a getter reads before `base.Awake()`. A getter that reads a
  component cached later returns its fallback first and the real value afterwards. This counts as a
  change too, so each client that starts sends its own value over the server's.

## Send rate

A synced object (`SyncTransform` or any other `SyncBehaviour`) sends at most **30 updates per
second** by default. Without a limit, a moving object sends an update every frame, 72 to 120 per
second on a headset. Dozens of headsets doing that overload one server and one Wi-Fi network.

- A single change is sent in the frame it is made.
- Faster changes are collected. Their latest values are sent together when the interval (1/30 s)
  ends, even if nothing changes afterwards.
- Values in between are never sent. A synced object shares its current state, not every step, so a
  `[Sync]` setter on another client does not see every value either. Use `Sync.Send` for events that
  must all arrive.
- `SetActive` sends pending changes at once, for a `SyncTransform` including the hide or show.
- Destroying the object sends its delete at once and drops any pending change.
- Pending changes are sent at once when the app pauses or loses focus. On a Quest, this happens when
  the headset is taken off, the system menu opens or the user leaves the app.
- When the app quits or Play mode ends, pending changes are sent as a best effort only, because the
  connection closes in the same teardown.
- A value from another client replaces a pending local change of the same member, so all copies end
  up with the same value.

Change the limit in *Window → Colibri Configuration → Optional Config → Max Send Rate (Hz)*, or at
runtime:

```c#
using HCIKonstanz.Colibri.Synchronization;

SyncSettings.MaxSendRate = 60; // updates per second per synced object; 0 = no limit
```

- A value set from code applies to the current run only (in the Editor: the Play session) and does
  not change the configuration.
- A negative value throws an `ArgumentOutOfRangeException`.
- `0` disables the limit. An update then goes out in every frame with a change, as in Colibri 1.x.
  The configuration window warns about it.
- A configuration saved before this setting existed uses 30.

## Remote Store

`Store` saves data per app name on the server through its REST interface, so it persists between
sessions. It takes anything Newtonsoft JSON can serialize, such as an object of your own class (also
with `Vector3`, `Quaternion` or `Color` fields), a list, a number or a string, up to 5 MiB of JSON
per name.

```c#
// Create example object
ExampleClass exampleObject = new ExampleClass();
exampleObject.Id = 1234;
exampleObject.Name = "Charly Sharp";

// Save example object using REST API
bool putSuccess = await Store.Put("exampleObject", exampleObject);
Debug.Log($"Success: {putSuccess}");
```

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

`await Store.Delete("exampleObject")` deletes the value and returns `false` on failure.

- Values are fetched only on request. They do not update automatically.
- Newtonsoft JSON saves the public fields and properties of your class. `[Serializable]` is not
  needed. A private `[SerializeField]` field is not saved.
- A `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Color` inside your class is converted with
  [`ColibriJson`](#json) and saved as an array of its components. Values Colibri 1.x saved as
  `{"x": …}` still load.
- Failures do not throw. `Store.Put` returns `false` if the value cannot be converted or the server
  did not store it. `Store.Get<T>` returns `default` if the request fails, nothing is saved under
  the name, or the saved value does not fit `T`. Both log the reason.
- A saved `null` is returned as `null`. Exceptions thrown by your own class, e.g. by its
  constructor, pass through.
- Requests give up after 10 s.
- The app name and the name you save under are URL-encoded. Names with `/`, `#`, `?`, `%` or spaces
  work and address the same value as in colibri-web.

## Connection and outages

Colibri connects when anything first calls `Sync.Send` or `Sync.Receive`, or a `SyncBehaviour` runs
`Awake`. After a drop it reconnects with delays of 0.5 s, 1 s, 2 s and so on up to 10 s. An attempt
without an answer is abandoned after 5 s.

| `WebServerConnection.Instance` member | Description |
|---|---|
| `Status` | `ConnectionStatus`: `Connecting`, `Connected`, `Reconnecting`, `Disconnected` or `ProtocolMismatch` |
| `OnConnected` | Raised on the main thread once the server has sent something, not when TCP accepts the connection |
| `OnDisconnected` | Raised once for every `OnConnected`, when that connection ends |
| `LastConnectFailure` | Why the last attempt failed, e.g. `… did not answer within 5 s` or a refusal. `null` once connected. |
| `Connected` | Task that completes once connected. Cancelled when the server refuses the protocol version or the component is disabled, so `await` then throws a `TaskCanceledException`. |
| `ServerVersion`, `ProtocolMismatchReason` | The server's answer to a refused protocol version |
| `SuspectedProtocolMismatch` | A mismatch the server could not report ([Requirements](#requirements)) |

An attempt that never connected raises no event. Events are raised in order, so the last one raised
is the current state. A drop and reconnect between two frames raises `OnDisconnected`, then
`OnConnected`.

### Sending during an outage

Messages sent while disconnected wait. After the reconnect they go out in order, before anything
sent later.

- **Broadcasts** (`Sync.Send`): at most 256 wait. Beyond that the oldest are dropped, with one
  warning per outage.
- **Log lines** wait in `[RemoteLogger]`, which keeps the newest 1000 ([Web Interface for
  Logging](#web-interface-for-logging)). Only lines it handed over before the drop count toward the
  256.
- **Synced object changes** are exempt from the 256 limit. Changes to one object are merged into one
  update, newer values winning.
- **Total:** at most **10 000 messages** wait, during an outage or on a link too slow for the
  traffic. Beyond that, the oldest broadcasts and log lines are dropped first, then the oldest
  synced-object requests, updates and deletes, which other clients then never see. The console warns
  once per connection: `Colibri: more than 10000 messages are waiting to be sent…`.

### Receiving while Update does not run

Received messages wait for `Update`. `Update` does not run while the app is paused, such as a Quest
with the headset off, or while the Editor is in the background without *Run In Background*. Colibri
keeps reading meanwhile, so the server does not drop the client.

- Beyond 1000 waiting messages, updates for one object are merged, newer values winning. Listeners
  then see only the newest state of each object for that period.
- Beyond 10 000, the oldest messages are dropped, broadcasts first.
- The console warns once per connection:
  `Colibri: … received messages waited for Update, which did not run for a while…`.

### After a reconnect

Colibri requests every synced object in the scene and everything on its `SyncBehaviourManager`
channels again, to receive changes made meanwhile. The server answers each object with:

- **its current state**, applied unless it reveals a lost change of this client ([Lost
  changes](#lost-changes))
- **nothing**, if the server forgot the app's objects because the server restarted or the app's last
  client disconnected. A single client whose connection drops is that last client. Colibri then
  sends the full state again, for the server and for clients that join later.
- **a delete** by another client during the outage, applied here too

An object changed during the outage sends only its merged update, ahead of the request. A server
that forgot the object creates it with only the changed members and answers with them. The other
members reach the server only when they change. Until then, clients that join later use the
template's values for them, shown even if the object is hidden here. Placed objects keep their scene
values.

### Lost changes

A change made as the Wi-Fi drops goes into a dead connection and is lost. The client notices the
drop 2 s later, when heartbeats stop, and the server's answer holds the value from before the
change.

To detect this, each `[Sync]` member keeps the values it sent around the time the client last heard
from the server, which heartbeats every 100 ms. These are the last 8 up to then, the first 8 after,
the newest, and the value held before those, which is the last one dropped or the last one received
from the server. The value the server holds stays among them until all answers are in, however many
later changes were lost or made after the reconnect.

Until all answers are in, everything that arrives for the object, other clients' updates included,
is compared with the values the member held since 10 s before the outage was noticed. These are the
values it sent since and the one it held then, e.g. `true` for an object switched on a minute ago.

| Arriving value | Result |
|---|---|
| The value sent last | The change arrived. |
| An earlier one | The next change was lost. The member keeps its value and sends it again, once. |
| Any value, if the member changed after the request | The same. The server reads that change after the answer. |
| A value the member did not hold | Another client's change during the outage. Applied. |
| Any value, if the member sent nothing in those 10 s, or the object never sent anything | Applied |

A second drop before all answers are in still counts from the first outage. The comparison uses
values, so some cases go wrong:

- Another client that sets a member back during the outage, to a value this client held in those
  10 s, is undone.
- More than 8 changes of a member within about 100 ms of the last heartbeat may go unrecognised, so
  the answer is applied. This needs a send-rate limit above about 80 per second, or none.
- More than one change between a reconnect and a second drop, before all answers are in, may go
  unrecognised too.
- A member whose first value ever was lost is not sent again.

### Lost deletes

Deletes made as the Wi-Fi drops are lost the same way. When the outage is noticed, Colibri sends
again the deletes made since the client last heard from the server or in the second before.

- Deletes made 60 s or more before the outage was noticed are not sent again.
- On a second drop before all answers are in, these deletes go out once more, whatever their age, as
  do deletes made since the outage was noticed, unless the object was created on this client again.
- Like any delete during an outage, a delete sent again also removes an object another client
  created under the same id meanwhile.

The server remembers deletes for `MODEL_TOMBSTONE_SECONDS`, 10 minutes by default. For an object
another client deleted longer ago while this client was away, the server answers with nothing, so
this client sends it again and recreates it. See [After a
reconnect](../../colibri-server/docs/protocol.md#after-a-reconnect) in the protocol documentation.

### Protocol mismatch

A refused protocol version is final. `Status` becomes `ProtocolMismatch`, the client stops
reconnecting, and queued and later messages are dropped with a one-time warning. `ServerVersion` and
`ProtocolMismatchReason` hold the server's answer. Disable and re-enable the `WebServerConnection`
component to retry. A mismatch the server cannot report appears in `SuspectedProtocolMismatch`
instead, and the client keeps retrying.

## Web Interface for Logging

<img src="../img/weblogger.png" alt="WebLogger" width=400/>

The web logger sends diagnostic data, currently console logs, to the server's web interface. Use it
on devices without an accessible console, such as VR headsets and smartphones.

Add the `[RemoteLogger]` prefab to the scene. The Unity log then appears at
`http://<your-server-ip>:9011`.

- Log lines are sent once per second. Identical lines in one batch are sent once.
- Between two sends, at most the newest 1000 lines are kept. During an outage, this covers the whole
  outage, and the lines are sent once the connection is back.
- Where older lines were dropped, the server log shows one line instead:
  `Colibri: N log lines are missing here …`. The device's own log keeps everything.
- If the server refuses the client's protocol version, the kept lines are discarded.

## Voice Chat

`VoiceBroadcast` records the microphone and streams the audio. Add it to an empty GameObject. Call
`StartBroadcast` with any `short` voice id except `0`, and `StopBroadcast` to stop:

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

On Android (Meta Quest), `VoiceBroadcast` requests the microphone permission when it starts. If the
permission is refused, it logs an error and does not broadcast.

`VoiceReceiver` plays the voice of one voice id. Add it to a GameObject, usually a user
representation such as an avatar. Adding it also adds an `AudioSource`. For several receivers, make
a prefab. Call `StartPlayback` with the voice id to play. Distribute voice ids with `Sync.Send`:

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

The `Samples/VoiceChat` sample is a complete voice chat, with a `VoiceManager` that handles voice
ids and instantiates `VoiceReceiver` prefabs.

- **Codec:** raw PCM by default. To reduce bandwidth, enable *Use Opus Codec* on both
  `VoiceBroadcast` and `VoiceReceiver`. Opus works on Windows, Linux and Android.
- **Spatial audio:** the voice plays at the `VoiceReceiver`'s position. Enable *Spatialize* on the
  `AudioSource` and set *Spatial Blend* to `1` (3D). Spatializer plugins set in the audio settings
  also work.
- **IPv4:** the voice server listens on IPv4 only. Colibri sends voice to an IPv4 address of the
  server, so `localhost` also works on Windows, where it resolves to `::1` first. If the address has
  no IPv4 address or cannot be resolved, Colibri logs an error and turns voice chat off.
- **Apps:** the server forwards voice only to clients with the same *App Name*, so voice ids must be
  unique only within an app. Each voice packet carries an app id, a hash of the App Name ([Voice
  packets](../../colibri-server/docs/protocol.md#voice-packets-udp)). Without an App Name, no voice
  is sent, and Colibri logs an error once.
- **App Name changes at runtime:** voice moves to the new app from the next frame on. Synced objects
  and `Sync` messages, such as voice ids sent with `Sync.Send`, stay in the old app until
  `WebServerConnection` reconnects. Disable and re-enable that component to move them too.
- **Colibri 1.x clients** are not heard. The server drops their voice packets, which have no app id.
- A client receives voice only while its own `VoiceBroadcast` is broadcasting, because the server
  registers voice clients by the voice they send.

### Limitations

- Limited scalability: each voice packet goes to every other broadcasting client of the app.
- Limited security: the app id separates apps like the App Name does for synced objects, but it is
  not access control. Anyone who knows the App Name can receive the app's voice. Voice is not
  encrypted, even with TLS on.
- High bandwidth without Opus.

## Related documents

- [MIGRATION.md](../../MIGRATION.md): upgrading a Colibri 1.x project, for all three components.
  Read it with the changelog's [Breaking changes](../CHANGELOG.md#breaking-changes).
- [CHANGELOG.md](../CHANGELOG.md): all changes from `1.3.1` to `2.0.0`
- [v2-ease-of-use-and-performance.md](v2-ease-of-use-and-performance.md): design of the sync loop
  and the diagnostics, and migrating an existing project
- [colibri-server/docs/protocol.md](../../colibri-server/docs/protocol.md): the v3 wire protocol

## Development

### Running the tests

```sh
node colibri-unity/run-tests.mjs              # both suites
node colibri-unity/run-tests.mjs --editmode   # unit tests only, no server needed
node colibri-unity/run-tests.mjs --playmode   # end-to-end only
node colibri-unity/run-tests.mjs --editmode --stripping   # plus the code-stripping check
node colibri-unity/run-tests.mjs --tls        # plus the PlayMode suite again, over TLS
```

| Suite | Location | Description |
|---|---|---|
| EditMode | `Assets/Colibri/Tests/Editor/` | NUnit tests of the framing, JSON conversions, diagnostics, outage queue, message dispatch, `[Sync]` accessors (including the IL2CPP path), send-rate limit, connect timeout, build settings check, app-name warning, and the voice server address, packet format and packet queue. No server needed, runs wherever Unity runs. |
| PlayMode | `Assets/Tests/` | A Unity client and a raw v3 peer against a running `colibri-server`. Reconnects go through a proxy the test can cut. Mismatch detection runs against a scripted stand-in server. |

The script starts the PlayMode server with `docker compose` and stops it afterwards. A server
already listening on the port is used as it is and left running.

`--stripping`, off by default, checks whether `[Sync]` members survive managed code stripping. The
Editor never strips, so the script builds a Release IL2CPP player of `Assets/StrippingCheck/` for
the Editor's desktop platform with *Managed Stripping Level* High, and runs it.

- The player checks that every `[Sync]` member of `SyncTransform` and of a test model (a private
  serialized field, public value and reference fields, a property) still has its `[Sync]`, applies
  an update to each, and checks the values.
- It prints the result lines and exits with 1 on any failure.
- The check needs no server, takes a few minutes, and needs the IL2CPP module for the platform.
  Without the module, it is skipped with a notice.
- `ProjectSettings` are restored exactly after the build.

For PlayMode, the script also starts a TLS server from `tls-test-server/compose.yml`
([README](../tls-test-server/README.md)) on ports 9111 (https) and 9112 (TLS), for `TlsTests` and
`StoreOverTlsTests`. Without it, these tests are skipped, and the script reports this.

- `--tls` runs the PlayMode suite again with every connection over TLS, including the tests' own
  fake server and proxy, into `TestResults/PlayMode-TLS.xml` and `.log`.
  `ProtocolMismatchDetectionTests` skip themselves in that run. Without the TLS server, `--tls`
  fails.
- The certificate files in `tls-test-server/` (`cert.pem`, `key.pem`, `cert.pfx`) are public and for
  tests only.

Results go to `TestResults/` as NUnit XML plus the Editor log. Without a reachable server, the
end-to-end tests are skipped, not failed, and name the command that fixes it. The script reports a
suite in which every test was skipped as failed.

Windows refuses connections to a full listen backlog instead of leaving them unanswered, so these
connect-timeout tests are skipped there:
`ConnectTimeoutTests.AnAttemptNothingAnswersIsGivenUpAfterTheTimeout`,
`ConnectTimeoutTests.CancellingGivesUpTheAttemptAtOnce` and
`ProtocolMismatchDetectionTests.AnAttemptNothingAnswersIsGivenUpAfterFiveSecondsAndRetried`. On
Windows, check manually that a client with an unreachable server address leaves *Connecting* after
5 s.

| Variable | Default | Description |
|---|---|---|
| `COLIBRI_E2E_SERVER` | unset | Host of a server to use instead of starting one. When set, the script never starts or stops anything. |
| `COLIBRI_E2E_PORT` | `9011` | Web/Socket.IO port |
| `COLIBRI_E2E_TCP_PORT` | `9012` | Binary v3 port |
| `COLIBRI_E2E_NO_BUILD` | unset | Skip `docker compose --build` |
| `COLIBRI_E2E_TLS_PORT` | `9111` | TLS server's web port (https) |
| `COLIBRI_E2E_TLS_TCP_PORT` | `9112` | TLS server's binary v3 port (TLS) |
| `COLIBRI_E2E_TLS_CERT` | `tls-test-server/cert.pem` | TLS server's certificate |
| `COLIBRI_E2E_TLS` | unset | `1` runs the PlayMode suite over TLS. `--tls` sets it. |
| `COLIBRI_E2E_TLS_PFX` | `tls-test-server/cert.pfx` | Certificate the tests' own fake server and proxy serve over TLS |
| `UNITY_PATH` | Unity Hub's location | Editor to use |

The script requires the exact Editor version in `ProjectSettings/ProjectVersion.txt` unless
`UNITY_PATH` is set. Another version would upgrade the project in place, turning a test run into a
diff across the manifest and half of `ProjectSettings`. If the version is missing, the script lists
the installed ones with the `UNITY_PATH` to use. Commit such an upgrade deliberately, not with an
unrelated change. The package supports Unity 2022.3 LTS and newer. The pinned version is only what
the development project is opened with.

Both suites also run in **Window → General → Test Runner**. The end-to-end tests enable *Run In
Background* themselves. For the TLS tests, start the TLS server with
`docker compose -f colibri-unity/tls-test-server/compose.yml up -d --build`. For a run over TLS,
also set `COLIBRI_E2E_TLS=1` in the Editor's environment.

Voice chat has no end-to-end tests, because they need a microphone. Unit tests cover only the server
address choice, the packet format with its app id, and the queue that hands received packets to the
main thread.
