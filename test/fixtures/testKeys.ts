import { randomBytes } from "node:crypto";
import type { CryptoKeys } from "../../src/lib/crypto.js";

export function makeTestKeys(): CryptoKeys {
  return { encKey: randomBytes(32), lookupKey: randomBytes(32) };
}
