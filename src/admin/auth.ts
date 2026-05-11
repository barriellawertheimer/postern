// Admin authentication primitives:
//   - scrypt password hashing with a verify path that's safe against
//     malformed-hash inputs and timing-leak comparisons.
//   - Stateless session tokens of the form `<b64u(payload)>.<b64u(HMAC)>`.
//
// No DB tables. No `@fastify/jwt`. Revocation is by rotating
// ADMIN_SESSION_SECRET.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_HASH_LEN = 64;
const SCRYPT_SALT_LEN = 16;

const HASH_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

/**
 * Encode a password as `scrypt$N=...,r=...,p=...$<saltB64>$<hashB64>`.
 * Used by the `scripts/hash-admin-password.mjs` helper at setup time;
 * never invoked at runtime.
 */
export function hashPasswordForSetup(plain: string): string {
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const hash = scryptSync(plain, salt, SCRYPT_HASH_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // scrypt's default maxmem rejects N=16384,r=8 unless we raise it slightly.
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time verify. Returns false on any malformed input. */
export function verifyPassword(plain: string, encoded: string): boolean {
  const m = HASH_RE.exec(encoded);
  if (!m) return false;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(m[4]!, "base64");
    expected = Buffer.from(m[5]!, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface SessionPayload {
  /** issued-at, ms since epoch */
  iat: number;
  /** expiry, ms since epoch */
  exp: number;
  /** schema version; bump if payload shape changes */
  v: 1;
}

// Domain-separation prefixes mixed into the HMAC input. A session token's
// signature can never validate as a pwreset token (and vice versa) even
// though they share `ADMIN_SESSION_SECRET`.
const DOMAIN_SESSION = Buffer.from("postern.session.v1", "utf8");
const DOMAIN_PWRESET = Buffer.from("postern.pwreset.v1", "utf8");

function sign(domain: Buffer, body: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(domain).update(":").update(body).digest("base64url");
}

function expectedSigBytes(domain: Buffer, body: string, secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(domain).update(":").update(body).digest();
}

/** `<b64u(JSON(payload))>.<b64u(HMAC-SHA256)>` */
export function signSession(payload: SessionPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(DOMAIN_SESSION, body, secret)}`;
}

/** Returns the payload on success; null on any failure (malformed, bad sig, expired, wrong version). */
export function verifySession(
  token: string,
  secret: Buffer,
  now: number = Date.now(),
): SessionPayload | null {
  const parsed = parseAndVerify(token, secret, DOMAIN_SESSION);
  if (!parsed) return null;
  if (!isSessionPayload(parsed)) return null;
  if (parsed.exp <= now) return null;
  return parsed;
}

export interface PwResetPayload {
  /** issued-at, ms since epoch */
  iat: number;
  /** expiry, ms since epoch */
  exp: number;
  /** admin_state.pwreset_epoch the token was minted against */
  epoch: number;
  /** schema version; bump if payload shape changes */
  v: 1;
  /** purpose tag — belt-and-braces alongside the domain-separated HMAC */
  p: "pwreset";
}

export function signPwResetToken(payload: PwResetPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(DOMAIN_PWRESET, body, secret)}`;
}

export function verifyPwResetToken(
  token: string,
  secret: Buffer,
  now: number = Date.now(),
): PwResetPayload | null {
  const parsed = parseAndVerify(token, secret, DOMAIN_PWRESET);
  if (!parsed) return null;
  if (!isPwResetPayload(parsed)) return null;
  if (parsed.exp <= now) return null;
  return parsed;
}

function parseAndVerify(token: string, secret: Buffer, domain: Buffer): unknown {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = expectedSigBytes(domain, body, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isSessionPayload(x: unknown): x is SessionPayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o["v"] === 1 &&
    typeof o["iat"] === "number" &&
    typeof o["exp"] === "number" &&
    Number.isFinite(o["iat"]) &&
    Number.isFinite(o["exp"])
  );
}

function isPwResetPayload(x: unknown): x is PwResetPayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    o["v"] === 1 &&
    o["p"] === "pwreset" &&
    typeof o["iat"] === "number" &&
    typeof o["exp"] === "number" &&
    typeof o["epoch"] === "number" &&
    Number.isFinite(o["iat"]) &&
    Number.isFinite(o["exp"]) &&
    Number.isInteger(o["epoch"])
  );
}
