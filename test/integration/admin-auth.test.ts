import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";
import { signSession } from "../../src/admin/auth.js";

describe("admin auth", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  function extractSessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
    const c = res.cookies.find((x) => x.name === "postern_admin");
    if (!c) throw new Error("postern_admin cookie missing from response");
    return `postern_admin=${c.value}`;
  }

  it("rejects wrong password with 401 and sets no cookie", async () => {
    ctx = await buildTestApp({}, { admin: { password: "correct-pw" } });
    const res = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === "postern_admin")).toBeUndefined();
  });

  it("accepts correct password, sets a session cookie, /me returns authenticated", async () => {
    ctx = await buildTestApp({}, { admin: { password: "correct-pw" } });
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "correct-pw" },
    });
    expect(login.statusCode).toBe(204);
    const cookie = extractSessionCookie(login);

    const me = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/api/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ authenticated: true });
    expect(typeof (me.json() as { exp: number }).exp).toBe("number");
  });

  it("/me requires a cookie", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const res = await ctx.built.app.inject({ method: "GET", url: "/admin/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a tampered cookie", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    const orig = extractSessionCookie(login);
    // Decode the signature, flip a byte, re-encode. Avoids the trap of
    // swapping a base64url char into the same data-bit equivalence class.
    const value = orig.slice("postern_admin=".length);
    const dot = value.indexOf(".");
    const sigB64u = value.slice(dot + 1);
    const sigBuf = Buffer.from(sigB64u, "base64url");
    sigBuf[0] ^= 0xff;
    const tamperedCookie = `postern_admin=${value.slice(0, dot + 1)}${sigBuf.toString("base64url")}`;

    const res = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/api/me",
      headers: { cookie: tamperedCookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an expired cookie (forged with the correct secret)", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const secret = ctx.built.config.adminSessionSecret!;
    const expiredToken = signSession({ iat: 0, exp: 1, v: 1 }, secret);
    const res = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/api/me",
      headers: { cookie: `postern_admin=${expiredToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logout clears the cookie and subsequent /me with the cleared cookie still 401s", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    const cookie = extractSessionCookie(login);

    const logout = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/logout",
      headers: { cookie, "content-type": "application/json" },
    });
    expect(logout.statusCode).toBe(204);
    // The Set-Cookie header should clear the cookie (Max-Age=0 or expires in the past).
    const cleared = logout.cookies.find((c) => c.name === "postern_admin");
    expect(cleared).toBeDefined();
    // The cleared cookie's value is empty.
    expect(cleared!.value).toBe("");
  });
});
