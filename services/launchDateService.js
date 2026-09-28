/**
 * services/launchDateService.js
 *
 * Launch-date lookup sourced from the "Schemes and Launch Date" workbook
 * (a simple two-column export: Scheme Name incl. "Reg/Dir - Growth" suffix,
 * Launch Date). Scheme names are normalized the same way the rest of the
 * app matches scheme names across sources (AMFI vs upload vs reference
 * sheet spellings never match exactly otherwise).
 *
 * This is the AUTOMATED source only. Schemes this file doesn't cover (or
 * where the date needs correcting) are handled by launchDateOverrideService
 * — an admin edit there always wins over this lookup, and survives future
 * AMFI refreshes since this file is only re-read at server boot.
 */
const path = require('path');
const XLSX = require('xlsx');
const { normalizeSchemeName } = require('../helpers/normalizer');
const logger = require('../helpers/logger');

const WORKBOOK_PATH = process.env.LAUNCH_DATE_WORKBOOK_PATH ||
  path.join(__dirname, '..', 'data', 'reference', 'Schemes_and_Launch_Date_17-Jul-2026.xlsx');

let launchDates = null;

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }

  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (match) {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const month = months.indexOf(match[2].toLowerCase()) + 1;
      const rawYear = Number(match[3]);
      const year = rawYear < 100 ? (rawYear >= 50 ? 1900 + rawYear : 2000 + rawYear) : rawYear;
      if (month) return `${year}-${String(month).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Strips "Reg"/"Ret" abbreviations that normalizeSchemeName's full-word
// regular/direct matcher doesn't catch (the reference sheet mostly uses the
// abbreviated form, e.g. "... - Reg - Growth"), on top of the standard
// plan/option/punctuation normalization already applied everywhere else.
function lookupKey(schemeName) {
  return normalizeSchemeName(schemeName).replace(/\b(reg|ret)\b/g, '').replace(/\s+/g, ' ').trim();
}

function parseLaunchDateWorkbook(source) {
  const map = new Map();
  try {
    const workbook = Buffer.isBuffer(source)
      ? XLSX.read(source, { cellDates: true })
      : XLSX.readFile(source, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });

    // Row 0 is the header ("Schemes", "Launch Date") — data starts at row 1.
    for (let i = 1; i < rows.length; i++) {
      const [rawName, rawDate] = rows[i];
      const schemeName = typeof rawName === 'string' ? rawName.trim() : '';
      if (!schemeName) continue;

      const isoDate = toIsoDate(rawDate);
      if (!isoDate) continue;

      const key = lookupKey(schemeName);
      if (key && !map.has(key)) map.set(key, isoDate);
    }
    return map;
  } catch (error) {
    throw new Error(`Could not parse launch-date workbook: ${error.message}`);
  }
}

function loadLaunchDates() {
  try {
    const map = parseLaunchDateWorkbook(WORKBOOK_PATH);
    logger.info('Launch dates loaded from reference workbook', { count: map.size, source: path.basename(WORKBOOK_PATH) });
    return map;
  } catch (error) {
    logger.warn(error.message);
    return new Map();
  }
}

function getLaunchDates() {
  if (!launchDates) launchDates = loadLaunchDates();
  return launchDates;
}

function getLaunchDate(schemeName) {
  return getLaunchDates().get(lookupKey(schemeName)) || '';
}

/** Test-only: force a reload on the next getLaunchDate() call. */
function resetForTests() {
  launchDates = null;
}

module.exports = { getLaunchDate, lookupKey, parseLaunchDateWorkbook, resetForTests };
