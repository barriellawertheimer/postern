// Admin JSON API. Mounted under /admin/api with the cookie plugin already
// registered in the parent encapsulation. Every mutating request goes
// through `mutatingGuard` (content-type + Origin); every non-login route
// goes through `requireAdmin`.
//
// The login route is intentionally rate-limited tighter than the rest
// (5 / 15 min per IP) to make brute-force expensive.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import { signSession, verifyPassword } from "./auth.js";
import {
  ADMIN_COOKIE_NAME,
  makeRequireAdmin,
  mutatingGuard,
} from "./preHandlers.js";
import type { VisitorRow } from "../db/repo.js";

export interface AdminApiDeps {
  config: Config;
  repo: Repo;
  breakerThreshold: number;
}

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerAdminApi(app: FastifyInstance, deps: AdminApiDeps): Promise<void> {
  const { config, repo, breakerThreshold } = deps;
  if (!config.adminEnabled || !config.adminPasswordHash || !config.adminSessionSecret) {
    throw new Error("registerAdminApi called without admin config");
  }
  const passwordHash = config.adminPasswordHash;
  const sessionSecret = config.adminSessionSecret;
  const requireAdmin = makeRequireAdmin(sessionSecret);
  const cookieMaxAgeSec = Math.floor(config.adminSessionTtlMs / 1000);

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
      if (!verifyPassword(parsed.data.password, passwordHash)) {
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
