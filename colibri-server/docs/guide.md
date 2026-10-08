# colibri-server guide

The full reference for colibri-server: setup, every setting, what it logs, and how it behaves under
load and when clients vanish. The [README](../README.md) is the short version. The wire protocol
is in [protocol.md](protocol.md), and everything that changed since 1.x in
[v2-changelog.md](v2-changelog.md).

- [Setup](#setup)
  - [Docker (recommended)](#docker-recommended): [data directory](#data-directory),
    [running as another user](#running-as-another-user),
    [when the server cannot save](#when-the-server-cannot-save),
    [settings and ports](#settings-and-ports)
  - [Node](#node)
  - [Configuration](#configuration)
- [TLS](#tls): [turning it on](#turning-it-on),
  [a self-signed certificate](#a-self-signed-certificate), [Docker](#tls-with-docker),
  [renewal](#renewal), [what stops the server](#what-stops-the-server-at-startup),
  [the log](#tls-in-the-log), [a reverse proxy instead](#a-reverse-proxy-instead),
  [performance](#performance)
- [Features](#features)
  - [Logs](#logs)
  - [Load limits](#load-limits)
  - [Lost connections](#lost-connections)
- [Protocol](#protocol)
- [Development](#development)

The server connects the Unity clients (TCP) and web clients (Socket.IO) of each app: it relays
their messages (`broadcast::`) and changes to synced objects (models) to each other, and keeps a
copy of each app's models. It also stores values through a small REST API, relays voice over UDP,
and serves an admin UI showing what every client logs.

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

The admin UI is then at `http://<your-server-ip>:9011`.

To run the server from a checkout of this repository instead of a published image, run
`docker compose up -d` in its `colibri-server` directory, whose own `docker-compose.yml` builds
the image from source and keeps the data in `./data`, or replace the `image:` line above with
`build: <path to the checkout>/colibri-server`.

The image sets `NODE_ENV=production` and runs the server as PID 1, so `docker stop` shuts it down
cleanly: it writes any pending store changes first, and saves the voice recordings still in
progress.

#### Data directory

`/srv/colibri/data` holds the REST store's `store.json` and any voice recordings. Mount your
volume there and leave `DATA_ROOT` unset: in the image, that path is the server's data directory,
and the only one the container gives to the server's user (see below). A volume mounted anywhere
else, with `DATA_ROOT` pointing at it, is left as it is, so unless it already belongs to uid 1000
the server cannot save there.

A named volume, like `colibri-data` above, needs no setup. To keep the data in a directory on the
host instead, mount that directory:

```yaml
    volumes:
      - ./data:/srv/colibri/data
```

This works with a `./data` that Docker creates on first start, and with a root-owned `data`
directory left behind by colibri-server 1.x, whose `store.json` keeps its format. The container
starts as root, gives `/srv/colibri/data` to the `node` user (uid 1000) if anything in it belongs
to someone else, and then runs the server as `node`; on the host, the directory ends up owned by
uid 1000.

#### Running as another user

Started with `--user` (or `user:` in the compose file), the container cannot change owners, so
the data directory has to belong to that user already. Give a host directory to it yourself,
e.g. `sudo chown -R 1001:1001 ./data` for `--user 1001:1001`. A new named volume belongs to uid
1000, as `/srv/colibri/data` does in the image, so it only works as it is with
`--user 1000:1000`. For any other uid, use a host directory you gave to that uid, or drop
`--user` and let the container hand the directory to `node` itself.

#### When the server cannot save

If the server cannot write to its data directory, it says so at startup on stderr, with the path,
the error, the uid it runs as and what to do about that error: give the directory to that uid,
drop a read-only (`:ro`) mount, move a file out of the way, or free disk space. It says so in the
admin UI's log too. It keeps running, but saves nothing: `store.json` and voice recordings stay in
memory until it stops.

#### Settings and ports

Settings from [Configuration](#configuration) go into an `environment:` section, e.g.
`CONSOLE_LOG_LEVEL: debug`, or into a `.env` file mounted at `/srv/colibri/.env`. To use other
ports, change only the host side of `ports:`, e.g. `"8011:9011"`, and leave the ports inside the
container as they are. If you do set `WEBSERVER_PORT`, publish that port instead, e.g.
`"9111:9111"`; the image's health check follows `WEBSERVER_PORT` and `WEBSERVER_HOST` wherever
they are set.

### Node

Requirements: NodeJS 24+

Clone this repository, then in `colibri-server` install with `npm ci`, build with
`npm run build`, and start with `npm start`.

### Configuration

The server reads its settings from environment variables, and from a `.env` file in the
directory it is started from (`colibri-server` for `npm start`); a variable that is already set
in the environment wins. [`.env.example`](../.env.example) lists every one with its default. In
short:

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
| `TCP_IDLE_TIMEOUT_SECONDS` | `10` | seconds a Unity client may send nothing at all, not even its heartbeat replies, before it is disconnected as gone, e.g. a headset that left the Wi-Fi; a connection that has not handshaked by then is closed too. A client reading a message larger than 64 KiB gets up to 6 times this much more (see [Lost connections](#lost-connections)). `0`: never |
| `APP_CLIENT_WARNING_THRESHOLD` | `8` | log a warning when one app has more clients than this, Unity and web together, the admin UI not counted; usually separate projects that kept the same app name. `0`: never |
| `MODEL_TOMBSTONE_SECONDS` | `600` | seconds the server remembers that a synced object (model) was deleted. Meanwhile it ignores updates for it, so one another client sent before the delete reached it cannot create the object again, and it tells a client that asks for the object again after a reconnect to delete its copy. A client that has the object in its scene again, such as a scene with placed objects loaded again, ends this early. Forgotten with the app's models once its last client has left. `0`: not remembered. See [Deleted models](protocol.md#deleted-models) |
| `TLS_CERT`, `TLS_KEY` | empty | PEM files of the certificate (with its chain) and of its private key. Set both, and the TCP port and the web port serve TLS only; see [TLS](#tls) |

`DATA_ROOT` and `WEBSERVER_ROOT` may be absolute paths, e.g. `DATA_ROOT=/var/lib/colibri`. A
relative path is taken from the compiled server's directory, `dist/server`, so the defaults are
`dist/ui` and the `data` directory next to `dist`. In the Docker image, leave `DATA_ROOT` alone and
mount the data at `/srv/colibri/data` instead (see [Data directory](#data-directory)).

A port that is not an integer from 1 to 65535, a sampling rate, stack trace limit or burst that is
not a positive integer, any other number that is not a whole number of 0 or more, or an unknown
log level stops the server at startup, with a message naming the variable. So does a `TLS_CERT`
or `TLS_KEY` it cannot use (see [What stops the server at startup](#what-stops-the-server-at-startup)).
See [Load limits](#load-limits) for what the limits are for.

## TLS

With `TLS_CERT` and `TLS_KEY` set, the server encrypts both client ports with one certificate: the
TCP port (9012) accepts only TLS, and the web port (9011) serves only HTTPS and WSS, the admin UI
included. With neither set, nothing changes. There is no mixed mode, so once TLS is on, every
client has to use it:

- **Unity:** tick *Server supports SSL/TLS?* in the Colibri configuration; see
  [TLS](../../colibri-unity/docs/guide.md#tls) in the Unity guide.
- **Web clients and the admin UI:** use `https://<host>:9011` or `wss://<host>:9011`; see
  [TLS](../../colibri-web/docs/guide.md#tls) in the web guide. `http://<host>:9011` then gets no
  answer: the connection is closed, not redirected.

Inside TLS the frames are the same, and the protocol version does not change (see
[TLS](protocol.md#tls) in the protocol docs). TLS encrypts the connections, but does not
authenticate clients: anyone who can reach the ports can still join any app. The voice relay (UDP)
stays unencrypted.

### Turning it on

| variable | |
| --- | --- |
| `TLS_CERT` | PEM file of the certificate, followed by its chain (Let's Encrypt: `fullchain.pem`) |
| `TLS_KEY` | PEM file of its private key, without a passphrase (Let's Encrypt: `privkey.pem`) |

Set both or neither. Use absolute paths: a relative one is resolved like `DATA_ROOT`, from
`dist/server`. RSA and EC certificates both work. The server never makes a certificate itself: use
one from a certificate authority, such as Let's Encrypt or your institution, or a
[self-signed one](#a-self-signed-certificate).

At startup the log then says `Web server listening on 0.0.0.0:9011, HTTPS and WSS only` and
`Starting Colibri TCP server on 0.0.0.0:9012, TLS only`, and names the certificate:

```
TLS is on, with the certificate in /srv/colibri/certs/fullchain.pem and the key in /srv/colibri/certs/privkey.pem: for DNS:colibri.example.org, IP Address:192.0.2.10, self-signed, valid until 2036-10-05T12:00:00.000Z; SHA-256 fingerprint 83:88:B1:CD:...
```

The fingerprint is what a Unity app can pin as its *Server certificate SHA-256*; case and colons do
not matter there. A certificate issued by itself is called `self-signed`: openssl's default
self-signed certificate, a server-only one such as PowerShell's `New-SelfSignedCertificate` makes,
or colibri-unity's test certificate. For those the line goes on to say how a Unity app and a
browser come to accept it. A certificate from an authority says `issued by <issuer>` instead.

### A self-signed certificate

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout privkey.pem -out fullchain.pem -days 3650 -subj "/CN=colibri.example.org" -addext "subjectAltName=DNS:colibri.example.org,IP:192.0.2.10"
```

Replace `colibri.example.org` and `192.0.2.10` with the name and the IP address clients connect
to. For RSA, replace `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1` with `-newkey rsa:2048`. On
Windows, Git for Windows ships openssl (in `usr/bin`). The certificate is valid for 10 years.

Unity apps accept it by its fingerprint (see [TLS](../../colibri-unity/docs/guide.md#tls) in the
Unity guide). A browser has to be told once to trust it: open `https://<host>:9011` and accept it,
or install it.

### TLS with Docker

```yaml
    environment:
      TLS_CERT: /srv/colibri/certs/fullchain.pem
      TLS_KEY: /srv/colibri/certs/privkey.pem
    volumes:
      - colibri-data:/srv/colibri/data
      - ./certs:/srv/colibri/certs:ro
```

- **Mount the directory, not the two files.** A bind mount of a single file stays on the file it
  found at start, so a renewal that replaces the file is never seen.
- **uid 1000 has to be able to read the key**: the server runs as the image's `node` user. openssl
  writes `privkey.pem` readable for its owner only, so give it to uid 1000
  (`sudo chown 1000 certs/privkey.pem`) if that is not you.
- **Let's Encrypt** needs one more step. Its `live/` entries are symbolic links into
  `../../archive`, which resolve only with the whole `/etc/letsencrypt` mounted, and it keeps
  `privkey.pem` readable for root only. Copy both files instead, with a certbot deploy hook, which
  certbot runs again after every renewal. For example, as
  `/etc/letsencrypt/renewal-hooks/deploy/colibri.sh` (executable), with `/opt/colibri/certs`
  mounted at `/srv/colibri/certs`:

  ```sh
  #!/bin/sh
  install -o 1000 -g 1000 -m 600 "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /opt/colibri/certs/
  ```

  Run it once by hand for the certificate you have now, with
  `RENEWED_LINEAGE=/etc/letsencrypt/live/<your domain>`.
- The `docker-compose.yml` in `colibri-server` has these lines, commented out.
- With TLS on, the image's health check uses HTTPS without checking the certificate, so a container
  with a self-signed certificate is healthy too.

### Renewal

The server reads both files every 10 s, and uses new contents once two reads in a row agree, so a
renewed certificate is in use within about 20 s, without a restart. Open connections keep the
certificate they started with.

New contents it cannot use (for example, the certificate renewed but the key not replaced yet), or
files it cannot read, get one warning, and the old certificate stays in use. The server also warns
once when the certificate is not valid yet, expires within 7 days (a short-lived certificate: in the
last fifth of its lifetime), or has expired.

### What stops the server at startup

With TLS configured, the server refuses to start, with a message that names the variable, the file
and the fix, when:

- only one of `TLS_CERT` and `TLS_KEY` is set;
- a file is missing, or is a directory;
- the server's uid cannot read it;
- the certificate and the key are swapped;
- the key belongs to another certificate, including an RSA key with an EC certificate or the other
  way round, which OpenSSL alone would accept and then fail every handshake;
- the key has a passphrase.

### TLS in the log

| message | what it means |
| --- | --- |
| WARN `Refusing a connection from <address> (Unity client '<name>', app '<app>'): it does not use TLS, and this server's TCP port accepts only TLS connections ...` | A Unity app without *Server supports SSL/TLS?* ticked. A Colibri 1.x client, which cannot use TLS, gets its own variant |
| WARN `Refusing a connection from <address>: it starts a TLS handshake, but this server's TCP port does not use TLS ...` | A Unity app with the setting ticked, on a server without TLS: untick it, or set `TLS_CERT` and `TLS_KEY` |
| INFO `TLS handshake with <address> failed: ...` | Says why. When the client refused the certificate, or hung up during the handshake (which is how many clients refuse one), it adds what to check about the certificate |
| WARN `TLS_CERT or TLS_KEY has changed, but cannot be used: ... Still serving the certificate with SHA-256 fingerprint ...` | A renewal is incomplete or broken; see [Renewal](#renewal) |

The first three are logged at most once a minute per address, the repeats at debug level.

### A reverse proxy instead

TLS can also end in a reverse proxy you already run, in front of a server with `TLS_CERT` and
`TLS_KEY` unset: for the TCP port, nginx's `stream` module with `listen 9012 ssl`, or a Traefik TCP
router with TLS. Colibri needs no change for that. The drawback: the server then sees every client
at the proxy's address, in the log and in the warnings it limits per address.

### Performance

Measured on a shared 4-core Linux host with Node 24, TLS against plain, with 30 to 60 Unity-like
clients sending 10 objects each at 20 to 30 Hz, and as many web clients:

- **Bytes:** about 15% more from Unity to the server (29 bytes per TLS 1.2 record, on frames of
  about 190 bytes), 11% more from the server to Unity, and 3 to 4% more on WSS.
- **CPU:** the TCP worker thread, which encrypts and decrypts the Unity traffic, uses 4 to 5
  percentage points more (about +10%). The main thread uses 11 to 17 points less, because Node packs
  many small WSS frames into fewer TLS records and send calls; behind a TLS-terminating proxy, that
  saving does not happen.
- **Latency:** the median is unchanged, within noise.
- **Connecting:** about 1 ms more for the TCP connect, and a median TLS handshake of 4 to 5 ms
  while 120 clients connect at once.

The cost of TLS on a headset itself was not measured.

## Features

- **Admin UI** at `http://<your-server-ip>:9011` (`https://` with [TLS](#tls)). The *Log* page
  shows what the server and every connected client log, filtered by app and level, with a separate
  *Sync traffic* switch for the continuous `broadcast::` messages. The *Statistics* page shows the
  connected clients and their latency.
- **Model synchronization** and **broadcasts** between the Unity and web clients of an app, see
  [protocol.md](protocol.md). Only `broadcast::` messages and model changes are passed on to other
  clients; see [What the server relays](protocol.md#what-the-server-relays).
- **REST store** at `/api/store` on the web port, saved to `store.json` in the data directory, see
  [REST store](protocol.md#rest-store).
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

Every message is relayed to every other client of the same app, so the server's work grows with
the square of an app's size. Give each project that shares a server an app name of its own. Each
time an app grows past `APP_CLIENT_WARNING_THRESHOLD` clients, the server logs a warning naming
it, e.g. `App 'MyApp' now has 9 clients, more than 8 (APP_CLIENT_WARNING_THRESHOLD) ...`.

When clients send more than the server can process, it holds messages back and drops some
rather than fall further and further behind. If its main thread is `TCP_INBOUND_BACKLOG_LIMIT`
messages behind what the Unity clients sent, or one client sends more than
`CLIENT_MESSAGE_RATE_LIMIT` messages a second, `model::update` messages are held back and merged
per object (the latest value of every field still arrives, only later) and `broadcast::`
messages are dropped. Nothing else is ever held back or dropped. Synced objects then move less
smoothly for the other clients. Updates are held for at most 1000 objects per client: an update
for one more object is lost, and that object reaches the server's copy of the app's models and the
other clients only when it changes again.

An episode that goes on for a second is logged as a warning then, naming
`TCP_INBOUND_BACKLOG_LIMIT`, or `CLIENT_MESSAGE_RATE_LIMIT` and the client, and again when it
ends, with how many updates were held back and messages dropped. A shorter one is summed up in a
single debug line, unless it lost updates, which is a warning however short the episode was.
[Inbound limits](protocol.md#inbound-limits) quotes the warnings and describes what the clients
see.

The rate limit leaves ordinary clients alone: one syncing 10 objects 72 times a second sends 720
updates a second. The backlog warning means the server as a whole is taking in more than it can
process; fewer synced objects, a lower sync rate or fewer clients per app reduce the load. The
rate warning names one client that sends far more than the others, usually because something
sends every frame without a rate cap.

### Lost connections

The server sends every Unity client a heartbeat ten times a second, and the client echoes it. A
Unity client that has sent nothing at all for `TCP_IDLE_TIMEOUT_SECONDS` (10 s) is disconnected
as if it had closed the connection, with a warning naming it: the other clients of its app see it
leave, and if it was the app's last client, the app's synchronized models are cleared. This is how
a headset that left the Wi-Fi or went to sleep without closing its connection is noticed, which
would otherwise take the operating system many minutes.

A message larger than 64 KiB has no heartbeat inside it, so a client reading one over a slow link
echoes nothing until it is through, and the server cannot see it being read. Until it echoes a
heartbeat sent after the message, such a client may stay silent one more
`TCP_IDLE_TIMEOUT_SECONDS` for every 64 KiB of the message, but at most 6 more (60 s at the
default). A 4 MiB message thus needs a link of about 60 KB/s or faster; over a slower one the
client is disconnected, and the warning names the message's size. Data sent as messages of 64 KiB
or less has heartbeats in between and needs no extra time. The price is that a headset that is
gone by the time such a message is sent to it, or goes while it is being read, is noticed that much
later: within 7 times `TCP_IDLE_TIMEOUT_SECONDS` (70 s) at worst.

colibri-unity echoes the heartbeats off Unity's main thread, so a long scene load does not trip
the timeout. A debugger stopped at a breakpoint usually pauses every thread of the app, though,
and then it does: when you debug with long breakpoints against a server of your own, raise
`TCP_IDLE_TIMEOUT_SECONDS` or set it to `0`. Web clients are not affected; Socket.IO's own ping
notices a web client that has gone, within about 45 s.

## Protocol

Web clients talk to the server over Socket.IO, and Unity clients over TCP using a custom binary
protocol; [protocol.md](protocol.md) describes both. **v2.0.0 introduces a v3 framing format that
is a breaking change** for Unity clients: colibri-unity 1.x cannot connect, update it to 2.x. The
Socket.IO envelope is unchanged, but colibri-web 1.x is refused too (see below), so update web
clients to 2.x as well.

Both transports announce a protocol version in their handshake, and the server refuses any client
that does not match its own: there is one supported version at a time and no negotiation. A
refused client is told why on the `colibri` channel and then disconnected, never appears in the
admin UI, and the server logs the refusal with both versions. A colibri-unity 1.x client cannot
read that refusal; the server recognises it by its 1.x framing instead and logs a warning naming
its address and the package to upgrade, at most once a minute per address. See
[Version checking](protocol.md#version-checking).

## Development

- `npm ci`: Install the dependencies.
- `npm run watch`: Run the development server, which compiles and reloads on file changes.
- `npm run build`: Compile.
- `npm start`: Start the server; compile first.
- `npm run lint`: Lint the server and admin UI sources.
- `npm test`: Run the vitest unit suite. The TLS tests make their certificates with `openssl`, so
  it has to be on `PATH` (Git for Windows ships it in `usr/bin`). In a test,
  `createTestCertificate(dir, name, { commonName, keyType: 'ec' | 'rsa', signedBy, serverOnly })`
  from [`test/tls-test-certificate.ts`](../test/tls-test-certificate.ts) makes a certificate valid
  for 2 days, self-signed or signed by another test certificate.
- `npm run gui:test`: Run the admin UI's unit tests.
- `npm run bench`: Run the vitest benchmark harness. Results are machine- and runtime-specific,
  so they are reported in the pull request that claims them rather than committed here; always
  measure a before/after pair on the same machine and the same Node version.
- `npm run test:vectors`: Check that colibri-unity's protocol test vectors still match this
  server's encoder, and that colibri-web, colibri-unity and the admin UI announce this server's
  protocol version. CI runs it; `npm run test:vectors -- --emit` prints the C# vector table.
- `npm run test:tcpclient`: Manual smoke test against a server running on this machine (on
  `TCP_PORT`): connects with the v3 TCP framing, handshakes and echoes heartbeats.
  `npm run test:tcpclient -- 1` announces protocol version 1 instead, to see a refusal. It exits
  0 when it connected and was heartbeated, 2 when the server refused its protocol version, after
  printing the server's reason, and 1 when something is wrong with the server: no heartbeat
  arrived, or the server sent a frame it cannot decode, which is printed as
  `Malformed frame from server` and ends the run. Against a server with TLS:
  `TCP_PORT=<port> npm run test:tcpclient -- --tls`, plus `--insecure` for a certificate that is
  not trusted here, such as a self-signed one, and `--host <name>` for a server on another machine.
  It prints the SHA-256 fingerprint of the server's certificate. The manual probe
  `tsx test/tcp-crosstalk-check.ts [app] [ms] --tls [--insecure] [--host <name>]` takes the same
  options.
- `npm run test:stressecho`: A raw TCP client that answers the probes of colibri-unity's Network
  Stress sample, so a single Unity editor can measure round trips
  (`npm run test:stressecho -- [app] [seconds]`).
- `npm run test:docker`: Needs Docker. Builds the image (or uses `COLIBRI_DOCKER_IMAGE`) and runs
  it with a fresh bind mount, a root-owned 1.x data directory, a named volume, as
  `--user 1000:1000` on a named volume and on a root-owned directory, with the 1.x data mounted
  read-only, without `CAP_CHOWN`, with `WEBSERVER_PORT` set in the environment and in a mounted
  `.env`, with `WEBSERVER_HOST=localhost`, and with TLS on both ports. It checks that each one
  becomes healthy and stops cleanly, and that it saves data and keeps it across a restart, or,
  where it cannot save, that it says so loudly, with advice that fits. With TLS, it also checks the
  certificate both ports serve, that a client without TLS is refused, and that a renewed
  certificate is taken up without a restart; like `npm test`, it needs `openssl` on `PATH` for
  that. It removes each container once its deployment is done, and everything else it created at
  the end. Pass deployment names to run only those; `COLIBRI_DOCKER_PREFIX`,
  `COLIBRI_DOCKER_PORT` and `COLIBRI_DOCKER_TMPDIR` are described at the top of
  [`test/docker-image-check.ts`](../test/docker-image-check.ts).
