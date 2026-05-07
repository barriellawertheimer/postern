-- Postern schema. Apply via db/migrate.ts when user_version mismatches.
-- All PII columns are AES-256-GCM ciphertext blobs; email_lookup is a
-- deterministic HMAC-SHA256 used by the UNIQUE index.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS visitors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email_lookup      BLOB NOT NULL,
  email_ct          BLOB NOT NULL,
  name_ct           BLOB NOT NULL,
  alias_local       TEXT NOT NULL,
  alias_full        TEXT NOT NULL,
  sl_alias_id       INTEGER NOT NULL,
  sl_reverse_alias  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_email_lookup
  ON visitors(email_lookup);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id  INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  message_ct  BLOB NOT NULL,
  ip_hash     BLOB,
  ua_hash     BLOB,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_visitor
  ON submissions(visitor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sends_today (
  -- 'YYYY-MM-DD' in UTC. Single row per day.
  day    TEXT PRIMARY KEY,
  count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL,
  visitor_id  INTEGER,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event_time
  ON audit_log(event, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_time
  ON audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_visitors_status_lastseen
  ON visitors(status, last_seen_at DESC);

PRAGMA user_version = 2;
