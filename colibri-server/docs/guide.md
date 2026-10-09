# colibri-server guide

Full reference for colibri-server. Overview: [README](../README.md). Wire protocol:
[protocol.md](protocol.md). Changes since 1.x: [v2-changelog.md](v2-changelog.md).

## Security

Colibri has no authentication. Anyone who can reach the ports can join any app, read and change its
data, and read the log. Run the server on a trusted network.

## Setup

### Docker

Recommended. Image: [`hcikn/colibri`](https://hub.docker.com/r/hcikn/colibri). Save as
`docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
  colibri:
    image: hcikn/colibri:2.0.0
    restart: unless-stopped
    container_name: colibri
    # Cap the log: Docker's json-file log never rotates, and client log lines are logged too.
    # Do not set `tty: true`, which mixes stderr into stdout in `docker logs`.
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    volumes:
      - colibri-data:/srv/colibri/data
    ports:
      - 9011:9011 # admin UI, web clients, REST store
      - 9012:9012 # TCP, Unity clients
      - "9013:9013/udp" # voice

volumes:
  colibri-data:
```

Admin UI: `http://<server-ip>:9011`.

To build from a checkout, run `docker compose up -d` in `colibri-server`, which builds from source
and keeps the data in `./data`. Or replace the `image:` line with
`build: <path to the checkout>/colibri-server`.

The image sets `NODE_ENV=production` and runs the server as PID 1, so `docker stop` shuts it down
cleanly, writing pending store changes and saving voice recordings in progress.

#### Data directory

`/srv/colibri/data` holds `store.json` and voice recordings. Mount the volume there and leave
`DATA_ROOT` unset. The container gives only this directory to the server's user. A volume mounted
elsewhere, with `DATA_ROOT` pointing at it, keeps its owner and is writable only if it belongs to uid
1000.

A named volume such as `colibri-data` needs no setup. For a host directory:

```yaml
    volumes:
      - ./data:/srv/colibri/data
```

This also works with a `./data` that Docker creates on first start, and with a root-owned `data`
directory from colibri-server 1.x, whose `store.json` format is unchanged. The container starts as
root, chowns `/srv/colibri/data` to `node` (uid 1000) if anything in it has another owner, and runs
the server as `node`. On the host, the directory then belongs to uid 1000.

#### Running as another user

With `--user` (or `user:` in the compose file), the container cannot change owners, so the data
directory must already belong to that user, e.g. `sudo chown -R 1001:1001 ./data` for
`--user 1001:1001`. A new named volume belongs to uid 1000, as `/srv/colibri/data` does in the image,
so it works unchanged only with `--user 1000:1000`. For another uid, use a host directory owned by that
uid, or drop `--user` so the container chowns the directory to `node`.

#### Unwritable data directory

If the server cannot write to its data directory, it prints `DATA_ROOT is not writable: <path>` on
stderr at startup, with the error, its uid and the fix for that error: chown the directory to that
uid, drop a read-only (`:ro`) mount, move a file out of the way, or free disk space. The admin UI log
shows it too. The server keeps running but saves nothing: `store.json` and voice recordings stay in
memory until it stops.

#### Settings and ports

Put [settings](#configuration) in `environment:`, e.g. `CONSOLE_LOG_LEVEL: debug`, or in a `.env`
file mounted at `/srv/colibri/.env`. To change a port, change only the host side of `ports:`, e.g.
`"8011:9011"`. If you set `WEBSERVER_PORT`, publish that port, e.g. `"9111:9111"`. The health check
reads `WEBSERVER_PORT` and `WEBSERVER_HOST` from the environment or the `.env` file.

### Node.js

Requires Node.js 24 or newer.

```sh
git clone https://github.com/hcigroupkonstanz/Colibri.git
cd Colibri/colibri-server
npm ci && npm run build && npm start
```

### Configuration

Set environment variables, or use a `.env` file in the working directory (`colibri-server` for
`npm start`). The environment takes precedence. [`.env.example`](../.env.example) lists every variable
with its default.

| Name | Default | Description |
| --- | --- | --- |
| `WEBSERVER_HOST`, `WEBSERVER_PORT` | `0.0.0.0`, `9011` | Admin UI, web clients (Socket.IO), REST store |
| `TCP_HOST`, `TCP_PORT` | `0.0.0.0`, `9012` | Unity clients |
| `VOICE_HOST`, `VOICE_PORT` | `0.0.0.0`, `9013` | Voice relay (UDP, IPv4) |
| `VOICE_SAMPLING_RATE` | `48000` | Sampling rate of voice recordings, in Hz |
| `VOICE_RECORDING` | `false` | `true` saves each voice client's PCM audio as a `.wav` file in the data directory, named as in [Voice packets](protocol.md#voice-packets-udp) |
| `DATA_ROOT` | `../../data` | Data directory: `store.json` and voice recordings |
| `WEBSERVER_ROOT` | `../ui/` | Admin UI build output |
| `BASE_URL` | empty | Path of the admin UI, e.g. `/colibri` behind a reverse proxy. `/api/store` and Socket.IO stay at the root. |
| `STACK_TRACE_LIMIT` | `30` | Stack frames captured for a logged error |
| `CONSOLE_LOG_LEVEL` | `info` | Least severe level printed to stdout/stderr: `error`, `warn`, `info` or `debug` |
| `CONSOLE_LOG_BROADCAST_TRAFFIC` | `false` | `true` also prints every `broadcast::` message, regardless of `CONSOLE_LOG_LEVEL` |
| `TCP_INBOUND_BACKLOG_LIMIT` | `2000` | Messages from Unity clients that may wait for the main thread before [load limiting](#load-limits) starts. `0`: no limit. |
| `CLIENT_MESSAGE_RATE_LIMIT`, `CLIENT_MESSAGE_RATE_BURST` | `1000`, `2000` | `model::update` and `broadcast::` messages per second one Unity or web client may send, and the burst after a quieter period. Beyond that, [load limiting](#load-limits) applies. Catches runaway send loops. `0`: no limit. The burst must be at least 1. |
| `TCP_IDLE_TIMEOUT_SECONDS` | `10` | Seconds a Unity client may send nothing, heartbeat replies included, before it is disconnected ([Idle timeout](#idle-timeout)). `0`: never. |
| `APP_CLIENT_WARNING_THRESHOLD` | `8` | Warn when one app has more clients than this, Unity and web together, admin UI excluded. Usually separate projects with the same app name. `0`: never. |
| `MODEL_TOMBSTONE_SECONDS` | `600` | Seconds a deleted synced object (model) is remembered. Meanwhile updates for it are ignored, so they cannot re-create it, and a re-request after a reconnect is answered with a delete. A client with the object in its scene again ends this early. Cleared with the app's models when its last client leaves. `0`: off. See [Deleted models](protocol.md#deleted-models). |
| `TLS_CERT`, `TLS_KEY` | empty | PEM files of the certificate with its chain, and of its private key. With both set, the TCP and web ports serve [TLS](#tls) only. |

`DATA_ROOT` and `WEBSERVER_ROOT` may be absolute, e.g. `DATA_ROOT=/var/lib/colibri`. Relative paths
resolve from `dist/server`, so the defaults are `dist/ui` and `data` next to `dist`. In Docker, leave
`DATA_ROOT` unset ([Data directory](#data-directory)).

Invalid values stop the server at startup with `Invalid <NAME>: "<value>" is not ...`: a port outside
1 to 65535, a `VOICE_SAMPLING_RATE`, `STACK_TRACE_LIMIT` or `CLIENT_MESSAGE_RATE_BURST` that is not a
positive integer, another number that is not an integer of 0 or more, or an unknown log level. Unusable
TLS files stop it too ([Startup errors](#startup-errors)).

## TLS

With `TLS_CERT` and `TLS_KEY` set, the TCP port (9012) accepts only TLS and the web port (9011) serves
only HTTPS and WSS, admin UI included, both with one certificate. Without them, both stay
unencrypted. There is no mixed mode, so every client must use TLS:

- **Unity:** tick *Server supports SSL/TLS?* in the Colibri configuration
  ([Unity guide](../../colibri-unity/docs/guide.md#tls)).
- **Web clients and admin UI:** use `https://<host>:9011` or `wss://<host>:9011`
  ([web guide](../../colibri-web/docs/guide.md#tls)). `http://<host>:9011` is closed without an
  answer, not redirected.

Frames and protocol version are unchanged inside TLS ([protocol](protocol.md#tls)). TLS does not
authenticate clients: anyone who can reach the ports can still join any app. Voice (UDP) stays
unencrypted.

### Enabling TLS

Set `TLS_CERT` to the PEM file of the certificate, followed by its chain (Let's Encrypt:
`fullchain.pem`), and `TLS_KEY` to the PEM file of its private key, without a passphrase (Let's
Encrypt: `privkey.pem`). Set both or neither, as absolute paths. Relative paths resolve from
`dist/server`, like `DATA_ROOT`. RSA and EC certificates both work. The server does not create
certificates. Use one from a certificate authority such as Let's Encrypt or your institution, or a
[self-signed one](#a-self-signed-certificate).

At startup the log shows `Web server listening on 0.0.0.0:9011, HTTPS and WSS only`,
`Starting Colibri TCP server on 0.0.0.0:9012, TLS only` and the certificate:

```
TLS is on, with the certificate in /srv/colibri/certs/fullchain.pem and the key in /srv/colibri/certs/privkey.pem: for DNS:colibri.example.org, IP Address:192.0.2.10, self-signed, valid until 2036-10-05T12:00:00.000Z; SHA-256 fingerprint 83:88:B1:CD:...
```

A Unity app can pin the fingerprint as *Server certificate SHA-256*. Case and colons are ignored
there. A self-issued certificate shows as `self-signed`, e.g. openssl's default, a server-only one from
PowerShell's `New-SelfSignedCertificate`, or colibri-unity's test certificate. The line then says how
a Unity app and a browser can accept it. A certificate from an authority shows `issued by <issuer>`.

### A self-signed certificate

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout privkey.pem -out fullchain.pem -days 3650 -subj "/CN=colibri.example.org" -addext "subjectAltName=DNS:colibri.example.org,IP:192.0.2.10"
```

Replace `colibri.example.org` and `192.0.2.10` with the name and IP address clients connect to. For
RSA, use `-newkey rsa:2048` instead of `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1`. Git for
Windows ships openssl in `usr/bin`. The certificate is valid for 10 years.

Unity apps accept it by fingerprint ([Unity guide](../../colibri-unity/docs/guide.md#tls)). A browser
must trust it once: open `https://<host>:9011` and accept it, or install it.

### TLS with Docker

```yaml
    environment:
      TLS_CERT: /srv/colibri/certs/fullchain.pem
      TLS_KEY: /srv/colibri/certs/privkey.pem
    volumes:
      - colibri-data:/srv/colibri/data
      - ./certs:/srv/colibri/certs:ro
```

- **Mount the directory, not the two files.** A single-file bind mount stays on the file it found at
  start and misses a renewal that replaces it.
- **uid 1000 must be able to read the key.** The server runs as the image's `node` user. openssl
  creates `privkey.pem` readable by its owner only. If that is not uid 1000:
  `sudo chown 1000 certs/privkey.pem`.
- **Let's Encrypt:** `live/` holds symbolic links into `../../archive`, which resolve only with all of
  `/etc/letsencrypt` mounted, and `privkey.pem` is readable by root only. Copy both files with a
  certbot deploy hook, which certbot runs after every renewal. Example
  `/etc/letsencrypt/renewal-hooks/deploy/colibri.sh` (executable), with `/opt/colibri/certs` mounted
  at `/srv/colibri/certs`:

  ```sh
  #!/bin/sh
  install -o 1000 -g 1000 -m 600 "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /opt/colibri/certs/
  ```

  Run it once manually for the current certificate, with
  `RENEWED_LINEAGE=/etc/letsencrypt/live/<your domain>`.
- `colibri-server/docker-compose.yml` has these lines, commented out.
- With TLS on, the health check uses HTTPS without verifying the certificate, so a container with a
  self-signed certificate is reported healthy.

### Renewal

The server reads both files every 10 s and switches once two consecutive reads match, so a renewed
certificate is in use within about 20 s, without a restart. Open connections keep their certificate.

If the new contents cannot be used, e.g. the certificate is renewed but the key not yet replaced, or
the files cannot be read, the server warns once and keeps the old certificate. It also warns once when
the certificate is not valid yet, has expired, or expires within 7 days or within the last fifth of its
lifetime, whichever is shorter.

### Startup errors

With TLS configured, these stop the server at startup. Each message names the variable, the file and
the fix.

| Message | Cause | Fix |
| --- | --- | --- |
| `TLS_CERT is set, but TLS_KEY is not.` or the reverse | Only one is set | Set both or neither |
| `Cannot read TLS_CERT (<path>): ...` or `TLS_KEY` | Missing, a directory, or not readable for the server's uid | Name a PEM file the server can read |
| `TLS_CERT (<path>) holds no certificate the server can use ...` | Not a PEM certificate, e.g. swapped with the key | Point `TLS_CERT` at the certificate |
| `TLS_KEY (<path>) holds no private key the server can use ...` | Not a PEM private key | Point `TLS_KEY` at the key |
| `TLS_KEY (<path>) is not the private key of the certificate in TLS_CERT ...` | Key of another certificate, also an RSA key with an EC certificate or the reverse, which OpenSSL alone accepts and then fails every handshake | Use the key that belongs to the certificate |
| `TLS_KEY (<path>) is protected by a passphrase ...` | The key has a passphrase | `openssl pkey -in <protected key> -out <key>` |

### TLS in the log

| Message | Cause | Fix |
| --- | --- | --- |
| WARN `Refusing a connection from <address> (Unity client '<name>', app '<app>'): it does not use TLS ...` | *Server supports SSL/TLS?* not ticked | Tick it |
| WARN `Refusing a connection from <address>: it looks like a Colibri 1.x client, which cannot use TLS ...` | Colibri 1.x client | Upgrade to 2.x |
| WARN `Refusing a connection from <address>: it starts a TLS handshake, but this server's TCP port does not use TLS ...` | *Server supports SSL/TLS?* ticked, server without TLS | Untick it, or enable TLS |
| INFO `TLS handshake with <address> failed: ...` | Gives the reason. If the client refused the certificate or hung up during the handshake, as many clients do to refuse one, it adds what to check. | See the message |
| WARN `TLS_CERT or TLS_KEY has changed, but cannot be used: ... Still serving the certificate with SHA-256 fingerprint ...` | Incomplete or broken renewal | See [Renewal](#renewal) |

Refusals and failed handshakes are logged at most once a minute per address, repeats at debug level.

### Reverse proxy

TLS can instead terminate in an existing reverse proxy, with `TLS_CERT` and `TLS_KEY` unset. For the
TCP port, use nginx's `stream` module with `listen 9012 ssl`, or a Traefik TCP router with TLS.
Colibri needs no changes, but then sees every client at the proxy's address, in the log and in the
per-address limits on warnings.

### Performance

TLS compared with unencrypted, on a shared 4-core Linux host with Node 24, with 30 to 60 Unity-like
clients sending 10 objects each at 20 to 30 Hz, and as many web clients:

- **Bytes:** about +15% from Unity to the server (29 bytes per TLS 1.2 record, frames of about 190
  bytes), +11% from the server to Unity, +3 to 4% on WSS.
- **CPU:** +4 to 5 percentage points (about +10%) on the TCP worker thread, which encrypts and
  decrypts the Unity traffic. 11 to 17 points less on the main thread, because Node packs many small
  WSS frames into fewer TLS records and send calls. Behind a TLS-terminating proxy, this saving is
  lost.
- **Latency:** median unchanged, within noise.
- **Connecting:** about +1 ms for the TCP connect. Median TLS handshake 4 to 5 ms with 120 clients
  connecting at once.

The cost of TLS on a headset was not measured.

## Features

- **Admin UI** at `http://<server-ip>:9011` (`https://` with [TLS](#tls)). The *Log* page shows the
  log of the server and every connected client, filtered by app and level, with a *Sync traffic*
  switch for the continuous `broadcast::` messages. The *Statistics* page shows the connected clients
  and their latency.
- **Model synchronization** and **broadcasts** between the Unity (TCP) and web (Socket.IO) clients of
  an app. The server keeps a copy of each app's models. Only `broadcast::` messages and model changes
  are relayed to other clients ([Relayed messages](protocol.md#relayed-messages)).
- **REST store** at `/api/store` on the web port, saved to `store.json` in the data directory
  ([REST store](protocol.md#rest-store)).
- **Voice relay** on UDP port 9013. A voice packet goes to the clients of the sender's app that send
  voice to this server. Each packet carries the app as an app id, the hash of the app name
  ([Voice packets](protocol.md#voice-packets-udp)). Like the app name on TCP, it separates apps but is
  not access control. Voice is not encrypted.

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

### Idle timeout

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

## Protocol version

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
