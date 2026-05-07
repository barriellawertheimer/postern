import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

describe("admin CSRF defense", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  async function authedCookie(): Promise<string> {
    const login = await ctx!.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    expect(login.statusCode).toBe(204);
    const c = login.cookies.find((x) => x.name === "postern_admin")!;
    return `postern_admin=${c.value}`;
  }

  it("rejects POST with non-JSON content-type with 415", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const cookie = await authedCookie();
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, "content-type": "text/plain" },
      payload: "anything",
    });
    expect(res.statusCode).toBe(415);
  });

  it("rejects POST with cross-origin Origin header with 403", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const cookie = await authedCookie();
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "csrf_origin_mismatch" });
  });

  it("allows POST with same-origin Origin header (matching host)", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const cookie = await authedCookie();
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://localhost:80",
        host: "localhost:80",
      },
    });
    expect(res.statusCode).toBe(204);
  });

  it("GET requests are unaffected by the mutating guard", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const cookie = await authedCookie();
    const res = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/api/me",
      headers: {
        cookie,
        origin: "https://attacker.example",
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
