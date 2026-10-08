# Colibri

<img src="img/colibri_header.png" width=800/>

Colibri synchronizes data between Unity and web clients for cross-reality research prototypes.

## Features

- Pub/sub messages on named channels
- Synchronized objects: `SyncTransform` and `SyncBehaviour` in Unity, `SyncModel` on the web
- Key-value store on the server
- Remote logging to the server's admin UI
- Voice chat between Unity clients
- TLS for client connections

Colibri is built for lab networks and favors low latency and high throughput over bandwidth savings.

## Components

| Component | Description |
| --- | --- |
| [colibri-unity](colibri-unity/README.md) | Unity client, Unity 2022.3 or newer |
| [colibri-web](colibri-web/README.md) | TypeScript client, [`@hcikn/colibri`](https://www.npmjs.com/package/@hcikn/colibri) on npm |
| [colibri-server](colibri-server/README.md) | Server, Node.js 24 or newer or [Docker image](https://hub.docker.com/r/hcikn/colibri) |

Clients and server must all be 2.x. Upgrading from 1.x: [MIGRATION.md](MIGRATION.md).

## Getting started

Tutorial: [docs/getting-started.md](docs/getting-started.md)

## Testing

`npm test` in `colibri-server/` and `colibri-web/` runs the unit tests. `node colibri-unity/run-tests.mjs`
runs the Unity unit and end-to-end tests ([details](colibri-unity/docs/guide.md#running-the-tests)).

## Security

Colibri has no authentication. Any client that can reach a server can join any app on it and read
and change its data. Run the server on a trusted network.

## Publication

Colibri was published at the ISMAR'23 Adjunct "1st Joint Workshop on Cross Reality":

> Sebastian Hubenschmid\*, Daniel Immanuel Fink\*, Johannes Zagermann, Jonathan Wieland, Harald Reiterer, Tiare Feuchtner. In: *ISMAR'23 Adjunct.* 2023. **Colibri: A toolkit for rapid prototyping of networking across realities**. doi: [10.1109/ISMAR-Adjunct60411.2023.00010](https://doi.org/10.1109/ISMAR-Adjunct60411.2023.00010)

Citation metadata: [CITATION.cff](CITATION.cff). Contact: [Sebastian Hubenschmid](https://hci.uni-konstanz.de/personen/wissenschaftliche-mitarbeiterinnen/sebastian-hubenschmid/) ([GitHub](https://github.com/SebiH)), [Daniel Fink](https://hci.uni-konstanz.de/personen/wissenschaftliche-mitarbeiterinnen/daniel-fink/) ([GitHub](https://github.com/dunifi91)).

## Projects built with early Colibri versions

| [ReLive](https://github.com/hcigroupkonstanz/ReLive) | [STREAM](https://github.com/hcigroupkonstanz/STREAM) |
| --- | --- |
| [![ReLive](http://img.youtube.com/vi/BaNZ02QkZ_k/0.jpg)](http://www.youtube.com/watch?v=BaNZ02QkZ_k "ReLive") | [![STREAM](http://img.youtube.com/vi/5tEgNzuehuM/0.jpg)](http://www.youtube.com/watch?v=5tEgNzuehuM "STREAM") |
| [**Re-Locations**](https://github.com/hcigroupkonstanz/Re-locations) | [**ARound the Smartphone**](https://github.com/hcigroupkonstanz/ARound-the-Smartphone) |
| [![Re-Locations](http://img.youtube.com/vi/_D0_B4Rux1U/0.jpg)](http://www.youtube.com/watch?v=_D0_B4Rux1U "Re-Locations") | [![ARound the Smartphone](http://img.youtube.com/vi/p6cHwLxHWJg/0.jpg)](http://www.youtube.com/watch?v=p6cHwLxHWJg "ARound the Smartphone") |

## License

[MIT](LICENSE)
