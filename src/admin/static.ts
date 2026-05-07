// Serves the built React SPA from `dist/admin-ui/` under /admin/.
// SPA fallback: GET requests under /admin/ that don't match a file and
// accept text/html return `index.html`, so client-side router deep links
// work (e.g. /admin/visitors/42).
//
// If the root directory or index.html is missing at boot, the plugin
// logs a warning and does NOT register itself — the API plugin still works.
// This lets operators enable ADMIN_ENABLED before they've built the UI.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export interface AdminStaticDeps {
  /** Absolute path to the directory containing the SPA's `index.html`. */
  staticRoot?: string;
}

export function defaultStaticRoot(): string {
  // src/admin/static.ts → dist/admin/static.js at runtime; the SPA bundle
  // is copied to dist/admin-ui by scripts/copy-assets.mjs.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../admin-ui");
}

export async function registerAdminStatic(
  app: FastifyInstance,
  deps: AdminStaticDeps = {},
): Promise<void> {
  const root = deps.staticRoot ?? defaultStaticRoot();
  if (!existsSync(resolve(root, "index.html"))) {
    app.log.warn({ root }, "admin SPA bundle not found; /admin will 404 until the UI is built");
    return;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: "/admin/",
    wildcard: false,
    // We need reply.sendFile in the SPA fallback below; decoration is scoped
    // to this encapsulation so it doesn't leak onto /contact or /healthz.
    decorateReply: true,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== "GET") {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const accept = req.headers.accept ?? "";
    if (!accept.includes("text/html")) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply.sendFile("index.html");
  });
}
