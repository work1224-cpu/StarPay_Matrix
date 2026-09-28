/**
 * services/oldBrokerageService.js
 *
 * Serves the historical / date-wise brokerage-structure data straight from
 * data/demo/Mutual_Fund_Brokerage_Consolidated_Verified.xlsx (the "Old
 * Brokerage Data" page), MERGED with anything admins have added on top via
 * the inline "Edit" button or the "Commission Structure Upload" file
 * import (see oldBrokerageOverrideService.js).
 *
 * Unlike services/brokerageService.js (which reads a pre-baked JSON
 * snapshot), this reads the workbook directly every time it changes on
 * disk, so simply replacing/appending rows in that Excel file (old data
 * going back years, or newer quarters going forward) is picked up
 * automatically without touching any code.
 *
 * The workbook stores one "Source Data Period (Validity)" text column per
 * AMC group (merged visually — blank on every row after the first for that
 * AMC). This service forward-fills that column, then parses the free-text
 * period into a proper { from, to } date range so the front-end can filter
 * "from date X to date Y" (and offer quick "last N years" presets).
 *
 * IMPORTANT — same scheme, many periods: a scheme legitimately shows up
 * multiple times with a DIFFERENT Data Period (each quarter's trail
 * structure is its own record). Everything here is keyed by
 * (amc, scheme, period) together, never by scheme name alone, so an edit
 * or upload for one period never clobbers another period's row for the
 * same scheme.
 *
 * Deliberately NOT included here (per product requirement — these are
 * "irregular" fields that belong only to the live TER table on the main
 * page): NSDL Code, Scheme Code / AMFI Code, Scheme Type, TER Difference,
 * BER Difference.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const logger = require('../helpers/logger');
const overrideService = require('./oldBrokerageOverrideService');

function getFilePath() {
  const primaryPath = path.join(__dirname, '..', 'data', 'demo', 'Mutual_Fund_Brokerage_Consolidated_Verified.xlsx');
  if (fs.existsSync(primaryPath)) return primaryPath;

  const demoDir = path.join(__dirname, '..', 'data', 'demo');
  if (fs.existsSync(demoDir)) {
    const files = fs.readdirSync(demoDir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
    if (files.length > 0) {
      const matched = files.find(f => f.toLowerCase().includes('old_brokerage_data_consolidated')) || files[0];
      return path.join(demoDir, matched);
    }
  }
  return primaryPath;
}

const FILE_PATH = getFilePath();

// Old Brokerage Data is maintained only for these distributor ARN codes.
// The consolidated source can contain other distributors' AMC data, which
// must not leak into this portal's table or filter dropdowns.
const ALLOWED_ARNS = new Set(['280532', '50111', '1182', '1183', '1184', '117196', '13025']);

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

let cache = null;      // { rows }
let lastMtime = null;

function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : null;
}

// A source row can be applicable to multiple distributor ARN numbers, stored
// in one Excel cell (for example: "117196, 1182"). Keep those as separate
// filter choices instead of treating every comma-separated combination as a
// new ARN.
function splitArnValues(value) {
  return String(value || '')
    .split(/[,;|\n]+/)
    .map(arn => arn.trim())
    .filter(Boolean);
}

function normalizeArn(value) {
  return String(value || '').trim().replace(/^arn\s*-?\s*/i, '');
}

function hasAllowedArn(value) {
  return splitArnValues(value).some(arn => ALLOWED_ARNS.has(normalizeArn(arn)));
}

// A missing ARN is valid source data. Those records stay visible so the
// UI's "None (ARN not present)" filter can find them; only a populated ARN
// outside the approved list is excluded.
function hasAllowedOrMissingArn(value) {
  return !String(value || '').trim() || hasAllowedArn(value);
}

function lastDayOfMonth(year, monthIdx) {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

/**
 * Pull every date token out of a free-text period string.
 * Supports "1 Apr 2026", "Feb 2026", "01/04/2026", "2026-04-01", and also
 * the month-first style some AMCs use, e.g. "August 01, 2025" —
 * without this, a period written month-first was never recognised as a
 * date at all, so the row was silently dropped as "unknown period" and
 * never reached the ARN / Date Period columns on the home page.
 */
function extractTokens(text) {
  const re = /(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})[\s\-,.]+(\d{4})|([A-Za-z]{3,9})[\s]+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})|([A-Za-z]{3,9})[\s\-,.]+(\d{4})/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let day = null, monKey = null, year = null;
    if (m[2] !== undefined) {
      // "1st April 2026" — day, month, year
      day = m[1] ? parseInt(m[1], 10) : null;
      monKey = m[2].slice(0, 3).toLowerCase();
      year = parseInt(m[3], 10);
    } else if (m[4] !== undefined) {
      // "August 01, 2025" — month, day, year
      monKey = m[4].slice(0, 3).toLowerCase();
      day = m[5] ? parseInt(m[5], 10) : null;
      year = parseInt(m[6], 10);
    } else if (m[7] !== undefined) {
      // "Feb 2026" — month, year only
      monKey = m[7].slice(0, 3).toLowerCase();
      year = parseInt(m[8], 10);
    }
    if (!monKey || !(monKey in MONTHS)) continue;
    tokens.push({ day, month: MONTHS[monKey], year });
  }

  if (tokens.length === 0) {
    // Fallback: DD/MM/YYYY or YYYY-MM-DD
    const numRe = /(?:(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4}))|(?:(\d{4})[\/\.-](\d{1,2})[\/\.-](\d{1,2}))/g;
    while ((m = numRe.exec(text)) !== null) {
      if (m[1]) {
        tokens.push({
          day: parseInt(m[1], 10),
          month: parseInt(m[2], 10) - 1,
          year: parseInt(m[3], 10),
        });
      } else if (m[4]) {
        tokens.push({
          day: parseInt(m[6], 10),
          month: parseInt(m[5], 10) - 1,
          year: parseInt(m[4], 10),
        });
      }
    }
  }

  return tokens;
}

/**
 * Parses a raw "Source Data Period (Validity)" cell into a usable range.
 * Returns { raw, from: Date|null, to: Date|null, ongoing: boolean, unknown: boolean }
 * `to` is null when the structure is open-ended ("onwards" / "till further
 * notice") — the front-end treats a null `to` as "still in effect today".
 *
 * Exported so oldBrokerageUploadService.js can parse the same free-text
 * "Data Period" column from an uploaded file identically.
 */
function parsePeriod(raw) {
  const text = String(raw || '').trim();
  if (!text || /not specified|not applicable/i.test(text)) {
    return { raw: text || 'Not specified', from: null, to: null, ongoing: false, unknown: true };
  }

  const tokens = extractTokens(text);
  const ongoing = /onwards|till further notice|ongoing|further notice/i.test(text);

  if (tokens.length === 0) {
    return { raw: text, from: null, to: null, ongoing: false, unknown: true };
  }

  const first = tokens[0];
  const from = new Date(Date.UTC(first.year, first.month, first.day || 1));

  if (tokens.length === 1) {
    // Single date + "onwards" (or effective date with no explicit end)
    return { raw: text, from, to: ongoing ? null : from, ongoing, unknown: false };
  }

  const last = tokens[tokens.length - 1];
  const toDay = last.day || lastDayOfMonth(last.year, last.month);
  const to = new Date(Date.UTC(last.year, last.month, toDay));
  return { raw: text, from, to, ongoing: false, unknown: false };
}

function loadFromDisk() {
  const filePath = getFilePath();
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames.includes('All Schemes') ? 'All Schemes' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  const header = rows[0] || [];
  const idx = {
    amc: header.findIndex(h => /amc|firm/i.test(String(h || ''))),
    period: header.findIndex(h => /period|validity/i.test(String(h || ''))),
    scheme: header.findIndex(h => /scheme\s*name/i.test(String(h || ''))),
    category: header.findIndex(h => /category|tier/i.test(String(h || ''))),
    arn: header.findIndex(h => /^arn\b|arn\s*no|arn\s*code/i.test(String(h || ''))),
    year1: header.findIndex(h => /1st\s*year/i.test(String(h || ''))),
    year2: header.findIndex(h => /2nd\s*year/i.test(String(h || ''))),
    year3: header.findIndex(h => /3rd\s*year/i.test(String(h || ''))),
    year4: header.findIndex(h => /4th\s*year/i.test(String(h || ''))),
    year5: header.findIndex(h => /5th\s*year/i.test(String(h || ''))),
    year6: header.findIndex(h => /6th\s*year/i.test(String(h || ''))),
    gst: header.findIndex(h => /gst/i.test(String(h || ''))),
    notes: header.findIndex(h => /note/i.test(String(h || ''))),
  };

  const out = [];
  let lastAmc = null;
  let lastPeriodRaw = null;
  let id = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const scheme = idx.scheme >= 0 ? String(row[idx.scheme] || '').trim() : '';
    if (!scheme) continue;

    const amcCell = idx.amc >= 0 ? row[idx.amc] : null;
    const periodCell = idx.period >= 0 ? row[idx.period] : null;
    const amc = amcCell ? String(amcCell).trim() : lastAmc;
    const periodRaw = periodCell ? String(periodCell).trim() : lastPeriodRaw;
    lastAmc = amc;
    lastPeriodRaw = periodRaw;
    if (!amc) continue;

    const period = parsePeriod(periodRaw);

    out.push({
      id: ++id,
      amc,
      period: period.raw,
      periodFrom: period.from ? period.from.toISOString().slice(0, 10) : null,
      periodTo: period.to ? period.to.toISOString().slice(0, 10) : null,
      ongoing: period.ongoing,
      unknownPeriod: period.unknown,
      scheme,
      category: idx.category >= 0 ? (row[idx.category] || '').trim() : '',
      arn: idx.arn >= 0 ? (row[idx.arn] || '').trim() : '',
      year1: idx.year1 >= 0 ? parseNumber(row[idx.year1]) : null,
      year2: idx.year2 >= 0 ? parseNumber(row[idx.year2]) : null,
      year3: idx.year3 >= 0 ? parseNumber(row[idx.year3]) : null,
      year4: idx.year4 >= 0 ? parseNumber(row[idx.year4]) : null,
      year5: idx.year5 >= 0 ? parseNumber(row[idx.year5]) : null,
      year6: idx.year6 >= 0 ? parseNumber(row[idx.year6]) : null,
      gst: idx.gst >= 0 ? (row[idx.gst] || '').trim() : '',
      notes: idx.notes >= 0 ? (row[idx.notes] || '').trim() : '',
    });
  }

  return { rows: out };
}

function getData() {
  let mtimeMs = null;
  const filePath = getFilePath();
  try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (e) { /* file missing */ }

  if (!cache || mtimeMs !== lastMtime) {
    try {
      cache = loadFromDisk();
      lastMtime = mtimeMs;
      logger.info('Old Brokerage Data excel loaded', { rows: cache.rows.length });
    } catch (err) {
      logger.error('Failed to load Old Brokerage Data excel', { error: err.message });
      if (!cache) cache = { rows: [] };
    }
  }
  return cache;
}

/**
 * Base Excel rows + admin overrides/uploads merged on top, keyed by
 * (amc, scheme, period). Matching keys have their Year 1-6 (and category,
 * if supplied) replaced and get `edited: true`. Override/upload entries
 * whose (amc, scheme, period) key has NO match in the base Excel at all
 * are APPENDED as brand-new rows — this is how a freshly uploaded quarter
 * for an existing scheme shows up as an additional row rather than
 * replacing the older period's data.
 */
function getAll() {
  const { rows: baseRows } = getData();
  const overrideEntries = overrideService.getAll();
  const overrideByKey = new Map(overrideEntries.map(o => [o.key, o]));
  const baseKeys = new Set();

  const merged = baseRows.map(r => {
    const key = overrideService.keyFor(r.amc, r.scheme, r.period);
    baseKeys.add(key);
    const ov = overrideByKey.get(key);
    if (!ov) return r;
    return {
      ...r,
      category: ov.category || r.category,
      // `null` means an inline edit did not touch ARN, so retain the base
      // value. An explicit empty string from an upload/manual entry means
      // the source ARN is genuinely absent and must remain blank.
      arn: ov.arn !== null && ov.arn !== undefined ? ov.arn : r.arn,
      year1: ov.year1,
      year2: ov.year2,
      year3: ov.year3,
      year4: ov.year4,
      year5: ov.year5,
      year6: ov.year6,
      edited: true,
    };
  });

  let nextId = merged.reduce((max, r) => Math.max(max, r.id), 0);
  overrideEntries.forEach(ov => {
    if (baseKeys.has(ov.key)) return; // already applied above
    const period = parsePeriod(ov.period);
    merged.push({
      id: ++nextId,
      amc: ov.amc,
      period: period.raw,
      periodFrom: period.from ? period.from.toISOString().slice(0, 10) : null,
      periodTo: period.to ? period.to.toISOString().slice(0, 10) : null,
      ongoing: period.ongoing,
      unknownPeriod: period.unknown,
      scheme: ov.scheme,
      category: ov.category || '',
      arn: ov.arn || '',
      year1: ov.year1,
      year2: ov.year2,
      year3: ov.year3,
      year4: ov.year4,
      year5: ov.year5,
      year6: ov.year6,
      gst: '',
      notes: '',
      edited: true,
      uploaded: true,
    });
  });

  return merged.filter(r =>
    !overrideService.isDeleted(r.amc, r.scheme, r.period) && hasAllowedArn(r.arn)
  );
}

/**
 * Computes the latest Data Period string across active brokerage records.
 */
function getLatestDataPeriod() {
  return getLatestDataPeriodInfo().period;
}

/**
 * Same "latest period" computation as getLatestDataPeriod(), but also
 * returns the ARN(s) belonging to that specific latest row — so the UI can
 * show which distributor ARN the currently-displayed Date Period came from.
 */
function getLatestDataPeriodInfo() {
  const rows = getAll();
  let latestPeriodRaw = null;
  let latestArn = '';
  let maxTime = -Infinity;
  for (const r of rows) {
    if (!r.period) continue;
    const p = parsePeriod(r.period);
    const t = p.to ? p.to.getTime() : (p.from ? p.from.getTime() : -Infinity);
    if (t > maxTime && !p.ongoing) {
      maxTime = t;
      latestPeriodRaw = r.period;
      latestArn = r.arn || '';
    }
  }
  return {
    period: latestPeriodRaw || '1st July 2026 to 30th September 2026',
    arn: latestArn,
  };
}

/**
 * Normalize a scheme name into a matching key.
 *
 * A plain lowercase+trim was too strict: the same scheme is often typed
 * slightly differently between the AMFI-sourced TER table and the manually
 * maintained Old Brokerage Data spreadsheet — different punctuation
 * (hyphens vs en-dashes vs none), stray "*"/"#" markers, extra spaces
 * around "&", or even the words in a different order (e.g. "ELSS Tax
 * Saver Nifty 50 Index Fund" vs "ELSS Nifty 50 Tax Saver Index Fund").
 * None of that changes which real-world scheme is meant.
 *
 * Strip all punctuation down to word characters, then sort the tokens
 * before joining, so two names built from the same words — in any order,
 * with any punctuation between them — produce the same key. This is safe
 * because it only ever collapses spelling/formatting/ordering variants of
 * literally the same set of words; it never merges two schemes that have
 * genuinely different words in their names.
 */
function normSchemeName(name) {
  let n = String(name || '').toLowerCase();
  // Drop any "... erstwhile <old scheme name>" tail. AMCs sometimes record
  // a renamed scheme's former name this way in the commission sheet (e.g.
  // "Kotak Aggressive Hybrid Fund erstwhile Kotak Equity Hybrid Fund"), but
  // the live AMFI-sourced TER table only ever uses the current name — so
  // keeping the "erstwhile" clause in the comparison key added extra words
  // that could never appear on the other side, and the scheme never matched.
  n = n.replace(/\berstwhile\b.*$/i, '');
  n = n.replace(/[^\w\s]/g, ' ');   // punctuation/symbols -> space
  n = n.replace(/\s+/g, ' ').trim();
  return n.split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Every scheme can have its own distributor-commission validity window —
 * one AMC's schemes often change on different dates from each other (e.g.
 * some Bandhan schemes moved to a new structure in Feb 2026, others only in
 * Jul 2026). A single "latest period across the whole file" value is
 * therefore wrong to show against an individual scheme's row.
 *
 * This returns a Map: normalized scheme name -> { period, arn, periodFrom,
 * year1, year2, year3, year4, yearOnward, year6Onward } — the TRUE latest
 * validity window AND commission percentages for that specific scheme,
 * chosen by the newest periodFrom. When two records share the same
 * periodFrom (which happens when a genuine "till further notice" row has a
 * corrupted/truncated duplicate recorded as a same-day closed period), the
 * ongoing open-ended record wins, since the truncated one is a known data
 * artifact rather than a real closed quarter.
 *
 * The Year 1-6 values here are what let the main StarPay Matrix table's
 * commission columns populate automatically straight from this same
 * archive — exactly like the ARN/Date Period columns already do — instead
 * of only ever showing a value once someone re-uploads that AMC via
 * "Commission Structure Upload".
 */
function getLatestPeriodByScheme() {
  const rows = getAll();
  const map = new Map();
  for (const r of rows) {
    if (!r.scheme || !r.periodFrom) continue;
    const key = normSchemeName(r.scheme);
    const existing = map.get(key);
    const isNewer = !existing
      || r.periodFrom > existing.periodFrom
      || (r.periodFrom === existing.periodFrom && r.ongoing && !existing.ongoing);
    if (isNewer) {
      map.set(key, {
        period: r.period,
        arn: r.arn || '',
        periodFrom: r.periodFrom,
        year1: r.year1 !== undefined ? r.year1 : null,
        year2: r.year2 !== undefined ? r.year2 : null,
        year3: r.year3 !== undefined ? r.year3 : null,
        year4: r.year4 !== undefined ? r.year4 : null,
        yearOnward: r.year5 !== undefined ? r.year5 : null,
        year6Onward: r.year6 !== undefined ? r.year6 : null,
      });
    }
  }
  return map;
}

function getMeta() {
  const rows = getAll();
  let minDate = null, maxDate = null;
  rows.forEach(r => {
    if (r.periodFrom && (!minDate || r.periodFrom < minDate)) minDate = r.periodFrom;
    const endBound = r.periodTo || (r.ongoing ? new Date().toISOString().slice(0, 10) : null);
    if (endBound && (!maxDate || endBound > maxDate)) maxDate = endBound;
  });

  return {
    amcs: [...new Set(rows.map(r => r.amc))].sort(),
    categories: [...new Set(rows.map(r => r.category).filter(Boolean))]
      .filter(c => !/^[\d.,%\s\-]+$/.test(c)) // guard: never show a purely numeric/percentage value as a "category"
      .sort(),
    arns: [...new Set(rows.flatMap(r => splitArnValues(r.arn)))].sort(),
    minDate,
    maxDate,
    total: rows.length,
    latestPeriod: getLatestDataPeriod(),
    source: 'Mutual_Fund_Brokerage_Consolidated_Verified.xlsx + admin uploads',
  };
}

module.exports = { getAll, getMeta, getLatestDataPeriod, getLatestDataPeriodInfo, getLatestPeriodByScheme, normSchemeName, parsePeriod, hasAllowedArn, hasAllowedOrMissingArn, ALLOWED_ARNS };