/**
 * services/oldBrokerageOverrideService.js
 *
 * Holds admin edits AND admin bulk-uploads made on the "Old Brokerage Data"
 * page. The base data always comes live from the Excel file
 * (oldBrokerageService.js reads it fresh whenever it changes on disk) — an
 * entry here sits ON TOP of that and always wins, the same pattern used by
 * commissionOverrideService.js for the main TER table.
 *
 * Keyed by (AMC + Scheme Name + Data Period). This is the important design
 * point: the SAME scheme legitimately appears many times with a DIFFERENT
 * "Data Period (Validity)" (a new quarter's trail structure, an old
 * archived one, etc.) — so the period is part of the identity, not just a
 * displayed column. Two entries for "XYZ Flexicap Fund" with different
 * periods are two different records, not the same one being overwritten.
 *
 * Two ways an entry lands here:
 *  - A single inline edit from the table (oldBrokerageOverrideService.set)
 *    — only touches an EXISTING (amc, scheme, period) row's Year 1-6.
 *  - A bulk Excel upload (oldBrokerageOverrideService.bulkUpsert) — each
 *    row in the file is upserted by its own (amc, scheme, period) key. If
 *    that exact key already exists (edited before, or uploaded before) it's
 *    replaced; if it's a period never seen in the base Excel, it becomes a
 *    brand-new row that oldBrokerageService.getAll() appends to the table.
 *
 * Persisted to disk so edits/uploads survive a server restart.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../helpers/logger');

const DISK_PATH = process.env.OLD_BROKERAGE_OVERRIDE_CACHE_PATH || path.join(__dirname, '..', 'old-brokerage-override-cache.json');

let overrides = new Map(); // key -> { amc, scheme, period, category, year1..year6, updatedAt, source }
let deletedKeys = new Set(); // tombstones for rows the admin explicitly deleted (incl. base-Excel rows)
let meta = { updatedAt: null, count: 0 };

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function keyFor(amc, scheme, period) {
  return `${norm(amc)}|${norm(scheme)}|${norm(period)}`;
}

function _saveToDisk() {
  const tmpPath = `${DISK_PATH}.tmp`;
  const data = JSON.stringify({
    overrides: [...overrides.entries()],
    deletedKeys: [...deletedKeys],
    meta,
  });
  try {
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, DISK_PATH);
  } catch (e) {
    logger.warn('Old Brokerage Data override disk save failed', { error: e.message });
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(DISK_PATH)) return false;
    const raw = fs.readFileSync(DISK_PATH, 'utf8');
    const p = JSON.parse(raw);
    if (!Array.isArray(p.overrides)) return false;
    overrides = new Map(p.overrides);
    deletedKeys = new Set(p.deletedKeys || []);
    meta = p.meta || meta;
    logger.info('Old Brokerage Data override cache loaded from disk', { count: overrides.size, deleted: deletedKeys.size });
    return true;
  } catch (e) {
    logger.warn('Old Brokerage Data override disk load failed', { error: e.message });
    try {
      if (fs.existsSync(DISK_PATH)) {
        const backupPath = `${DISK_PATH}.corrupted.${Date.now()}`;
        fs.renameSync(DISK_PATH, backupPath);
        logger.warn(`Moved corrupted override cache to ${backupPath}`);
      }
    } catch (renameErr) {
      // ignore
    }
    overrides = new Map();
    deletedKeys = new Set();
    return false;
  }
}

function _touchMeta() {
  meta = { updatedAt: new Date().toISOString(), count: overrides.size };
}

/**
 * Save/replace the Year 1-6 values for one EXISTING (amc, scheme, period)
 * row — used by the inline "Edit" button on the table. Category is kept
 * as-is (undefined = don't touch) since the inline editor only exposes
 * Year 1-6 fields.
 */
function set(amc, scheme, period, values) {
  const key = keyFor(amc, scheme, period);
  if (!key.trim()) return null;

  const existing = overrides.get(key) || {};
  const record = {
    amc, scheme, period,
    category: values.category !== undefined ? values.category : (existing.category ?? null),
    arn: values.arn !== undefined ? values.arn : (existing.arn ?? null),
    year1: values.year1 ?? null,
    year2: values.year2 ?? null,
    year3: values.year3 ?? null,
    year4: values.year4 ?? null,
    year5: values.year5 ?? null,
    year6: values.year6 ?? null,
    updatedAt: new Date().toISOString(),
    source: existing.source || 'edit',
  };
  overrides.set(key, record);
  deletedKeys.delete(key);
  _touchMeta();
  _saveToDisk();
  logger.info('Old Brokerage Data override saved', { amc, scheme, period });
  return record;
}

/**
 * Bulk-upsert many rows at once — used by the "Commission Structure
 * Upload" file import. Each row is keyed by its OWN (amc, scheme, period),
 * so uploading a new quarter's file for schemes that already exist under
 * older periods simply ADDS new rows rather than overwriting the old ones.
 * Re-uploading the exact same (amc, scheme, period) combo again just
 * refreshes that one entry's values.
 *
 * rows: [{ amc, scheme, period, category, year1..year6 }, ...]
 * Returns { added, updated }.
 */
function bulkUpsert(rows, sourceLabel) {
  let added = 0, updated = 0;
  for (const r of rows) {
    const key = keyFor(r.amc, r.scheme, r.period);
    if (!key.trim()) continue;
    if (overrides.has(key)) updated++; else added++;
    deletedKeys.delete(key);
    overrides.set(key, {
      amc: r.amc,
      scheme: r.scheme,
      period: r.period,
      category: r.category ?? null,
      arn: r.arn ?? null,
      year1: r.year1 ?? null,
      year2: r.year2 ?? null,
      year3: r.year3 ?? null,
      year4: r.year4 ?? null,
      year5: r.year5 ?? null,
      year6: r.year6 ?? null,
      updatedAt: new Date().toISOString(),
      source: sourceLabel || 'upload',
    });
  }
  _touchMeta();
  _saveToDisk();
  logger.info('Old Brokerage Data bulk upload applied', { added, updated, total: rows.length });
  return { added, updated };
}

function get(amc, scheme, period) {
  return overrides.get(keyFor(amc, scheme, period)) || null;
}

/**
 * Permanently removes ONE (amc, scheme, period) row from the Old Brokerage
 * Data table — whether it originally came from the base Excel file or was
 * added/edited here. Recorded as a tombstone key so a base-Excel row never
 * resurfaces on the next load (the Excel file itself is never touched);
 * any existing override/upload entry for that same key is discarded
 * outright too, so it can't resurrect the row.
 * A subsequent inline edit, manual "Add New Scheme", or bulk upload for
 * the exact same key is treated as an intentional restore and clears the
 * tombstone again (see set() / bulkUpsert() above).
 */
function removeRow(amc, scheme, period) {
  const key = keyFor(amc, scheme, period);
  if (!key.trim()) return false;
  overrides.delete(key);
  deletedKeys.add(key);
  _touchMeta();
  _saveToDisk();
  logger.info('Old Brokerage Data row deleted', { amc, scheme, period });
  return true;
}

/** Remove every visible row while keeping the read-only Excel file intact. */
function clearAll(rows = []) {
  const keys = new Set(rows.map(row => keyFor(row.amc, row.scheme, row.period)).filter(Boolean));
  const removed = overrides.size;
  for (const key of keys) deletedKeys.add(key);
  overrides.clear();
  _touchMeta();
  _saveToDisk();
  logger.info('Old Brokerage Data cleared', { removed, deleted: keys.size });
  return { removed, deleted: keys.size };
}

function isDeleted(amc, scheme, period) {
  return deletedKeys.has(keyFor(amc, scheme, period));
}

/**
 * All stored entries, each tagged with its lookup key — used by
 * oldBrokerageService to (a) apply matching overrides on top of base
 * Excel rows and (b) append entries whose key has NO matching base row
 * (i.e. genuinely new AMC+scheme+period combinations from an upload).
 */
function getAll() {
  return [...overrides.entries()].map(([key, val]) => ({ key, ...val }));
}

function getMeta() {
  return { ...meta };
}

loadFromDisk();

module.exports = { set, bulkUpsert, get, getAll, getMeta, loadFromDisk, keyFor, removeRow, clearAll, isDeleted };