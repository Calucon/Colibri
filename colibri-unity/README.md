# Colibri Unity

The Unity client of [Colibri](../README.md), an open-source toolkit for networking across realities
in research prototypes. It sends messages between clients, keeps objects in sync, stores data on the
server and carries voice chat. Everything goes through a [colibri-server](../colibri-server/), and
browser clients built with [colibri-web](../colibri-web/) can share the same data.

This page gets two clients talking. Every option, limit and console message is in the
**[full guide](docs/guide.md)**.

## Requirements

- Unity 2022.3 LTS or higher
- **colibri-server 2.0.0 or higher.** This package speaks the [v3 binary TCP
  protocol](../colibri-server/docs/protocol.md) and cannot talk to a 1.x server, nor Colibri Unity
  1.x to a 2.0.0 server: upgrade both together ([what a mismatch looks like](docs/guide.md#requirements)).

## Installation

In Unity, open *Window → Package Manager → + → Install package from git URL* and paste:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

The Package Manager should list **Colibri 2.0.0** or newer; errors about UniRx or UniTask mean it
installed a 1.x. To stay on one version, append a release tag from the [Releases
page](https://github.com/hcigroupkonstanz/Colibri/releases), e.g. `#v2.0.0`. The only dependency,
Newtonsoft JSON, is installed with it. A [`.unitypackage`](docs/guide.md#unitypackage) works too,
but then Newtonsoft JSON (`com.unity.nuget.newtonsoft-json`) has to be added by hand.

## Quickstart

1. Install Colibri. A configuration window opens on its own.
2. Enter an **App Name** and the **Server Address**, then press *Save Config*.
   - Only clients with the *same* app name see each other, and nobody else on the server should use
     it: avoid names many people pick, such as `test` or `myAppName`.
   - The address is a host name or IP address, without `http://`. It is preset to the public test
     server `colibri.hci.uni-konstanz.de`, usable only while that runs colibri-server 2.x. You can
     also [run your own](../colibri-server/README.md#docker-recommended). On a headset, `localhost`
     is the headset: enter the IPv4 address of the server machine on your local network.
3. Turn on *Project Settings → Player → Resolution and Presentation → **Run In Background***. With it
   off, the Editor stops running your game when its window loses focus: still *Connected*, but
   nothing is sent or delivered.
4. Import the **SendData** sample (*Window → Package Manager → Colibri → Samples → Import*). Its
   scene needs [TextMeshPro's essential resources](docs/guide.md#samples).
5. Start a second client. Unity does not open one project twice, so copy the project's `Assets`,
   `Packages` and `ProjectSettings` folders into a new folder and open that from the Unity Hub.
6. Open the sample scene in both Editors and press Play. Tick `SendProperties` on the `[ClickMe]`
   object in one: the other's console logs `Received message with value …`. The sender logs no such
   line, as a client never receives what it sent itself.

## Usage

### Sending data

```c#
using HCIKonstanz.Colibri.Synchronization;

void Start() {
    Sync.Receive<float>("MyChannel", OnNumber); // register before anything is sent
}

private void OnNumber(float myNumber) {
    // runs whenever a float arrives on "MyChannel"
}

// anywhere, on another client:
Sync.Send("MyChannel", 5f);
```

`Sync.Send` reaches every other client with the same app name, never the sender. Channel *and* type
have to match. `bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color` and
arrays of them work directly, anything else as JSON. A listener registered by a `MonoBehaviour` is
removed by itself when that component is destroyed ([details](docs/guide.md#sending-data-between-clients)).

### SyncTransform

Attach `SyncTransform` to an object: its active state, position, rotation and scale are synced
between all clients, and a client that joins later gets the current state. For objects created at
runtime, add the `[SyncTransformManager]` prefab from `Packages/Colibri/Prefabs/` to the scene and
set its `Template` to the object's prefab, which needs a `ModelId` and an empty `Id`
([details](docs/guide.md#synctransform)).

### SyncBehaviour

To sync your own data model, inherit from `SyncBehaviour<T>` and mark members with `[Sync]`:

```c#
public class MyClass : SyncBehaviour<MyClass>
{
    [Sync] public string MyString = "123";
}

public class MyClassManager : SyncBehaviourManager<MyClass> { }
```

Add the manager to your scene, e.g. on an empty GameObject, and set its `Template` to a prefab with
the model script ([details](docs/guide.md#syncbehaviour)). Need `Awake` or `OnDestroy` in a model?
Override them and call `base.Awake()` / `base.OnDestroy()`: a plain `void Awake()` hides the one
where the object registers, and it never syncs (only compiler warning CS0114 says so).

## Meta Quest

A Quest app is an Android build: switch the platform to Android under *File → Build Settings* (*File
→ Build Profiles* on Unity 6). Quest needs ARM64, which on Android requires the IL2CPP scripting
backend. With the Android target active, *Window → Colibri Configuration* checks two Player settings
that otherwise only fail on the headset, each with a button that fixes it:

- **Internet Access** must be *Require*.
- **Allow downloads over HTTP** must be *Always allowed* while `SSL/TLS` is off and the server is not
  `localhost`.

More in [Meta Quest and Android](docs/guide.md#meta-quest-and-android).

## When something does not work

Open **Window → Colibri Status** while the game runs. It shows whether you are connected, to which
server and as which app name, why the last attempt failed, which channels have listeners, and the
last 20 messages in and out. Colibri also reports the common mistakes in the console:

| Symptom | Cause |
|---|---|
| Two clients don't see each other | Different app names; the connect log names the one in use |
| Connected, but one client is silent | Its Editor window is in the background and *Run In Background* is off |
| `a float arrived on channel 'chat', but the listener registered there expects string…` | Channel *and* type have to match |
| `… did not answer within 5 s` | Wrong address, another network, Wi-Fi client isolation or a firewall |
| `… failed (ConnectionRefused), retrying...` | Nothing listens on the TCP port: start colibri-server, or check the port |
| `… This usually means a protocol mismatch…` | The server is probably 1.x, or the address is not a colibri-server |
| Objects or messages you did not create | Someone else uses the same app name |
| `NullReferenceException` in `TMP_Settings` in a sample | [TextMeshPro's essential resources](docs/guide.md#samples) are missing |
| Works in the Editor, not on the Quest | Look for `Colibri (Android build): …` in the console ([Meta Quest](#meta-quest)) |

Every message and what to do about it: [Troubleshooting](docs/guide.md#troubleshooting).

## Full guide

[docs/guide.md](docs/guide.md) has everything in detail:

- [Configuration](docs/guide.md#configuration): ports, plain HTTP, voice sampling rate, send rate
- [Meta Quest and Android](docs/guide.md#meta-quest-and-android): build checks, code stripping, IL2CPP
- [Sending Data between Clients](docs/guide.md#sending-data-between-clients): JSON, your own classes
- [SyncTransform](docs/guide.md#synctransform): hiding, deleting, physics, objects created at runtime
- [SyncBehaviour](docs/guide.md#syncbehaviour): models, managers and templates
- [How often synced objects send](docs/guide.md#how-often-synced-objects-send): the 30 Hz default
- [Remote Store](docs/guide.md#remote-store): saving data on the server between sessions
- [Connection and outages](docs/guide.md#connection-and-outages): reconnects, what waits, what is dropped
- [Web Interface for Logging](docs/guide.md#web-interface-for-logging): a device's console logs in the server's web interface
- [Voice Chat](docs/guide.md#voice-chat): broadcasting, receiving, Opus, spatial audio

Also: [MIGRATION.md](../MIGRATION.md) (upgrading a 1.x project), [CHANGELOG.md](CHANGELOG.md), [how
the sync loop and diagnostics work](docs/v2-ease-of-use-and-performance.md), [v3 wire
protocol](../colibri-server/docs/protocol.md).

## License

Copyright (c) HCI Group University of Konstanz. All rights reserved.

Licensed under the [MIT](../LICENSE) license.

This repository includes third-party open source libraries as listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt).

## For maintainers

`node colibri-unity/run-tests.mjs` runs the EditMode unit tests and the PlayMode end-to-end tests
against a real server; `--editmode` or `--playmode` runs one suite. What each needs, the environment
variables and the tests skipped on Windows: [Running the tests](docs/guide.md#running-the-tests).
