import { describe, it, expect, afterEach } from "vitest";
import { buildTestApp, type TestContext } from "../fixtures/buildTestApp.js";

describe("admin visitors API", () => {
  let ctx: TestContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await ctx.built.shutdown();
      ctx = null;
    }
  });

  async function setup(): Promise<{ cookie: string }> {
    ctx = await buildTestApp({}, { admin: { password: "pw" } });
    const login = await ctx.built.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "content-type": "application/json" },
      payload: { password: "pw" },
    });
    const c = login.cookies.find((x) => x.name === "postern_admin")!;
    return { cookie: `postern_admin=${c.value}` };
  }

  async function postContact(email: string, message = "hi"): Promise<void> {
    const r = await ctx!.built.app.inject({
      method: "POST",
      url: "/contact",
      payload: { firstName: "First", lastName: "Last", email, message },
    });
    expect(r.statusCode).toBe(202);
  }

  it("requires auth on every endpoint", async () => {
    const { cookie: _ } = await setup();
    void _;
    for (const path of [
      "/admin/api/dashboard",
      "/admin/api/visitors",
      "/admin/api/visitors/1",
      "/admin/api/submissions",
      "/admin/api/audit",
    ]) {
      const r = await ctx!.built.app.inject({ method: "GET", url: path });
      expect(r.statusCode, `unauthed ${path}`).toBe(401);
    }
  });

  it("lists visitors after a /contact submission seeds the DB", async () => {
    const { cookie } = await setup();
    await postContact("alice@example.com");
    await postContact("bob@example.com");

    const res = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/visitors",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ email: string; status: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    expect(body.rows.every((r) => r.status === "active")).toBe(true);
  });

  it("filters by status", async () => {
    const { cookie } = await setup();
    await postContact("alice@example.com");
    await postContact("bob@example.com");

    const list = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/visitors",
      headers: { cookie },
    });
    const aliceId = (list.json() as { rows: Array<{ id: number; email: string }> }).rows.find(
      (r) => r.email === "alice@example.com",
    )!.id;

    await ctx!.built.app.inject({
      method: "POST",
      url: `/admin/api/visitors/${aliceId}/block`,
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });

    const blocked = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/visitors?status=blocked",
      headers: { cookie },
    });
    const blockedBody = blocked.json() as { rows: Array<{ email: string }>; total: number };
    expect(blockedBody.total).toBe(1);
    expect(blockedBody.rows[0].email).toBe("alice@example.com");
  });

  it("search by exact email finds the matching visitor (HMAC lookup path)", async () => {
    const { cookie } = await setup();
    await postContact("alice.smith@example.com");
    await postContact("bob.jones@example.com");

    const res = await ctx!.built.app.inject({
      method: "GET",
      url: `/admin/api/visitors?q=${encodeURIComponent("alice.smith@example.com")}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ email: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].email).toBe("alice.smith@example.com");
  });

  it("search by alias substring returns the matching visitor (LIKE path)", async () => {
    const { cookie } = await setup();
    await postContact("a@example.com");
    // The minted alias_local is `first.last.NNNNN`; "first" is the substring we search for.
    const res = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/visitors?q=first.last",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: Array<{ email: string; aliasLocal: string }> };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows[0].aliasLocal).toMatch(/^first\.last\./);
  });

  it("visitor detail returns the visitor + their submissions", async () => {
    const { cookie } = await setup();
    await postContact("alice@example.com", "first message");
    await postContact("alice@example.com", "second message");

    const list = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/visitors",
      headers: { cookie },
    });
    const id = (list.json() as { rows: Array<{ id: number }> }).rows[0].id;

    const detail = await ctx!.built.app.inject({
      method: "GET",
      url: `/admin/api/visitors/${id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      visitor: { email: string };
      submissions: Array<{ message: string }>;
      submissionsTotal: number;
    };
    expect(body.visitor.email).toBe("alice@example.com");
    expect(body.submissionsTotal).toBe(2);
    expect(body.submissions.map((s) => s.message).sort()).toEqual(["first message", "second message"]);
  });

  it("block then unblock writes audit rows and toggles status", async () => {
    const { cookie } = await setup();
    await postContact("alice@example.com");
    const list = await ctx!.built.app.inject({ method: "GET", url: "/admin/api/visitors", headers: { cookie } });
    const id = (list.json() as { rows: Array<{ id: number }> }).rows[0].id;

    const block = await ctx!.built.app.inject({
      method: "POST",
      url: `/admin/api/visitors/${id}/block`,
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(block.statusCode).toBe(200);
    expect(block.json()).toEqual({ status: "blocked" });

    const unblock = await ctx!.built.app.inject({
      method: "POST",
      url: `/admin/api/visitors/${id}/unblock`,
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(unblock.statusCode).toBe(200);
    expect(unblock.json()).toEqual({ status: "active" });

    const audit = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/audit",
      headers: { cookie },
    });
    const events = (audit.json() as { rows: Array<{ event: string }> }).rows.map((r) => r.event);
    expect(events).toContain("admin_block");
    expect(events).toContain("admin_unblock");
  });

  it("block on a missing id returns 404", async () => {
    const { cookie } = await setup();
    const res = await ctx!.built.app.inject({
      method: "POST",
      url: "/admin/api/visitors/99999/block",
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("dashboard returns composite stats", async () => {
    const { cookie } = await setup();
    await postContact("alice@example.com");
    await postContact("bob@example.com");
    const list = await ctx!.built.app.inject({ method: "GET", url: "/admin/api/visitors", headers: { cookie } });
    const aliceId = (list.json() as { rows: Array<{ id: number; email: string }> }).rows.find(
      (r) => r.email === "alice@example.com",
    )!.id;
    await ctx!.built.app.inject({
      method: "POST",
      url: `/admin/api/visitors/${aliceId}/block`,
      headers: { cookie, "content-type": "application/json" },
      payload: {},
    });

    const res = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/dashboard",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sendsToday: number;
      cap: number;
      visitorsActive: number;
      visitorsBlocked: number;
      breakerTripped: boolean;
    };
    expect(body.cap).toBe(1000);
    expect(body.visitorsActive).toBe(1);
    expect(body.visitorsBlocked).toBe(1);
    expect(body.breakerTripped).toBe(false);
    expect(body.sendsToday).toBe(2);
  });

  it("submission detail returns the full message and writes admin_message_view audit", async () => {
    const { cookie } = await setup();
    await postContact("alice@example.com", "the full body of the message");
    const subs = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/submissions",
      headers: { cookie },
    });
    const id = (subs.json() as { rows: Array<{ id: number }> }).rows[0].id;

    const detail = await ctx!.built.app.inject({
      method: "GET",
      url: `/admin/api/submissions/${id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { submission: { message: string } }).submission.message).toBe(
      "the full body of the message",
    );

    const audit = await ctx!.built.app.inject({
      method: "GET",
      url: "/admin/api/audit?event=admin_message_view",
      headers: { cookie },
    });
    expect((audit.json() as { rows: unknown[] }).rows.length).toBe(1);
  });
});
