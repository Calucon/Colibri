# Colibri - Server

## Setup

### [Docker](https://hub.docker.com/r/hcikn/colibri) _(recommended)_

Use the following `docker-compose.yml` and run `docker-compose up -d`:

```yaml
services:
  colibri:
    build: .
    restart: unless-stopped
    container_name: colibri
    tty: true
    volumes:
        - ./data/:/srv/colibri/data
    ports:
      - 9011:9011 # web interface / web sockets
      - 9012:9012 # tcp (unity)
      - "9013:9013/udp" # voice
```

### Node

Requirements: NodeJS 24+

Clone this repository, build with `npm run build`, then start with `npm start`.

#### Configuration

The web interface, socketIO server, and voice server are customizable.
The main aspect here lies in changing default ports or hostnames to facilitate running the application behind a proxy.
Additionally, voice server settings such as the sampling rate and recording options can be adjusted.

For reference, see the `.env.example` file:

```basic
TCP_HOST='0.0.0.0'
TCP_PORT=9012

VOICE_HOST='0.0.0.0'
VOICE_PORT=9013
VOICE_SAMPLING_RATE=48000
VOICE_RECORDING=false

WEBSERVER_HOST='0.0.0.0'
WEBSERVER_PORT=9011
WEBSERVER_ROOT='../ui/'
BASE_URL=''

DATA_ROOT='../../data'

# Frames walked when capturing a stack trace for a logged error.
STACK_TRACE_LIMIT=30
```

## Features

A web interface is available on `http://<your-server-ip>:9011` to view the log output of connected clients.

## Protocol

Web clients talk to the server over Socket.IO. Unity clients talk to the server over TCP using a
custom binary protocol - see [docs/protocol.md](docs/protocol.md) for the wire format. **v2.0.0
introduces a v3 framing format that is a breaking change** for any TCP client older than this
version (older clients must be updated to the new framing, see `docs/protocol.md`); the Socket.IO
envelope is unaffected.

## Development

* `npm run watch`: Run development server with auto-compile and reload on file changes
* `npm run build`: Compilation
* `npm start`: Start server -- make sure to compile first.
* `npm run lint`: Lint the server and admin UI sources.
* `npm test`: Run the vitest unit suite.
* `npm run bench`: Run the vitest benchmark harness. Results are machine- and runtime-specific,
  so they are reported in the pull request that claims them rather than committed here; always
  measure a before/after pair on the same machine and the same Node version.
* `npm run test:tcpclient`: Manual smoke test - connects with the v3 TCP framing and sends a
  handshake.
