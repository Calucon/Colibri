# Colibri Unity

Unity client for [Colibri](../README.md): messaging, object synchronization, a
[key-value store](docs/guide.md#remote-store), [remote logging](docs/guide.md#web-interface-for-logging)
and [voice chat](docs/guide.md#voice-chat). Requires a [colibri-server](../colibri-server/README.md)
and interoperates with [colibri-web](../colibri-web/README.md).

Full documentation: [docs/guide.md](docs/guide.md)

## Requirements

- Unity 2022.3 LTS or newer
- colibri-server 2.0.0 or newer. Colibri Unity 2.x cannot connect to a 1.x server, and Colibri
  Unity 1.x cannot connect to a 2.x server ([mismatch symptoms](docs/guide.md#requirements)).

## Installation

In *Window → Package Manager → + → Install package from git URL*, enter:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

The Package Manager must list **Colibri 2.0.0** or newer. Errors about UniRx or UniTask mean that a
1.x version was installed. To pin a version, append a
[release](https://github.com/hcigroupkonstanz/Colibri/releases) tag such as `#v2.0.0`. The
dependency `com.unity.nuget.newtonsoft-json` is installed automatically, except with the
[`.unitypackage`](docs/guide.md#unitypackage).

## Quick start

1. In *Window → Colibri Configuration*, set **App Name** and **Server Address**, then click
   *Save Config*. The window opens after installation.
   - Only clients with the same app name exchange data. Choose a name no other project on the
     server uses, not `test` or `myAppName`.
   - The address is a host name or IP address without `http://`. The default public test server
     `colibri.hci.uni-konstanz.de` works only while it runs colibri-server 2.x. To host your own,
     see [colibri-server](../colibri-server/README.md#installation).
2. Enable *Project Settings → Player → Resolution and Presentation → **Run In Background***.
   Otherwise the Editor pauses the game when its window loses focus. The client stays *Connected*,
   but sends and delivers no messages.
3. Import the **SendData** sample from *Window → Package Manager → Colibri → Samples*. Its scene
   requires [TextMeshPro essential resources](docs/guide.md#samples).
4. Create a second client. Unity cannot open a project twice, so copy the `Assets`, `Packages` and
   `ProjectSettings` folders to a new folder and open that from Unity Hub.
5. Open the sample scene in both Editors and enter Play mode. Enable `SendProperties` on the
   `[ClickMe]` object in one Editor. The other Editor logs `Received message with value …`. The
   sender does not receive its own messages.

## Usage

### Messages

```c#
using HCIKonstanz.Colibri.Synchronization;

// Receiver. Register before anything is sent.
void Start() => Sync.Receive<float>("MyChannel", OnNumber);
void OnNumber(float value) { /* called for every float on "MyChannel" */ }

// Sender, on another client:
Sync.Send("MyChannel", 5f);
```

- `Sync.Send` delivers to all other clients with the same app name, not to the sender.
- Channel and type must match on both sides.
- Supported types: `bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color`
  and arrays of these. Send other data as [`JToken`](docs/guide.md#sending-data-between-clients).
- A listener that is a method of a `MonoBehaviour` is removed when the component is destroyed.

### SyncTransform

Add `SyncTransform` to a GameObject to sync its active state, position, rotation and scale. Late
joiners receive the current state. For objects instantiated at runtime, add the
`[SyncTransformManager]` prefab from `Packages/Colibri/Prefabs/` to the scene and set its `Template`
to the object's prefab, which needs a `ModelId` and an empty `Id` ([details](docs/guide.md#synctransform)).

### SyncBehaviour

```c#
public class MyClass : SyncBehaviour<MyClass> { [Sync] public string MyString = "123"; }
public class MyClassManager : SyncBehaviourManager<MyClass> { }
```

Add the manager to the scene and set its `Template` to a prefab with the model component
([details](docs/guide.md#syncbehaviour)). To use `Awake` or `OnDestroy` in a model, declare them
`protected override` and call `base.Awake()` or `base.OnDestroy()`. A plain `void Awake()` compiles
with warning CS0114, but the object never syncs.

## Configuration

*Window → Colibri Configuration* saves to `Assets/Resources/ColibriConfig`. Ports, TLS and the voice
sampling rate under *Optional Config* must match the server ([options](docs/guide.md#configuration)).
For a server with [TLS](docs/guide.md#tls), tick *Server supports SSL/TLS?*. For a self-signed
certificate, also paste the fingerprint from the server log into *Server certificate SHA-256*.
Voice chat is not encrypted.

## Meta Quest

Quest builds target Android with IL2CPP and ARM64. On a headset, `localhost` is the headset, so use
the server's IPv4 address on the LAN. For the Android target, *Window → Colibri Configuration*
checks two Player settings and offers fixes ([details](docs/guide.md#meta-quest-and-android)):

| Player setting | Required value | Failure on the headset otherwise |
| --- | --- | --- |
| Internet Access | *Require* | The app never connects |
| Allow downloads over HTTP | *Always allowed*, if TLS is off and the server is not `localhost` | `Store` calls fail with "Insecure connection not allowed" |

## Troubleshooting

*Window → Colibri Status* shows the connection state, app name, last connection error, channels
with listeners and the last 20 messages. [All console messages](docs/guide.md#troubleshooting).

| Symptom | Cause | Fix |
|---|---|---|
| Two connected clients do not see each other | Different app names | Use the same app name. The connect log line shows the name in use. |
| One client is connected but silent | Its Editor is in the background with *Run In Background* off | Enable *Run In Background* |
| `a float arrived on channel 'chat', but the listener registered there expects string…` | Type mismatch | Send and receive the same type on a channel |
| `… did not answer within 5 s` | Wrong address, another network, Wi-Fi client isolation or a firewall | Check the address and the network |
| `… failed (ConnectionRefused), retrying...` | No process listens on the TCP port | Start colibri-server or correct *TCP server Port* |
| `… This usually means a protocol mismatch…` | 1.x server, not a colibri-server, or TLS on the server only | Use a 2.x server, correct the address or tick *Server supports SSL/TLS?* |
| `… did not answer the TLS handshake` or `rejected the certificate of …` | TLS settings do not match the server | See [TLS errors](docs/guide.md#tls-errors) |
| Unknown objects or messages appear | Another project uses the same app name | Choose a unique app name |
| Works in the Editor but not on the Quest | Android Player settings | See [Meta Quest](#meta-quest) and the `Colibri (Android build): …` warnings |

## Documentation

- [Guide](docs/guide.md), including [outages](docs/guide.md#connection-and-outages) and [send rate](docs/guide.md#how-often-synced-objects-send)
- [Upgrading from 1.x](../MIGRATION.md), [CHANGELOG](CHANGELOG.md),
  [sync loop internals](docs/v2-ease-of-use-and-performance.md), [v3 protocol](../colibri-server/docs/protocol.md)

## Testing

`node colibri-unity/run-tests.mjs` runs the EditMode unit tests and the PlayMode end-to-end tests
against a real server. `--editmode` or `--playmode` runs one suite ([details](docs/guide.md#running-the-tests)).

## License

Copyright (c) HCI Group University of Konstanz. All rights reserved. Licensed under the
[MIT](../LICENSE) license. Third-party libraries: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt).
