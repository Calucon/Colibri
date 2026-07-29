# ---- Builder: full devDependencies, Angular toolchain, TypeScript sources ----
FROM node:24-alpine AS builder

WORKDIR /srv/colibri/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime: production dependencies and build output only ----
FROM node:24-alpine AS runtime

WORKDIR /srv/colibri/

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /srv/colibri/dist ./dist

RUN mkdir -p data && chown -R node:node /srv/colibri
USER node

# Webserver
EXPOSE 9011
# TCP (Unity) Port
EXPOSE 9012
# Voice
EXPOSE 9013/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:9011/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD [ "npm", "start" ]
