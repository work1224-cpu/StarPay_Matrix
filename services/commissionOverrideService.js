/**
 * services/commissionOverrideService.js
 *
 * Holds the scheme-wise Year 1 / 2 / 3 / 4 / 5-Onward / 6-Onward distributor-commission
 * values uploaded via the "TER Data Upload" box on the home page.
 *
 * This sits ON TOP OF the static, hardcoded mapping in terService.js
 * (getForcedYearValues' `mapping` object) — an upload here always wins,
 * so the site can be updated instantly without a code deploy.
 *
 * Persisted to disk so it survives a server restart.
 * Also stores C/B (Commission to BER) ratios for each year.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../helpers/logger');

const DISK_PATH = process.env.COMMISSION_OVERRIDE_CACHE_PATH || path.join(__dirname, '..', 'commission-override-cache.json');

let overrides = new Map();   // normalized scheme name -> { year1, year2, year3, year4, yearOnward, year6Onward, amc, c1-c6 }
let meta = { uploadedAt: null, filename: null, count: 0, brokerageCleared: false };

function norm(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Calculate Commission to BER Ratio
 */
function calcRatio(commission, ber) {
  if (commission === null || commission === undefined || ber === null || ber === undefined || ber === 0) return null;
  return commission / ber;
}

function _saveToDisk() {
  const tmpPath = `${DISK_PATH}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({
      overrides: [...overrides.entries()],
      meta,
    }), 'utf8');
    fs.renameSync(tmpPath, DISK_PATH);
  } catch (e) {
    logger.warn('Commission override disk save failed', { error: e.message });
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(DISK_PATH)) return false;
    const p = JSON.parse(fs.readFileSync(DISK_PATH, 'utf8'));
    if (!Array.isArray(p.overrides)) return false;
    overrides = new Map(p.overrides);
    meta = { ...meta, ...(p.meta || {}) };
    logger.info('Commission override cache loaded from disk', { count: overrides.size });
    return true;
  } catch (e) {
    logger.warn('Commission override disk load failed', { error: e.message });
    return false;
  }
}

/**
 * Replace only the override entries tagged with a given AMC, leaving every
 * other AMC's uploaded commission data untouched. Used by the per-AMC
 * "Commission Structure Upload" widget.
 * Also calculates C/B ratios for each scheme.
 */
function setForAMC(amc, rows, filename) {
  const amcNorm = norm(amc);
  // Drop previous entries for this AMC
  for (const [key, value] of overrides.entries()) {
    if (norm(value.amc) === amcNorm) overrides.delete(key);
  }
  let added = 0;
  for (const r of rows) {
    const key = norm(r.scheme);
    if (!key) continue;
    
    // Calculate C/B ratios - BER will be fetched from cache when applied
    // Store the raw values, C/B will be calculated when applied to schemes
    overrides.set(key, {
      year1: r.year1 ?? null,
      year2: r.year2 ?? null,
      year3: r.year3 ?? null,
      year4: r.year4 ?? null,
      yearOnward: r.yearOnward ?? null,
      year6Onward: r.year6Onward ?? r.yearOnward ?? null,
      amc,
      // C/B ratios will be calculated when applied to schemes
      c1: null,
      c2: null,
      c3: null,
      c4: null,
      c5: null,
      c6: null,
    });
    added++;
  }
  meta = { uploadedAt: new Date().toISOString(), filename: filename || null, count: overrides.size, lastAMC: amc, brokerageCleared: false };
  logger.info('Commission overrides updated (per-AMC)', { amc, added, totalOverrides: overrides.size });
  _saveToDisk();
  return added;
}

/**
 * Set a single scheme override (used by admin edit)
 * Also calculates C/B ratios based on the provided data
 */
function setForScheme(schemeName, data) {
  const key = norm(schemeName);
  if (!key) return false;
  
  // Calculate C/B ratios if BER is provided
  const ber = data.regularBER || null;
  
  const overrideData = {
    year1: data.year1 ?? null,
    year2: data.year2 ?? null,
    year3: data.year3 ?? null,
    year4: data.year4 ?? null,
    yearOnward: data.yearOnward ?? null,
    year6Onward: data.year6Onward ?? data.yearOnward ?? null,
    amc: data.amc || null,
    // Calculate C/B ratios
    c1: calcRatio(data.year1, ber),
    c2: calcRatio(data.year2, ber),
    c3: calcRatio(data.year3, ber),
    c4: calcRatio(data.year4, ber),
    c5: calcRatio(data.yearOnward, ber),
    c6: calcRatio(data.year6Onward, ber),
  };
  
  overrides.set(key, overrideData);
  meta.count = overrides.size;
  meta.brokerageCleared = false;
  _saveToDisk();
  logger.info('Single scheme override updated with C/B ratios', { schemeName: key });
  return true;
}

/**
 * Get override data for a scheme, including C/B ratios
 */
function get(schemeName) {
  if (!schemeName) return null;
  const name = norm(schemeName);
  if (overrides.has(name)) return overrides.get(name);
  for (const [key, value] of overrides.entries()) {
    if (name.includes(key) || key.includes(name)) return value;
  }
  return null;
}

/**
 * Get override data with C/B ratios calculated based on provided BER
 */
function getWithBER(schemeName, ber) {
  const data = get(schemeName);
  if (!data) return null;
  
  // If C/B ratios are already stored, return them
  if (data.c1 !== null && data.c1 !== undefined) return data;
  
  // Otherwise calculate them
  return {
    ...data,
    c1: calcRatio(data.year1, ber),
    c2: calcRatio(data.year2, ber),
    c3: calcRatio(data.year3, ber),
    c4: calcRatio(data.year4, ber),
    c5: calcRatio(data.yearOnward, ber),
    c6: calcRatio(data.year6Onward, ber),
  };
}

function getMeta() {
  return { ...meta };
}

function hasAny() {
  return overrides.size > 0;
}

function clearAll() {
  overrides.clear();
  meta = { uploadedAt: null, filename: null, count: 0, brokerageCleared: true };
  _saveToDisk();
  logger.info('Commission override cache cleared');
  return true;
}

function isBrokerageCleared() {
  return meta.brokerageCleared === true;
}

function getAll() {
  return overrides;
}

module.exports = {
  setForAMC,
  setForScheme,
  get,
  getWithBER,
  getMeta,
  hasAny,
  clearAll,
  isBrokerageCleared,
  loadFromDisk,
  getAll,
};