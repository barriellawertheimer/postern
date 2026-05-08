# syntax=docker/dockerfile:1.7

# ---- builder ---------------------------------------------------------------
# Compiles TypeScript, builds the Vite admin-ui bundle, and prunes dev deps.
# `node:20-slim` ships glibc, which means better-sqlite3's prebuilt linux-x64
# and linux-arm64 binaries work without compilation. If a future better-sqlite3
# bump drops a prebuild, add `apt-get install -y python3 build-essential` here.
FROM node:20-slim AS builder

WORKDIR /app

# Root deps first — copied separately so source edits don't bust the layer.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# admin-ui deps next, same caching reasoning.
COPY admin-ui/package.json admin-ui/package-lock.json ./admin-ui/
RUN --mount=type=cache,target=/root/.npm \
    cd admin-ui && npm ci --no-audit --no-fund

# Source.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY admin-ui ./admin-ui

# Build: Vite admin-ui → tsc server → copy schema.sql + admin-ui/dist into dist/.
RUN npm run build

# Drop dev deps so the runtime stage copies a slim node_modules.
RUN npm prune --omit=dev


# ---- runtime ---------------------------------------------------------------
FROM node:20-slim AS runtime

LABEL org.opencontainers.image.title="postern" \
      org.opencontainers.image.description="Self-hosted contact-form alias backend with admin UI"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/postern.db

WORKDIR /app

# Runtime artifacts only.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

# /data — DB lives here. Operator mounts a volume.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

# Hits /healthz on the configured PORT. Exits non-zero on non-200 or fetch error.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
