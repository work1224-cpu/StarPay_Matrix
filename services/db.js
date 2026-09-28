/**
 * services/db.js
 *
 * Shared SQLite connection, using Node's built-in `node:sqlite` module
 * (no native compilation, no external dependency — ships with Node itself
 * from v22.5+). Marked experimental by Node, but functionally stable for
 * this app's needs; if that ever becomes a blocker, swapping to
 * `better-sqlite3` needs only this file to change (same synchronous API
 * shape) — every service that uses `db` is unaffected.
 *
 * SCOPE: backs the user-account store (services/userService.js) and the
 * "Save Sync" full-project snapshot (services/syncService.js). The
 * commission/old-brokerage "override" stores intentionally remain
 * JSON-backed — see the comment at the top of commissionOverrideService.js
 * and oldBrokerageOverrideService.js for why. Everything that does use
 * SQLite shares this ONE connection (WAL mode, opened once per process),
 * so there is a single lock/connection story for the whole app rather than
 * one per feature.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const logger = require('../helpers/logger');

const defaultDbPath = path.join(__dirname, '..', 'data', 'app.db');
let dbPath = process.env.DB_PATH || defaultDbPath;
let db = null;

function ensureDir(forPath) {
  const dir = path.dirname(forPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username   TEXT PRIMARY KEY,
      password   TEXT NOT NULL,
      role       TEXT NOT NULL,
      createdAt  TEXT NOT NULL,
      createdBy  TEXT,
      updatedAt  TEXT
    );
  `);

  // --- "Save Sync" full-project backup -----------------------------------
  // A single operator-triggered snapshot of BOTH the Home page's fully
  // computed table (TER/BER/commission/C-B — everything slimScheme() would
  // return) and the "All Brokerage Data" (Old Brokerage Data) page's full
  // table. Stored in this same SQLite database — reusing the one shared,
  // WAL-mode connection every other table already uses — rather than as
  // separate JSON files, so there is exactly one connection/lock story for
  // the whole app instead of two.
  //
  // There is deliberately only ever ONE snapshot (id = 1): every "Save
  // Sync" replaces it, matching the previous JSON behaviour where saving
  // overwrote the one sync file. sync_home_schemes / sync_old_brokerage
  // rows carry snapshotId = 1 and are wiped and reinserted together with
  // it inside a single transaction, so a restore can never see a half-old,
  // half-new mix of the two tables.
  connection.exec(`
    CREATE TABLE IF NOT EXISTS sync_snapshots (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      savedAt           TEXT NOT NULL,
      savedBy           TEXT,
      lastRefreshed     TEXT,
      homeSchemeCount   INTEGER NOT NULL DEFAULT 0,
      oldBrokerageCount INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sync_home_schemes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshotId      INTEGER NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE,
      srNo            INTEGER,
      nsdlCode        TEXT,
      amfiCode        TEXT,
      schemeName      TEXT,
      launchDate      TEXT,
      amc             TEXT,
      schemeType      TEXT,
      schemeCategory  TEXT,
      regularBER      REAL,
      terDiff         REAL,
      berDiff         REAL,
      brokeragePeriod TEXT,
      brokerageArn    TEXT,
      year1           REAL,
      year2           REAL,
      year3           REAL,
      year4           REAL,
      yearOnward      REAL,
      year6Onward     REAL,
      c1              REAL,
      c2              REAL,
      c3              REAL,
      c4              REAL,
      c5              REAL,
      c6              REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_home_snapshot ON sync_home_schemes(snapshotId);

    CREATE TABLE IF NOT EXISTS sync_old_brokerage (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshotId   INTEGER NOT NULL REFERENCES sync_snapshots(id) ON DELETE CASCADE,
      amc          TEXT,
      scheme       TEXT,
      category     TEXT,
      arn          TEXT,
      period       TEXT,
      periodFrom   TEXT,
      periodTo     TEXT,
      ongoing      INTEGER,
      year1        REAL,
      year2        REAL,
      year3        REAL,
      year4        REAL,
      year5        REAL,
      year6        REAL,
      ber          REAL,
      c1           REAL,
      c2           REAL,
      c3           REAL,
      c4           REAL,
      c5           REAL,
      c6           REAL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_ob_snapshot ON sync_old_brokerage(snapshotId);
  `);
}

function open() {
  ensureDir(dbPath);
  const connection = new DatabaseSync(dbPath);
  connection.exec('PRAGMA journal_mode = WAL;');   // safe concurrent reads while a write is in flight
  connection.exec('PRAGMA foreign_keys = ON;');
  buildSchema(connection);
  return connection;
}

function getDb() {
  if (!db) db = open();
  return db;
}

/** Test-only: point at a fresh database file (mirrors the pattern used by
 *  userService's resetUsersStore / AMC_DOCUMENTS_ROOT env override). */
function resetForTests(customPath) {
  if (db) {
    try { db.close(); } catch (e) { /* already closed */ }
  }
  dbPath = customPath || process.env.DB_PATH || defaultDbPath;
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    for (const suffix of ['-wal', '-shm']) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  db = open();
  return db;
}

module.exports = { getDb, resetForTests };