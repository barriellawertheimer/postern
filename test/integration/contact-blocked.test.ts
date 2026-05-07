import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

describe("blocked-visitor guard on /contact", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  const VALID_BODY = {
    firstName: "John",
    lastName: "Doe",
    email: "john.doe@example.com",
    message: "hi",
  } as const;

  it("a blocked visitor's submission silently 202s, writes audit, and never touches SL/SMTP", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const app = ctx.built.app;

    // Seed: first submission mints + sends.
    const seed = await app.inject({ method: "POST", url: "/contact", payload: VALID_BODY });
    expect(seed.statusCode).toBe(202);
    const slMintsBefore = ctx.sl.createAliasCalls;
    const sendsBefore = ctx.mailer.sent.length;

    // Block the visitor via the admin API.
    const login = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    const cookie = `postern_admin=${login.cookies.find((c) => c.name === "postern_admin")!.value}`;
    const list = await app.inject({ method: "GET", url: "/admin/api/visitors", headers: { cookie } });
    const id = (list.json() as { rows: Array<{ id: number }> }).rows[0].id;
    const block = await app.inject({
      method: "POST",
      url: `/admin/api/visitors/${id}/block`,
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(block.statusCode).toBe(200);

    // Re-submit from the blocked email.
    const blocked = await app.inject({ method: "POST", url: "/contact", payload: VALID_BODY });
    expect(blocked.statusCode).toBe(202);
    expect(blocked.json()).toEqual({ status: "queued" });

    // SL was NOT called again, SMTP did NOT fire.
    expect(ctx.sl.createAliasCalls).toBe(slMintsBefore);
    expect(ctx.mailer.sent.length).toBe(sendsBefore);

    // Audit row was written.
    const audit = await app.inject({
      method: "GET",
      url: "/admin/api/audit?event=blocked_submission_rejected",
      headers: { cookie },
    });
    const rows = (audit.json() as { rows: Array<{ visitorId: number }> }).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].visitorId).toBe(id);
  });
});
