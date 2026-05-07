// Cloudflare Turnstile token verification.
//
// In production, calls the official `siteverify` endpoint with the secret,
// the token, the visitor IP, and an `idempotency_key` so legitimate retries
// don't fail with `timeout-or-duplicate`.
//
// In development/test, returns `{success: true}` when the secret is unset
// so local form submissions work without the Cloudflare round-trip.

import { request } from "undici";
import { randomUUID } from "node:crypto";
import type { Logger } from "../lib/log.js";

export interface TurnstileResult {
  success: boolean;
  errorCodes?: string[];
}

export interface TurnstileVerifierOptions {
  secret: string | undefined;
  verifyUrl: string;
  isProduction: boolean;
  logger?: Logger;
}

export interface VerifyArgs {
  token: string;
  ip?: string | null;
  /** Stable across retries of the same logical submission. */
  idempotencyKey?: string;
}

export class TurnstileVerifier {
  constructor(private readonly opts: TurnstileVerifierOptions) {}

  async verify(args: VerifyArgs): Promise<TurnstileResult> {
    if (!this.opts.secret) {
      if (this.opts.isProduction) {
        // Defense in depth — config.ts already enforces this.
        return { success: false, errorCodes: ["missing-secret"] };
      }
      this.opts.logger?.debug("Turnstile secret unset; skipping verification (dev/test)");
      return { success: true };
    }
    const form = new URLSearchParams();
    form.set("secret", this.opts.secret);
    form.set("response", args.token);
    if (args.ip) form.set("remoteip", args.ip);
    form.set("idempotency_key", args.idempotencyKey ?? randomUUID());

    try {
      const res = await request(this.opts.verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      });
      const data = (await res.body.json()) as {
        success: boolean;
        ["error-codes"]?: string[];
      };
      return { success: !!data.success, errorCodes: data["error-codes"] ?? [] };
    } catch (err) {
      this.opts.logger?.warn({ err }, "Turnstile verify request failed");
      return { success: false, errorCodes: ["network-error"] };
    }
  }
}
