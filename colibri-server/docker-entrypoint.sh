#!/bin/sh
# Entrypoint of the colibri-server image.
#
# The server runs as the image's unprivileged "node" user (uid 1000). The directory mounted at
# /srv/colibri/data often belongs to root instead: Docker creates a missing bind-mount source as
# root, and colibri-server 1.x ran as root, so it left a root-owned data/ and store.json behind.
# The server could then not write store.json, while PUT /api/store kept answering 201.
#
# Started as root (the default), this hands the data directory to node and then runs the
# server as node. Started as anyone else (docker run --user ...), it cannot change ownership
# and does not try: the server checks DATA_ROOT itself and says on stderr what to fix.
#
# Either way it exec's, so the server ends up as PID 1 and `docker stop` signals it directly.
set -eu

DATA_DIR=/srv/colibri/data

if [ "$(id -u)" = '0' ]; then
    # Only walks the whole tree when something in it is not node's yet, so a data directory full
    # of voice recordings is not re-chowned on every start. -h changes a symlink itself, never
    # what it points to.
    if [ -d "$DATA_DIR" ] && [ -n "$(find "$DATA_DIR" ! -user node -print | head -n 1)" ]; then
        chown -Rh node:node "$DATA_DIR" ||
            echo "colibri-entrypoint: could not give $DATA_DIR to the node user (uid 1000); see the server's own message below" >&2
    fi
    exec su-exec node "$@"
fi

exec "$@"
