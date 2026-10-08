# Colibri Server

Server for [Colibri](../README.md). It relays messages and synchronized-object updates between the
Unity and web clients of each app and keeps the current object state. It also provides a REST
key-value store, a UDP voice relay and an admin UI with all client logs.

Full documentation: [docs/guide.md](docs/guide.md)

## Requirements

- Docker, or Node.js 24 or newer
- Clients: colibri-unity 2.x, colibri-web 2.x. The server refuses 1.x clients ([upgrading](../MIGRATION.md)).

## Installation

### Docker

Save as `docker-compose.yml` and run `docker compose up -d`. The image is
[`hcikn/colibri`](https://hub.docker.com/r/hcikn/colibri) on Docker Hub.

```yaml
services:
  colibri:
    image: hcikn/colibri:2.0.0
    restart: unless-stopped
    container_name: colibri
    # Cap the log size. Do not set `tty: true`, which mixes stderr into stdout.
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

The admin UI is at `http://<server-ip>:9011`. `docker logs colibri` shows the log. Client setup:
[Unity](../docs/getting-started.md), [web](../colibri-web/README.md).

- **Data:** `/srv/colibri/data` holds `store.json` and voice recordings. Mount a volume or a host
  directory there, e.g. `./data:/srv/colibri/data`, and leave `DATA_ROOT` unset. The container makes
  uid 1000 the owner of a host directory, including one from colibri-server 1.x. With `--user`, see
  [Running as another user](docs/guide.md#running-as-another-user).
- **Settings:** an `environment:` section, e.g. `CONSOLE_LOG_LEVEL: debug`, or a `.env` file
  mounted at `/srv/colibri/.env`.
- **Ports:** change only the host side of `ports:`, e.g. `"8011:9011"`.

### Node.js

Clone the repository. In `colibri-server`, run `npm ci`, `npm run build` and `npm start`. Ports and
admin UI are the same as with Docker. Data is stored in `colibri-server/data`.

## Configuration

Set environment variables or a `.env` file in the working directory, which is `colibri-server` for
`npm start` and `/srv/colibri` in the Docker image. [`.env.example`](.env.example) lists all
variables with defaults ([reference](docs/guide.md#configuration)).

`TLS_CERT` and `TLS_KEY` enable [TLS](docs/guide.md#tls) on ports 9011 and 9012. All clients must
then use TLS. Voice chat stays unencrypted.

## Security

Colibri has no authentication. Anyone who can reach the ports can join any app, read and change its
data, and read the log. Run the server on a trusted network.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Startup error on stderr about the data directory | The server cannot write there. It keeps running but saves nothing. | Apply the fix named in the message ([details](docs/guide.md#when-the-server-cannot-save)) |
| A client is missing from the admin UI, and the log shows `Refusing ...` | A 1.x client, or the Unity app's *Server supports SSL/TLS?* does not match the server | Update the client to 2.x, or fix the TLS setting ([TLS in the log](docs/guide.md#tls-in-the-log)) |
| A Unity client disconnects while stopped at a breakpoint | The debugger also pauses heartbeat replies | Raise `TCP_IDLE_TIMEOUT_SECONDS` (default 10) or set it to `0` |
| `App 'MyApp' now has 9 clients, more than 8 ...` | Separate projects use the same app name | Give each project its own app name |
| Warning naming `TCP_INBOUND_BACKLOG_LIMIT`, synced objects lag, broadcasts missing | The server is overloaded | Sync fewer objects, less often, or with fewer clients per app ([Load limits](docs/guide.md#load-limits)) |
| Warning naming `CLIENT_MESSAGE_RATE_LIMIT` | The named client sends too much, usually every frame | Cap that client's send rate |
| Voice from another app | The voice relay does not separate apps | Use distinct voice user ids per app |
| Admin UI Log page empty after a restart | It keeps the last 20,000 messages in memory only | Use `docker logs colibri`, filtered by `CONSOLE_LOG_LEVEL` |

## Development

Run `npm ci`, then `npm run watch` for a development server that recompiles and reloads on changes.
`npm test` runs the unit tests and `npm run lint` the linter ([all scripts](docs/guide.md#development)).

## Documentation

- [Guide](docs/guide.md): [Docker](docs/guide.md#docker-recommended), [logs](docs/guide.md#logs),
  [load limits](docs/guide.md#load-limits), [lost connections](docs/guide.md#lost-connections)
- [Version checking](docs/guide.md#protocol), [wire protocol](docs/protocol.md),
  [changes since 1.x](docs/v2-changelog.md)
