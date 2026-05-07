// Admin auth preHandler + CSRF guard for mutating requests.
//
// requireAdmin reads the signed session cookie and either attaches the
// payload to the request or sends 401. The mutatingGuard runs on POSTs
// and rejects requests with the wrong content-type or a cross-origin
// `Origin` header — our layered CSRF defense alongside SameSite=Lax.

import type { FastifyReply, FastifyRequest } from "fastify";
import { verifySession, type SessionPayload } from "./auth.js";

export const ADMIN_COOKIE_NAME = "postern_admin";

declare module "fastify" {
  interface FastifyRequest {
    adminSession?: SessionPayload;
  }
}

export function makeRequireAdmin(secret: Buffer) {
  return async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies?.[ADMIN_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const session = verifySession(token, secret);
    if (!session) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    req.adminSession = session;
  };
}

/**
 * Reject mutating requests that aren't `application/json` or whose `Origin`
 * doesn't match the request host. SameSite=Lax on the session cookie is the
 * primary CSRF defense; this hook is the second layer.
 */
export async function mutatingGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    reply.code(415).send({ error: "unsupported_media_type" });
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const expected = `${req.protocol}://${req.headers.host}`;
    if (origin !== expected) {
      reply.code(403).send({ error: "csrf_origin_mismatch" });
      return;
    }
  }
}
