# Colibri - Server

The server connects the Unity clients (TCP) and web clients (Socket.IO) of each app: it relays
their `broadcast::` messages and model changes to each other and keeps the app's synchronized
models. It also stores values through a small REST API, relays voice over UDP, and serves an
admin UI showing what every client logs.

Colibri has no authentication: anyone who can reach these ports can join any app, read and change
its data, and read the log. Run it on a network you trust.

**Requirements:** Docker, or NodeJS 24+ to run from source. Clients need colibri-unity 2.x or
colibri-web 2.x; the server refuses 1.x clients. Upgrading a 1.x project:
[MIGRATION.md](../MIGRATION.md).

## Setup

### [Docker](https://hub.docker.com/r/hcikn/colibri) _(recommended)_

Save the following as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  colibri:
    image: hcikn/colibri:2.0.0
    restart: unless-stopped
    container_name: colibri
    # The server logs to stdout/stderr, client log lines included, and Docker's default
    # json-file log never rotates: cap it rather than let a long study fill the disk. And no
    # `tty: true`: with a TTY, `docker logs` has no stderr, and the warnings and errors are
    # mixed into stdout.
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

The admin UI is then at `http://<your-server-ip>:9011`, and `docker logs colibri` shows the log.

- **Data:** `/srv/colibri/data` holds the REST store's `store.json` and any voice recordings.
  Mount a volume or a host directory there, e.g. `./data:/srv/colibri/data`, and leave
  `DATA_ROOT` unset. A host directory, one left behind by colibri-server 1.x included, ends up
  owned by uid 1000. With `--user`, see
  [Running as another user](docs/guide.md#running-as-another-user).
- **Settings** go into an `environment:` section, e.g. `CONSOLE_LOG_LEVEL: debug`, or into a
  `.env` file mounted at `/srv/colibri/.env`.
- **Other ports:** change only the host side of `ports:`, e.g. `"8011:9011"`.

### Node

Clone this repository, then in `colibri-server` run `npm ci`, `npm run build` and `npm start`.

## Configuration

Settings are environment variables, or lines in a `.env` file in the directory the server is
started from: `colibri-server` for `npm start`, `/srv/colibri` in the Docker image.
[`.env.example`](.env.example) lists every one with its default, and the
[guide](docs/guide.md#configuration) explains each.

## Common problems

| What you see | What to do |
| --- | --- |
| At startup, on stderr: the server cannot write to its data directory | It keeps running but saves nothing. The message names the path, the uid and the fix; see [When the server cannot save](docs/guide.md#when-the-server-cannot-save) |
| A client never appears in the admin UI, and the server log has a line starting `Refusing` | Its protocol version does not match: 1.x clients cannot use a 2.x server. Update colibri-unity or colibri-web to 2.x |
| A Unity client is disconnected while you are stopped at a breakpoint | A debugger usually pauses the thread that answers heartbeats too. On your own server, raise `TCP_IDLE_TIMEOUT_SECONDS` (10 s) or set it to `0` |
| `App 'MyApp' now has 9 clients, more than 8 ...` | Usually separate projects that kept the same app name. Give each project its own |
| Warnings naming `TCP_INBOUND_BACKLOG_LIMIT` or `CLIENT_MESSAGE_RATE_LIMIT`; synced objects move less smoothly | The server holds back updates and drops broadcasts to keep up. Backlog: sync fewer objects, at a lower rate, or with fewer clients per app. Rate: the named client sends far more than the others, usually every frame without a rate cap. See [Load limits](docs/guide.md#load-limits) |
| Several apps share a server and use voice | The voice relay does not separate apps, and receivers pick voices by user id: give each app distinct voice user ids |
| The admin UI's Log page is empty after a restart | It keeps the last 20,000 messages in memory only. They also go to stdout and stderr (`docker logs colibri`), filtered by `CONSOLE_LOG_LEVEL` |

## Full guide

[docs/guide.md](docs/guide.md) has everything else:

- [Docker in detail](docs/guide.md#docker-recommended): building from a checkout, host
  directories, `--user`, clean shutdown
- [Configuration](docs/guide.md#configuration): every variable, and what stops the server at startup
- [Logs](docs/guide.md#logs), [Load limits](docs/guide.md#load-limits) and
  [Lost connections](docs/guide.md#lost-connections)
- [Protocol and version checking](docs/guide.md#protocol)
- [Development](docs/guide.md#development): every npm script

The wire protocol for both transports is in [docs/protocol.md](docs/protocol.md), and everything
that changed since 1.x in [docs/v2-changelog.md](docs/v2-changelog.md).

## Development

`npm ci`, then `npm run watch` for a development server that compiles and reloads on file changes,
`npm test` for the unit tests and `npm run lint`. The other scripts are in the
[guide](docs/guide.md#development).
