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

export type VisitorStatus = "active" | "blocked";

export interface SubmissionRow {
  id: number;
  visitorId: number;
  message: string;
  ipHashHex: string | null;
  uaHashHex: string | null;
  createdAt: number;
}

export interface SubmissionListItem {
  id: number;
  visitorId: number;
  aliasFull: string;
  messagePreview: string;
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  event: string;
  visitorId: number | null;
  detail: string | null;
  createdAt: number;
}

export interface FailureSummary {
  event: string;
  count: number;
  lastAt: number;
}

export interface DashboardStats {
  sendsToday: number;
  visitorsActive: number;
  visitorsBlocked: number;
  failures24h: FailureSummary[];
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

  // Admin read/write paths.
  private readonly listVisitorsStmt: Database.Statement;
  private readonly countVisitorsStmt: Database.Statement;
  private readonly searchVisitorsStmt: Database.Statement;
  private readonly findVisitorByIdStmt: Database.Statement<[number]>;
  private readonly setVisitorStatusStmt: Database.Statement;
  private readonly listSubmissionsByVisitorStmt: Database.Statement;
  private readonly countSubmissionsByVisitorStmt: Database.Statement<[number]>;
  private readonly findSubmissionByIdStmt: Database.Statement<[number]>;
  private readonly listSubmissionsStmt: Database.Statement;
  private readonly listAuditStmt: Database.Statement;
  private readonly countAuditStmt: Database.Statement;
  private readonly recentFailuresStmt: Database.Statement<[number]>;

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

    this.listVisitorsStmt = db.prepare(
      `SELECT id, email_ct, name_ct, alias_local, alias_full, sl_alias_id,
              sl_reverse_alias, status, created_at, last_seen_at
         FROM visitors
        WHERE (@status IS NULL OR status = @status)
        ORDER BY last_seen_at DESC, id DESC
        LIMIT @limit OFFSET @offset`,
    );
    this.countVisitorsStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM visitors
        WHERE (@status IS NULL OR status = @status)`,
    );
    // LIKE escape char is '\' — caller pre-escapes the user input.
    this.searchVisitorsStmt = db.prepare(
      `SELECT id, email_ct, name_ct, alias_local, alias_full, sl_alias_id,
              sl_reverse_alias, status, created_at, last_seen_at
         FROM visitors
        WHERE alias_local LIKE @q ESCAPE '\\'
           OR alias_full  LIKE @q ESCAPE '\\'
        ORDER BY last_seen_at DESC, id DESC
        LIMIT @limit`,
    );
    this.findVisitorByIdStmt = db.prepare(
      `SELECT id, email_ct, name_ct, alias_local, alias_full, sl_alias_id,
              sl_reverse_alias, status, created_at, last_seen_at
         FROM visitors WHERE id = ?`,
    );
    this.setVisitorStatusStmt = db.prepare(
      `UPDATE visitors SET status = @status WHERE id = @id`,
    );
    this.listSubmissionsByVisitorStmt = db.prepare(
      `SELECT id, message_ct, ip_hash, ua_hash, created_at
         FROM submissions
        WHERE visitor_id = @visitor_id
        ORDER BY created_at DESC, id DESC
        LIMIT @limit OFFSET @offset`,
    );
    this.countSubmissionsByVisitorStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM submissions WHERE visitor_id = ?`,
    );
    this.findSubmissionByIdStmt = db.prepare(
      `SELECT id, visitor_id, message_ct, ip_hash, ua_hash, created_at
         FROM submissions WHERE id = ?`,
    );
    this.listSubmissionsStmt = db.prepare(
      `SELECT s.id, s.visitor_id, s.message_ct, s.created_at, v.alias_full
         FROM submissions s
         JOIN visitors  v ON v.id = s.visitor_id
        WHERE s.created_at >= @since
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT @limit OFFSET @offset`,
    );
    this.listAuditStmt = db.prepare(
      `SELECT id, event, visitor_id, detail, created_at
         FROM audit_log
        WHERE (@event IS NULL OR event = @event)
          AND created_at >= @since
        ORDER BY created_at DESC, id DESC
        LIMIT @limit OFFSET @offset`,
    );
    this.countAuditStmt = db.prepare(
      `SELECT COUNT(*) AS c FROM audit_log
        WHERE (@event IS NULL OR event = @event)
          AND created_at >= @since`,
    );
    this.recentFailuresStmt = db.prepare(
      `SELECT event, COUNT(*) AS count, MAX(created_at) AS lastAt
         FROM audit_log
        WHERE created_at >= ?
          AND event IN ('mint_failed', 'smtp_send_failed', 'circuit_breaker_skip')
        GROUP BY event
        ORDER BY lastAt DESC`,
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

  listVisitors(opts: { status?: VisitorStatus | null; limit: number; offset: number }): VisitorRow[] {
    const rows = this.listVisitorsStmt.all({
      status: opts.status ?? null,
      limit: opts.limit,
      offset: opts.offset,
    }) as VisitorRowDb[];
    return rows.map((r) => rowToVisitor(r, this.keys));
  }

  countVisitors(status: VisitorStatus | null = null): number {
    const row = this.countVisitorsStmt.get({ status }) as { c: number };
    return row.c;
  }

  searchVisitors(query: string, limit: number): VisitorRow[] {
    const escaped = escapeLike(query);
    const rows = this.searchVisitorsStmt.all({
      q: `%${escaped}%`,
      limit,
    }) as VisitorRowDb[];
    return rows.map((r) => rowToVisitor(r, this.keys));
  }

  getVisitorById(id: number): VisitorRow | null {
    const row = this.findVisitorByIdStmt.get(id) as VisitorRowDb | undefined;
    return row ? rowToVisitor(row, this.keys) : null;
  }

  setVisitorStatus(id: number, status: VisitorStatus): boolean {
    const result = this.setVisitorStatusStmt.run({ id, status });
    return result.changes > 0;
  }

  listSubmissionsByVisitor(visitorId: number, limit: number, offset: number): SubmissionRow[] {
    const rows = this.listSubmissionsByVisitorStmt.all({
      visitor_id: visitorId,
      limit,
      offset,
    }) as Array<{
      id: number;
      message_ct: Buffer;
      ip_hash: Buffer | null;
      ua_hash: Buffer | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      visitorId,
      message: decryptColumn(r.message_ct, this.keys),
      ipHashHex: r.ip_hash ? r.ip_hash.toString("hex") : null,
      uaHashHex: r.ua_hash ? r.ua_hash.toString("hex") : null,
      createdAt: r.created_at,
    }));
  }

  countSubmissionsByVisitor(visitorId: number): number {
    const row = this.countSubmissionsByVisitorStmt.get(visitorId) as { c: number };
    return row.c;
  }

  getSubmissionById(id: number): SubmissionRow | null {
    const row = this.findSubmissionByIdStmt.get(id) as
      | {
          id: number;
          visitor_id: number;
          message_ct: Buffer;
          ip_hash: Buffer | null;
          ua_hash: Buffer | null;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      visitorId: row.visitor_id,
      message: decryptColumn(row.message_ct, this.keys),
      ipHashHex: row.ip_hash ? row.ip_hash.toString("hex") : null,
      uaHashHex: row.ua_hash ? row.ua_hash.toString("hex") : null,
      createdAt: row.created_at,
    };
  }

  listSubmissions(opts: { limit: number; offset: number; sinceMs?: number }): SubmissionListItem[] {
    const rows = this.listSubmissionsStmt.all({
      limit: opts.limit,
      offset: opts.offset,
      since: opts.sinceMs ?? 0,
    }) as Array<{
      id: number;
      visitor_id: number;
      message_ct: Buffer;
      created_at: number;
      alias_full: string;
    }>;
    return rows.map((r) => {
      const message = decryptColumn(r.message_ct, this.keys);
      return {
        id: r.id,
        visitorId: r.visitor_id,
        aliasFull: r.alias_full,
        messagePreview: message.length > 200 ? `${message.slice(0, 200)}…` : message,
        createdAt: r.created_at,
      };
    });
  }

  listAudit(opts: {
    event?: string | null;
    limit: number;
    offset: number;
    sinceMs?: number;
  }): AuditEntry[] {
    const rows = this.listAuditStmt.all({
      event: opts.event ?? null,
      since: opts.sinceMs ?? 0,
      limit: opts.limit,
      offset: opts.offset,
    }) as Array<{
      id: number;
      event: string;
      visitor_id: number | null;
      detail: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      visitorId: r.visitor_id,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  countAudit(opts: { event?: string | null; sinceMs?: number } = {}): number {
    const row = this.countAuditStmt.get({
      event: opts.event ?? null,
      since: opts.sinceMs ?? 0,
    }) as { c: number };
    return row.c;
  }

  recentFailures(sinceMs: number): FailureSummary[] {
    return this.recentFailuresStmt.all(sinceMs) as FailureSummary[];
  }

  dashboardStats(now: Date = new Date()): DashboardStats {
    return {
      sendsToday: this.dailyCount(now),
      visitorsActive: this.countVisitors("active"),
      visitorsBlocked: this.countVisitors("blocked"),
      failures24h: this.recentFailures(now.getTime() - 24 * 60 * 60 * 1000),
    };
  }
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function utcDay(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
