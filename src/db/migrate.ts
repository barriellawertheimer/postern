// Applies schema.sql at boot when the on-disk PRAGMA user_version is below
// the latest. Migrations are additive and idempotent — every CREATE uses
// IF NOT EXISTS, so re-applying schema.sql is safe even on a populated db.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const SCHEMA_VERSION = 1;

export interface OpenedDb {
  db: Database.Database;
  applied: boolean;
}

export function openDatabase(path: string): OpenedDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Reasonable defaults for a single-process server. Synchronous=NORMAL is
  // safe with WAL and meaningfully faster than FULL.
  db.pragma("synchronous = NORMAL");

  const current = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  let applied = false;
  if (current < SCHEMA_VERSION) {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(resolve(here, "schema.sql"), "utf8");
    db.exec(sql);
    applied = true;
  }
  return { db, applied };
}
