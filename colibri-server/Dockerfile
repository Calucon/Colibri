# ---- Builder: full devDependencies, Angular toolchain, TypeScript sources ----
FROM node:24-alpine AS builder

WORKDIR /srv/colibri/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime: production dependencies and build output only ----
FROM node:24-alpine AS runtime

# su-exec is how the entrypoint drops from root to the node user once the data directory is
# node's; see docker-entrypoint.sh.
RUN apk add --no-cache su-exec

WORKDIR /srv/colibri/

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /srv/colibri/dist ./dist

# The sed undoes a Windows checkout's CRLF line endings, which would otherwise leave the
# container unable to start ("no such file or directory" for /bin/sh\r).
COPY docker-entrypoint.sh /usr/local/bin/colibri-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/colibri-entrypoint.sh && chmod 755 /usr/local/bin/colibri-entrypoint.sh

RUN mkdir -p data && chown -R node:node /srv/colibri

# Webserver
EXPOSE 9011
# TCP (Unity) Port
EXPOSE 9012
# Voice
EXPOSE 9013/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9011/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Starts as root only long enough to give /srv/colibri/data to the node user, then runs the
# server as node. node itself, not npm, so the server is PID 1 and receives docker stop's SIGTERM.
ENTRYPOINT [ "colibri-entrypoint.sh" ]
CMD [ "node", "--enable-source-maps", "dist/server/main.js" ]
