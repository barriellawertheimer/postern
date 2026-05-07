// Format model + validation. Pure. Ported verbatim from alias_email_gen.
// The {site}{sep}{suffix} shape is reused as {first.last}{sep}{suffix} —
// only the meaning of the local-part input changed; the format model itself
// is unchanged.

export type SuffixKind = "digits" | "hex" | "words" | "none";
export type Order = "site-suffix" | "suffix-site";
export type Separator = "." | "-" | "_" | "";

export interface SuffixConfig {
  kind: SuffixKind;
  length: number;
}

export interface Format {
  separator: Separator;
  suffix: SuffixConfig;
  order: Order;
  plusAddressing: boolean;
  lowercase: boolean;
  template: string;
}

export const DEFAULT_FORMAT: Format = {
  separator: ".",
  suffix: { kind: "digits", length: 5 },
  order: "site-suffix",
  plusAddressing: false,
  lowercase: true,
  template: "",
};

const SEPARATORS = new Set<Separator>([".", "-", "_", ""]);
const SUFFIX_KINDS = new Set<SuffixKind>(["digits", "hex", "words", "none"]);
const ORDERS = new Set<Order>(["site-suffix", "suffix-site"]);

function clampLength(n: unknown, kind: SuffixKind): number {
  const fallback = kind === "hex" ? 6 : 5;
  const v = Number.isFinite(n) ? Math.floor(n as number) : fallback;
  if (kind === "words" || kind === "none") return v; // unused but preserved
  return Math.max(3, Math.min(8, v));
}

export function normalizeFormat(input?: Partial<Format> | null): Format {
  const f: Format = { ...DEFAULT_FORMAT, ...(input ?? {}) };
  if (!SEPARATORS.has(f.separator)) f.separator = DEFAULT_FORMAT.separator;
  if (!ORDERS.has(f.order)) f.order = DEFAULT_FORMAT.order;
  f.plusAddressing = Boolean(f.plusAddressing);
  f.lowercase = f.lowercase !== false;
  f.template = typeof f.template === "string" ? f.template : "";

  const inSuffix = (input?.suffix ?? {}) as Partial<SuffixConfig>;
  const s: SuffixConfig = { ...DEFAULT_FORMAT.suffix, ...inSuffix };
  if (!SUFFIX_KINDS.has(s.kind)) s.kind = "digits";
  s.length = clampLength(s.length, s.kind);
  f.suffix = s;
  return f;
}

export function describeFormat(f: Partial<Format> | null | undefined): string {
  const fmt = normalizeFormat(f);
  if (fmt.template) {
    const plus = fmt.plusAddressing ? ", plus-addressed" : "";
    return `template "${fmt.template}"${plus}`;
  }
  const sep = fmt.separator || "(none)";
  let suffix: string;
  switch (fmt.suffix.kind) {
    case "digits":
      suffix = `${fmt.suffix.length} digits`;
      break;
    case "hex":
      suffix = `${fmt.suffix.length} hex`;
      break;
    case "words":
      suffix = "random word";
      break;
    case "none":
      suffix = "no suffix";
      break;
    default:
      suffix = (fmt.suffix as { kind: string }).kind;
  }
  const order = fmt.order === "suffix-site" ? "suffix first" : "site first";
  const plus = fmt.plusAddressing ? ", plus-addressed" : "";
  return `sep "${sep}", ${suffix}, ${order}${plus}`;
}
