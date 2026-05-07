// Per-IP rate limit. The plugin is registered globally (no auto-application);
// individual routes opt in via `config.rateLimit`. We use a short window
// (per-minute) on /contact — the daily Proton cap is the *separate* circuit
// breaker enforced by the route handler reading sends_today.

import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

export interface RateLimitOptions {
  perMin: number;
}

export async function registerRateLimit(
  app: FastifyInstance,
  opts: RateLimitOptions,
): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    max: opts.perMin,
    timeWindow: "1 minute",
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    keyGenerator: (req) => req.ip,
  });
}
