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

/** `<b64u(JSON(payload))>.<b64u(HMAC-SHA256)>` */
export function signSession(payload: SessionPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Returns the payload on success; null on any failure (malformed, bad sig, expired, wrong version). */
export function verifySession(
  token: string,
  secret: Buffer,
  now: number = Date.now(),
): SessionPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = createHmac("sha256", secret).update(body).digest();
  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let payload: unknown;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isSessionPayload(payload)) return null;
  if (payload.exp <= now) return null;
  return payload;
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
