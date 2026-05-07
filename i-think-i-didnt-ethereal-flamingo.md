# Contact-Form Visitor-Alias Backend — Plan

## Context

The user runs a personal website on Proton Mail with a custom domain whose MX is delegated to SimpleLogin (catch-all). They want a self-hosted backend that, when a visitor submits the contact form, mints a per-visitor SimpleLogin alias like `johndoe.12345@ownerdomain.com`, sends the form contents to the owner's Proton inbox, and arranges things so a Reply in Proton routes the response back to the visitor through SL — without the owner ever seeing the visitor's real address. A SQLite DB (encrypted at rest) maps each visitor email to a single alias so returning visitors don't get a new one each time.

This backend is a new project in a separate directory. The current repo at `c:\Users\Barriella\alias_email_gen` is **reference only** — its alias-format library will be ported into the new project. Nothing in the current repo will be modified.

## Core flow

1. Visitor `POST /contact` with `{firstName, lastName, email, message, turnstileToken}`.
2. Verify Turnstile token. Validate input. Apply per-IP rate limit.
3. Look up visitor in DB by `HMAC-SHA256(email)`. If found and active, reuse alias; else mint:
   - `GET /api/v5/alias/options?hostname=ownerdomain.com` → fresh `signed_suffix` (10-min TTL — never cache).
   - Build prefix `johndoe.12345` via the ported alias-format library.
   - `POST /api/v3/alias/custom/new` → numeric `alias_id` + alias string.
   - `POST /api/aliases/<alias_id>/contacts` `{contact: visitor_email}` → `reverse_alias_address`.
   - Persist encrypted row.
4. Send notification via Proton SMTP (`smtp.protonmail.ch:587`, STARTTLS, address + SMTP token):
   - `From:` is forced to owner's Proton address (Proton anti-spoof).
   - `Reply-To:` = `reverse_alias_address` (the bit that closes the loop).
   - Body renders pretty alias `johndoe.12345@ownerdomain.com` for human readability.
   - `X-Alias-Pretty:` header carries the same value for Proton filter rules.
5. Increment daily-send counter. Trip circuit-breaker at 95% of Proton's daily cap (1000/day on Mail Plus, 300/hour).

## Design decisions (locked in)

- **Reply-To = SL reverse alias.** The visible From/Reply-To in Proton on each thread is `re-abc123@ownerdomain.com`, not the pretty alias. The pretty alias is a tracking handle (DB key, body display, deletable to permanently block that visitor). Owner just hits Reply in Proton; SL routes to visitor. This is the only design that closes the loop with SL primitives + Proton SMTP without running a custom MX.
- **Single user / single tenant.** No auth, no admin UI in v1. Config via env.
- **Encryption at rest = app-level AES-256-GCM with HMAC-SHA256 lookup column.** Not SQLCipher (ARM/Pi build pain; better-sqlite3 SQLCipher forks lag upstream). Two 32-byte keys (`ENC_KEY`, `LOOKUP_KEY`) loaded from env or a mode-600 file. Selective per-column encryption on PII (`email_ct`, `name_ct`, `message_ct`); `email_lookup` is a deterministic HMAC blob with a UNIQUE index for returning-visitor matching and double-submit idempotency.
- **Stack:** Node.js, Fastify 5, `better-sqlite3`, `nodemailer` (pool: 1 conn, rate-limited 1/s), `undici` for SL HTTP, `zod` for input validation, `pino` for logs, `@fastify/rate-limit` for per-IP buckets.

## Code reuse (port, don't rewrite)

Port these two pure modules from the reference repo, **changing only the random source from Web Crypto to `node:crypto`**:

- [src/lib/generate.js](c:\Users\Barriella\alias_email_gen\src\lib\generate.js) — `buildSuffix`, `randomDigits`, `randomHex`, `randomWord`, `sanitizeSite` (rename to `sanitizeLocal` — its job is now slugifying `first.last`, not a site name), `renderTemplate`, `buildAlias`. Replace each `crypto.getRandomValues(buf)` with `randomFillSync(buf)` from `node:crypto` to preserve the rejection-sampling semantics (don't substitute `randomInt`).
- [src/lib/format.js](c:\Users\Barriella\alias_email_gen\src\lib\format.js) — `DEFAULT_FORMAT`, `normalizeFormat`, `describeFormat`. Verbatim. The `{site}{sep}{suffix}` shape becomes `{first.last}{sep}{suffix}`; the format model itself is unchanged. The template-mode tokens (`{rand:N}`, `{hex:N}`, etc.) carry over.

These modules are pure (no DOM, no `chrome.*`, no I/O), which is why they port cleanly.

## Project layout (new repo, separate directory)

```
src/
  server.ts                Fastify bootstrap, route registration, graceful shutdown
  config.ts                zod-validated env parser (Proton creds, SL key, encryption keys, Turnstile secret)
  routes/
    contact.ts             POST /contact: Turnstile → dedupe → mint → mail
    health.ts              GET /healthz
  services/
    simplelogin.ts         options(), createCustomAlias(), createContact(); undici client
    proton.ts              sendOwnerNotification(); nodemailer pool transport
    turnstile.ts           verify(token, ip) with idempotency_key
    aliasMint.ts           orchestrates the 3 SL calls; uses ported format lib for the prefix
  lib/
    generate.ts            PORTED from reference repo (Web Crypto → node:crypto)
    format.ts              PORTED verbatim
    crypto.ts              encryptColumn(iv|ct|tag), decryptColumn(), hmacLookup()
  db/
    schema.sql             visitors, sends_today, audit_log
    migrate.ts             apply schema.sql on boot if user_version mismatch
    repo.ts                getVisitorByEmail, upsertVisitor, recordSend, dailyCount
  middleware/
    rateLimit.ts           per-IP token bucket via @fastify/rate-limit
test/
  unit/                    aliasMint, crypto, format, generate
  integration/             routes with msw (SL) + nodemailer-mock (SMTP)
.env.example
README.md
```

## DB schema (sketch)

- `visitors(id INTEGER PK, email_lookup BLOB UNIQUE NOT NULL, email_ct BLOB, name_ct BLOB, alias_local TEXT, alias_full TEXT, sl_alias_id INTEGER, sl_reverse_alias TEXT, status TEXT DEFAULT 'active', created_at INTEGER, last_seen_at INTEGER)`
- `submissions(id INTEGER PK, visitor_id INTEGER FK, message_ct BLOB, ip_hash BLOB, ua_hash BLOB, created_at INTEGER)`
- `sends_today(day TEXT PK, count INTEGER NOT NULL DEFAULT 0)` — for the Proton cap circuit breaker.

## Risks to handle in code (not just nice-to-have)

1. **`signed_suffix` 10-min TTL** — fetch options *immediately* before each create call. Never cache across requests. On 4xx with "expired" error, refetch + retry once.
2. **SL contact endpoint takes numeric `alias_id`, not the alias string.** Persist both columns from the create response.
3. **Proton 1000/day cap is the real bottleneck.** A scraper that bypasses Turnstile can DoS the owner's whole mailbox. Mitigations layered: per-IP rate limit *before* SL/SMTP work, daily counter in `sends_today`, circuit-breaker at 95% (still record the visitor + alias, defer SMTP, surface in admin log).
4. **Idempotency on double-submit:** `INSERT … ON CONFLICT(email_lookup) DO NOTHING RETURNING *` so a retry never mints two aliases.
5. **Turnstile token replay** returns `timeout-or-duplicate` — pass `idempotency_key` on retries.
6. **SL paid plan required** — free SL is capped at 10 aliases total. Note in README as a prerequisite.
7. **Proton From: forced to authenticated address** is documented behavior, not a bug — say so in the email body so the owner doesn't think it's spoofed.
8. **Concurrent mints for the same visitor** — relying on the UNIQUE constraint is correct; wrap the mint orchestration in a per-`email_lookup` in-process mutex so we don't burn an SL alias and then discard it on UNIQUE conflict.

## Critical files (when implementation begins)

- `<new-repo>/src/services/simplelogin.ts` — the 3-call orchestration; `signed_suffix` TTL handling lives here.
- `<new-repo>/src/services/proton.ts` — nodemailer pool config (`pool: true, maxConnections: 1, rateLimit: 1`).
- `<new-repo>/src/lib/crypto.ts` — AES-GCM with random 12-byte IV + 16-byte tag, HMAC lookup. The whole at-rest story hinges on this being correct.
- `<new-repo>/src/lib/generate.ts` — ported alias-format library; the Web Crypto → `node:crypto` swap is the only intentional change.
- `<new-repo>/src/routes/contact.ts` — where Turnstile, dedupe, mint, and SMTP all converge.

## Verification plan

**Local (no real Proton/SL accounts):**
- `msw` (node) intercepts `app.simplelogin.io` with fixtures for `/alias/options`, `/alias/custom/new`, `/aliases/:id/contacts`, including the expired-`signed_suffix` 4xx path.
- `nodemailer-mock` replaces the SMTP transport; assertions on `From`, `Reply-To`, `X-Alias-Pretty`, body contains the pretty alias.
- Stub `turnstile.verify()` to `{success: true}` when `NODE_ENV !== 'production'`.
- Unit: encryption round-trip (`decrypt(encrypt(x)) === x`), HMAC determinism, tamper test (flipping one ciphertext byte throws).
- Property test on `aliasMint`: 10k iterations, prefix always matches `/^[a-z0-9._+-]+$/` and never accidentally contains the suffix substring.
- Concurrency test: 20 parallel `POST /contact` with the same email → exactly one row in `visitors`, exactly one SL create call observed by msw.

**Staging (real accounts):**
- Separate Proton paid account + separate SL paid account + a `staging-contact.ownerdomain.com` subdomain pointed at the VPS.
- Submit from a real browser end-to-end (real Turnstile).
- Confirm SL dashboard shows the alias and the auto-created contact; send a real reply from the visitor's email through `reverse_alias_address`; confirm it threads correctly into owner's Proton inbox.
- Throughput test: lower the daily cap to 10, send 12 quickly, verify the circuit breaker trips and the 11th and 12th submissions still persist a visitor row + alias but skip the SMTP send (visible in `audit_log`).
- Restart the process; resubmit with the same visitor email; assert no new SL alias is created (DB row reused).

## Out of scope for v1

- Admin UI (alias list, disable, search). CLI script reading the DB is enough initially.
- Multi-tenant / multi-site. Schema doesn't preclude adding a `site_id` later.
- Connecting this backend to the browser extension. The user explicitly said this comes later as a separate effort.
- Key rotation tooling. Document the rotation procedure in README; build it when first needed.
