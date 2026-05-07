// Env parsing + validation. Single source of truth for configuration.
//
// Encryption keys (`ENC_KEY`, `LOOKUP_KEY`) are accepted as either:
//   - 64 hex chars (32 bytes), or
//   - a base64 / base64url string that decodes to 32 bytes.
// Or, alternatively, a path may be given via `KEY_FILE` pointing at a
// mode-600 file containing a JSON object `{enc, lookup}` of the same encoded
// strings. Direct env values win when both are provided.

import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { CryptoKeys } from "./lib/crypto.js";

function decodeKey(input: string, name: string): Buffer {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  // base64 / base64url. Node's "base64" decoder accepts both with the
  // url-safe variant under "base64url".
  const isUrl = /[-_]/.test(trimmed);
  try {
    const buf = Buffer.from(trimmed, isUrl ? "base64url" : "base64");
    if (buf.length === 32) return buf;
  } catch {
    /* fall through */
  }
  throw new Error(`${name} must decode to 32 bytes (hex or base64)`);
}

const KeyFileSchema = z.object({
  enc: z.string().min(1),
  lookup: z.string().min(1),
});

function loadKeysFromFile(path: string): { enc: string; lookup: string } {
  const st = statSync(path);
  if (process.platform !== "win32") {
    // Best-effort permission check on POSIX. Skipped on Windows because
    // the mode bits don't map cleanly.
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `KEY_FILE ${path} has permissive mode ${mode.toString(8)} — must be 0600`,
      );
    }
  }
  const raw = readFileSync(path, "utf8");
  const parsed = KeyFileSchema.parse(JSON.parse(raw));
  return parsed;
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_PATH: z.string().min(1).default("./data/postern.db"),

  ENC_KEY: z.string().optional(),
  LOOKUP_KEY: z.string().optional(),
  KEY_FILE: z.string().optional(),

  // SimpleLogin
  SL_BASE_URL: z.string().url().default("https://app.simplelogin.io"),
  SL_API_KEY: z.string().min(10),
  OWNER_DOMAIN: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "OWNER_DOMAIN must be a bare domain"),

  // Proton SMTP
  SMTP_HOST: z.string().default("smtp.protonmail.ch"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().email("SMTP_USER must be the owner Proton address"),
  SMTP_PASS: z.string().min(1, "SMTP_PASS must be a Proton SMTP token"),
  OWNER_EMAIL: z.string().email().optional(),

  // Turnstile
  TURNSTILE_SECRET: z.string().min(1).optional(),
  TURNSTILE_VERIFY_URL: z.string().url().default("https://challenges.cloudflare.com/turnstile/v0/siteverify"),

  // Caps / rate limits
  PROTON_DAILY_CAP: z.coerce.number().int().positive().default(1000),
  PROTON_HOURLY_CAP: z.coerce.number().int().positive().default(300),
  CIRCUIT_BREAKER_PCT: z.coerce.number().min(0.5).max(1).default(0.95),
  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),

  // Alias generation
  ALIAS_SUFFIX_KIND: z.enum(["digits", "hex", "words", "none"]).default("digits"),
  ALIAS_SUFFIX_LENGTH: z.coerce.number().int().min(3).max(8).default(5),
  ALIAS_SEPARATOR: z.enum([".", "-", "_", ""]).default("."),

  // CORS — allowed origins for the contact form. Comma-separated. Empty = same-origin only.
  ALLOWED_ORIGINS: z.string().default(""),

  // Admin UI (mounted at /admin). Disabled by default; existing deployments boot unchanged.
  ADMIN_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s.trim().toLowerCase() === "true"),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().optional(),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  ADMIN_COOKIE_SECURE: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : s.trim().toLowerCase() === "true")),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Config {
  env: RawEnv;
  isProd: boolean;
  isTest: boolean;
  keys: CryptoKeys;
  ownerEmail: string;
  allowedOrigins: string[];
  adminEnabled: boolean;
  /** Present iff adminEnabled. */
  adminPasswordHash: string | null;
  adminSessionSecret: Buffer | null;
  adminSessionTtlMs: number;
  adminCookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);

  let encRaw = parsed.ENC_KEY;
  let lookupRaw = parsed.LOOKUP_KEY;
  if ((!encRaw || !lookupRaw) && parsed.KEY_FILE) {
    const fromFile = loadKeysFromFile(parsed.KEY_FILE);
    encRaw = encRaw ?? fromFile.enc;
    lookupRaw = lookupRaw ?? fromFile.lookup;
  }
  if (!encRaw || !lookupRaw) {
    throw new Error("ENC_KEY and LOOKUP_KEY must be set (directly or via KEY_FILE)");
  }
  const encKey = decodeKey(encRaw, "ENC_KEY");
  const lookupKey = decodeKey(lookupRaw, "LOOKUP_KEY");
  if (encKey.equals(lookupKey)) {
    throw new Error("ENC_KEY and LOOKUP_KEY must be independent values");
  }

  if (parsed.NODE_ENV === "production" && !parsed.TURNSTILE_SECRET) {
    throw new Error("TURNSTILE_SECRET is required in production");
  }

  const allowedOrigins = parsed.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isProd = parsed.NODE_ENV === "production";
  let adminPasswordHash: string | null = null;
  let adminSessionSecret: Buffer | null = null;
  if (parsed.ADMIN_ENABLED) {
    if (!parsed.ADMIN_PASSWORD_HASH || !parsed.ADMIN_SESSION_SECRET) {
      throw new Error(
        "ADMIN_ENABLED=true requires ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET",
      );
    }
    adminPasswordHash = parsed.ADMIN_PASSWORD_HASH;
    adminSessionSecret = decodeKey(parsed.ADMIN_SESSION_SECRET, "ADMIN_SESSION_SECRET");
    if (adminSessionSecret.equals(encKey) || adminSessionSecret.equals(lookupKey)) {
      throw new Error("ADMIN_SESSION_SECRET must be independent of ENC_KEY/LOOKUP_KEY");
    }
  }

  return {
    env: parsed,
    isProd,
    isTest: parsed.NODE_ENV === "test",
    keys: { encKey, lookupKey },
    ownerEmail: parsed.OWNER_EMAIL ?? parsed.SMTP_USER,
    allowedOrigins,
    adminEnabled: parsed.ADMIN_ENABLED,
    adminPasswordHash,
    adminSessionSecret,
    adminSessionTtlMs: parsed.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000,
    adminCookieSecure: parsed.ADMIN_COOKIE_SECURE ?? isProd,
  };
}
