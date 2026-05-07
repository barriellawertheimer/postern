import { describe, it, expect } from "vitest";
import { normalizeFormat, describeFormat, DEFAULT_FORMAT } from "../../src/lib/format.js";

describe("format", () => {
  it("returns DEFAULT_FORMAT shape on empty input", () => {
    const f = normalizeFormat({});
    expect(f).toMatchObject({
      separator: ".",
      order: "site-suffix",
      plusAddressing: false,
      lowercase: true,
      template: "",
    });
    expect(f.suffix).toEqual({ kind: "digits", length: 5 });
  });

  it("clamps suffix length into [3,8] for digits/hex", () => {
    expect(normalizeFormat({ suffix: { kind: "digits", length: 1 } }).suffix.length).toBe(3);
    expect(normalizeFormat({ suffix: { kind: "digits", length: 99 } }).suffix.length).toBe(8);
    expect(normalizeFormat({ suffix: { kind: "hex", length: 4 } }).suffix.length).toBe(4);
  });

  it("falls back to defaults on invalid enum values", () => {
    // @ts-expect-error testing runtime fallback for invalid separator
    const f = normalizeFormat({ separator: "?", order: "garbage" });
    expect(f.separator).toBe(DEFAULT_FORMAT.separator);
    expect(f.order).toBe(DEFAULT_FORMAT.order);
  });

  it("describeFormat returns a useful single line", () => {
    expect(describeFormat({})).toContain("digits");
    expect(describeFormat({ template: "{site}-{rand:4}" })).toContain("template");
  });
});
