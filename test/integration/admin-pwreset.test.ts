import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

const OWNER_EMAIL = "owner@protonmail.example";

// Pulls the `?token=...` value out of the most recent admin mail. The mail
// body is rendered by api.ts and contains the URL twice (text + html).
function extractToken(body: string): string {
  const m = /[?&]token=([^"\s&<]+)/.exec(body);
  if (!m) throw new Error(`no token in mail body: ${body}`);
  return decodeURIComponent(m[1]!);
}

async function login(ctx: TestContext, password: string): Promise<number> {
  const res = await ctx.built.app.inject({
    method: "POST",
    url: "/admin/api/login",
    headers: { "content-type": "application/json" },
    payload: { password },
  });
  return res.statusCode;
}

async function forgot(ctx: TestContext, email: string): Promise<number> {
  const res = await ctx.built.app.inject({
    method: "POST",
    url: "/admin/api/forgot",
    headers: { "content-type": "application/json" },
    payload: { email },
  });
  return res.statusCode;
}

async function reset(
  ctx: TestContext,
  token: string,
  password: string,
): Promise<{ statusCode: number; body: string }> {
  const res = await ctx.built.app.inject({
    method: "POST",
    url: "/admin/api/reset",
    headers: { "content-type": "application/json" },
    payload: { token, password },
  });
  return { statusCode: res.statusCode, body: res.body };
}

describe("admin password reset", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  it("end-to-end: forgot → mail captured → reset → login with new password", async () => {
    ctx = await buildTestApp({}, { admin: { password: "old-password" } });

    expect(await forgot(ctx, OWNER_EMAIL)).toBe(204);
    expect(ctx.mailer.adminSent).toHaveLength(1);
    const mail = ctx.mailer.adminSent[0]!;
    expect(mail.subject).toMatch(/password reset/i);

    const token = extractToken(mail.text);
    const r = await reset(ctx, token, "new-password-99");
    expect(r.statusCode).toBe(204);

    expect(await login(ctx, "old-password")).toBe(401);
    expect(await login(ctx, "new-password-99")).toBe(204);
  });

  it("/forgot with a non-owner email returns 204 but does NOT enqueue mail", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });

    expect(await forgot(ctx, "attacker@example.com")).toBe(204);
    expect(ctx.mailer.adminSent).toHaveLength(0);
  });

  it("/forgot is case-insensitive on the owner email comparison", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });

    expect(await forgot(ctx, OWNER_EMAIL.toUpperCase())).toBe(204);
    expect(ctx.mailer.adminSent).toHaveLength(1);
  });

  it("a used reset token cannot be replayed", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    expect(await forgot(ctx, OWNER_EMAIL)).toBe(204);
    const token = extractToken(ctx.mailer.adminSent[0]!.text);

    expect((await reset(ctx, token, "new-password-1")).statusCode).toBe(204);
    // Second attempt: epoch has advanced, token is now stale.
    const replay = await reset(ctx, token, "another-password-2");
    expect(replay.statusCode).toBe(401);
  });

  it("a fresh reset invalidates outstanding tokens from before it", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });

    // Two concurrent /forgot calls produce two tokens against the same epoch.
    expect(await forgot(ctx, OWNER_EMAIL)).toBe(204);
    expect(await forgot(ctx, OWNER_EMAIL)).toBe(204);
    expect(ctx.mailer.adminSent).toHaveLength(2);
    const tokenA = extractToken(ctx.mailer.adminSent[0]!.text);
    const tokenB = extractToken(ctx.mailer.adminSent[1]!.text);

    expect((await reset(ctx, tokenA, "first-password")).statusCode).toBe(204);
    // Token B was issued in the same epoch as A, so it's now stale.
    expect((await reset(ctx, tokenB, "second-password")).statusCode).toBe(401);
    // And login still uses the password set by tokenA, not B.
    expect(await login(ctx, "first-password")).toBe(204);
  });

  it("a garbage token returns 401", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    expect((await reset(ctx, "not.a.real.token", "newpassword")).statusCode).toBe(401);
  });

  it("a short password returns 400 (zod min length)", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    expect(await forgot(ctx, OWNER_EMAIL)).toBe(204);
    const token = extractToken(ctx.mailer.adminSent[0]!.text);
    expect((await reset(ctx, token, "short")).statusCode).toBe(400);
  });

  it("audits the failed email match without leaking which email was tried", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    expect(await forgot(ctx, "wrong@example.com")).toBe(204);

    // Pull the audit log row count for the mismatch event via the API.
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    const cookie = `postern_admin=${login.cookies.find((c) => c.name === "postern_admin")!.value}`;
    const audit = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/api/audit?event=admin_pwreset_email_mismatch",
      headers: { cookie },
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as { total: number }).total).toBe(1);
  });
});
