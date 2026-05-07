// SimpleLogin client — three calls per mint:
//   1. GET  /api/v5/alias/options?hostname=<owner-domain>
//      → fresh `signed_suffix` (10-min TTL — never cache across requests).
//   2. POST /api/v3/alias/custom/new (with selected suffix + alias_prefix)
//      → numeric `alias_id` and the alias string.
//   3. POST /api/aliases/<alias_id>/contacts  body {contact: <visitor email>}
//      → reverse_alias_address — the bit that closes the Reply loop.
//
// All requests use a shared `undici` Pool keyed to the SL base origin.

import { request } from "undici";
import type { Logger } from "../lib/log.js";

export class SimpleLoginError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SimpleLoginError";
  }
}

export interface AliasOptions {
  /** First domain entry whose `signed_suffix` we'll use. */
  signedSuffix: string;
  /** The displayed suffix, e.g. ".abc12@ownerdomain.com". Logged for debug only. */
  prettySuffix: string;
}

export interface CreatedAlias {
  aliasId: number;
  alias: string;
}

export interface CreatedContact {
  contactId: number;
  reverseAliasAddress: string;
}

export interface SimpleLoginConfig {
  baseUrl: string;
  apiKey: string;
  ownerDomain: string;
  logger?: Logger;
}

export class SimpleLoginClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly ownerDomain: string;
  private readonly logger: Logger | undefined;

  constructor(cfg: SimpleLoginConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "Authentication": cfg.apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    this.ownerDomain = cfg.ownerDomain;
    this.logger = cfg.logger;
  }

  async close(): Promise<void> {
    /* nothing to close — undici's global agent is reused */
  }

  private async json<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const opts: Parameters<typeof request>[1] = {
      method,
      headers: this.headers,
      headersTimeout: 10_000,
      bodyTimeout: 15_000,
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await request(`${this.baseUrl}${path}`, opts);
    const text = await res.body.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.statusCode >= 400) {
      const errorMsg = extractErrorMessage(data);
      throw new SimpleLoginError(
        `SimpleLogin ${method} ${path} failed: ${res.statusCode} ${errorMsg}`,
        res.statusCode,
        data,
        classifyErrorCode(res.statusCode, errorMsg),
      );
    }
    return { status: res.statusCode, data: data as T };
  }

  /**
   * Fetch alias options for the owner's hostname. Picks the first custom
   * domain matching `ownerDomain` and returns its `signed_suffix`. The
   * 10-minute TTL on this token is why callers must invoke `options()`
   * immediately before `createCustomAlias()`.
   */
  async options(): Promise<AliasOptions> {
    interface OptionsResponse {
      can_create: boolean;
      suffixes?: Array<{ suffix: string; signed_suffix: string }>;
    }
    const { data } = await this.json<OptionsResponse>(
      "GET",
      `/api/v5/alias/options?hostname=${encodeURIComponent(this.ownerDomain)}`,
    );
    if (!data.can_create) {
      throw new SimpleLoginError(
        "SimpleLogin reports user cannot create aliases (plan limit?)",
        200,
        data,
        "cannot_create",
      );
    }
    const suffixes = data.suffixes ?? [];
    // Prefer a suffix whose pretty form ends with the owner domain. SL's API
    // returns suffixes for every custom + shared domain available; we want
    // ours, not a random shared SL one.
    const owned = suffixes.find((s) => s.suffix.endsWith(`@${this.ownerDomain}`))
      ?? suffixes[0];
    if (!owned) {
      throw new SimpleLoginError(
        "SimpleLogin returned no usable suffix",
        200,
        data,
        "no_suffix",
      );
    }
    return { signedSuffix: owned.signed_suffix, prettySuffix: owned.suffix };
  }

  async createCustomAlias(
    aliasPrefix: string,
    signedSuffix: string,
    note?: string,
  ): Promise<CreatedAlias> {
    interface NewAliasResponse {
      alias: string;
      id: number;
    }
    const body: Record<string, unknown> = {
      alias_prefix: aliasPrefix,
      signed_suffix: signedSuffix,
    };
    if (note) body["note"] = note;
    const { data } = await this.json<NewAliasResponse>(
      "POST",
      `/api/v3/alias/custom/new`,
      body,
    );
    return { aliasId: data.id, alias: data.alias };
  }

  async createContact(aliasId: number, visitorEmail: string): Promise<CreatedContact> {
    interface ContactResponse {
      id: number;
      reverse_alias_address: string;
    }
    const { data } = await this.json<ContactResponse>(
      "POST",
      `/api/aliases/${aliasId}/contacts`,
      { contact: visitorEmail },
    );
    return { contactId: data.id, reverseAliasAddress: data.reverse_alias_address };
  }

  /**
   * Best-effort cleanup. Used when we mint an alias and then lose the
   * UNIQUE-constraint race in the DB — we don't want to burn the user's
   * SL alias quota on a row we won't keep.
   */
  async deleteAlias(aliasId: number): Promise<void> {
    try {
      await this.json<unknown>("DELETE", `/api/aliases/${aliasId}`);
    } catch (err) {
      this.logger?.warn({ err, aliasId }, "failed to delete orphan SL alias");
    }
  }
}

function extractErrorMessage(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj["error"] === "string") return obj["error"];
    if (typeof obj["message"] === "string") return obj["message"];
  }
  return "";
}

/**
 * Map an HTTP error to a coarse code so callers can react to specific
 * conditions (notably `signed_suffix` expiry, which the orchestrator retries
 * once after refetching options).
 */
function classifyErrorCode(status: number, msg: string): string | undefined {
  const m = msg.toLowerCase();
  if (status === 400 || status === 410 || status === 422) {
    if (m.includes("expire") || m.includes("invalid") && m.includes("suffix")) {
      return "signed_suffix_expired";
    }
    if (m.includes("alias") && (m.includes("exist") || m.includes("taken") || m.includes("already"))) {
      return "alias_exists";
    }
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return undefined;
}
