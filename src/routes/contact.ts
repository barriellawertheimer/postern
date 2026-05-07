// POST /contact — the convergence point.
//
// Order is intentional:
//   1. Schema validation (zod)         — cheap, kills malformed payloads
//   2. Per-IP rate limit (plugin)      — handled by route config
//   3. Turnstile verification          — gate before any external calls
//   4. Circuit breaker                 — daily Proton cap check
//   5. Alias mint (DB-cached or fresh) — talks to SL only on miss
//   6. SMTP send                       — Proton notification
//   7. submission row + send count     — only on success
//
// On (4) trip we still persist the visitor + submission rows and audit
// `circuit_breaker_skip` so the operator can see what was dropped.

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import type { AliasMint } from "../services/aliasMint.js";
import type { ProtonMailerLike } from "../services/proton.js";
import type { TurnstileVerifier } from "../services/turnstile.js";

const ContactBody = z.object({
  firstName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/, "no control chars"),
  lastName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/, "no control chars"),
  email: z.string().trim().toLowerCase().email().max(254),
  message: z.string().trim().min(1).max(5000),
  // In tests we let an absent token slide through when Turnstile is stubbed.
  turnstileToken: z.string().min(1).max(2048).optional(),
});

export interface ContactDeps {
  config: Config;
  repo: Repo;
  aliasMint: AliasMint;
  mailer: ProtonMailerLike;
  turnstile: TurnstileVerifier;
}

export async function registerContactRoute(
  app: FastifyInstance,
  deps: ContactDeps,
): Promise<void> {
  const { config, repo, aliasMint, mailer, turnstile } = deps;
  const breakerThreshold = Math.floor(
    config.env.PROTON_DAILY_CAP * config.env.CIRCUIT_BREAKER_PCT,
  );

  app.post("/contact", {
    config: {
      rateLimit: {
        max: config.env.RATE_LIMIT_PER_IP_PER_MIN,
        timeWindow: "1 minute",
        keyGenerator: (req) => req.ip,
      },
    },
  }, async (request, reply) => {
    const parsed = ContactBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", issues: parsed.error.flatten() });
    }
    const body = parsed.data;
    const log = request.log;

    // Idempotency key for Turnstile retries — derived from the lookup-stable
    // tuple so a network retry of the same submission collides correctly.
    const idemKey = createHash("sha256")
      .update([body.email, body.firstName, body.lastName, body.message].join("\x1f"))
      .digest("hex")
      .slice(0, 32);

    if (config.isProd || config.env.TURNSTILE_SECRET) {
      const tokenForVerify = body.turnstileToken;
      if (!tokenForVerify) {
        return reply.code(400).send({ error: "missing_turnstile_token" });
      }
      const ts = await turnstile.verify({
        token: tokenForVerify,
        ip: request.ip,
        idempotencyKey: idemKey,
      });
      if (!ts.success) {
        log.warn({ errorCodes: ts.errorCodes }, "turnstile verification failed");
        return reply.code(403).send({ error: "turnstile_failed", codes: ts.errorCodes ?? [] });
      }
    }

    // Mint (or reuse) the alias *before* the circuit breaker check, so a
    // broken-mailbox day doesn't lose the visitor's identity. SL state is
    // cheap to maintain even when SMTP is paused.
    let outcome;
    try {
      outcome = await aliasMint.getOrMint({
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
      });
    } catch (err) {
      log.error({ err }, "alias mint failed");
      repo.audit("mint_failed", { detail: errMsg(err) });
      return reply.code(502).send({ error: "alias_mint_failed" });
    }
    const visitor = outcome.visitor;

    // Always persist the submission, regardless of circuit-breaker state.
    repo.recordSubmission({
      visitorId: visitor.id,
      message: body.message,
      ipHash: hashOrNull(request.ip),
      uaHash: hashOrNull(request.headers["user-agent"]),
    });

    const dailyCount = repo.dailyCount();
    if (dailyCount >= breakerThreshold) {
      log.warn({ dailyCount, breakerThreshold }, "circuit breaker tripped; deferring SMTP");
      repo.audit("circuit_breaker_skip", {
        visitorId: visitor.id,
        detail: `dailyCount=${dailyCount} threshold=${breakerThreshold}`,
      });
      return reply.code(202).send({
        status: "queued",
        reused: outcome.kind === "reused",
        deferred: true,
      });
    }

    const prettyAlias = aliasMint.prettyAlias(visitor);
    try {
      const sent = await mailer.send({
        visitorFirstName: body.firstName,
        visitorLastName: body.lastName,
        visitorPrettyAlias: prettyAlias,
        reverseAliasAddress: visitor.slReverseAlias,
        message: body.message,
      });
      const newCount = repo.recordSend();
      repo.audit(outcome.kind === "minted" ? "minted_and_sent" : "reused_and_sent", {
        visitorId: visitor.id,
        detail: `messageId=${sent.messageId} dailyCount=${newCount}`,
      });
      return reply.code(202).send({ status: "sent", reused: outcome.kind === "reused" });
    } catch (err) {
      log.error({ err }, "smtp send failed");
      repo.audit("smtp_send_failed", { visitorId: visitor.id, detail: errMsg(err) });
      return reply.code(502).send({ error: "send_failed" });
    }
  });
}

function hashOrNull(input: string | string[] | undefined | null): Buffer | null {
  if (!input) return null;
  const value = Array.isArray(input) ? input.join(",") : input;
  return createHash("sha256").update(value, "utf8").digest();
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
