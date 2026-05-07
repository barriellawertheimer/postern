// Encrypted repository over `better-sqlite3`. The repo owns crypto: callers
// pass plaintext, the repo encrypts on write and decrypts on read.
//
// All write paths use prepared statements bound at construction.

import type Database from "better-sqlite3";
import { encryptColumn, decryptColumn, hmacLookup, type CryptoKeys } from "../lib/crypto.js";

export interface VisitorRow {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  aliasLocal: string;
  aliasFull: string;
  slAliasId: number;
  slReverseAlias: string;
  status: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface NewVisitor {
  email: string;
  firstName: string;
  lastName: string;
  aliasLocal: string;
  aliasFull: string;
  slAliasId: number;
  slReverseAlias: string;
}

export interface SubmissionInsert {
  visitorId: number;
  message: string;
  ipHash?: Buffer | null;
  uaHash?: Buffer | null;
}

interface VisitorRowDb {
  id: number;
  email_ct: Buffer;
  name_ct: Buffer;
  alias_local: string;
  alias_full: string;
  sl_alias_id: number;
  sl_reverse_alias: string;
  status: string;
  created_at: number;
  last_seen_at: number;
}

function serializeName(firstName: string, lastName: string): string {
  // Tab-separated keeps it trivially decodable and tolerates any unicode in
  // the names without escaping. Names are validated upstream not to contain
  // control chars.
  return `${firstName}\t${lastName}`;
}

function deserializeName(s: string): { firstName: string; lastName: string } {
  const idx = s.indexOf("\t");
  if (idx < 0) return { firstName: s, lastName: "" };
  return { firstName: s.slice(0, idx), lastName: s.slice(idx + 1) };
}

function rowToVisitor(row: VisitorRowDb, keys: CryptoKeys): VisitorRow {
  const email = decryptColumn(row.email_ct, keys);
  const { firstName, lastName } = deserializeName(decryptColumn(row.name_ct, keys));
  return {
    id: row.id,
    email,
    firstName,
    lastName,
    aliasLocal: row.alias_local,
    aliasFull: row.alias_full,
    slAliasId: row.sl_alias_id,
    slReverseAlias: row.sl_reverse_alias,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class Repo {
  private readonly findByLookup: Database.Statement<[Buffer]>;
  private readonly insertVisitor: Database.Statement;
  private readonly touchVisitor: Database.Statement;
  private readonly insertSubmission: Database.Statement;
  private readonly bumpSendsToday: Database.Statement;
  private readonly readSendsToday: Database.Statement<[string]>;
  private readonly insertAudit: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    private readonly keys: CryptoKeys,
  ) {
    this.findByLookup = db.prepare(
      `SELECT id, email_ct, name_ct, alias_local, alias_full, sl_alias_id,
              sl_reverse_alias, status, created_at, last_seen_at
         FROM visitors WHERE email_lookup = ?`,
    );
    this.insertVisitor = db.prepare(
      `INSERT INTO visitors
         (email_lookup, email_ct, name_ct, alias_local, alias_full,
          sl_alias_id, sl_reverse_alias, status, created_at, last_seen_at)
       VALUES (@email_lookup, @email_ct, @name_ct, @alias_local, @alias_full,
               @sl_alias_id, @sl_reverse_alias, 'active', @now, @now)
       ON CONFLICT(email_lookup) DO NOTHING`,
    );
    this.touchVisitor = db.prepare(
      `UPDATE visitors SET last_seen_at = @now WHERE id = @id`,
    );
    this.insertSubmission = db.prepare(
      `INSERT INTO submissions (visitor_id, message_ct, ip_hash, ua_hash, created_at)
       VALUES (@visitor_id, @message_ct, @ip_hash, @ua_hash, @now)`,
    );
    this.bumpSendsToday = db.prepare(
      `INSERT INTO sends_today (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1`,
    );
    this.readSendsToday = db.prepare(
      `SELECT count FROM sends_today WHERE day = ?`,
    );
    this.insertAudit = db.prepare(
      `INSERT INTO audit_log (event, visitor_id, detail, created_at)
       VALUES (@event, @visitor_id, @detail, @now)`,
    );
  }

  getVisitorByEmail(email: string): VisitorRow | null {
    const lookup = hmacLookup(email, this.keys);
    const row = this.findByLookup.get(lookup) as VisitorRowDb | undefined;
    return row ? rowToVisitor(row, this.keys) : null;
  }

  /**
   * Insert a new visitor. Returns the inserted row, or — if a concurrent
   * insert lost the UNIQUE race — the existing row.
   */
  upsertVisitor(input: NewVisitor): VisitorRow {
    const now = Date.now();
    const lookup = hmacLookup(input.email, this.keys);
    const emailCt = encryptColumn(input.email, this.keys);
    const nameCt = encryptColumn(
      serializeName(input.firstName, input.lastName),
      this.keys,
    );
    const result = this.insertVisitor.run({
      email_lookup: lookup,
      email_ct: emailCt,
      name_ct: nameCt,
      alias_local: input.aliasLocal,
      alias_full: input.aliasFull,
      sl_alias_id: input.slAliasId,
      sl_reverse_alias: input.slReverseAlias,
      now,
    });
    if (result.changes === 0) {
      // Lost the race; return the existing row. Caller is responsible for
      // releasing the SL alias they just minted (see aliasMint).
      const row = this.findByLookup.get(lookup) as VisitorRowDb | undefined;
      if (!row) throw new Error("UNIQUE conflict but no existing visitor row");
      return rowToVisitor(row, this.keys);
    }
    const row = this.findByLookup.get(lookup) as VisitorRowDb | undefined;
    if (!row) throw new Error("inserted visitor row vanished");
    return rowToVisitor(row, this.keys);
  }

  touchLastSeen(id: number): void {
    this.touchVisitor.run({ id, now: Date.now() });
  }

  recordSubmission(input: SubmissionInsert): void {
    const messageCt = encryptColumn(input.message, this.keys);
    this.insertSubmission.run({
      visitor_id: input.visitorId,
      message_ct: messageCt,
      ip_hash: input.ipHash ?? null,
      ua_hash: input.uaHash ?? null,
      now: Date.now(),
    });
  }

  decryptSubmission(messageCt: Buffer): string {
    return decryptColumn(messageCt, this.keys);
  }

  recordSend(): number {
    const day = utcDay(new Date());
    this.bumpSendsToday.run(day);
    const row = this.readSendsToday.get(day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  dailyCount(now: Date = new Date()): number {
    const row = this.readSendsToday.get(utcDay(now)) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  audit(event: string, opts: { visitorId?: number | null; detail?: string | null } = {}): void {
    this.insertAudit.run({
      event,
      visitor_id: opts.visitorId ?? null,
      detail: opts.detail ?? null,
      now: Date.now(),
    });
  }
}

export function utcDay(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
