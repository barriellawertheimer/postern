import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

describe("admin disabled", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  it("/admin/api/login returns 404 when ADMIN_ENABLED is false", async () => {
    ctx = await buildTestApp(); // no admin opts → disabled
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "anything" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("/admin/api/me returns 404 when admin is disabled", async () => {
    ctx = await buildTestApp();
    const res = await ctx.built.app.inject({ method: "GET", url: "/admin/api/me" });
    expect(res.statusCode).toBe(404);
  });

  it("/contact and /healthz still work when admin is disabled", async () => {
    ctx = await buildTestApp();
    const health = await ctx.built.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);

    const contact = await ctx.built.app.inject({
      method: "POST",
      url: "/contact",
      payload: {
        firstName: "John",
        lastName: "Doe",
        email: "john.doe@example.com",
        message: "hi",
      },
    });
    expect(contact.statusCode).toBe(202);
  });
});
