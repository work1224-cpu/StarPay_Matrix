/**
 * services/oldBrokerageUploadService.js
 *
 * Parses an admin-uploaded "Old Brokerage Data" Excel file — the
 * "Commission Structure Upload" on the Old Brokerage Data page. Expected
 * columns (header row, fuzzy-matched, any order): AMC, Data Period
 * (Validity), Scheme Name, Category, 1st/2nd/3rd/4th/5th/6th Year %.
 *
 * Same forward-fill convention as the base
 * Mutual_Fund_Brokerage_Consolidated_Verified.xlsx file: AMC and Data
 * Period only need to be filled on the FIRST row of each group — every
 * blank cell below inherits the value above it. This lets an admin paste
 * one quarter's full AMC block (many schemes) without repeating the same
 * AMC/period text on every single row.
 *
 * Each row becomes its own (amc, scheme, period) record — the same scheme
 * appearing under two different periods produces two separate rows, which
 * is exactly the point (see oldBrokerageOverrideService.js).
 */

const XLSX = require('xlsx');
const logger = require('../helpers/logger');
const { parsePeriod } = require('./oldBrokerageService');

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_/.-]+/g, ' ').trim();
}

function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : null;
}

const PATTERNS = {
  amc:      /amc|firm|fund\s*house/i,
  period:   /period|validity|date\s*range/i,
  scheme:   /scheme|fund\s*name/i,
  category: /category|tier|type/i,
  arn:      /arn/i,
  year1:    /1st|year\s*1\b|yr\s*1\b|y1\b/i,
  year2:    /2nd|year\s*2\b|yr\s*2\b|y2\b/i,
  year3:    /3rd|year\s*3\b|yr\s*3\b|y3\b/i,
  year4:    /4th(?!\s*onward)|year\s*4\b(?!\s*onward)|yr\s*4\b(?!\s*onward)|y4\b/i,
  year5:    /5th(?!\s*onward)|year\s*5\b(?!\s*onward)|yr\s*5\b(?!\s*onward)|y5\b/i,
  year6:    /6th|onward|year\s*6\b|yr\s*6\b|y6\b/i,
};

function detectHeader(rows) {
  let bestRow = -1, bestMap = {}, bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const row = rows[r] || [];
    const map = {};
    let score = 0;
    row.forEach((cell, i) => {
      const clean = norm(cell);
      if (!clean) return;
      for (const [key, re] of Object.entries(PATTERNS)) {
        if (re.test(clean) && map[key] === undefined) { map[key] = i; score++; }
      }
    });
    if (map.scheme !== undefined && score > bestScore) {
      bestScore = score; bestRow = r; bestMap = map;
    }
  }
  return { headerRow: bestRow, map: bestMap };
}

/**
 * Returns [{ amc, scheme, period, category, year1..year6 }, ...]
 * Throws with a human-readable message if the file doesn't look right.
 */
function parseOldBrokerageExcel(buffer, defaultAmc = null) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const out = [];
  let sheetsUsed = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
    if (!rows.length) continue;

    const { headerRow, map } = detectHeader(rows);
    if (headerRow === -1) continue;
    sheetsUsed++;

    let lastAmc = defaultAmc || null;
    let lastPeriodRaw = null;

    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const scheme = map.scheme !== undefined ? String(row[map.scheme] || '').trim() : '';
      if (!scheme) continue;
      if (/^total|^grand total/i.test(scheme)) continue;

      const amcCell = map.amc !== undefined ? row[map.amc] : null;
      const periodCell = map.period !== undefined ? row[map.period] : null;
      const amc = amcCell ? String(amcCell).trim() : lastAmc;
      const periodRaw = periodCell ? String(periodCell).trim() : lastPeriodRaw;
      lastAmc = amc;
      lastPeriodRaw = periodRaw;
      if (!amc) continue;
      if (!periodRaw) continue; // period is mandatory here — it's the whole point of this upload

      const period = parsePeriod(periodRaw);
      const year1 = map.year1 !== undefined ? parseNumber(row[map.year1]) : null;
      const year2 = map.year2 !== undefined ? parseNumber(row[map.year2]) : null;
      const year3 = map.year3 !== undefined ? parseNumber(row[map.year3]) : null;
      const year4 = map.year4 !== undefined ? parseNumber(row[map.year4]) : null;
      const year5 = map.year5 !== undefined ? parseNumber(row[map.year5]) : null;
      const year6 = map.year6 !== undefined ? parseNumber(row[map.year6]) : null;

      if ([year1, year2, year3, year4, year5, year6].every(v => v === null)) continue;

      out.push({
        amc,
        scheme,
        period: period.raw,
        category: map.category !== undefined ? String(row[map.category] || '').trim() : '',
        arn: map.arn !== undefined ? String(row[map.arn] || '').trim() : '',
        year1, year2, year3, year4, year5, year6,
      });
    }
  }

  if (sheetsUsed === 0) {
    throw new Error('Could not find a "Scheme Name" header in any sheet of this file.');
  }
  if (out.length === 0) {
    throw new Error('Header row was found, but no rows with a Data Period AND at least one Year value could be read underneath it.');
  }

  logger.info('Old Brokerage Data upload parsed', { sheets: sheetsUsed, rows: out.length });
  return out;
}

/**
 * Given the flat rows returned by parseOldBrokerageExcel (one row per
 * amc+scheme+period+arn), collapse down to ONE representative dataset per
 * AMC — the point being that a firm's brokerage sheet legitimately lists
 * the same schemes under several different (older + newer) Data Periods,
 * and under several different ARN codes, but for "what should the main
 * StarPay Matrix table show right now" we only want:
 *
 *   1. the MOST RECENT Data Period for that AMC (by parsed end/start date;
 *      an "onwards"/open-ended period always counts as the most recent), and
 *   2. ONE ARN's rows for that AMC+period (arbitrary — different ARNs under
 *      the same AMC+period represent the same commission structure, just
 *      quoted for different distributor codes, so it doesn't matter which
 *      one is used; we pick whichever ARN has the most scheme rows, which
 *      in practice also means "the most complete" one).
 *
 * Returns a Map<amcName, { amc, period, arn, rows: [{scheme, category, year1..year6}] }>
 */
function pickLatestPerAMC(rows) {
  const byAmc = new Map();
  for (const r of rows) {
    if (!byAmc.has(r.amc)) byAmc.set(r.amc, []);
    byAmc.get(r.amc).push(r);
  }

  function periodSortKey(periodRaw) {
    const p = parsePeriod(periodRaw);
    if (p.ongoing) return Infinity;
    if (p.to) return p.to.getTime();
    if (p.from) return p.from.getTime();
    return -Infinity;
  }

  const result = new Map();

  for (const [amc, amcRows] of byAmc.entries()) {
    // 1. Group by period text, find the latest period.
    const byPeriod = new Map();
    for (const r of amcRows) {
      if (!byPeriod.has(r.period)) byPeriod.set(r.period, []);
      byPeriod.get(r.period).push(r);
    }
    let latestPeriod = null, latestKey = -Infinity;
    for (const periodRaw of byPeriod.keys()) {
      const key = periodSortKey(periodRaw);
      if (latestPeriod === null || key > latestKey) { latestKey = key; latestPeriod = periodRaw; }
    }
    const latestRows = byPeriod.get(latestPeriod) || [];

    // 2. Within the latest period, group by ARN and pick the biggest group.
    const byArn = new Map();
    for (const r of latestRows) {
      const arnKey = r.arn || '';
      if (!byArn.has(arnKey)) byArn.set(arnKey, []);
      byArn.get(arnKey).push(r);
    }
    let chosenArn = '', chosenRows = [];
    for (const [arnKey, arnRows] of byArn.entries()) {
      if (arnRows.length > chosenRows.length) { chosenArn = arnKey; chosenRows = arnRows; }
    }

    result.set(amc, {
      amc,
      period: latestPeriod,
      arn: chosenArn,
      rows: chosenRows.map(r => ({
        scheme: r.scheme,
        category: r.category,
        year1: r.year1,
        year2: r.year2,
        year3: r.year3,
        year4: r.year4,
        yearOnward: r.year5,
        year6Onward: r.year6,
      })),
    });
  }

  return result;
}

module.exports = { parseOldBrokerageExcel, pickLatestPerAMC };