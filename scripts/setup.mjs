#!/usr/bin/env node
// Interactive setup: prompts for per-deployment values, auto-generates
// encryption keys, optionally hashes an admin password, and writes .env
// (mode 0600 on POSIX). The assembled config is validated via loadConfig
// before writing — if it would fail at boot, it fails here.
//
// Usage:
//   npm run setup            # fresh install — refuses if .env exists
//   npm run setup -- --force # overwrite existing .env (preserves ENC_KEY/LOOKUP_KEY if present)

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { stdin, stdout, stderr, argv, exit, platform } from "node:process";
import { hashPasswordForSetup } from "../src/admin/auth.ts";
import { loadConfig } from "../src/config.ts";

const ENV_PATH = resolve(process.cwd(), ".env");
const FORCE = argv.includes("--force");

if (!stdin.isTTY) {
  stderr.write("setup must be run from an interactive terminal\n");
  exit(2);
}

if (existsSync(ENV_PATH) && !FORCE) {
  stderr.write(
    `${ENV_PATH} already exists. Move/delete it, or re-run with --force.\n` +
      `(--force preserves existing ENC_KEY/LOOKUP_KEY so the database stays readable.)\n`,
  );
  exit(2);
}

// ---- prompt helpers ----

function ask(question, opts = {}) {
  const { default: dflt, validate, secret = false } = opts;
  return new Promise((resolveAns) => {
    const display =
      dflt !== undefined && dflt !== "" && !secret
        ? `  ${question} [${dflt}]: `
        : `  ${question}: `;
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    if (secret) {
      let prompted = false;
      const orig = rl._writeToOutput;
      rl._writeToOutput = function (s) {
        if (!prompted) {
          prompted = true;
          orig.call(this, s);
        }
      };
    }
    rl.question(display, async (raw) => {
      rl.close();
      if (secret) stdout.write("\n");
      const answer = raw.trim() === "" ? dflt ?? "" : raw.trim();
      if (validate) {
        const err = validate(answer);
        if (err) {
          stderr.write(`    ✗ ${err}\n`);
          resolveAns(await ask(question, opts));
          return;
        }
      }
      resolveAns(answer);
    });
  });
}

async function askSecret(question, { confirm = false, validate } = {}) {
  const value = await ask(question, { secret: true, validate });
  if (confirm) {
    const v2 = await ask("Confirm           ", { secret: true });
    if (value !== v2) {
      stderr.write("    ✗ values did not match — try again\n");
      return askSecret(question, { confirm, validate });
    }
  }
  return value;
}

async function askYesNo(question, dflt = false) {
  const raw = (
    await ask(question, { default: dflt ? "y" : "n" })
  ).toLowerCase();
  return raw === "y" || raw === "yes";
}

// ---- validators ----

const required = (name) => (v) => (v ? null : `${name} is required`);
const isPort = (v) =>
  /^\d+$/.test(v) && +v >= 1 && +v <= 65535 ? null : "must be a port (1-65535)";
const isDomain = (v) =>
  /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) ? null : "must be a bare domain (example.com)";
const isEmail = (v) =>
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "must be a valid email";
const isOptionalEmail = (v) => (v === "" ? null : isEmail(v));
const minLen = (n) => (v) => (v.length >= n ? null : `must be at least ${n} characters`);
const isEnvName = (v) =>
  ["development", "production", "test"].includes(v)
    ? null
    : "must be development, production, or test";

// ---- preserve existing keys on --force ----

function readExistingEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const existing = FORCE ? readExistingEnv(ENV_PATH) : {};
const preserved = [];
function takeOrGenerate(name) {
  if (existing[name]) {
    preserved.push(name);
    return existing[name];
  }
  return randomBytes(32).toString("hex");
}

// ---- main flow ----

stdout.write("\nPostern setup — writes .env in this directory.\n");
stdout.write("Press Ctrl-C at any time to abort (no .env is written until the end).\n\n");

stdout.write("[1/5] Server\n");
const NODE_ENV = await ask("Environment", { default: "production", validate: isEnvName });
const HOST = await ask("Bind host", { default: "127.0.0.1" });
const PORT = await ask("Bind port", { default: "8787", validate: isPort });
const DATABASE_PATH = await ask("Database path", { default: "./data/postern.db" });

stdout.write("\n[2/5] Encryption keys\n");
const ENC_KEY = takeOrGenerate("ENC_KEY");
const LOOKUP_KEY = takeOrGenerate("LOOKUP_KEY");
if (preserved.includes("ENC_KEY")) {
  stdout.write("  ✓ ENC_KEY preserved from existing .env\n");
} else {
  stdout.write("  ✓ ENC_KEY generated (32 bytes)\n");
}
if (preserved.includes("LOOKUP_KEY")) {
  stdout.write("  ✓ LOOKUP_KEY preserved from existing .env\n");
} else {
  stdout.write("  ✓ LOOKUP_KEY generated (32 bytes)\n");
}

stdout.write("\n[3/5] SimpleLogin\n");
const SL_API_KEY = await askSecret("API key (no echo)", { validate: minLen(10) });
const OWNER_DOMAIN = await ask("Owner domain (e.g. example.com)", { validate: isDomain });

stdout.write("\n[4/5] Proton SMTP\n");
const SMTP_USER = await ask("SMTP user (Proton email)", { validate: isEmail });
const SMTP_PASS = await askSecret("SMTP password (Proton SMTP token, no echo)", {
  validate: minLen(1),
});
const OWNER_EMAIL = await ask("Reply-To owner email (blank = same as SMTP user)", {
  default: "",
  validate: isOptionalEmail,
});

stdout.write("\n[5/5] Cloudflare Turnstile\n");
const turnstileRequired = NODE_ENV === "production";
const TURNSTILE_SECRET = await askSecret(
  `Turnstile secret${turnstileRequired ? " (required in production, no echo)" : " (blank to skip in dev, no echo)"}`,
  { validate: turnstileRequired ? minLen(1) : undefined },
);
const ALLOWED_ORIGINS = await ask(
  "Allowed origins (comma-separated, blank = same-origin only)",
  { default: "" },
);

stdout.write("\n[+] Admin UI (optional)\n");
const enableAdmin = await askYesNo("Enable admin UI?", false);
let ADMIN_PASSWORD_HASH = "";
let ADMIN_SESSION_SECRET = "";
let ADMIN_SESSION_TTL_HOURS = "12";
if (enableAdmin) {
  const pw = await askSecret("Admin password (min 8 chars, no echo)", {
    confirm: true,
    validate: minLen(8),
  });
  ADMIN_PASSWORD_HASH = hashPasswordForSetup(pw);
  ADMIN_SESSION_SECRET = takeOrGenerate("ADMIN_SESSION_SECRET");
  if (preserved.includes("ADMIN_SESSION_SECRET")) {
    stdout.write("  ✓ ADMIN_SESSION_SECRET preserved from existing .env\n");
  } else {
    stdout.write("  ✓ ADMIN_SESSION_SECRET generated (32 bytes)\n");
  }
  ADMIN_SESSION_TTL_HOURS = await ask("Session TTL hours (1-168)", {
    default: "12",
    validate: (v) =>
      /^\d+$/.test(v) && +v >= 1 && +v <= 168 ? null : "must be 1-168",
  });
}

// ---- assemble env object & validate via loadConfig ----

const envObj = {
  NODE_ENV,
  HOST,
  PORT,
  LOG_LEVEL: "info",
  DATABASE_PATH,
  ENC_KEY,
  LOOKUP_KEY,
  SL_BASE_URL: "https://app.simplelogin.io",
  SL_API_KEY,
  OWNER_DOMAIN,
  SMTP_HOST: "smtp.protonmail.ch",
  SMTP_PORT: "587",
  SMTP_USER,
  SMTP_PASS,
  ...(OWNER_EMAIL ? { OWNER_EMAIL } : {}),
  ...(TURNSTILE_SECRET ? { TURNSTILE_SECRET } : {}),
  TURNSTILE_VERIFY_URL: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  ALLOWED_ORIGINS,
  ADMIN_ENABLED: enableAdmin ? "true" : "false",
  ...(enableAdmin
    ? { ADMIN_PASSWORD_HASH, ADMIN_SESSION_SECRET, ADMIN_SESSION_TTL_HOURS }
    : {}),
};

try {
  loadConfig(envObj);
} catch (err) {
  stderr.write(`\n✗ validation failed: ${err?.message ?? err}\n`);
  stderr.write("  No .env was written. Re-run setup.\n");
  exit(1);
}

// ---- render & write .env ----

const lines = [
  `# Postern — generated by 'npm run setup' on ${new Date().toISOString()}.`,
  `# Edit by hand or re-run 'npm run setup -- --force' to regenerate.`,
  ``,
  `# --- runtime`,
  `NODE_ENV=${NODE_ENV}`,
  `HOST=${HOST}`,
  `PORT=${PORT}`,
  `LOG_LEVEL=info`,
  ``,
  `# --- database`,
  `DATABASE_PATH=${DATABASE_PATH}`,
  ``,
  `# --- encryption keys (32 bytes each, hex). Independent values.`,
  `# Alternative: KEY_FILE=/etc/postern/keys.json (mode 0600, JSON {"enc","lookup"})`,
  `ENC_KEY=${ENC_KEY}`,
  `LOOKUP_KEY=${LOOKUP_KEY}`,
  `# KEY_FILE=`,
  ``,
  `# --- SimpleLogin`,
  `SL_BASE_URL=https://app.simplelogin.io`,
  `SL_API_KEY=${SL_API_KEY}`,
  `OWNER_DOMAIN=${OWNER_DOMAIN}`,
  ``,
  `# --- Proton SMTP`,
  `SMTP_HOST=smtp.protonmail.ch`,
  `SMTP_PORT=587`,
  `SMTP_USER=${SMTP_USER}`,
  `SMTP_PASS=${SMTP_PASS}`,
  OWNER_EMAIL ? `OWNER_EMAIL=${OWNER_EMAIL}` : `# OWNER_EMAIL=`,
  ``,
  `# --- Cloudflare Turnstile (required in production)`,
  `TURNSTILE_SECRET=${TURNSTILE_SECRET ?? ""}`,
  `TURNSTILE_VERIFY_URL=https://challenges.cloudflare.com/turnstile/v0/siteverify`,
  ``,
  `# --- Caps & rate limits (defaults shown; uncomment to override)`,
  `# PROTON_DAILY_CAP=1000`,
  `# PROTON_HOURLY_CAP=300`,
  `# CIRCUIT_BREAKER_PCT=0.95`,
  `# RATE_LIMIT_PER_IP_PER_MIN=5`,
  `# RATE_LIMIT_PER_IP_PER_HOUR=20`,
  ``,
  `# --- Alias generation (defaults shown)`,
  `# ALIAS_SUFFIX_KIND=digits`,
  `# ALIAS_SUFFIX_LENGTH=5`,
  `# ALIAS_SEPARATOR=.`,
  ``,
  `# --- CORS allowlist`,
  `ALLOWED_ORIGINS=${ALLOWED_ORIGINS}`,
  ``,
  `# --- Admin UI (mounted at /admin).`,
  `ADMIN_ENABLED=${enableAdmin ? "true" : "false"}`,
];
if (enableAdmin) {
  lines.push(
    `ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}`,
    `ADMIN_SESSION_SECRET=${ADMIN_SESSION_SECRET}`,
    `ADMIN_SESSION_TTL_HOURS=${ADMIN_SESSION_TTL_HOURS}`,
  );
} else {
  lines.push(
    `# ADMIN_PASSWORD_HASH=`,
    `# ADMIN_SESSION_SECRET=`,
    `# ADMIN_SESSION_TTL_HOURS=12`,
  );
}
lines.push(`# ADMIN_COOKIE_SECURE=true  # defaults to NODE_ENV==production`, ``);

writeFileSync(ENV_PATH, lines.join("\n"), { encoding: "utf8" });
if (platform !== "win32") {
  chmodSync(ENV_PATH, 0o600);
}

stdout.write(
  `\n✓ Wrote ${ENV_PATH}${platform === "win32" ? "" : " (mode 0600)"}\n`,
);
if (preserved.length > 0) {
  stdout.write(`  Preserved from prior .env: ${preserved.join(", ")}\n`);
}
stdout.write("\nNext steps:\n");
stdout.write("  npm install\n");
stdout.write("  npm run build && npm start\n");
stdout.write("  # or: docker compose up -d --build\n");
