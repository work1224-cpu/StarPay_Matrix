/**
 * services/syncService.js
 *
 * Backs the "Save Sync" feature. A single operator-triggered snapshot of
 * BOTH:
 *   - the Home page's fully computed table (every scheme with its TER/BER,
 *     ARN No. / Date Period, and Year 1-6 commission % / C-B ratios —
 *     exactly what controllers/schemeController.js's slimScheme() would
 *     return), and
 *   - the "All Brokerage Data" (Old Brokerage Data) page's full table
 *     (every historical record with its live-computed BER%/C-B columns —
 *     exactly what controllers/oldBrokerageController.js's getOldBrokerage
 *     would return),
 * stored in the app's one shared SQLite database (services/db.js) instead
 * of as separate JSON files. Reusing that single WAL-mode connection means
 * there is exactly one connection/locking story for the whole app, rather
 * than a second ad-hoc one for sync data.
 *
 * There is deliberately only ever ONE snapshot (id = 1) — every "Save
 * Sync" replaces it. Both child tables are wiped and reinserted together
 * with it inside a single transaction, so a restore can never mix an old
 * Home-page table with a newer Old Brokerage Data table or vice versa.
 */

const { getDb } = require('./db');
const logger = require('../helpers/logger');

const HOME_COLUMNS = [
  'srNo', 'nsdlCode', 'amfiCode', 'schemeName', 'launchDate', 'amc',
  'schemeType', 'schemeCategory', 'regularBER', 'terDiff', 'berDiff',
  'brokeragePeriod', 'brokerageArn', 'year1', 'year2', 'year3', 'year4',
  'yearOnward', 'year6Onward', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6',
];

const OB_COLUMNS = [
  'amc', 'scheme', 'category', 'arn', 'period', 'periodFrom', 'periodTo',
  'ongoing', 'year1', 'year2', 'year3', 'year4', 'year5', 'year6', 'ber',
  'c1', 'c2', 'c3', 'c4', 'c5', 'c6',
];

/**
 * Save a full snapshot. homeSchemes and oldBrokerageRows should already be
 * in the exact shape the two pages' own APIs return (see the module
 * doc-comment) — this function does not recompute or reshape anything, it
 * only persists what it's given.
 */
function saveSnapshot({ homeSchemes, oldBrokerageRows, lastRefreshed, savedBy }) {
  const db = getDb();
  const savedAt = new Date().toISOString();

  const homeInsert = db.prepare(
    `INSERT INTO sync_home_schemes (${HOME_COLUMNS.join(', ')}, snapshotId)
     VALUES (${HOME_COLUMNS.map(() => '?').join(', ')}, 1)`
  );
  const obInsert = db.prepare(
    `INSERT INTO sync_old_brokerage (${OB_COLUMNS.join(', ')}, snapshotId)
     VALUES (${OB_COLUMNS.map(() => '?').join(', ')}, 1)`
  );

  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    db.prepare('DELETE FROM sync_home_schemes WHERE snapshotId = 1').run();
    db.prepare('DELETE FROM sync_old_brokerage WHERE snapshotId = 1').run();
    db.prepare('DELETE FROM sync_snapshots WHERE id = 1').run();

    db.prepare(
      `INSERT INTO sync_snapshots (id, savedAt, savedBy, lastRefreshed, homeSchemeCount, oldBrokerageCount)
       VALUES (1, ?, ?, ?, ?, ?)`
    ).run(savedAt, savedBy || null, lastRefreshed || null, homeSchemes.length, oldBrokerageRows.length);

    for (const s of homeSchemes) {
      homeInsert.run(...HOME_COLUMNS.map(col => valueFor(s[col])));
    }
    for (const r of oldBrokerageRows) {
      obInsert.run(...OB_COLUMNS.map(col => valueFor(col === 'ongoing' ? (r.ongoing ? 1 : 0) : r[col])));
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error('Save Sync snapshot failed', { error: err.message });
    throw err;
  }

  logger.info('Save Sync snapshot saved to SQLite', {
    homeSchemeCount: homeSchemes.length,
    oldBrokerageCount: oldBrokerageRows.length,
    savedAt,
  });
  return { savedAt, homeSchemeCount: homeSchemes.length, oldBrokerageCount: oldBrokerageRows.length };
}

// node:sqlite rejects `undefined` bind parameters — every column must be
// null or a plain SQLite-storable value.
function valueFor(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function getMeta() {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_snapshots WHERE id = 1').get() || null;
}

/** Remove the saved copy so cleared live data cannot be restored from it. */
function clearSnapshot() {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    db.prepare('DELETE FROM sync_home_schemes WHERE snapshotId = 1').run();
    db.prepare('DELETE FROM sync_old_brokerage WHERE snapshotId = 1').run();
    db.prepare('DELETE FROM sync_snapshots WHERE id = 1').run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error('Clear Sync snapshot failed', { error: err.message });
    throw err;
  }
  logger.info('Sync snapshot cleared');
}

/** Returns null if no snapshot has ever been saved. */
function getHomeSnapshot() {
  const meta = getMeta();
  if (!meta) return null;
  const db = getDb();
  const rows = db.prepare(
    `SELECT ${HOME_COLUMNS.join(', ')} FROM sync_home_schemes WHERE snapshotId = 1 ORDER BY srNo ASC`
  ).all();
  return { meta, rows };
}

/** Returns null if no snapshot has ever been saved. */
function getOldBrokerageSnapshot() {
  const meta = getMeta();
  if (!meta) return null;
  const db = getDb();
  const rows = db.prepare(
    `SELECT ${OB_COLUMNS.join(', ')} FROM sync_old_brokerage WHERE snapshotId = 1`
  ).all().map(r => ({ ...r, ongoing: !!r.ongoing }));
  return { meta, rows };
}

function hasSnapshot() {
  return !!getMeta();
}

module.exports = { saveSnapshot, clearSnapshot, getHomeSnapshot, getOldBrokerageSnapshot, hasSnapshot, getMeta };