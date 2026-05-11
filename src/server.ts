// Fastify bootstrap. Wires config → DB → services → routes, registers
// graceful-shutdown handlers, and starts listening.
//
// Importing this file as a side-effect runs the server (when invoked
// directly via `node dist/server.js` or `tsx src/server.ts`). Tests
// import `buildApp` instead and never call `start()`.

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { openDatabase } from "./db/migrate.js";
import { Repo } from "./db/repo.js";
import { SimpleLoginClient } from "./services/simplelogin.js";
import { ProtonMailer, type ProtonMailerLike } from "./services/proton.js";
import { TurnstileVerifier } from "./services/turnstile.js";
import { AliasMint } from "./services/aliasMint.js";
import { normalizeFormat } from "./lib/format.js";
import { registerRateLimit } from "./middleware/rateLimit.js";
import { registerContactRoute } from "./routes/contact.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAdmin } from "./admin/index.js";

export interface BuildOptions {
  config?: Config;
  /** Used by tests to inject mock SMTP / SL / Turnstile. */
  overrides?: Partial<{
    mailer: ProtonMailerLike;
    sl: SimpleLoginClient;
    turnstile: TurnstileVerifier;
    dbPath: string;
    /** Override the admin SPA bundle directory. */
    adminStaticRoot: string;
  }>;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: Config;
  shutdown: () => Promise<void>;
}

export async function buildApp(opts: BuildOptions = {}): Promise<BuiltApp> {
  const config = opts.config ?? loadConfig();

  const dbPath = opts.overrides?.dbPath ?? config.env.DATABASE_PATH;
  const { db, applied } = openDatabase(dbPath);
  const repo = new Repo(db, config.keys);

  const loggerOpts: {
    level: string;
    redact: { paths: string[]; censor: string };
    transport?: { target: string; options: Record<string, unknown> };
  } = {
    level: config.env.LOG_LEVEL,
    redact: {
      paths: [
        "env.ADMIN_PASSWORD_HASH",
        "env.ADMIN_SESSION_SECRET",
        "env.SL_API_KEY",
        "env.SMTP_PASS",
        "env.TURNSTILE_SECRET",
      ],
      censor: "[REDACTED]",
    },
  };
  // pino-pretty is dev-only; not installed in production. We don't ship it.
  // If you want pretty logs locally, `npm i -D pino-pretty`.
  // Skip the transport entirely otherwise to keep the type clean.

  const app: FastifyInstance = Fastify({
    logger: loggerOpts,
    trustProxy: true, // honor X-Forwarded-For when behind a reverse proxy
    bodyLimit: 64 * 1024,
  });

  app.log.info({ dbPath, schemaApplied: applied }, "database opened");

  const sl = opts.overrides?.sl ?? new SimpleLoginClient({
    baseUrl: config.env.SL_BASE_URL,
    apiKey: config.env.SL_API_KEY,
    ownerDomain: config.env.OWNER_DOMAIN,
    logger: app.log,
  });

  const mailer = opts.overrides?.mailer ?? new ProtonMailer({
    host: config.env.SMTP_HOST,
    port: config.env.SMTP_PORT,
    user: config.env.SMTP_USER,
    pass: config.env.SMTP_PASS,
    ownerEmail: config.ownerEmail,
    logger: app.log,
  });

  const turnstile = opts.overrides?.turnstile ?? new TurnstileVerifier({
    secret: config.env.TURNSTILE_SECRET,
    verifyUrl: config.env.TURNSTILE_VERIFY_URL,
    isProduction: config.isProd,
    logger: app.log,
  });

  const aliasMint = new AliasMint(sl, repo, config.keys, {
    ownerDomain: config.env.OWNER_DOMAIN,
    format: normalizeFormat({
      separator: config.env.ALIAS_SEPARATOR,
      suffix: { kind: config.env.ALIAS_SUFFIX_KIND, length: config.env.ALIAS_SUFFIX_LENGTH },
    }),
    logger: app.log,
  });

  await registerRateLimit(app, { perMin: config.env.RATE_LIMIT_PER_IP_PER_MIN });

  if (config.allowedOrigins.length > 0) {
    app.addHook("onSend", async (req, reply) => {
      // Scope to /contact only. Without this, a misconfigured ALLOWED_ORIGINS
      // would also grant CORS on /admin/* and undermine its same-origin posture.
      if (req.routeOptions?.url !== "/contact") return;
      const origin = req.headers.origin;
      if (origin && config.allowedOrigins.includes(origin)) {
        reply.header("access-control-allow-origin", origin);
        reply.header("access-control-allow-credentials", "false");
        reply.header("vary", "origin");
      }
    });
    app.options("/contact", async (req, reply) => {
      const origin = req.headers.origin;
      if (origin && config.allowedOrigins.includes(origin)) {
        reply.header("access-control-allow-origin", origin);
        reply.header("access-control-allow-methods", "POST, OPTIONS");
        reply.header("access-control-allow-headers", "content-type");
        reply.header("access-control-max-age", "600");
      }
      return reply.code(204).send();
    });
  }

  await registerHealthRoute(app);
  await registerContactRoute(app, { config, repo, aliasMint, mailer, turnstile });

  if (config.adminEnabled) {
    // Seed admin_state from the env hash on first boot. After that the DB row
    // is the source of truth — env becomes irrelevant unless the DB is wiped.
    const existing = repo.getAdminState();
    if (!existing) {
      if (!config.adminPasswordHash) {
        throw new Error(
          "ADMIN_ENABLED=true with no admin_state in DB requires ADMIN_PASSWORD_HASH for first-boot seed",
        );
      }
      repo.seedAdminState(config.adminPasswordHash);
      app.log.info("seeded admin_state from ADMIN_PASSWORD_HASH");
    }

    const breakerThreshold = Math.floor(
      config.env.PROTON_DAILY_CAP * config.env.CIRCUIT_BREAKER_PCT,
    );
    await registerAdmin(app, {
      config,
      repo,
      mailer,
      breakerThreshold,
      ...(opts.overrides?.adminStaticRoot !== undefined
        ? { staticRoot: opts.overrides.adminStaticRoot }
        : {}),
    });
  }

  const shutdown = async (): Promise<void> => {
    try { await app.close(); } catch (err) { app.log.warn({ err }, "fastify close failed"); }
    try { await mailer.close(); } catch (err) { app.log.warn({ err }, "mailer close failed"); }
    if (!opts.overrides?.sl) {
      try { await sl.close(); } catch (err) { app.log.warn({ err }, "sl close failed"); }
    }
    try { db.close(); } catch (err) { app.log.warn({ err }, "db close failed"); }
  };

  return { app, config, shutdown };
}

async function start(): Promise<void> {
  const built = await buildApp();
  const { app, config, shutdown } = built;

  const handle = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutdown signal received");
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void handle("SIGINT"));
  process.on("SIGTERM", () => void handle("SIGTERM"));

  try {
    await app.listen({ host: config.env.HOST, port: config.env.PORT });
  } catch (err) {
    app.log.error({ err }, "listen failed");
    await shutdown();
    process.exit(1);
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMainModule) {
  start().catch((err) => {
    console.error("startup failed", err);
    process.exit(1);
  });
}
