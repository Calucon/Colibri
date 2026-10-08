# Colibri

<img src="img/colibri_header.png" width=800/>

Provides easy model synchronization and easy access to data for faster cross reality prototyping for research.

## Where to start

- **New to Colibri?** [Getting started](docs/getting-started.md): install it, connect two clients,
  and share your first value.
- **Coming from Colibri 1.x?** [MIGRATION.md](MIGRATION.md): a checklist of what changed in all
  three components, and which of it will not fail to compile.
- **Working on Colibri itself?** `npm test` runs the unit tests in `colibri-server/` and
  `colibri-web/`; `node colibri-unity/run-tests.mjs` runs the Unity client's tests, the end-to-end
  ones against a real server ([details](colibri-unity/README.md#for-maintainers)).

## Components

Each component has its own README, the place to start for that component.

| Component | What it is |
| --- | --- |
| [colibri-unity](colibri-unity/README.md) | Unity client, for Unity 2022.3 or newer |
| [colibri-web](colibri-web/README.md) | TypeScript client, [`@hcikn/colibri`](https://www.npmjs.com/package/@hcikn/colibri) on npm |
| [colibri-server](colibri-server/README.md) | The server, for Node.js 24 or as a [Docker image](https://hub.docker.com/r/hcikn/colibri) |

## Features

Colibri focuses on three key areas:

- **Low Barrier:** Setup and Development is as simple as possible, with little to no configuration/code required.
- **Multi-Platform:** Colibri (currently) supports synchronization between Unity and Web.
- **Lab Conditions:** XR Research prototypes often benefit from ideal lab conditions, allowing Colibri to focus on low latency and high throughput (at the cost of potential bandwidth savings and some performance).

Colibri has no authentication, by design: anyone who can reach a server can join any app on it, and read and change
its data. Run it on a network you trust.

## Publication / Authors

This is the code repository of the ISMAR'23 Adjunct publication for the  "1st Joint Workshop on Cross Reality":

> Sebastian Hubenschmid\*, Daniel Immanuel Fink\*, Johannes Zagermann, Jonathan Wieland, Harald Reiterer, Tiare Feuchtner. In: *ISMAR'23 Adjunct.* 2023. **Colibri: A toolkit for rapid prototyping of networking across realities**. doi: [10.1109/ISMAR-Adjunct60411.2023.00010](https://doi.org/10.1109/ISMAR-Adjunct60411.2023.00010) 

For questions or feedback, please contact [Sebastian Hubenschmid](https://hci.uni-konstanz.de/personen/wissenschaftliche-mitarbeiterinnen/sebastian-hubenschmid/) ([GitHub](https://github.com/SebiH)) or [Daniel Fink](https://hci.uni-konstanz.de/personen/wissenschaftliche-mitarbeiterinnen/daniel-fink/) ([GitHub](https://github.com/dunifi91)).

## Examples

The following research projects were built using (early versions of) Colibri.

### [ReLive](https://github.com/hcigroupkonstanz/ReLive)

[![ReLive Youtube Video](http://img.youtube.com/vi/BaNZ02QkZ_k/0.jpg)](http://www.youtube.com/watch?v=BaNZ02QkZ_k "ReLive")

### [STREAM](https://github.com/hcigroupkonstanz/STREAM)

[![STREAM](http://img.youtube.com/vi/5tEgNzuehuM/0.jpg)](http://www.youtube.com/watch?v=5tEgNzuehuM "STREAM")

### [Re-Locations](https://github.com/hcigroupkonstanz/Re-locations)

[![Re-Locations](http://img.youtube.com/vi/_D0_B4Rux1U/0.jpg)](http://www.youtube.com/watch?v=_D0_B4Rux1U "Re-Locations")

### [ARound the Smartphone](https://github.com/hcigroupkonstanz/ARound-the-Smartphone)

[![ARound the Smartphone](http://img.youtube.com/vi/p6cHwLxHWJg/0.jpg)](http://www.youtube.com/watch?v=p6cHwLxHWJg "ARound the Smartphone")
