// Admin sub-tree wiring. Encapsulates the cookie plugin and the JSON API
// plugin under a single Fastify register so cookie parsing does NOT leak
// onto /contact or /healthz.
//
// Caller (server.ts) should only invoke this when config.adminEnabled.

import type { FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import type { ProtonMailerLike } from "../services/proton.js";
import { registerAdminApi } from "./api.js";
import { registerAdminStatic } from "./static.js";

export interface AdminDeps {
  config: Config;
  repo: Repo;
  mailer: ProtonMailerLike;
  breakerThreshold: number;
  /** Override the SPA bundle directory (test fixtures use this). */
  staticRoot?: string;
}

export async function registerAdmin(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  if (!deps.config.adminEnabled) return;

  await app.register(async (instance) => {
    await instance.register(fastifyCookie);

    // API plugin first (its own JSON 404 handler, scoped to /admin/api).
    await instance.register(
      async (api) => {
        await registerAdminApi(api, deps);
      },
      { prefix: "/admin/api" },
    );

    // Static plugin second, in its own encapsulation so its SPA-fallback
    // 404 handler does not steal /admin/api/* 404s.
    await instance.register(async (staticScope) => {
      await registerAdminStatic(
        staticScope,
        deps.staticRoot !== undefined ? { staticRoot: deps.staticRoot } : {},
      );
    });
  });
}
