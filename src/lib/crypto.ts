// AES-256-GCM column encryption + HMAC-SHA256 deterministic lookup.
//
// On-disk layout for an encrypted column (a single Buffer):
//
//   [version:1 byte][iv:12 bytes][tag:16 bytes][ciphertext:N bytes]
//
// version=1 today; bump on any cipher/format change. The IV is generated
// fresh per encryption with `randomBytes(12)`. GCM tag is 16 bytes.
//
// The lookup column is `HMAC-SHA256(LOOKUP_KEY, normalizedEmail)` —
// deterministic so a UNIQUE index resolves returning visitors and acts
// as the idempotency key on double-submit.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

export interface CryptoKeys {
  /** 32 bytes: AES-256-GCM column key. */
  encKey: Buffer;
  /** 32 bytes: HMAC-SHA256 lookup key. Independent of encKey. */
  lookupKey: Buffer;
}

function assertKey(buf: Buffer, name: string): void {
  if (!Buffer.isBuffer(buf) || buf.length !== 32) {
    throw new Error(`${name} must be 32 bytes (got ${buf?.length ?? "n/a"})`);
  }
}

export function encryptColumn(plaintext: string, keys: CryptoKeys): Buffer {
  assertKey(keys.encKey, "ENC_KEY");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, keys.encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) {
    throw new Error(`unexpected GCM tag length ${tag.length}`);
  }
  const header = Buffer.alloc(1);
  header[0] = VERSION;
  return Buffer.concat([header, iv, tag, ct]);
}

export function decryptColumn(blob: Buffer, keys: CryptoKeys): string {
  assertKey(keys.encKey, "ENC_KEY");
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_LEN) {
    throw new Error("ciphertext too short");
  }
  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`unsupported ciphertext version ${version}`);
  }
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, HEADER_LEN);
  const ct = blob.subarray(HEADER_LEN);
  const decipher = createDecipheriv(ALGO, keys.encKey, iv);
  decipher.setAuthTag(tag);
  // GCM authenticates the (iv, ciphertext, tag) tuple. If any byte in any
  // of these is flipped, `final()` throws. That's the tamper guarantee
  // tested by `test/unit/crypto.test.ts`.
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Normalize an email before HMAC so trivial equivalents collide:
 *   - trim whitespace
 *   - lowercase the whole address (technically only the domain is
 *     case-insensitive per RFC 5321, but every consumer mailer
 *     lowercases the local part too, and we want returning-visitor
 *     matching to be forgiving)
 */
export function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

export function hmacLookup(email: string, keys: CryptoKeys): Buffer {
  assertKey(keys.lookupKey, "LOOKUP_KEY");
  const h = createHmac("sha256", keys.lookupKey);
  h.update(normalizeEmail(email), "utf8");
  return h.digest();
}

/** Constant-time equality for two HMAC blobs. */
export function lookupEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
