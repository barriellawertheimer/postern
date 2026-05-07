import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

describe("POST /contact", () => {
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
    message: "hi from the contact form",
  } as const;

  it("mints an alias and sends an SMTP notification on first submission", async () => {
    ctx = await buildTestApp();
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/contact",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "sent", reused: false });

    expect(ctx.sl.optionsCalls).toBe(1);
    expect(ctx.sl.createAliasCalls).toBe(1);
    expect(ctx.sl.createContactCalls).toBe(1);

    expect(ctx.mailer.sent).toHaveLength(1);
    const sent = ctx.mailer.sent[0]!;
    expect(sent.visitorPrettyAlias).toMatch(/^john\.doe\.\d+@ownerdomain\.com$/);
    expect(sent.reverseAliasAddress).toMatch(/^re-[0-9a-f]+@ownerdomain\.com$/);
    expect(sent.message).toBe(VALID_BODY.message);
  });

  it("reuses the alias on the second submission from the same email", async () => {
    ctx = await buildTestApp();
    const r1 = await ctx.built.app.inject({ method: "POST", url: "/contact", payload: VALID_BODY });
    expect(r1.statusCode).toBe(202);

    const r2 = await ctx.built.app.inject({ method: "POST", url: "/contact", payload: VALID_BODY });
    expect(r2.statusCode).toBe(202);
    expect(r2.json()).toMatchObject({ status: "sent", reused: true });

    expect(ctx.sl.createAliasCalls).toBe(1); // not minted again
    expect(ctx.mailer.sent).toHaveLength(2);
  });

  it("retries after signed_suffix expires", async () => {
    ctx = await buildTestApp();
    ctx.sl.expireOnce = true;
    const res = await ctx.built.app.inject({ method: "POST", url: "/contact", payload: VALID_BODY });
    expect(res.statusCode).toBe(202);
    // Two options() calls: initial + post-expiry refetch.
    expect(ctx.sl.optionsCalls).toBe(2);
    expect(ctx.sl.createAliasCalls).toBe(2);
  });

  it("trips circuit breaker when daily count >= 95% of cap", async () => {
    ctx = await buildTestApp({ PROTON_DAILY_CAP: 10 });
    const built = ctx.built;

    // Pre-load the daily counter to the threshold (95% of 10 = 9, floor).
    const repo = (built as unknown as { app: import("fastify").FastifyInstance }).app;
    // Use raw SQL to bump the counter — simulating yesterday's traffic.
    const today = new Date().toISOString().slice(0, 10);
    // Reach inside via an injected request to bump the counter naturally.
    // 9 successful sends would do it, but we already test that path; just hit
    // the row directly through the test app's underlying DB.
    // Easier: do 9 real sends, then verify the 10th defers.
    for (let i = 0; i < 9; i++) {
      const r = await built.app.inject({
        method: "POST",
        url: "/contact",
        payload: { ...VALID_BODY, email: `user${i}@example.com` },
      });
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ status: "sent" });
    }

    const tripped = await built.app.inject({
      method: "POST",
      url: "/contact",
      payload: { ...VALID_BODY, email: `tenth@example.com` },
    });
    expect(tripped.statusCode).toBe(202);
    expect(tripped.json()).toMatchObject({ status: "queued", deferred: true });
    // SMTP did NOT fire on this one.
    expect(ctx.mailer.sent).toHaveLength(9);
    // SL alias was still minted — visitor identity is preserved.
    expect(ctx.sl.createAliasCalls).toBe(10);
    void today;
    void repo;
  });

  it("rejects invalid input with 400", async () => {
    ctx = await buildTestApp();
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/contact",
      payload: { firstName: "", lastName: "", email: "not-an-email", message: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("concurrent submissions for the same email mint exactly one alias", async () => {
    ctx = await buildTestApp();
    const N = 20;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        ctx!.built.app.inject({ method: "POST", url: "/contact", payload: VALID_BODY }),
      ),
    );
    for (const r of responses) expect(r.statusCode).toBe(202);
    expect(ctx.sl.createAliasCalls).toBe(1);
    expect(ctx.sl.deleteAliasCalls).toBe(0);
    expect(ctx.mailer.sent).toHaveLength(N);
  });

  it("releases the SL alias when contact creation fails", async () => {
    ctx = await buildTestApp();
    ctx.sl.failContact = true;
    const res = await ctx.built.app.inject({ method: "POST", url: "/contact", payload: VALID_BODY });
    expect(res.statusCode).toBe(502);
    expect(ctx.sl.createAliasCalls).toBe(1);
    expect(ctx.sl.deleteAliasCalls).toBe(1);
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});
