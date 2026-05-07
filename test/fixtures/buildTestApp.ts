// Helper that builds a `BuiltApp` against in-memory SQLite + fake SL/SMTP.
// Tests import this rather than wiring up `buildApp` themselves each time.

import { buildApp, type BuiltApp } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import { FakeSimpleLogin } from "./fakeSimpleLogin.js";
import { FakeMailer } from "./fakeMailer.js";
import { TurnstileVerifier } from "../../src/services/turnstile.js";
import { makeTestKeys } from "./testKeys.js";

export interface TestContext {
  built: BuiltApp;
  sl: FakeSimpleLogin;
  mailer: FakeMailer;
}

export async function buildTestApp(overrides: Partial<Config["env"]> = {}): Promise<TestContext> {
  const sl = new FakeSimpleLogin();
  const mailer = new FakeMailer();

  const config: Config = {
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 0,
      LOG_LEVEL: "fatal",
      DATABASE_PATH: ":memory:",
      SL_BASE_URL: "https://example.invalid",
      SL_API_KEY: "test-key",
      OWNER_DOMAIN: "ownerdomain.com",
      SMTP_HOST: "smtp.invalid",
      SMTP_PORT: 587,
      SMTP_USER: "owner@protonmail.example",
      SMTP_PASS: "smtp-token",
      OWNER_EMAIL: undefined,
      TURNSTILE_SECRET: undefined,
      TURNSTILE_VERIFY_URL: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      PROTON_DAILY_CAP: 1000,
      PROTON_HOURLY_CAP: 300,
      CIRCUIT_BREAKER_PCT: 0.95,
      RATE_LIMIT_PER_IP_PER_MIN: 1000,
      RATE_LIMIT_PER_IP_PER_HOUR: 1000,
      ALIAS_SUFFIX_KIND: "digits",
      ALIAS_SUFFIX_LENGTH: 5,
      ALIAS_SEPARATOR: ".",
      ALLOWED_ORIGINS: "",
      ...overrides,
    } as Config["env"],
    isProd: false,
    isTest: true,
    keys: makeTestKeys(),
    ownerEmail: "owner@protonmail.example",
    allowedOrigins: [],
  };

  const turnstile = new TurnstileVerifier({
    secret: config.env.TURNSTILE_SECRET,
    verifyUrl: config.env.TURNSTILE_VERIFY_URL,
    isProduction: false,
  });

  const built = await buildApp({
    config,
    overrides: {
      mailer,
      sl: sl as unknown as import("../../src/services/simplelogin.js").SimpleLoginClient,
      turnstile,
      dbPath: ":memory:",
    },
  });

  return { built, sl, mailer };
}
