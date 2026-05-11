// Admin JSON API. Mounted under /admin/api with the cookie plugin already
// registered in the parent encapsulation. Every mutating request goes
// through `mutatingGuard` (content-type + Origin); every non-login route
// goes through `requireAdmin`.
//
// The login route is intentionally rate-limited tighter than the rest
// (5 / 15 min per IP) to make brute-force expensive.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import type { ProtonMailerLike } from "../services/proton.js";
import {
  hashPasswordForSetup,
  signPwResetToken,
  signSession,
  verifyPassword,
  verifyPwResetToken,
} from "./auth.js";
import {
  ADMIN_COOKIE_NAME,
  makeRequireAdmin,
  mutatingGuard,
} from "./preHandlers.js";
import type { VisitorRow } from "../db/repo.js";

export interface AdminApiDeps {
  config: Config;
  repo: Repo;
  mailer: ProtonMailerLike;
  breakerThreshold: number;
}

const PWRESET_TTL_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LEN = 8;

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

const VisitorListQuery = PaginationQuery.extend({
  status: z.enum(["active", "blocked"]).optional(),
  q: z.string().trim().min(1).max(254).optional(),
});

const SubmissionListQuery = PaginationQuery.extend({
  visitorId: z.coerce.number().int().positive().optional(),
});

const AuditQuery = PaginationQuery.extend({
  event: z.string().trim().min(1).max(64).optional(),
  since: z.coerce.number().int().min(0).optional(),
});

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const LoginBody = z.object({ password: z.string().min(1).max(1024) });
const ForgotBody = z.object({ email: z.string().trim().min(1).max(254) });
const ResetBody = z.object({
  token: z.string().min(1).max(4096),
  password: z.string().min(MIN_PASSWORD_LEN).max(1024),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps): Promise<void> {
  const { config, repo, mailer, breakerThreshold } = deps;
  if (!config.adminEnabled || !config.adminSessionSecret) {
    throw new Error("registerAdminApi called without admin config");
  }
  // Live hash: read on every login so resets are picked up without a restart.
  // The admin_state row is seeded at boot in server.ts before we get here.
  const sessionSecret = config.adminSessionSecret;
  const requireAdmin = makeRequireAdmin(sessionSecret);
  const cookieMaxAgeSec = Math.floor(config.adminSessionTtlMs / 1000);
  const ownerEmail = config.ownerEmail;

  // Treat empty bodies on POST as {} so block/unblock/logout don't need a body.
  // Replaces Fastify's default JSON parser within this encapsulation only.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, bodyStr, done) => {
      const s = String(bodyStr ?? "").trim();
      if (s.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        e.statusCode = 400;
        done(e, undefined);
      }
    },
  );

  app.addHook("preValidation", mutatingGuard);

  // Unknown /admin/api/* paths must stay JSON; without this they would
  // fall through to the sibling static plugin's HTML SPA-fallback handler.
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: "not_found" });
  });

  // --- Auth ----------------------------------------------------------------

  app.post(
    "/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input" });
      }
      const adminState = repo.getAdminState();
      if (!adminState) {
        request.log.error("admin_state row missing at login time");
        return reply.code(500).send({ error: "server_error" });
      }
      if (!verifyPassword(parsed.data.password, adminState.passwordHash)) {
        request.log.warn({ ip: request.ip }, "admin login failed");
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const now = Date.now();
      const token = signSession(
        { iat: now, exp: now + config.adminSessionTtlMs, v: 1 },
        sessionSecret,
      );
      reply.setCookie(ADMIN_COOKIE_NAME, token, {
        path: "/admin",
        httpOnly: true,
        sameSite: "lax",
        secure: config.adminCookieSecure,
        maxAge: cookieMaxAgeSec,
      });
      request.log.info({ ip: request.ip }, "admin login ok");
      return reply.code(204).send();
    },
  );

  app.post("/logout", { preHandler: requireAdmin }, async (_request, reply) => {
    reply.clearCookie(ADMIN_COOKIE_NAME, { path: "/admin" });
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: requireAdmin }, async (request) => ({
    authenticated: true,
    exp: request.adminSession!.exp,
  }));

  // Password reset request. Mints a short-lived HMAC token bound to the
  // current pwreset_epoch, mails the recovery link to the owner mailbox
  // via Proton SMTP, and always returns 204 (no enumeration / no leak of
  // whether the supplied email matched). Tight rate-limit on top of the
  // 1-msg/sec Proton transport limit.
  app.post(
    "/forgot",
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 hour",
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = ForgotBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input" });
      }
      // Constant-time owner-email compare — refuse to enqueue mail unless the
      // supplied email exactly matches the configured owner. This prevents
      // trivial mail-bombing of the owner inbox.
      const provided = Buffer.from(parsed.data.email.toLowerCase(), "utf8");
      const expected = Buffer.from(ownerEmail.toLowerCase(), "utf8");
      const sameLen = provided.length === expected.length;
      const matches = sameLen && timingSafeEqual(provided, expected);
      if (!matches) {
        // Audit so brute-force enumeration is visible, but still 204 to
        // the caller. Logging the IP is fine; the email is not echoed.
        repo.audit("admin_pwreset_email_mismatch", { detail: `ip=${request.ip}` });
        return reply.code(204).send();
      }

      const state = repo.getAdminState();
      if (!state) {
        request.log.error("admin_state row missing at /forgot");
        return reply.code(500).send({ error: "server_error" });
      }
      const now = Date.now();
      const token = signPwResetToken(
        { iat: now, exp: now + PWRESET_TTL_MS, epoch: state.pwresetEpoch, v: 1, p: "pwreset" },
        sessionSecret,
      );
      const proto = request.protocol;
      const host = request.headers.host ?? "";
      const link = `${proto}://${host}/admin/reset?token=${encodeURIComponent(token)}`;
      const ttlMin = Math.floor(PWRESET_TTL_MS / 60_000);

      try {
        await mailer.sendAdminMail({
          subject: "Postern admin: password reset",
          text: renderResetText(link, ttlMin, request.ip),
          html: renderResetHtml(link, ttlMin, request.ip),
        });
        repo.audit("admin_pwreset_requested", { detail: `ip=${request.ip}` });
      } catch (err) {
        request.log.warn({ err, ip: request.ip }, "admin pwreset mail failed");
        repo.audit("admin_pwreset_mail_failed", { detail: `ip=${request.ip}` });
      }
      return reply.code(204).send();
    },
  );

  app.post(
    "/reset",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = ResetBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_input" });
      }
      const payload = verifyPwResetToken(parsed.data.token, sessionSecret);
      if (!payload) {
        repo.audit("admin_pwreset_invalid_token", { detail: `ip=${request.ip}` });
        return reply.code(401).send({ error: "invalid_token" });
      }
      const state = repo.getAdminState();
      if (!state) {
        request.log.error("admin_state row missing at /reset");
        return reply.code(500).send({ error: "server_error" });
      }
      // Epoch mismatch means the token was minted before a more recent reset
      // (or another concurrent reset finished first). Either way, dead.
      if (payload.epoch !== state.pwresetEpoch) {
        repo.audit("admin_pwreset_stale_epoch", { detail: `ip=${request.ip}` });
        return reply.code(401).send({ error: "invalid_token" });
      }

      const newHash = hashPasswordForSetup(parsed.data.password);
      repo.updateAdminPassword(newHash);
      repo.audit("admin_pwreset_completed", { detail: `ip=${request.ip}` });
      request.log.info({ ip: request.ip }, "admin password reset ok");
      return reply.code(204).send();
    },
  );

  // --- Dashboard -----------------------------------------------------------

  app.get("/dashboard", { preHandler: requireAdmin }, async () => {
    const stats = repo.dashboardStats();
    return {
      sendsToday: stats.sendsToday,
      cap: config.env.PROTON_DAILY_CAP,
      breakerThreshold,
      breakerTripped: stats.sendsToday >= breakerThreshold,
      visitorsActive: stats.visitorsActive,
      visitorsBlocked: stats.visitorsBlocked,
      failures24h: stats.failures24h,
    };
  });

  // --- Visitors ------------------------------------------------------------

  app.get("/visitors", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = VisitorListQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", issues: parsed.error.flatten() });
    }
    const { limit, offset, status, q } = parsed.data;

    if (q !== undefined) {
      const seen = new Set<number>();
      const rows: VisitorRow[] = [];
      // Substring match on alias_local / alias_full.
      for (const v of repo.searchVisitors(q, limit)) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          rows.push(v);
        }
      }
      // If the query parses as an email, also try an exact lookup on the
      // (encrypted) email column via the deterministic HMAC.
      if (EMAIL_RE.test(q) && rows.length < limit) {
        const exact = repo.getVisitorByEmail(q);
        if (exact && !seen.has(exact.id)) rows.push(exact);
      }
      return { rows: rows.map(visitorToDto), total: rows.length };
    }

    const rows = repo.listVisitors({ status: status ?? null, limit, offset });
    const total = repo.countVisitors(status ?? null);
    return { rows: rows.map(visitorToDto), total };
  });

  app.get("/visitors/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = IdParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const visitor = repo.getVisitorById(parsed.data.id);
    if (!visitor) return reply.code(404).send({ error: "not_found" });
    const submissions = repo.listSubmissionsByVisitor(visitor.id, PAGE_LIMIT_DEFAULT, 0);
    const total = repo.countSubmissionsByVisitor(visitor.id);
    return {
      visitor: visitorToDto(visitor),
      submissions,
      submissionsTotal: total,
    };
  });

  app.post("/visitors/:id/block", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = IdParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const ok = repo.setVisitorStatus(parsed.data.id, "blocked");
    if (!ok) return reply.code(404).send({ error: "not_found" });
    repo.audit("admin_block", { visitorId: parsed.data.id });
    return { status: "blocked" };
  });

  app.post("/visitors/:id/unblock", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = IdParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const ok = repo.setVisitorStatus(parsed.data.id, "active");
    if (!ok) return reply.code(404).send({ error: "not_found" });
    repo.audit("admin_unblock", { visitorId: parsed.data.id });
    return { status: "active" };
  });

  // --- Submissions ---------------------------------------------------------

  app.get("/submissions", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = SubmissionListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const { limit, offset, visitorId } = parsed.data;
    if (visitorId !== undefined) {
      const rows = repo.listSubmissionsByVisitor(visitorId, limit, offset);
      const total = repo.countSubmissionsByVisitor(visitorId);
      return { rows, total };
    }
    const rows = repo.listSubmissions({ limit, offset });
    return { rows };
  });

  app.get("/submissions/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = IdParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const submission = repo.getSubmissionById(parsed.data.id);
    if (!submission) return reply.code(404).send({ error: "not_found" });
    repo.audit("admin_message_view", {
      visitorId: submission.visitorId,
      detail: `submissionId=${submission.id}`,
    });
    return { submission };
  });

  // --- Audit log -----------------------------------------------------------

  app.get("/audit", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = AuditQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input" });
    const { limit, offset, event, since } = parsed.data;
    const listOpts = { event: event ?? null, limit, offset, ...(since !== undefined ? { sinceMs: since } : {}) };
    const countOpts = { event: event ?? null, ...(since !== undefined ? { sinceMs: since } : {}) };
    const rows = repo.listAudit(listOpts);
    const total = repo.countAudit(countOpts);
    return { rows, total };
  });
}

function renderResetText(link: string, ttlMin: number, requesterIp: string): string {
  return [
    `Someone requested a password reset for the Postern admin UI.`,
    ``,
    `Reset link (valid for ${ttlMin} minutes, single-use):`,
    link,
    ``,
    `Requested from IP: ${requesterIp}`,
    ``,
    `If you did not request this, you can ignore this email — the link will`,
    `expire on its own and your current password is still valid. Any future`,
    `reset will invalidate this link.`,
  ].join("\n");
}

function renderResetHtml(link: string, ttlMin: number, requesterIp: string): string {
  const safeLink = escapeHtmlAttr(link);
  const safeIp = escapeHtmlAttr(requesterIp);
  return `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5">
<h2 style="margin:0 0 12px 0">Postern admin password reset</h2>
<p>Someone requested a password reset for the Postern admin UI.</p>
<p><a href="${safeLink}">Reset password</a> &nbsp; <small>(valid for ${ttlMin} minutes, single-use)</small></p>
<p style="font-size:12px;color:#666">Requested from IP: <code>${safeIp}</code></p>
<p style="font-size:12px;color:#666">
If you did not request this, you can ignore this email — the link will expire
on its own and your current password is still valid. Any future reset will
invalidate this link.
</p>
</body></html>`;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function visitorToDto(v: VisitorRow) {
  return {
    id: v.id,
    email: v.email,
    firstName: v.firstName,
    lastName: v.lastName,
    aliasLocal: v.aliasLocal,
    aliasFull: v.aliasFull,
    slAliasId: v.slAliasId,
    slReverseAlias: v.slReverseAlias,
    status: v.status,
    createdAt: v.createdAt,
    lastSeenAt: v.lastSeenAt,
  };
}
