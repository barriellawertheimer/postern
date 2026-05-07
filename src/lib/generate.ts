// Pure alias generation. Ported from alias_email_gen with one intentional
// change: Web Crypto (`crypto.getRandomValues`) is replaced by
// `randomFillSync` from `node:crypto` so rejection-sampling semantics
// are preserved (don't substitute `randomInt`).
//
// `sanitizeSite` is renamed to `sanitizeLocal` because its job here is
// slugifying `first.last`, not a site name.

import { randomFillSync } from "node:crypto";
import type { Format, SuffixConfig } from "./format.js";

const WORDS = [
  "amber", "azure", "basil", "blaze", "brisk", "cedar", "clay", "cliff",
  "coral", "cove", "crisp", "dawn", "delta", "drift", "ember", "fable",
  "fern", "flint", "frost", "glade", "glow", "grove", "harbor", "haven",
  "hazel", "ivory", "juno", "koda", "lake", "lark", "linen", "lumen",
  "lupin", "lyric", "marsh", "mesa", "mint", "mist", "moss", "nimbus",
  "north", "oak", "ocean", "onyx", "opal", "orbit", "otter", "pebble",
  "pine", "plume", "polar", "quartz", "quill", "raven", "reef", "river",
  "rune", "sable", "salt", "sand", "sage", "shore", "silk", "sky",
  "slate", "snow", "solar", "spark", "spire", "spruce", "stone", "storm",
  "stream", "sun", "swift", "tarn", "teal", "thistle", "thorn", "tide",
  "tiger", "topaz", "trail", "vale", "verge", "vine", "violet", "vortex",
  "willow", "wind", "wing", "winter", "wisp", "wolf", "wren", "yarrow",
  "zenith", "zephyr",
] as const;

// Rejection sampling — uniformly distributed digit 0..9.
function randomDigit(): number {
  const buf = new Uint8Array(1);
  do {
    randomFillSync(buf);
  } while (buf[0]! >= 250); // floor(256 / 10) * 10
  return buf[0]! % 10;
}

function randomHexNibble(): string {
  const buf = new Uint8Array(1);
  do {
    randomFillSync(buf);
  } while (buf[0]! >= 240); // floor(256 / 16) * 16
  return (buf[0]! % 16).toString(16);
}

function randomIndex(max: number): number {
  if (max <= 0) throw new Error("randomIndex requires max > 0");
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    randomFillSync(buf);
  } while (buf[0]! >= limit);
  return buf[0]! % max;
}

export function randomDigits(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String(randomDigit());
  return out;
}

export function randomHex(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += randomHexNibble();
  return out;
}

export function randomWord(): string {
  return WORDS[randomIndex(WORDS.length)]!;
}

export function buildSuffix(suffixCfg: SuffixConfig | null | undefined): string {
  if (!suffixCfg || suffixCfg.kind === "none") return "";
  switch (suffixCfg.kind) {
    case "digits":
      return randomDigits(suffixCfg.length || 5);
    case "hex":
      return randomHex(suffixCfg.length || 6);
    case "words":
      return randomWord();
    default:
      throw new Error(`Unknown suffix kind: ${(suffixCfg as { kind: string }).kind}`);
  }
}

// Slugify a local-part candidate (e.g. `first.last`) down to safe characters,
// preserving the dot used as the name separator. Falls back to "user" if the
// input collapses to empty.
export function sanitizeLocal(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  // Collapse repeated dots and trim leading/trailing dots — these break the
  // RFC local part and look ugly in an alias.
  const tidy = cleaned.replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  return tidy || "user";
}

// Strip characters disallowed in the local part. Keeps RFC-safe punctuation.
function sanitizeLocalPart(s: unknown): string {
  return String(s ?? "").replace(/[^a-zA-Z0-9._+-]/g, "");
}

export const TEMPLATE_TOKENS = [
  "{site}", "{yyyy}", "{yy}", "{mm}", "{dd}",
  "{rand:N}", "{hex:N}", "{word}", "{counter}",
] as const;

export interface TemplateCtx {
  site?: unknown;
  counter?: number;
  now?: Date;
}

export function renderTemplate(template: string, ctx?: TemplateCtx): string {
  const site = sanitizeLocal(ctx?.site);
  const now = ctx?.now instanceof Date ? ctx.now : new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const counter = Number.isFinite(ctx?.counter) ? String(ctx!.counter) : "1";

  return String(template).replace(/\{([a-z]+)(?::(\d+))?\}/gi, (match, name: string, n?: string) => {
    const len = Math.max(1, Math.min(32, Number(n) || 4));
    switch (name.toLowerCase()) {
      case "site":
        return site;
      case "yyyy":
        return yyyy;
      case "yy":
        return yyyy.slice(-2);
      case "mm":
        return mm;
      case "dd":
        return dd;
      case "rand":
        return randomDigits(len);
      case "hex":
        return randomHex(len);
      case "word":
        return randomWord();
      case "counter":
        return counter;
      default:
        return match;
    }
  });
}

export interface DomainEntry {
  value: string;
}

// Assemble an alias from a local-part input (e.g. "john.doe"), a domain
// entry, a format, and a pre-rolled suffix.
export function buildAlias(
  localRaw: unknown,
  domainEntry: DomainEntry,
  format: Format,
  suffix: string,
  ctx?: TemplateCtx,
): string {
  let local: string;
  if (format.template) {
    local = sanitizeLocalPart(
      renderTemplate(format.template, { site: localRaw, counter: ctx?.counter ?? 1 }),
    );
    if (!local) local = sanitizeLocal(localRaw);
  } else {
    const base = sanitizeLocal(localRaw);
    const sep = format.separator || "";
    const order = format.order === "suffix-site" ? "suffix-site" : "site-suffix";
    if (!suffix) {
      local = base;
    } else if (order === "suffix-site") {
      local = `${suffix}${sep}${base}`;
    } else {
      local = `${base}${sep}${suffix}`;
    }
  }
  if (format.lowercase !== false) local = local.toLowerCase();

  const domain = domainEntry?.value || "";
  if (format.plusAddressing && domain.includes("@")) {
    const [base, host] = domain.split("@");
    return `${base}+${local}@${host}`;
  }
  return `${local}@${domain}`;
}
