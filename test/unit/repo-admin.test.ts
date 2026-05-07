import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/migrate.js";
import { Repo, type NewVisitor } from "../../src/db/repo.js";
import { makeTestKeys } from "../fixtures/testKeys.js";
import type { CryptoKeys } from "../../src/lib/crypto.js";

describe("Repo (admin paths)", () => {
  let db: Database.Database;
  let repo: Repo;
  let keys: CryptoKeys;

  beforeEach(() => {
    keys = makeTestKeys();
    const opened = openDatabase(":memory:");
    db = opened.db;
    repo = new Repo(db, keys);
  });

  afterEach(() => {
    db.close();
  });

  function seed(input: Partial<NewVisitor> & { email: string }): number {
    const v = repo.upsertVisitor({
      firstName: input.firstName ?? "First",
      lastName: input.lastName ?? "Last",
      aliasLocal: input.aliasLocal ?? `local.${input.email.split("@")[0]}`,
      aliasFull: input.aliasFull ?? `${input.aliasLocal ?? "local"}@ownerdomain.com`,
      slAliasId: input.slAliasId ?? Math.floor(Math.random() * 1_000_000),
      slReverseAlias: input.slReverseAlias ?? "re-x@ownerdomain.com",
      email: input.email,
    });
    return v.id;
  }

  function setLastSeen(id: number, ts: number): void {
    db.prepare(`UPDATE visitors SET last_seen_at = ? WHERE id = ?`).run(ts, id);
  }

  function insertAuditAt(event: string, createdAt: number, visitorId: number | null = null, detail: string | null = null): void {
    db.prepare(
      `INSERT INTO audit_log (event, visitor_id, detail, created_at) VALUES (?, ?, ?, ?)`,
    ).run(event, visitorId, detail, createdAt);
  }

  describe("listVisitors / countVisitors", () => {
    it("orders by last_seen_at DESC and respects limit/offset", () => {
      const a = seed({ email: "a@example.com" });
      const b = seed({ email: "b@example.com" });
      const c = seed({ email: "c@example.com" });
      setLastSeen(a, 100);
      setLastSeen(b, 300);
      setLastSeen(c, 200);

      const page1 = repo.listVisitors({ limit: 2, offset: 0 });
      expect(page1.map((v) => v.id)).toEqual([b, c]);

      const page2 = repo.listVisitors({ limit: 2, offset: 2 });
      expect(page2.map((v) => v.id)).toEqual([a]);
    });

    it("filters by status when provided", () => {
      const a = seed({ email: "a@example.com" });
      const b = seed({ email: "b@example.com" });
      repo.setVisitorStatus(b, "blocked");

      expect(repo.listVisitors({ status: "active", limit: 10, offset: 0 }).map((v) => v.id)).toEqual([a]);
      expect(repo.listVisitors({ status: "blocked", limit: 10, offset: 0 }).map((v) => v.id)).toEqual([b]);
      expect(repo.listVisitors({ limit: 10, offset: 0 }).map((v) => v.id).sort()).toEqual([a, b].sort());
    });

    it("countVisitors returns total or filtered count", () => {
      seed({ email: "a@example.com" });
      const b = seed({ email: "b@example.com" });
      const c = seed({ email: "c@example.com" });
      repo.setVisitorStatus(b, "blocked");
      repo.setVisitorStatus(c, "blocked");

      expect(repo.countVisitors()).toBe(3);
      expect(repo.countVisitors("active")).toBe(1);
      expect(repo.countVisitors("blocked")).toBe(2);
    });

    it("decrypts PII in returned rows", () => {
      seed({ email: "Alice@Example.com", firstName: "Alice", lastName: "Example", aliasLocal: "alice.x" });
      const [row] = repo.listVisitors({ limit: 10, offset: 0 });
      expect(row.email).toBe("Alice@Example.com");
      expect(row.firstName).toBe("Alice");
      expect(row.lastName).toBe("Example");
    });
  });

  describe("searchVisitors", () => {
    it("matches substring on alias_local and alias_full", () => {
      const a = seed({ email: "a@example.com", aliasLocal: "alice.smith.123", aliasFull: "alice.smith.123@ownerdomain.com" });
      const b = seed({ email: "b@example.com", aliasLocal: "bob.jones.999", aliasFull: "bob.jones.999@ownerdomain.com" });

      expect(repo.searchVisitors("alice", 10).map((v) => v.id)).toEqual([a]);
      expect(repo.searchVisitors("jones", 10).map((v) => v.id)).toEqual([b]);
      expect(repo.searchVisitors("ownerdomain", 10).map((v) => v.id).sort()).toEqual([a, b].sort());
    });

    it("treats LIKE metacharacters in the query as literals (escape)", () => {
      seed({ email: "x@example.com", aliasLocal: "abcdef" });
      // Without escaping, "ab_d" would match "abcdef" via the `_` single-char wildcard.
      // With escaping, `_` is literal — so no match.
      expect(repo.searchVisitors("ab_d", 10)).toHaveLength(0);
      // Literal "abc" still matches.
      expect(repo.searchVisitors("abc", 10)).toHaveLength(1);
      // Literal "%" in the query must not turn into a wildcard.
      expect(repo.searchVisitors("ab%ef", 10)).toHaveLength(0);
    });

    it("respects the limit", () => {
      seed({ email: "x@example.com", aliasLocal: "shared.one" });
      seed({ email: "y@example.com", aliasLocal: "shared.two" });
      seed({ email: "z@example.com", aliasLocal: "shared.three" });
      expect(repo.searchVisitors("shared", 2)).toHaveLength(2);
    });
  });

  describe("getVisitorById / setVisitorStatus", () => {
    it("getVisitorById returns null for missing id", () => {
      expect(repo.getVisitorById(99999)).toBeNull();
    });

    it("setVisitorStatus returns false for missing id, true for existing", () => {
      expect(repo.setVisitorStatus(99999, "blocked")).toBe(false);
      const id = seed({ email: "a@example.com" });
      expect(repo.setVisitorStatus(id, "blocked")).toBe(true);
      expect(repo.getVisitorById(id)?.status).toBe("blocked");
      expect(repo.setVisitorStatus(id, "active")).toBe(true);
      expect(repo.getVisitorById(id)?.status).toBe("active");
    });
  });

  describe("submissions read paths", () => {
    it("listSubmissionsByVisitor decrypts message + hex-encodes hashes, ordered DESC", () => {
      const id = seed({ email: "a@example.com" });
      repo.recordSubmission({ visitorId: id, message: "first", ipHash: Buffer.from("aa", "hex") });
      repo.recordSubmission({ visitorId: id, message: "second", uaHash: Buffer.from("bb", "hex") });
      repo.recordSubmission({ visitorId: id, message: "third" });

      const rows = repo.listSubmissionsByVisitor(id, 10, 0);
      expect(rows.map((r) => r.message)).toEqual(["third", "second", "first"]);
      expect(rows[2].ipHashHex).toBe("aa");
      expect(rows[2].uaHashHex).toBeNull();
      expect(rows[1].uaHashHex).toBe("bb");
    });

    it("countSubmissionsByVisitor", () => {
      const id = seed({ email: "a@example.com" });
      expect(repo.countSubmissionsByVisitor(id)).toBe(0);
      repo.recordSubmission({ visitorId: id, message: "m" });
      repo.recordSubmission({ visitorId: id, message: "m" });
      expect(repo.countSubmissionsByVisitor(id)).toBe(2);
    });

    it("getSubmissionById returns full message or null", () => {
      const id = seed({ email: "a@example.com" });
      repo.recordSubmission({ visitorId: id, message: "the full message body" });
      const [first] = repo.listSubmissionsByVisitor(id, 1, 0);
      const fetched = repo.getSubmissionById(first.id);
      expect(fetched?.message).toBe("the full message body");
      expect(fetched?.visitorId).toBe(id);
      expect(repo.getSubmissionById(99999)).toBeNull();
    });

    it("listSubmissions truncates preview at 200 chars and joins alias_full", () => {
      const id = seed({ email: "a@example.com", aliasFull: "abc.123@ownerdomain.com" });
      repo.recordSubmission({ visitorId: id, message: "short" });
      repo.recordSubmission({ visitorId: id, message: "x".repeat(500) });

      const rows = repo.listSubmissions({ limit: 10, offset: 0 });
      expect(rows).toHaveLength(2);
      expect(rows[0].messagePreview.length).toBe(201); // 200 chars + ellipsis
      expect(rows[0].messagePreview.endsWith("…")).toBe(true);
      expect(rows[1].messagePreview).toBe("short");
      expect(rows[0].aliasFull).toBe("abc.123@ownerdomain.com");
    });
  });

  describe("audit log read paths", () => {
    it("listAudit filters by event and since, orders DESC", () => {
      insertAuditAt("minted_and_sent", 1000);
      insertAuditAt("smtp_send_failed", 2000);
      insertAuditAt("minted_and_sent", 3000);

      const all = repo.listAudit({ limit: 10, offset: 0 });
      expect(all.map((r) => r.createdAt)).toEqual([3000, 2000, 1000]);

      const onlyFails = repo.listAudit({ event: "smtp_send_failed", limit: 10, offset: 0 });
      expect(onlyFails.map((r) => r.createdAt)).toEqual([2000]);

      const recent = repo.listAudit({ sinceMs: 2500, limit: 10, offset: 0 });
      expect(recent.map((r) => r.createdAt)).toEqual([3000]);
    });

    it("countAudit honors event + since", () => {
      insertAuditAt("a", 1000);
      insertAuditAt("a", 2000);
      insertAuditAt("b", 3000);
      expect(repo.countAudit()).toBe(3);
      expect(repo.countAudit({ event: "a" })).toBe(2);
      expect(repo.countAudit({ sinceMs: 1500 })).toBe(2);
      expect(repo.countAudit({ event: "a", sinceMs: 1500 })).toBe(1);
    });
  });

  describe("recentFailures + dashboardStats", () => {
    it("recentFailures groups failure events only, respects since, sorts by lastAt DESC", () => {
      insertAuditAt("mint_failed", 100);
      insertAuditAt("mint_failed", 200);
      insertAuditAt("smtp_send_failed", 300);
      insertAuditAt("circuit_breaker_skip", 400);
      insertAuditAt("minted_and_sent", 500); // not a failure event
      insertAuditAt("blocked_submission_rejected", 600); // not in the failure set

      const rows = repo.recentFailures(0);
      expect(rows.map((r) => r.event)).toEqual(["circuit_breaker_skip", "smtp_send_failed", "mint_failed"]);
      const mint = rows.find((r) => r.event === "mint_failed");
      expect(mint?.count).toBe(2);
      expect(mint?.lastAt).toBe(200);

      const cutoff = repo.recentFailures(250);
      expect(cutoff.map((r) => r.event).sort()).toEqual(["circuit_breaker_skip", "smtp_send_failed"]);
    });

    it("dashboardStats returns composite snapshot", () => {
      const a = seed({ email: "a@example.com" });
      const b = seed({ email: "b@example.com" });
      seed({ email: "c@example.com" });
      repo.setVisitorStatus(a, "blocked");

      repo.recordSend();
      repo.recordSend();

      const now = new Date();
      insertAuditAt("smtp_send_failed", now.getTime() - 1000, b);
      insertAuditAt("mint_failed", now.getTime() - 25 * 60 * 60 * 1000); // outside 24h window

      const stats = repo.dashboardStats(now);
      expect(stats.sendsToday).toBe(2);
      expect(stats.visitorsActive).toBe(2);
      expect(stats.visitorsBlocked).toBe(1);
      expect(stats.failures24h.map((r) => r.event)).toEqual(["smtp_send_failed"]);
    });
  });
});
