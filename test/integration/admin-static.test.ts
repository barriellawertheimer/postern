import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

describe("admin static (SPA serving + fallback)", () => {
  let staticRoot: string;
  let ctx: TestContext | null = null;

  beforeAll(() => {
    staticRoot = mkdtempSync(resolve(tmpdir(), "postern-admin-ui-"));
    writeFileSync(resolve(staticRoot, "index.html"), "<!doctype html><title>postern admin</title>");
    mkdirSync(resolve(staticRoot, "assets"));
    writeFileSync(resolve(staticRoot, "assets", "app.js"), "// bundle stub");
  });

  afterAll(() => {
    rmSync(staticRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  it("serves index.html at /admin/", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw", staticRoot } });
    const res = await ctx.built.app.inject({ method: "GET", url: "/admin/", headers: { accept: "text/html" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("postern admin");
  });

  it("serves explicit asset paths from the bundle", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw", staticRoot } });
    const res = await ctx.built.app.inject({ method: "GET", url: "/admin/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("bundle stub");
  });

  it("falls back to index.html for SPA deep links (HTML accept)", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw", staticRoot } });
    const res = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/visitors/42",
      headers: { accept: "text/html" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("postern admin");
  });

  it("returns JSON 404 for non-HTML unmatched paths under /admin/", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw", staticRoot } });
    const res = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/missing.json",
      headers: { accept: "application/json" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
  });

  it("API 404s are JSON, not the SPA shell", async () => {
    ctx = await buildTestApp({}, { admin: { password: "pw", staticRoot } });
    // Auth this so we don't get the 401 short-circuit on a missing route.
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    const cookie = `postern_admin=${login.cookies.find((c) => c.name === "postern_admin")!.value}`;
    const res = await ctx.built.app.inject({
      method: "GET",
      url: "/admin/api/does-not-exist",
      headers: { cookie, accept: "text/html" }, // even with HTML accept, API stays JSON
    });
    expect(res.statusCode).toBe(404);
    // Must NOT be the SPA shell.
    expect(res.body).not.toContain("postern admin");
  });

  it("when staticRoot is missing, /admin/ deep links 404 but the API still works", async () => {
    const missingRoot = resolve(staticRoot, "does-not-exist");
    ctx = await buildTestApp({}, { admin: { password: "pw", staticRoot: missingRoot } });

    const ui = await ctx.built.app.inject({ method: "GET", url: "/admin/", headers: { accept: "text/html" } });
    expect(ui.statusCode).toBe(404);

    // API still works.
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    expect(login.statusCode).toBe(204);
  });
});
