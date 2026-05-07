import { describe, it, expect } from "vitest";
import {
  buildAlias,
  buildSuffix,
  randomDigits,
  randomHex,
  randomWord,
  sanitizeLocal,
  renderTemplate,
} from "../../src/lib/generate.js";
import { normalizeFormat } from "../../src/lib/format.js";

describe("generate", () => {
  it("randomDigits returns N digits", () => {
    const s = randomDigits(8);
    expect(s).toMatch(/^\d{8}$/);
  });

  it("randomHex returns N lowercase hex chars", () => {
    const s = randomHex(12);
    expect(s).toMatch(/^[0-9a-f]{12}$/);
  });

  it("randomWord returns a word from the list", () => {
    const w = randomWord();
    expect(w).toMatch(/^[a-z]+$/);
  });

  it("sanitizeLocal preserves first.last shape and strips junk", () => {
    expect(sanitizeLocal("John.Doe")).toBe("john.doe");
    expect(sanitizeLocal("  John D'Oé  ")).toBe("johndo");
    expect(sanitizeLocal("..a..b..")).toBe("a.b");
    expect(sanitizeLocal("")).toBe("user");
  });

  it("buildSuffix dispatches on kind", () => {
    expect(buildSuffix({ kind: "digits", length: 4 })).toMatch(/^\d{4}$/);
    expect(buildSuffix({ kind: "hex", length: 5 })).toMatch(/^[0-9a-f]{5}$/);
    expect(buildSuffix({ kind: "words", length: 0 })).toMatch(/^[a-z]+$/);
    expect(buildSuffix({ kind: "none", length: 0 })).toBe("");
  });

  it("buildAlias produces local-part with valid characters only", () => {
    const fmt = normalizeFormat({});
    for (let i = 0; i < 1000; i++) {
      const suffix = buildSuffix(fmt.suffix);
      const alias = buildAlias("john.doe", { value: "ownerdomain.com" }, fmt, suffix);
      const [local] = alias.split("@");
      expect(local).toMatch(/^[a-z0-9._+-]+$/);
      // Pretty alias must contain the suffix exactly once (suffix appears
      // contiguously after the separator-joined local).
      expect(local!.endsWith(suffix)).toBe(true);
    }
  });

  it("renderTemplate replaces tokens", () => {
    const out = renderTemplate("{site}-{rand:3}", { site: "Hello.World", counter: 1 });
    expect(out).toMatch(/^hello\.world-\d{3}$/);
  });
});
