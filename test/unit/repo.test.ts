import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/migrate.js";
import { Repo } from "../../src/db/repo.js";
import { makeTestKeys } from "../fixtures/testKeys.js";
import type { CryptoKeys } from "../../src/lib/crypto.js";

describe("Repo", () => {
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

  it("inserts and retrieves a visitor with PII round-tripping", () => {
    const inserted = repo.upsertVisitor({
      email: "Alice@Example.com",
      firstName: "Alice",
      lastName: "Example",
      aliasLocal: "alice.example.12345",
      aliasFull: "alice.example.12345@ownerdomain.com",
      slAliasId: 42,
      slReverseAlias: "re-abc123@ownerdomain.com",
    });
    expect(inserted.id).toBeGreaterThan(0);

    const fetched = repo.getVisitorByEmail("alice@example.com");
    expect(fetched).not.toBeNull();
    expect(fetched!.email).toBe("Alice@Example.com");
    expect(fetched!.firstName).toBe("Alice");
    expect(fetched!.lastName).toBe("Example");
    expect(fetched!.slAliasId).toBe(42);
  });

  it("UNIQUE(email_lookup) yields the existing row on conflict (idempotent)", () => {
    const a = repo.upsertVisitor({
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "B",
      aliasLocal: "bob.b.111",
      aliasFull: "bob.b.111@ownerdomain.com",
      slAliasId: 1,
      slReverseAlias: "re-1@x",
    });
    const b = repo.upsertVisitor({
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "B",
      aliasLocal: "bob.b.222", // would-be new local on duplicate insert
      aliasFull: "bob.b.222@ownerdomain.com",
      slAliasId: 2,
      slReverseAlias: "re-2@x",
    });
    expect(b.id).toBe(a.id);
    expect(b.slAliasId).toBe(1); // first writer wins; second is rejected by UNIQUE
  });

  it("records and decrypts submissions", () => {
    const v = repo.upsertVisitor({
      email: "c@example.com", firstName: "C", lastName: "X",
      aliasLocal: "c.x.1", aliasFull: "c.x.1@d.com",
      slAliasId: 7, slReverseAlias: "re-7@d.com",
    });
    repo.recordSubmission({ visitorId: v.id, message: "hello there" });
    const row = (db.prepare("SELECT message_ct FROM submissions WHERE visitor_id = ?").get(v.id) as { message_ct: Buffer });
    expect(repo.decryptSubmission(row.message_ct)).toBe("hello there");
  });

  it("daily counter increments and reads back", () => {
    expect(repo.dailyCount()).toBe(0);
    expect(repo.recordSend()).toBe(1);
    expect(repo.recordSend()).toBe(2);
    expect(repo.dailyCount()).toBe(2);
  });
});
