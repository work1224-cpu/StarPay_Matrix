/**
 * services/excelUploadService.js
 *
 * Parses a manually-uploaded "Commission Structure" Excel file (Scheme Name +
 * Year 1/2/3/4/5-Onward/6-Onward columns, optionally a "Data Period
 * (Validity)" column) so an admin can update distributor commission data
 * for one AMC at a time.
 *
 * Header detection is fuzzy/keyword based (not a fixed column index)
 * because sheets vary slightly release to release.
 *
 * IMPORTANT — same scheme, multiple months in one file: when a "Data
 * Period (Validity)" column is present (forward-filled same as the Old
 * Brokerage format — only needs to be filled on the first row of a block),
 * a scheme can legitimately appear more than once under different periods.
 * Only the MOST RECENT period's row is kept per scheme; older rows for
 * that same scheme are dropped. Without a period column at all, every row
 * is kept as-is (legacy behaviour — nothing to compare periods against).
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

function periodSortKey(periodRaw) {
  const p = parsePeriod(periodRaw);
  if (p.ongoing) return Infinity;
  if (p.to) return p.to.getTime();
  if (p.from) return p.from.getTime();
  return -Infinity;
}

/**
 * Parses a "TER Data Upload" file — i.e. a scheme-wise distributor
 * commission sheet with Year 1 / 2 / 3 / 4 / 5-Onward / 6-Onward columns
 * (same shape as Mutual_Fund_Brokerage_Consolidated.xlsx), optionally with
 * a "Data Period (Validity)" column.
 * Returns [{ scheme, year1, year2, year3, year4, yearOnward, year6Onward }, ...]
 * — deduplicated to the latest period per scheme when a period column exists.
 */
function parseCommissionExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const patterns = {
    scheme:      /scheme\s*name/,
    period:      /period|validity/,
    year1:       /1st\s*year|year\s*1\b|1\s*yr\b/,
    year2:       /2nd\s*year|year\s*2\b|2\s*yr\b/,
    year3:       /3rd\s*year|year\s*3\b|3\s*yr\b/,
    year4:       /4th\s*year|year\s*4\b|4\s*yr\b/,
    yearOnward:  /5th\s*year|year\s*5\b|5\s*yr\b|\bonward\b/,
    year6Onward: /6th\s*year|year\s*6\b|6\s*yr\b/,
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
        for (const [key, re] of Object.entries(patterns)) {
          if (re.test(clean) && map[key] === undefined) { map[key] = i; score++; }
        }
      });
      if (map.scheme !== undefined && score > bestScore) {
        bestScore = score; bestRow = r; bestMap = map;
      }
    }
    return { headerRow: bestRow, map: bestMap };
  }

  const out = [];
  let sheetsUsed = 0;
  let sawPeriodColumn = false;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    if (!rows.length) continue;

    const { headerRow, map } = detectHeader(rows);
    if (headerRow === -1) continue;
    sheetsUsed++;
    if (map.period !== undefined) sawPeriodColumn = true;

    let lastPeriodRaw = null;

    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const scheme = String(row[map.scheme] ?? '').trim();
      if (!scheme || scheme.length < 3) continue;
      if (/^total|^grand total/i.test(scheme)) continue;

      const periodCell = map.period !== undefined ? row[map.period] : null;
      const periodRaw = periodCell ? String(periodCell).trim() : lastPeriodRaw;
      lastPeriodRaw = periodRaw;

      const year1 = map.year1 !== undefined ? parseNumber(row[map.year1]) : null;
      const year2 = map.year2 !== undefined ? parseNumber(row[map.year2]) : null;
      const year3 = map.year3 !== undefined ? parseNumber(row[map.year3]) : null;
      const year4 = map.year4 !== undefined ? parseNumber(row[map.year4]) : null;
      let yearOnward = map.yearOnward !== undefined ? parseNumber(row[map.yearOnward]) : null;
      if (yearOnward === null) yearOnward = year4; // fall back if sheet has no separate 5th-yr column
      let year6Onward = map.year6Onward !== undefined ? parseNumber(row[map.year6Onward]) : null;
      if (year6Onward === null) year6Onward = yearOnward; // fall back if sheet has no separate 6th-yr column

      if (year1 === null && year2 === null && year3 === null && year4 === null && yearOnward === null) continue;

      out.push({ scheme, period: periodRaw || null, year1, year2, year3, year4, yearOnward, year6Onward });
    }
  }

  if (sheetsUsed === 0) {
    throw new Error('Could not find a "Scheme Name" header in any sheet of this file.');
  }
  if (out.length === 0) {
    throw new Error('Header row was found but no scheme rows with Year 1-4/Onward values could be read underneath it.');
  }

  let result = out;
  let droppedOlder = 0;

  if (sawPeriodColumn) {
    // Keep only the latest-period row per scheme name.
    const byScheme = new Map(); // scheme -> { row, key }
    for (const row of out) {
      const key = periodSortKey(row.period);
      const existing = byScheme.get(row.scheme);
      if (!existing || key > existing.key) {
        if (existing) droppedOlder++;
        byScheme.set(row.scheme, { row, key });
      } else {
        droppedOlder++;
      }
    }
    result = [...byScheme.values()].map(v => v.row);
  }

  logger.info('Commission Excel parsed', {
    sheets: sheetsUsed,
    rowsRead: out.length,
    schemes: result.length,
    periodColumnDetected: sawPeriodColumn,
    olderPeriodRowsDropped: droppedOlder,
  });
  return result;
}

module.exports = { parseCommissionExcel };
