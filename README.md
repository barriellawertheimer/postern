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

- `GET /healthz` — liveness probe.
- `npm run dev` — Fastify with pretty logs and watch mode.
- `npm run build && npm start` — production.
- `npm test` — unit + integration tests with in-memory SQLite, fake SL, fake
  SMTP. No real network calls.
- The SQLite WAL is enabled; back up `postern.db`, `postern.db-wal`, and
  `postern.db-shm` together.

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
