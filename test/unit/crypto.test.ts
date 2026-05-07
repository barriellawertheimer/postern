import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptColumn,
  decryptColumn,
  hmacLookup,
  lookupEquals,
  normalizeEmail,
} from "../../src/lib/crypto.js";
import { makeTestKeys } from "../fixtures/testKeys.js";

describe("crypto", () => {
  it("encrypt → decrypt round-trips arbitrary plaintext", () => {
    const keys = makeTestKeys();
    const cases = [
      "",
      "ascii",
      "café — résumé — 🌐 — naïve",
      "x".repeat(10_000),
      "control\x00chars\nare\tfine",
    ];
    for (const pt of cases) {
      const blob = encryptColumn(pt, keys);
      expect(decryptColumn(blob, keys)).toBe(pt);
    }
  });

  it("ciphertexts are unique across identical plaintexts (random IV)", () => {
    const keys = makeTestKeys();
    const a = encryptColumn("same", keys);
    const b = encryptColumn("same", keys);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it("flipping any byte in the ciphertext throws on decrypt", () => {
    const keys = makeTestKeys();
    const pt = "tamper-test-payload";
    const blob = encryptColumn(pt, keys);
    for (let i = 0; i < blob.length; i++) {
      const tampered = Buffer.from(blob);
      tampered[i] = tampered[i]! ^ 0x01;
      expect(() => decryptColumn(tampered, keys)).toThrow();
    }
  });

  it("decrypt with the wrong key throws", () => {
    const a = makeTestKeys();
    const b = makeTestKeys();
    const blob = encryptColumn("secret", a);
    expect(() => decryptColumn(blob, b)).toThrow();
  });

  it("hmacLookup is deterministic for normalized email", () => {
    const keys = makeTestKeys();
    const a = hmacLookup("Alice@Example.COM", keys);
    const b = hmacLookup("  alice@example.com  ", keys);
    expect(lookupEquals(a, b)).toBe(true);
  });

  it("hmacLookup differs across distinct emails", () => {
    const keys = makeTestKeys();
    const a = hmacLookup("alice@example.com", keys);
    const b = hmacLookup("bob@example.com", keys);
    expect(lookupEquals(a, b)).toBe(false);
  });

  it("hmacLookup differs across distinct keys", () => {
    const k1 = makeTestKeys();
    const k2 = { ...k1, lookupKey: randomBytes(32) };
    const a = hmacLookup("alice@example.com", k1);
    const b = hmacLookup("alice@example.com", k2);
    expect(lookupEquals(a, b)).toBe(false);
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  FOO@BAR.com  ")).toBe("foo@bar.com");
  });
});
