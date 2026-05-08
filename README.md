# Postern

Self-hosted contact-form backend that mints a per-visitor SimpleLogin alias on
submission, sends the form contents to your Proton inbox, and arranges things
so a Reply in Proton routes the response back to the visitor through SL —
without ever exposing the visitor's real address.

A SQLite DB (encrypted at rest) maps each visitor email to a single alias so
returning visitors don't get a new one each time.

## Prerequisites

- **SimpleLogin paid plan.** The free tier is capped at 10 aliases total; this
  app mints one per visitor.
- **Proton Mail Plus (or above)** with a custom domain whose MX is delegated
  to SimpleLogin (catch-all). Create an SMTP token in Proton settings — that's
  what `SMTP_PASS` is.
- **Cloudflare Turnstile** site key + secret for the front-end form.

## Quickstart

```bash
npm install
cp .env.example .env
# Generate two independent 32-byte keys
node -e "console.log('ENC_KEY='+require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log('LOOKUP_KEY='+require('node:crypto').randomBytes(32).toString('hex'))"
# Paste them into .env, plus your SL/Proton/Turnstile creds
npm run dev
```

`POST /contact` with:

```json
{
  "firstName": "John",
  "lastName":  "Doe",
  "email":     "john.doe@example.com",
  "message":   "Hi from your website",
  "turnstileToken": "<from cf-turnstile-response>"
}
```

Returns `202 {"status":"sent","reused":false}` (or `"reused":true` for a
returning visitor). When the daily cap circuit-breaker is tripped you get
`202 {"status":"queued","deferred":true}` instead — the visitor and alias are
still recorded; only the SMTP send is skipped.

## How the loop closes

```
visitor → POST /contact → mint alias `john.doe.12345@yourdomain.com`
                       → SL adds visitor as a contact, returns reverse alias
                          `re-abcdef@yourdomain.com`
                       → Postern emails owner from owner@protonmail
                          with Reply-To: re-abcdef@yourdomain.com
owner → hits Reply in Proton → mail goes to re-abcdef@yourdomain.com
                            → SL forwards the reply to the visitor's real address
```

The visitor's real address is never visible to the owner. The "pretty" alias
(`john.doe.12345@yourdomain.com`) is the DB key and a deletable handle: delete
it in the SimpleLogin dashboard to permanently block that visitor.

## Why `From:` is your own address

Proton's anti-spoofing rewrites `From:` to the authenticated SMTP user. We
display the visitor's name and pretty alias in the email body and in the
`X-Alias-Pretty` header so you can build Proton filter rules on it.

## Encryption at rest

PII columns (`email_ct`, `name_ct`, `message_ct`) are AES-256-GCM with a
random 12-byte IV per row and a 16-byte auth tag. The lookup column
(`email_lookup`) is `HMAC-SHA256(LOOKUP_KEY, normalize(email))` with a UNIQUE
index — deterministic so returning visitors and double-submits collide
correctly, but doesn't reveal the email.

`ENC_KEY` and `LOOKUP_KEY` are independent 32-byte values. They can be set
directly in env, or via `KEY_FILE=/path/to/keys.json` pointing at a mode-0600
file containing `{"enc":"...","lookup":"..."}`.

### Key rotation

Not yet automated. To rotate:

1. Generate new keys.
2. Walk every encrypted row, decrypt with the old `ENC_KEY`, re-encrypt with
   the new one, and update the row. (No HMAC-rotation tooling — to rotate
   `LOOKUP_KEY`, walk the table reading `email_ct`, recompute `email_lookup`,
   update.)
3. Bump a version somewhere and ship.

This will be tooled when a rotation actually happens.

## Operations

### Lifecycle commands

| Command | What it does |
|---|---|
| `npm run dev` | Fastify on `127.0.0.1:8787` with `tsx watch`. Hot reload on save. |
| `npm run build` | Vite admin-ui → `tsc` → `copy-assets`. Outputs `dist/` (server) + `dist/admin-ui/` (SPA). |
| `npm start` | `node dist/server.js`. Production entry point. |
| `npm test` | Unit + integration suite via vitest. In-memory SQLite, fake SL, fake SMTP — zero real network calls. |
| `npm run typecheck` | `tsc --noEmit` — fast verification without producing output. |
| `npm run hash:admin` | Interactive scrypt hasher for `ADMIN_PASSWORD_HASH` (see Admin UI section). |

### Liveness

`GET /healthz` returns `{"status":"ok","time":"..."}` with HTTP 200 when
the process is up and Fastify is listening. No DB or SL/SMTP probe — it
exists for orchestrators (Docker, k8s) to detect a dead process, not to
report dependency health. If you want deeper checks, run them out-of-band
against the admin dashboard.

### Schema migrations

Bumps to `db/schema.sql` are applied automatically on boot when the
on-disk `PRAGMA user_version` is older than `SCHEMA_VERSION` in
[src/db/migrate.ts](src/db/migrate.ts). Every `CREATE` uses
`IF NOT EXISTS`, so re-applying the schema on a populated DB is safe and
preserves existing rows. There is no rollback path — capture a backup
before upgrading across schema versions.

### Backups

Three files comprise a consistent SQLite WAL snapshot. Back them up
**together** — never one without the others:

```
postern.db        # the main database
postern.db-wal    # write-ahead log; uncommitted pages live here until checkpoint
postern.db-shm    # shared-memory index for the WAL
```

Two backup approaches:

- **Hot backup** (no downtime). SQLite's online backup API copies a
  consistent snapshot while the writer is live:

  ```bash
  node -e "
    import('better-sqlite3').then(async ({default: D}) => {
      const src = new D(process.env.DATABASE_PATH ?? './data/postern.db', { readonly: true });
      await src.backup('./postern.db.bak');
      console.log('backup ok');
    })"
  ```

  The resulting `.bak` is a single-file snapshot — no WAL companions
  needed. Pair with rsync/restic/whatever to get it off-host.

- **Cold backup** (brief downtime). Stop the process, archive the data
  directory, restart. Simplest and unambiguous:

  ```bash
  pkill -INT -f 'node dist/server.js'   # or: docker compose down
  tar -czf postern-$(date +%Y%m%d).tar.gz data/
  npm start                              # or: docker compose up -d
  ```

If you're using `KEY_FILE` (mode-0600 JSON `{enc, lookup}`), back that
up **separately** on different infrastructure. Losing it permanently
locks every encrypted column.

### Logs

Pino emits structured JSON to stdout. In dev with `npm run dev` you can
pretty-print by piping through `npx pino-pretty` (install `pino-pretty`
as a devDep first). In production, ship to whatever log aggregator you
use — for systemd: `journalctl -fu postern.service`; for Docker:
`docker compose logs -f`; for ad-hoc: `npm start | tee postern.log`.

Useful filters with `jq`:

```bash
# Just request lifecycle.
... | jq -c 'select(.req or .res)'

# Failed alias mints.
... | jq -c 'select(.msg | test("mint failed"))'

# Admin actions (logins, blocks, message views).
... | jq -c 'select(.msg | test("admin login|admin_(block|unblock|message_view)"))'

# Errors only.
... | jq -c 'select(.level >= 50)'
```

`pino` redacts `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`,
`SL_API_KEY`, `SMTP_PASS`, and `TURNSTILE_SECRET` when they appear in
serialized config — they will not leak into logs even at `trace`
level.

### Recommended deployment

Run via [Docker Compose](#docker) behind a TLS-terminating reverse
proxy (Caddy or nginx). Native deployment works fine too — same
`npm run build && npm start` flow, with a systemd unit and a process
supervisor of your choice.

## Admin UI

A React SPA mounted at `/admin/` for browsing visitors + their (decrypted)
submissions, blocking abusive senders, watching the daily Proton cap and
recent failures, and reading the audit log. Disabled by default — existing
deployments boot unchanged when the env vars are absent.

### Enabling

```bash
# 1. Generate a session-cookie HMAC secret (independent of ENC_KEY/LOOKUP_KEY).
node -e "console.log('ADMIN_SESSION_SECRET='+require('node:crypto').randomBytes(32).toString('hex'))"

# 2. Hash a password. Prompts twice with no echo; emits `scrypt$N=...,r=...,p=...$<salt>$<hash>`.
npm run hash:admin

# 3. Paste both into .env, plus:
ADMIN_ENABLED=true
ADMIN_PASSWORD_HASH=scrypt$...
ADMIN_SESSION_SECRET=...
# Optional:
# ADMIN_SESSION_TTL_HOURS=12      # 1..168
# ADMIN_COOKIE_SECURE=true        # defaults to NODE_ENV===production
```

`ADMIN_SESSION_SECRET` must not equal `ENC_KEY` or `LOOKUP_KEY` (`loadConfig`
rejects this at boot). Rotate it whenever you want to invalidate every active
admin session.

### Block semantics

Block flips `visitors.status` to `blocked` and writes an `admin_block` audit
row. Future `POST /contact` calls from that email silently 202 with
`{"status":"queued"}` (matching the circuit-breaker shape — no info leak)
and write a `blocked_submission_rejected` audit row. The SimpleLogin alias
keeps routing, so you can still reply to existing threads. Unblock fully
restores. There is no v1 path to delete the upstream SL alias from the UI;
do that in the SL dashboard if you need to.

### Dev workflow (two terminals)

```bash
# terminal A — backend
npm run dev        # Fastify on http://127.0.0.1:8787

# terminal B — SPA with HMR
cd admin-ui
npm install        # one-time
npm run dev        # Vite on http://127.0.0.1:5173, proxying /admin/api → :8787
```

Open http://127.0.0.1:5173/admin/login. Vite proxies API requests to the
Fastify backend; the cookie (`Path=/admin`) flows because both servers are
on `localhost`. `ADMIN_COOKIE_SECURE=false` in dev (it defaults to
`isProd`) lets the cookie set over plain HTTP.

### Production

`npm run build` produces `dist/admin-ui/` (the bundled SPA) and `dist/`
(the server). `npm start` serves both from a single Fastify on
`HOST:PORT` — `/admin/` returns the SPA shell, `/admin/api/*` is the
JSON API, deep links like `/admin/visitors/42` are handled by the
SPA fallback. If `admin-ui/` is absent at build time, the build script
no-ops cleanly and `/admin/` returns 404 (the API still works once env
vars are set, so you can enable admin before scaffolding the UI).

### Security posture

- Single shared password (scrypt, N=16384). Stateless signed session
  cookie (`HttpOnly; SameSite=Lax; Path=/admin`; `Secure` in prod);
  HMAC-SHA256 over a JSON payload of `{iat, exp, v}`. No DB sessions.
- Login is rate-limited at 5 attempts per 15 minutes per IP.
- CSRF defense is layered: `SameSite=Lax` cookie + `Origin` header
  check + `application/json` content-type assertion on every mutating
  request. No CSRF token round-trip.
- Pino redacts `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`,
  `SL_API_KEY`, `SMTP_PASS`, and `TURNSTILE_SECRET` from request logs.
- The `/contact` CORS hook is scoped to `/contact` only — a
  misconfigured `ALLOWED_ORIGINS` cannot grant CORS on `/admin/api/*`.

## Docker

A multi-stage Dockerfile produces a self-contained ~345 MB image based
on `node:20-slim`. The runtime stage ships only the compiled server
bundle, the built admin SPA, and production `node_modules` — no source,
no toolchain, no test fixtures. It runs as the unprivileged `node` user
(uid 1000), serves the API + admin UI from a single Fastify on `:8787`,
and persists state to a `/data` volume.

`better-sqlite3` ships prebuilt binaries for `linux/amd64` and
`linux/arm64` against glibc 2.31+, so the build succeeds on `slim`
without a compiler. The image is **not** built for `linux/arm/v7`
(32-bit Pi) — see [Troubleshooting](#troubleshooting).

### Quickstart with Docker Compose

```bash
git clone <your fork> postern && cd postern

# 1. Generate the encryption keys.
cp .env.example .env
node -e "console.log('ENC_KEY='+require('node:crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('LOOKUP_KEY='+require('node:crypto').randomBytes(32).toString('hex'))" >> .env

# 2. Edit .env: paste SL_API_KEY, OWNER_DOMAIN, SMTP_USER, SMTP_PASS,
#    TURNSTILE_SECRET, and (optional) ALLOWED_ORIGINS.
$EDITOR .env

# 3. (Optional) Enable the admin UI.
node -e "console.log('ADMIN_SESSION_SECRET='+require('node:crypto').randomBytes(32).toString('hex'))" >> .env
npm install && npm run hash:admin
# Paste the printed scrypt$... line into .env as ADMIN_PASSWORD_HASH=...
# Set ADMIN_ENABLED=true.

# 4. Make ./data writable by uid 1000 (Linux Docker only — Docker Desktop
#    on Mac/Windows handles uid mapping for you).
mkdir -p data
sudo chown 1000:1000 data

# 5. Build + boot.
docker compose up -d --build
docker compose logs -f

# Sanity check from the host:
curl http://127.0.0.1:8787/healthz
# → {"status":"ok","time":"..."}
```

The compose service publishes `127.0.0.1:8787:8787` — meaning the
container port is reachable only from the host loopback. This is
deliberate: production deployments belong behind a TLS-terminating
reverse proxy (see [Behind a reverse proxy](#behind-a-reverse-proxy)).
To expose Postern directly to the internet, edit the `ports:` line in
`docker-compose.yml` to `"8787:8787"` — but doing so means admin login
travels in cleartext, which is a bad idea.

### Building the image

```bash
docker build -t postern:latest .
```

Build cache uses BuildKit `--mount=type=cache` for the npm package
cache, so warm rebuilds finish in ~15 seconds. Cold builds (no image
layers, no Node cache) take ~2 minutes — most of that is pulling
`node:20-slim` for the first time.

The `# syntax=docker/dockerfile:1.7` directive at the top of the
Dockerfile turns BuildKit on automatically. If you're on an older
Docker daemon that doesn't honor it, set `DOCKER_BUILDKIT=1` in your
environment or upgrade Docker.

#### Multi-arch builds

For pushing a single tag that works on both `amd64` and `arm64` hosts:

```bash
docker buildx create --use --name postern-builder
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/postern:0.1.0 \
  --push .
```

QEMU emulators are needed if you build on a single-arch host; install
them with `docker run --privileged --rm tonistiigi/binfmt --install
all`.

#### Build stages

| Stage | Purpose |
|---|---|
| `builder` | `npm ci` for both root and `admin-ui/` (cached separately so source edits don't bust them). Runs `npm run build` — Vite produces `admin-ui/dist`, `tsc` produces `dist/`, `copy-assets` copies `schema.sql` and the SPA bundle into `dist/`. Finally `npm prune --omit=dev` strips `vitest`, `tsx`, `@types/*`, etc. |
| `runtime` | `node:20-slim` with three things copied in: `node_modules` (production-only), `dist/`, `package.json`. Runs as `node`, exposes 8787, declares `/data`, ships a Node-based HEALTHCHECK against `/healthz`. |

The runtime image carries no `npm` install layer — everything's already
installed in the builder stage's pruned `node_modules`. This keeps the
final image lean and avoids re-downloading packages at runtime.

### File ownership and the data volume

The runtime container runs as `node` (uid 1000, gid 1000). On native
Linux Docker, the bind-mounted `./data` directory must be writable by
that uid:

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

Docker Desktop (macOS / Windows / WSL2) mediates uid mapping for you,
so a plain `mkdir -p data` is enough.

To confirm it's working:

```bash
docker compose exec postern ls -la /data
# Should show -rw-r--r-- 1 node node ... postern.db
```

Inside the container the on-disk layout is:

```
/app/
  package.json
  node_modules/         pruned (no devDeps); ~95 MB
  dist/
    server.js           Fastify entry point
    admin-ui/           built SPA — index.html + assets/
    db/schema.sql       applied at boot if user_version mismatches
    ...
/data/
  postern.db            main DB; encrypted PII columns
  postern.db-wal        WAL — must back up alongside .db
  postern.db-shm        shared-memory index
```

`DATABASE_PATH` is set to `/data/postern.db` by the Dockerfile. Override
in `.env` if you mount the volume elsewhere — but `/data` is what the
declared `VOLUME` instruction expects, so changing the path on the
container side breaks Docker's volume tracking.

### Persistence and backups

See [Operations → Backups](#backups) for the file inventory and the
hot-vs-cold tradeoff. Run hot backups from inside the container so the
`DATABASE_PATH` resolves correctly:

```bash
# Hot backup. .bak appears in ./data on the host.
docker compose exec postern node -e "
  import('better-sqlite3').then(async ({default: D}) => {
    const src = new D(process.env.DATABASE_PATH, { readonly: true });
    await src.backup('/data/postern.db.bak');
    console.log('ok');
  })"
mv data/postern.db.bak /your/offsite/backups/postern-$(date +%F).db

# Cold backup. Brief downtime; archives the whole volume.
docker compose down
tar -czf postern-$(date +%F).tar.gz data/
docker compose up -d
```

Restore is the reverse: stop the container, replace `data/`, start back
up. Schema migrations run automatically and are idempotent.

### Behind a reverse proxy

The admin session cookie is `SameSite=Lax` and `Secure` (in production),
so admin access **must** terminate TLS upstream. Postern's CSRF guard
also checks the request `Origin` against `request.protocol://Host` — so
the proxy must preserve `Host` and forward `X-Forwarded-Proto`.

`trustProxy: true` is already set in `src/server.ts` so the standard
`X-Forwarded-*` headers are honored.

#### Caddy

Easiest. Caddy preserves `Host` by default and obtains Let's Encrypt
certificates automatically.

```caddyfile
contact.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

#### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name contact.example.com;
  ssl_certificate     /etc/letsencrypt/live/contact.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/contact.example.com/privkey.pem;

  client_max_body_size 256k;   # /contact rejects > 64 KB; this is generous slack

  location / {
    proxy_pass         http://127.0.0.1:8787;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
  }
}
```

The `proxy_set_header Host $host` line is **mandatory**. Without it,
nginx forwards `Host: 127.0.0.1:8787`, the admin Origin check sees a
mismatch on every POST, and login + block + unblock all return
`403 csrf_origin_mismatch`. This trips up first-time deployers.

In `.env`, configure for the public hostname:

```
ADMIN_COOKIE_SECURE=true                                       # default in prod; explicit doesn't hurt
ALLOWED_ORIGINS=https://contact.example.com,https://example.com
```

`ALLOWED_ORIGINS` only affects the `/contact` CORS hook — `/admin/api/*`
is always same-origin (the SPA is served from the same hostname), so
admin requests don't go through CORS at all.

### Updating

Schema bumps are applied on boot (idempotent — `CREATE … IF NOT EXISTS`
+ a `PRAGMA user_version` guard in [src/db/migrate.ts](src/db/migrate.ts)).
Standard upgrade flow:

```bash
git pull
docker compose build         # rebuild the image with new code
docker compose up -d         # start the new container
docker compose logs -f --since 30s
```

Docker Compose stops the old container before starting the new one, so
there's a brief downtime per upgrade (~1–2 seconds). Existing data
survives because `./data` lives on the host, not in the image.

To roll back: `git checkout <previous-tag>` then rebuild. If the schema
bumped between versions, the old binary may refuse to boot — restore a
backup taken before the upgrade.

### Logs and healthcheck

Pino emits structured JSON to stdout — Docker's default log driver
captures it. Useful queries (assuming `jq` is on the host):

```bash
docker compose logs -f                              # tail all output
docker compose logs --since 1h | jq .

# Just request lifecycle entries.
docker compose logs --since 5m | jq -c 'select(.req or .res)'

# Admin auth events.
docker compose logs --since 1d | jq -c 'select(.msg | test("admin login"))'

# Errors only.
docker compose logs | jq -c 'select(.level >= 50)'
```

The Dockerfile declares a `HEALTHCHECK` that fetches `/healthz` every
30 seconds. The compose file declares the same probe at the service
level for orchestrators that ignore image-level checks. Status:

```bash
$ docker ps --filter name=postern --format '{{.Names}}\t{{.Status}}'
postern Up 4 hours (healthy)

$ docker inspect postern --format '{{.State.Health.Status}}'
healthy

$ docker inspect postern --format '{{json .State.Health}}' | jq
# Last 5 health-check probes with timestamps, exit codes, and stdout
```

Switch the log driver to `json-file` with rotation if you don't want
unbounded stdout retention:

```yaml
# docker-compose.yml
services:
  postern:
    # ...
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Container exits immediately, log says `ENC_KEY and LOOKUP_KEY must be set` | `.env` is empty or in the wrong location. With compose, `env_file: .env` is relative to `docker-compose.yml`. |
| `EACCES: permission denied, open '/data/postern.db'` | `./data` on the host isn't owned by uid 1000. `sudo chown -R 1000:1000 data`. |
| Admin POST returns `403 csrf_origin_mismatch` | Reverse proxy isn't preserving the `Host` header. See nginx note above. |
| Admin login succeeds (204) but immediate `/me` returns 401 | Cookie didn't make it back to the browser. Causes: `ADMIN_COOKIE_SECURE=true` over plain HTTP (browser drops the cookie); SPA on a different origin from the API (cross-site); broken proxy stripping `Set-Cookie`. |
| `port is already allocated` on `up` | Another process is on `:8787`. `lsof -i :8787` or change `ports:`. |
| `npm WARN ... 1 high severity vulnerability` during build | Transitive dep flagged by npm audit. Doesn't break the build; investigate with `npm audit --omit=dev` outside Docker. |
| better-sqlite3 prebuild missing on `linux/arm/v7` (32-bit Pi) | The image only supports 64-bit. Build the image on a 64-bit OS, or run on `linux/arm64` (Pi 3+ on a 64-bit OS). |
| `connect ECONNREFUSED 127.0.0.1:8787` from the host immediately after `up -d` | Container's still booting. Wait for `(healthy)` in `docker ps`. |
| Want to re-init the DB | `docker compose down`, `rm -rf data/`, `mkdir -p data && sudo chown 1000:1000 data`, `docker compose up -d`. Note this destroys all encrypted PII. |

Quick shell into a running container:

```bash
docker compose exec postern sh
ls -la /data
node -e "console.log(process.versions, process.env.DATABASE_PATH)"
```

### Hashing the admin password without a host Node toolchain

The `npm run hash:admin` script depends on `tsx`, which is a devDep and
gets pruned out of the runtime image. If you don't have Node on the
host, hash inside the container against the compiled module instead:

```bash
docker compose run --rm --no-deps -T postern node -e \
  "import('./dist/admin/auth.js').then(m=>{let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(m.hashPasswordForSetup(d.trim())))})" \
  <<< "your-password-here"
```

The output is a single `scrypt$N=...,r=...,p=...$<salt>$<hash>` line
ready to paste into `.env`. The `-T` flag disables TTY allocation so
the heredoc is read cleanly.

Note: this runs against the SAME image you're deploying, so the salt +
hash format is guaranteed to match what `verifyPassword` in production
expects. There's no version skew risk.

### Raw `docker run`

If you don't want compose:

```bash
docker build -t postern .
mkdir -p data
sudo chown 1000:1000 data    # Linux only

docker run -d --name postern \
  -p 127.0.0.1:8787:8787 \
  --env-file .env \
  -v "$(pwd)/data:/data" \
  --restart unless-stopped \
  postern
```

To stop, restart, and clean up:

```bash
docker stop postern && docker rm postern   # stop + remove container
docker rmi postern                          # remove the image
# data/ on the host is left intact.
```

## Project layout

```
src/
  server.ts              Fastify bootstrap, route registration, graceful shutdown
  config.ts              zod-validated env parser (incl. ADMIN_* fields)
  routes/
    contact.ts           POST /contact: Turnstile → dedupe → mint → mail
                          (with blocked-status guard before mint)
    health.ts            GET /healthz
  services/
    simplelogin.ts       options(), createCustomAlias(), createContact(); undici
    proton.ts            sendOwnerNotification(); nodemailer pool transport
    turnstile.ts         verify(token, ip) with idempotency_key
    aliasMint.ts         orchestrates the 3 SL calls; per-email mutex
  lib/
    generate.ts          PORTED from alias_email_gen (Web Crypto → node:crypto)
    format.ts            PORTED verbatim
    crypto.ts            encryptColumn / decryptColumn / hmacLookup
  db/
    schema.sql           visitors, submissions, sends_today, audit_log
    migrate.ts           applies schema.sql when user_version mismatches
    repo.ts              encrypted CRUD + admin read/write paths
  admin/
    index.ts             registerAdmin: cookie + API + static, encapsulated
    auth.ts              scrypt verify + signed session cookies (HMAC-SHA256)
    preHandlers.ts       requireAdmin + CSRF mutating-guard
    api.ts               /admin/api/* JSON endpoints
    static.ts            @fastify/static + SPA fallback for /admin/*
  middleware/
    rateLimit.ts         per-IP token bucket via @fastify/rate-limit
admin-ui/                 React SPA served under /admin/ (Vite + react-router)
  vite.config.ts         base: '/admin/', dev proxy /admin/api → :8787
  src/
    api.ts               fetch wrapper, cookie creds, surfaces HttpError
    types.ts             DTOs mirroring src/db/repo.ts + src/admin/api.ts
    hooks/useAuth.ts     /me probe → redirect to /login on 401
    routes/              Login, Layout, Dashboard, Visitors,
                          VisitorDetail, Submission, AuditLog
scripts/
  hash-admin-password.mjs  one-shot CLI: prompts (no echo) → scrypt$... line
  build-admin.mjs          guard wrapper: skips cleanly if admin-ui/ absent
  copy-assets.mjs          copies schema.sql + admin-ui/dist into dist/
test/
  unit/                  crypto, format, generate, repo, repo-admin, admin-auth
  integration/           contact, contact-blocked, admin-{auth,csrf,disabled,
                          static,visitors}
  fixtures/              shared test doubles (incl. admin-enabled buildTestApp)
```

## Risks handled in code

1. **`signed_suffix` 10-min TTL** — fetched immediately before each create,
   never cached. On `signed_suffix_expired`, refetched and retried once.
2. **SL contact endpoint takes numeric `alias_id`**, not the alias string —
   we persist both.
3. **Proton 1000/day cap** — circuit breaker at 95% defers SMTP, still
   records visitor + submission rows + audit entry.
4. **Double-submit idempotency** — `INSERT … ON CONFLICT(email_lookup) DO
   NOTHING`, so a retry never mints two aliases.
5. **Turnstile token replay** — `idempotency_key` derived from the submission
   tuple is passed to the verify endpoint.
6. **Concurrent mints for the same visitor** — per-`email_lookup` in-process
   mutex on top of the UNIQUE constraint, so we don't burn an SL alias and
   then discard it on conflict. If the race is lost despite the mutex (e.g.
   two processes), the orphan alias is deleted.

## Out of scope for v1

- Multi-tenant / multi-site. Schema doesn't preclude adding a `site_id` later.
- Browser extension integration. That comes later as a separate effort.
- Automated key rotation tooling.
- Admin "hard delete" — UI block is soft-only. Use the SimpleLogin
  dashboard to delete an alias permanently.
