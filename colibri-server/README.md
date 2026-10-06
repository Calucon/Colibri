# Colibri - Server

The server connects the Unity clients (TCP) and web clients (Socket.IO) of each app: it relays
their `broadcast::` messages and model changes to each other and keeps the app's synchronized
models. It also stores values through a small REST API, relays voice over UDP, and serves an
admin UI showing what every client logs.

Colibri has no authentication: anyone who can reach these ports can join any app, read and change
its data, and read the log. Run it on a network you trust.

## Setup

### [Docker](https://hub.docker.com/r/hcikn/colibri) _(recommended)_

Save the following as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  colibri:
    image: hcikn/colibri:2.0.0
    restart: unless-stopped
    container_name: colibri
    tty: true
    # The server logs to stdout/stderr, client log lines included, and Docker's default
    # json-file log never rotates: cap it rather than let a long study fill the disk.
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    volumes:
      - colibri-data:/srv/colibri/data
    ports:
      - 9011:9011 # web interface / web sockets / REST store
      - 9012:9012 # tcp (unity)
      - "9013:9013/udp" # voice

volumes:
  colibri-data:
```

The admin UI is then at `http://<your-server-ip>:9011`.

To run the server from a checkout of this repository instead of a published image, run
`docker compose up -d` in its `colibri-server` directory, whose own `docker-compose.yml` builds
the image from source and keeps the data in `./data`, or replace the `image:` line above with
`build: <path to the checkout>/colibri-server`.

`/srv/colibri/data` holds the REST store's `store.json` and any voice recordings. A named volume,
like `colibri-data` above, needs no setup. To keep the data in a directory on the host instead,
mount that directory:

```yaml
    volumes:
      - ./data:/srv/colibri/data
```

This works with a `./data` that Docker creates on first start, and with a root-owned `data`
directory left behind by colibri-server 1.x, whose `store.json` keeps its format. The container
starts as root, gives `/srv/colibri/data` to the `node` user (uid 1000) if anything in it belongs
to someone else, and then runs the server as `node`; on the host, the directory ends up owned by
uid 1000.

Started with `--user` (or `user:` in the compose file), the container cannot change owners, so
the data directory has to belong to that user already. Give a host directory to it yourself,
e.g. `sudo chown -R 1001:1001 ./data` for `--user 1001:1001`. A new named volume belongs to uid
1000, as `/srv/colibri/data` does in the image, so it only works as it is with
`--user 1000:1000`. For any other uid, use a host directory you gave to that uid, or drop
`--user` and let the container hand the directory to `node` itself.

If the server cannot write to its data directory, it says so at startup, on stderr - with the
path, the error and the uid it runs as - and in the admin UI's log. It keeps running, but saves
nothing: `store.json` and voice recordings stay in memory until it stops.

Settings from [Configuration](#configuration) go into an `environment:` section, e.g.
`CONSOLE_LOG_LEVEL: debug`. To use other ports, change only the host side of `ports:`, e.g.
`"8011:9011"`, and leave the ports inside the container as they are.

The image sets `NODE_ENV=production` and runs the server as PID 1, so `docker stop` shuts it down
cleanly and writes any pending store changes first.

### Node

Requirements: NodeJS 24+

Clone this repository, then in `colibri-server` install with `npm ci`, build with
`npm run build`, and start with `npm start`.

### Configuration

The server reads its settings from environment variables, and from a `.env` file in the
directory it is started from (`colibri-server` for `npm start`); a variable that is already set
in the environment wins. [`.env.example`](.env.example) lists every one with its default. In short:

| variable | default | |
| --- | --- | --- |
| `WEBSERVER_HOST`, `WEBSERVER_PORT` | `0.0.0.0`, `9011` | admin UI, web clients (Socket.IO) and the REST store |
| `TCP_HOST`, `TCP_PORT` | `0.0.0.0`, `9012` | Unity clients |
| `VOICE_HOST`, `VOICE_PORT` | `0.0.0.0`, `9013` | voice relay (UDP, IPv4) |
| `VOICE_SAMPLING_RATE` | `48000` | sampling rate written into voice recordings, in Hz |
| `VOICE_RECORDING` | `false` | `true` saves each voice client's audio as a `.wav` file in the data directory (PCM voice only) |
| `DATA_ROOT` | `../../data` | data directory: `store.json` and voice recordings |
| `WEBSERVER_ROOT` | `../ui/` | the admin UI's build output |
| `BASE_URL` | empty | path the admin UI is served under, e.g. `/colibri` behind a reverse proxy; `/api/store` and Socket.IO stay at the root |
| `STACK_TRACE_LIMIT` | `30` | stack frames captured for a logged error |
| `CONSOLE_LOG_LEVEL` | `info` | least severe level printed to stdout/stderr: `error`, `warn`, `info` or `debug` |
| `CONSOLE_LOG_BROADCAST_TRAFFIC` | `false` | `true` also prints every `broadcast::` message, whatever the level |
| `TCP_INBOUND_BACKLOG_LIMIT` | `2000` | messages from Unity clients that may wait for the server's main thread before it holds back `model::update` and drops `broadcast::` messages, so an overloaded server's memory and delay stay bounded; `0`: no limit |
| `CLIENT_MESSAGE_RATE_LIMIT`, `CLIENT_MESSAGE_RATE_BURST` | `1000`, `2000` | `model::update` and `broadcast::` messages a second that one client, Unity or web, may send, and how many at once after a quieter stretch; beyond that, the same happens to its messages. Catches a runaway send loop. `0` turns the limit off; the burst must be at least 1 |

`DATA_ROOT` and `WEBSERVER_ROOT` may be absolute paths, e.g. `DATA_ROOT=/var/lib/colibri`. A
relative path is taken from the compiled server's directory, `dist/server`, so the defaults are
`dist/ui` and the `data` directory next to `dist`. A port that is not an integer from 1 to 65535,
a sampling rate, stack trace limit or burst that is not a positive integer, a limit that is not a
whole number of 0 or more, or an unknown log level stops the server at startup, with a message
naming the variable. See [Load limits](#load-limits) for what the limits are for.

## Features

- **Admin UI** at `http://<your-server-ip>:9011`. The *Log* page shows what the server and every
  connected client log, filtered by app and level, with a separate *Sync traffic* switch for the
  continuous `broadcast::` messages. The *Statistics* page shows the connected clients and their
  latency.
- **Model synchronization** and **broadcasts** between the Unity and web clients of an app, see
  [docs/protocol.md](docs/protocol.md). Only `broadcast::` messages and model changes are passed
  on to other clients; see [What the server relays](docs/protocol.md#what-the-server-relays).
- **REST store** at `/api/store` on the web port, saved to `store.json` in the data directory, see
  [REST store](docs/protocol.md#rest-store).
- **Voice relay** on UDP port 9013. It does not separate apps: every voice packet goes to every
  other client currently sending voice to this server, and receivers pick voices by user id, so
  apps that share a server need distinct voice user ids.

### Logs

Everything the server logs, and every line a client sends through colibri-unity's
`RemoteLogging` or colibri-web's `RemoteLogger`, goes to two places:

- **stdout and stderr**, one line per message, `<time> <LEVEL> [<group>/<service>] <message>`;
  errors and warnings go to stderr. With Docker, `docker logs colibri` shows them: refused
  clients, failed `store.json` writes and client errors included. `CONSOLE_LOG_LEVEL` sets how
  much is printed (by default everything but debug messages), and `broadcast::` messages only
  appear with `CONSOLE_LOG_BROADCAST_TRAFFIC=true`.
- **the admin UI's Log page**, which keeps the last 20,000 messages of every level in memory,
  repeats merged into one entry. They are gone when the server restarts.

### Load limits

When clients send more than the server can process, it holds messages back and drops some
rather than fall further and further behind. If its main thread is `TCP_INBOUND_BACKLOG_LIMIT`
messages behind what the Unity clients sent, or one client sends more than
`CLIENT_MESSAGE_RATE_LIMIT` messages a second, `model::update` messages are held back and merged
per object - the latest value of every field still arrives, only later - and `broadcast::`
messages are dropped. Nothing else is ever held back or dropped. Synced objects then move less
smoothly for the other clients.

Each such episode is logged as a warning when it starts, naming `TCP_INBOUND_BACKLOG_LIMIT`, or
`CLIENT_MESSAGE_RATE_LIMIT` and the client, and again when it ends, with how many updates were
held back and messages dropped. [Inbound limits](docs/protocol.md#inbound-limits) describes what
the clients see.

The rate limit leaves ordinary clients alone: one syncing 10 objects 72 times a second sends 720
updates a second. The backlog warning means the server as a whole is taking in more than it can
process; fewer synced objects, a lower sync rate or fewer clients per app reduce the load. The
rate warning names one client that sends far more than the others, usually because something
sends every frame without a rate cap.

## Protocol

Web clients talk to the server over Socket.IO, and Unity clients over TCP using a custom binary
protocol - see [docs/protocol.md](docs/protocol.md) for both. **v2.0.0 introduces a v3 framing
format that is a breaking change** for Unity clients: colibri-unity 1.x cannot connect, update it
to 2.x. The Socket.IO envelope is unchanged, but colibri-web 1.x is refused too (see below), so
update web clients to 2.x as well.

Both transports announce a protocol version in their handshake, and the server refuses any client
that does not match its own - there is one supported version at a time and no negotiation. A
refused client is told why on the `colibri` channel and then disconnected, never appears in the
admin UI, and the server logs the refusal with both versions. A colibri-unity 1.x client cannot
read that refusal; the server recognises it by its 1.x framing instead and logs a warning naming
its address and the package to upgrade, at most once a minute per address. See
[Version checking](docs/protocol.md#version-checking).

## Development

* `npm ci`: Install the dependencies.
* `npm run watch`: Run development server with auto-compile and reload on file changes
* `npm run build`: Compilation
* `npm start`: Start server -- make sure to compile first.
* `npm run lint`: Lint the server and admin UI sources.
* `npm test`: Run the vitest unit suite.
* `npm run gui:test`: Run the admin UI's unit tests.
* `npm run bench`: Run the vitest benchmark harness. Results are machine- and runtime-specific,
  so they are reported in the pull request that claims them rather than committed here; always
  measure a before/after pair on the same machine and the same Node version.
* `npm run test:vectors`: Check that colibri-unity's protocol test vectors still match this
  server's encoder, and that colibri-web, colibri-unity and the admin UI announce this server's
  protocol version. CI runs it; `npm run test:vectors -- --emit` prints the C# vector table.
* `npm run test:tcpclient`: Manual smoke test against a server running on this machine (on
  `TCP_PORT`) - connects with the v3 TCP framing, handshakes and echoes heartbeats.
  `npm run test:tcpclient -- 1` announces protocol version 1 instead, to see a refusal. It exits
  2 when the server refused its protocol version, after printing the server's reason, and 1 when
  no heartbeat arrived; 0 means it connected and was heartbeated. A frame it cannot decode is
  printed as `Malformed frame from server` and ends the run.
* `npm run test:stressecho`: A raw TCP client that answers the probes of colibri-unity's Network
  Stress sample, so a single Unity editor can measure round trips
  (`npm run test:stressecho -- [app] [seconds]`).
* `npm run test:docker`: Needs Docker. Builds the image (or uses `COLIBRI_DOCKER_IMAGE`) and runs
  it with a fresh bind mount, a root-owned 1.x data directory, a named volume, and as
  `--user 1000:1000` on a named volume and on a root-owned directory. It checks that each one
  saves data (or, in the last case, says loudly that it cannot), keeps it across a restart and
  stops cleanly, then removes everything it created. Pass deployment names to run only those;
  `COLIBRI_DOCKER_PREFIX`, `COLIBRI_DOCKER_PORT` and `COLIBRI_DOCKER_TMPDIR` are described at the
  top of `test/docker-image-check.ts`.
