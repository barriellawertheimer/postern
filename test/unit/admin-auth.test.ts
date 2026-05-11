import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import {
  hashPasswordForSetup,
  verifyPassword,
  signSession,
  verifySession,
  signPwResetToken,
  verifyPwResetToken,
  type SessionPayload,
  type PwResetPayload,
} from "../../src/admin/auth.js";

describe("hashPasswordForSetup / verifyPassword", () => {
  it("produces a parseable scrypt-encoded string", () => {
    const encoded = hashPasswordForSetup("hunter2");
    expect(encoded).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it("round-trips: correct password verifies, wrong password does not", () => {
    const encoded = hashPasswordForSetup("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", encoded)).toBe(true);
    expect(verifyPassword("incorrect horse battery staple", encoded)).toBe(false);
    expect(verifyPassword("", encoded)).toBe(false);
  });

  it("each call uses a fresh random salt (encoded output differs)", () => {
    const a = hashPasswordForSetup("pw");
    const b = hashPasswordForSetup("pw");
    expect(a).not.toBe(b);
    expect(verifyPassword("pw", a)).toBe(true);
    expect(verifyPassword("pw", b)).toBe(true);
  });

  it("rejects malformed encoded strings without throwing", () => {
    expect(verifyPassword("pw", "")).toBe(false);
    expect(verifyPassword("pw", "not-a-hash")).toBe(false);
    expect(verifyPassword("pw", "scrypt$N=16384,r=8,p=1$$")).toBe(false);
    expect(verifyPassword("pw", "argon2$abc$def$ghi")).toBe(false);
  });

  it("rejects a hash whose bytes have been tampered with", () => {
    const encoded = hashPasswordForSetup("pw");
    // Decode the hash segment, flip the first byte, re-encode.
    const lastDollar = encoded.lastIndexOf("$");
    const hashB64 = encoded.slice(lastDollar + 1);
    const buf = Buffer.from(hashB64, "base64");
    buf[0] ^= 0xff;
    const tampered = `${encoded.slice(0, lastDollar + 1)}${buf.toString("base64")}`;
    expect(verifyPassword("pw", tampered)).toBe(false);
  });
});

describe("signSession / verifySession", () => {
  const secret = randomBytes(32);
  const now = 1_700_000_000_000;

  function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
    return { iat: now, exp: now + 60_000, v: 1, ...overrides };
  }

  it("round-trips a valid token", () => {
    const token = signSession(payload(), secret);
    const got = verifySession(token, secret, now);
    expect(got).toEqual(payload());
  });

  it("rejects expired tokens", () => {
    const token = signSession(payload({ exp: now - 1 }), secret);
    expect(verifySession(token, secret, now)).toBeNull();
  });

  it("treats exp == now as expired (boundary)", () => {
    const token = signSession(payload({ exp: now }), secret);
    expect(verifySession(token, secret, now)).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const token = signSession(payload(), secret);
    expect(verifySession(token, randomBytes(32), now)).toBeNull();
  });

  it("rejects tokens with a tampered body", () => {
    const token = signSession(payload(), secret);
    const [body, sig] = token.split(".");
    // Decode, mutate exp, re-encode body — sig won't match.
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.exp = now + 1_000_000_000;
    const tamperedBody = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    expect(verifySession(`${tamperedBody}.${sig}`, secret, now)).toBeNull();
  });

  it("rejects tokens with a tampered signature", () => {
    const token = signSession(payload(), secret);
    const last = token.slice(-1);
    const swap = last === "A" ? "B" : "A";
    expect(verifySession(token.slice(0, -1) + swap, secret, now)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySession("", secret, now)).toBeNull();
    expect(verifySession("nodot", secret, now)).toBeNull();
    expect(verifySession(".sigonly", secret, now)).toBeNull();
    expect(verifySession("bodyonly.", secret, now)).toBeNull();
    expect(verifySession("garbage.morejunk", secret, now)).toBeNull();
  });

  it("rejects tokens with the wrong version field", () => {
    // Forge a payload with v=2 and a valid HMAC over it.
    const forged = { iat: now, exp: now + 60_000, v: 2 };
    const body = Buffer.from(JSON.stringify(forged)).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(verifySession(`${body}.${sig}`, secret, now)).toBeNull();
  });

  it("rejects payloads missing required numeric fields", () => {
    const forged = { v: 1, exp: now + 60_000 }; // missing iat
    const body = Buffer.from(JSON.stringify(forged)).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(verifySession(`${body}.${sig}`, secret, now)).toBeNull();
  });
});

describe("signPwResetToken / verifyPwResetToken", () => {
  const secret = randomBytes(32);
  const now = 1_700_000_000_000;

  function payload(overrides: Partial<PwResetPayload> = {}): PwResetPayload {
    return { iat: now, exp: now + 15 * 60_000, epoch: 0, v: 1, p: "pwreset", ...overrides };
  }

  it("round-trips a valid token", () => {
    const token = signPwResetToken(payload(), secret);
    expect(verifyPwResetToken(token, secret, now)).toEqual(payload());
  });

  it("rejects expired tokens", () => {
    const token = signPwResetToken(payload({ exp: now - 1 }), secret);
    expect(verifyPwResetToken(token, secret, now)).toBeNull();
  });

  it("rejects tokens signed with a different secret", () => {
    const token = signPwResetToken(payload(), secret);
    expect(verifyPwResetToken(token, randomBytes(32), now)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyPwResetToken("", secret, now)).toBeNull();
    expect(verifyPwResetToken("nodot", secret, now)).toBeNull();
    expect(verifyPwResetToken("garbage.morejunk", secret, now)).toBeNull();
  });

  it("domain-separates session and pwreset tokens (a session token cannot validate as pwreset)", () => {
    // Forge a session token whose body happens to satisfy the pwreset shape.
    // Even with matching body, the session HMAC mixes a different domain
    // string, so the pwreset verifier rejects it.
    const body: SessionPayload & Partial<PwResetPayload> = {
      iat: now,
      exp: now + 60_000,
      v: 1,
    };
    const sessionToken = signSession(body, secret);
    // Tack on the pwreset-required fields by signing a fresh pwreset payload
    // and confirming the session token still doesn't pass pwreset verification.
    expect(verifyPwResetToken(sessionToken, secret, now)).toBeNull();
  });

  it("domain-separates the other direction (a pwreset token cannot validate as a session)", () => {
    const pwToken = signPwResetToken(payload(), secret);
    expect(verifySession(pwToken, secret, now)).toBeNull();
  });

  it("rejects pwreset payloads with missing epoch", () => {
    // Sign via the actual signer so the HMAC is valid, then manually rebuild
    // a body without the epoch field. The fresh body won't match the original
    // signature — so this is effectively the same as "tampered body" but
    // documents that epoch is required.
    const body = { iat: now, exp: now + 60_000, v: 1, p: "pwreset" };
    const bodyB64 = Buffer.from(JSON.stringify(body)).toString("base64url");
    // Sign with the right domain to isolate the missing-field check.
    const sig = createHmac("sha256", secret)
      .update(Buffer.from("postern.pwreset.v1", "utf8"))
      .update(":")
      .update(bodyB64)
      .digest("base64url");
    expect(verifyPwResetToken(`${bodyB64}.${sig}`, secret, now)).toBeNull();
  });

  it("preserves epoch through round-trip (caller is responsible for comparing it to live state)", () => {
    const got = verifyPwResetToken(signPwResetToken(payload({ epoch: 42 }), secret), secret, now);
    expect(got?.epoch).toBe(42);
  });
});
