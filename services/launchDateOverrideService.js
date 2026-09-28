/**
 * services/launchDateOverrideService.js
 *
 * Admin-edited launch dates — set via the editable "Launch Date" column on
 * the home page table. Always wins over launchDateService's automated
 * lookup from the reference workbook, and survives future AMFI refreshes
 * (refreshes re-derive every OTHER field from AMFI/the workbook, but check
 * this override first for launchDate — same pattern commissionOverrideService
 * uses for Year 1-4/Onward commission values).
 *
 * Persisted to disk so it survives a server restart.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../helpers/logger');
const { lookupKey } = require('./launchDateService');

const DISK_PATH = process.env.LAUNCH_DATE_OVERRIDE_CACHE_PATH ||
  path.join(__dirname, '..', 'launch-date-override-cache.json');

let overrides = new Map(); // normalized scheme name -> { launchDate, schemeName, updatedAt }

function _saveToDisk() {
  fs.promises.writeFile(DISK_PATH, JSON.stringify({
    overrides: [...overrides.entries()],
  }), 'utf8').catch((e) => {
    logger.warn('Launch date override disk save failed', { error: e.message });
  });
}

function loadFromDisk() {
  try {
    if (fs.existsSync(DISK_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DISK_PATH, 'utf8'));
      overrides = new Map(parsed.overrides || []);
      logger.info('Launch date override cache loaded from disk', { count: overrides.size });
    }
  } catch (e) {
    logger.warn('Launch date override disk load failed', { error: e.message });
  }
}
loadFromDisk();

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Set (or clear, with an empty string) a manual launch-date override. */
function set(schemeName, launchDate) {
  const key = lookupKey(schemeName);
  if (!key) return { success: false, message: 'Scheme name is required.' };

  const trimmed = String(launchDate || '').trim();
  if (trimmed && !ISO_DATE_PATTERN.test(trimmed)) {
    return { success: false, message: 'Launch date must be in YYYY-MM-DD format.' };
  }

  if (!trimmed) {
    overrides.delete(key);
  } else {
    overrides.set(key, { launchDate: trimmed, schemeName, updatedAt: new Date().toISOString() });
  }
  _saveToDisk();
  return { success: true, launchDate: trimmed };
}

/** Set many imported dates and persist them with one disk write. */
function setMany(entries) {
  let count = 0;
  for (const entry of entries) {
    const key = lookupKey(entry.schemeName);
    if (!key || !ISO_DATE_PATTERN.test(String(entry.launchDate || ''))) continue;
    overrides.set(key, {
      launchDate: String(entry.launchDate),
      schemeName: entry.schemeName,
      updatedAt: new Date().toISOString(),
    });
    count++;
  }
  if (count) _saveToDisk();
  return count;
}

/** Returns the override date string, or null if there is no override. */
function get(schemeName) {
  const entry = overrides.get(lookupKey(schemeName));
  return entry ? entry.launchDate : null;
}

/** Test-only: reset to an empty in-memory + on-disk store. */
function resetForTests() {
  overrides = new Map();
}

module.exports = { set, setMany, get, resetForTests };
