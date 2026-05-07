// Alias mint orchestrator. Composes:
//   - the ported alias-format library (lib/generate.ts, lib/format.ts)
//   - SimpleLogin's three-call flow (services/simplelogin.ts)
//   - the encrypted Repo (db/repo.ts)
//
// Concurrency: relies on the UNIQUE(email_lookup) constraint for correctness,
// but wraps the orchestration in a per-email-lookup in-process mutex so a
// burst of identical submissions doesn't burn SL alias quota and then
// discard the result on UNIQUE conflict.

import { hmacLookup } from "../lib/crypto.js";
import { buildAlias, buildSuffix, sanitizeLocal } from "../lib/generate.js";
import { normalizeFormat, type Format } from "../lib/format.js";
import {
  SimpleLoginClient,
  SimpleLoginError,
  type CreatedAlias,
  type CreatedContact,
} from "./simplelogin.js";
import type { Repo, VisitorRow } from "../db/repo.js";
import type { CryptoKeys } from "../lib/crypto.js";
import type { Logger } from "../lib/log.js";

export interface MintInput {
  firstName: string;
  lastName: string;
  email: string;
}

export type MintOutcome =
  | { kind: "reused"; visitor: VisitorRow }
  | { kind: "minted"; visitor: VisitorRow };

export interface AliasMintConfig {
  ownerDomain: string;
  format: Format;
  logger?: Logger;
}

export class AliasMint {
  private readonly cfg: AliasMintConfig;
  private readonly inflight = new Map<string, Promise<MintOutcome>>();

  constructor(
    private readonly sl: SimpleLoginClient,
    private readonly repo: Repo,
    private readonly keys: CryptoKeys,
    cfg: AliasMintConfig,
  ) {
    this.cfg = { ...cfg, format: normalizeFormat(cfg.format) };
  }

  /**
   * Idempotent mint. If a row exists for this email already, returns it.
   * Otherwise: SL options → SL create alias → SL create contact → DB upsert.
   * If two concurrent calls land at the same time, only one talks to SL;
   * the other awaits the in-flight promise.
   */
  async getOrMint(input: MintInput): Promise<MintOutcome> {
    const lookup = hmacLookup(input.email, this.keys);
    const key = lookup.toString("hex");

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.runOnce(input).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async runOnce(input: MintInput): Promise<MintOutcome> {
    const cached = this.repo.getVisitorByEmail(input.email);
    if (cached && cached.status === "active") {
      this.repo.touchLastSeen(cached.id);
      return { kind: "reused", visitor: cached };
    }

    const localPrefix = this.buildLocalPrefix(input.firstName, input.lastName);
    const created = await this.mintWithRetry(localPrefix);
    let contact: CreatedContact;
    try {
      contact = await this.sl.createContact(created.aliasId, input.email);
    } catch (err) {
      // Don't leak the alias if contact creation failed.
      this.cfg.logger?.warn(
        { err, aliasId: created.aliasId },
        "createContact failed; deleting orphan alias",
      );
      await this.sl.deleteAlias(created.aliasId);
      throw err;
    }

    const aliasLocal = created.alias.split("@")[0] ?? localPrefix;

    const visitor = this.repo.upsertVisitor({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      aliasLocal,
      aliasFull: created.alias,
      slAliasId: created.aliasId,
      slReverseAlias: contact.reverseAliasAddress,
    });

    if (visitor.slAliasId !== created.aliasId) {
      // Lost the race. Release the SL alias we just minted; the row we got
      // back belongs to the winner of the UNIQUE conflict.
      this.cfg.logger?.info(
        { aliasId: created.aliasId, kept: visitor.slAliasId },
        "lost UNIQUE race; releasing orphan SL alias",
      );
      await this.sl.deleteAlias(created.aliasId);
      return { kind: "reused", visitor };
    }
    return { kind: "minted", visitor };
  }

  /**
   * Try mint once. On `signed_suffix_expired`, refetch options and retry
   * exactly once. On `alias_exists`, reroll the prefix and retry once.
   */
  private async mintWithRetry(initialPrefix: string): Promise<CreatedAlias> {
    let prefix = initialPrefix;
    let attempts = 0;
    let lastErr: unknown;

    while (attempts < 3) {
      attempts++;
      // Always fetch options immediately before each create — `signed_suffix`
      // has a 10-minute TTL and we never cache it.
      const opts = await this.sl.options();
      try {
        return await this.sl.createCustomAlias(prefix, opts.signedSuffix, "postern visitor alias");
      } catch (err) {
        lastErr = err;
        if (err instanceof SimpleLoginError) {
          if (err.code === "signed_suffix_expired") {
            this.cfg.logger?.info("signed_suffix expired between options() and create; retrying");
            continue;
          }
          if (err.code === "alias_exists") {
            // Reroll the suffix and try again — a different visitor or a
            // prior incarnation already grabbed this exact local-part.
            prefix = this.buildLocalPrefix(prefix, "");
            this.cfg.logger?.info({ prefix }, "alias collision; rerolling prefix");
            continue;
          }
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("alias mint exhausted retries");
  }

  private buildLocalPrefix(firstName: string, lastName: string): string {
    const base = sanitizeLocal(`${firstName}.${lastName}`);
    const suffix = buildSuffix(this.cfg.format.suffix);
    // Domain is irrelevant here — SL appends its own; we only want the local
    // part. Pass an empty value and strip the `@` that buildAlias appends.
    const built = buildAlias(base, { value: "" }, this.cfg.format, suffix);
    const local = built.replace(/@$/, "");
    return local || base || "visitor";
  }

  /** Pretty alias for owner-facing display: `<local>@<owner-domain>`. */
  prettyAlias(visitor: VisitorRow): string {
    return `${visitor.aliasLocal}@${this.cfg.ownerDomain}`;
  }
}
