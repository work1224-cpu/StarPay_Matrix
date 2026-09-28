/**
 * services/brokerageAnalysisService.js
 *
 * Aggregates the full old-brokerage dataset (services/oldBrokerageService.js
 * — every AMC, every scheme, every quarter/period ever uploaded) into the
 * summary numbers the Brokerage Analysis page charts and comparison table
 * need. Nothing here touches disk directly; it all derives from
 * oldBrokerageService.getAll(), so it always reflects the latest uploads
 * and inline edits.
 */

const oldBrokerageService = require('./oldBrokerageService');

const YEAR_KEYS = ['year1', 'year2', 'year3', 'year4', 'year5', 'year6'];

function isNum(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function round(v, dp = 3) {
  return isNum(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null;
}

function avg(values) {
  const nums = values.filter(isNum);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Calendar year a row's validity period starts in, or null if unknown. */
function periodYear(row) {
  if (!row.periodFrom) return null;
  const y = Number(String(row.periodFrom).slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * Applies the (optional) amc / category / arn / year filters used by the
 * Brokerage Analysis page's filter bar. Any filter left blank is a no-op.
 */
function filterRows(rows, filters = {}) {
  const amc = (filters.amc || '').trim().toLowerCase();
  const category = (filters.category || '').trim().toLowerCase();
  const arn = (filters.arn || '').trim().toLowerCase();
  const year = filters.year ? Number(filters.year) : null;

  return rows.filter((r) => {
    if (amc && (r.amc || '').toLowerCase() !== amc) return false;
    if (category && (r.category || '').toLowerCase() !== category) return false;
    if (arn && String(r.arn || '').toLowerCase() !== arn) return false;
    if (year && periodYear(r) !== year) return false;
    return true;
  });
}

/**
 * Builds every number the analysis page's charts + KPI strip need, for the
 * given filter set. Averages are computed per year-of-holding column
 * (Year 1 … Year 6 Onward) so a caller can pick whichever column a chart is
 * currently displaying.
 */
function computeSummary(filters = {}) {
  const allRows = oldBrokerageService.getAll();
  const rows = filterRows(allRows, filters);

  // ── Trend over time: avg commission per calendar year, per year-column ──
  const byYear = new Map();
  rows.forEach((r) => {
    const y = periodYear(r);
    if (!y) return;
    if (!byYear.has(y)) byYear.set(y, { rowCount: 0, cols: YEAR_KEYS.map(() => []) });
    const bucket = byYear.get(y);
    bucket.rowCount += 1;
    YEAR_KEYS.forEach((k, i) => { if (isNum(r[k])) bucket.cols[i].push(r[k]); });
  });
  const yearlyTrend = [...byYear.keys()].sort((a, b) => a - b).map((y) => {
    const bucket = byYear.get(y);
    const entry = { year: y, recordCount: bucket.rowCount };
    YEAR_KEYS.forEach((k, i) => { entry[k] = round(avg(bucket.cols[i])); });
    return entry;
  });

  // ── AMC comparison: avg Year-1 commission + record count per AMC ──
  const byAmc = new Map();
  rows.forEach((r) => {
    if (!r.amc) return;
    if (!byAmc.has(r.amc)) byAmc.set(r.amc, { rowCount: 0, cols: YEAR_KEYS.map(() => []) });
    const bucket = byAmc.get(r.amc);
    bucket.rowCount += 1;
    YEAR_KEYS.forEach((k, i) => { if (isNum(r[k])) bucket.cols[i].push(r[k]); });
  });
  const amcComparison = [...byAmc.entries()].map(([amc, bucket]) => {
    const entry = { amc, recordCount: bucket.rowCount };
    YEAR_KEYS.forEach((k, i) => { entry[k] = round(avg(bucket.cols[i])); });
    return entry;
  }).sort((a, b) => (b.year1 ?? -1) - (a.year1 ?? -1));

  // ── Category comparison: same shape, grouped by scheme category ──
  const byCategory = new Map();
  rows.forEach((r) => {
    const cat = r.category || 'Uncategorised';
    if (!byCategory.has(cat)) byCategory.set(cat, { rowCount: 0, cols: YEAR_KEYS.map(() => []) });
    const bucket = byCategory.get(cat);
    bucket.rowCount += 1;
    YEAR_KEYS.forEach((k, i) => { if (isNum(r[k])) bucket.cols[i].push(r[k]); });
  });
  const categoryComparison = [...byCategory.entries()].map(([category, bucket]) => {
    const entry = { category, recordCount: bucket.rowCount };
    YEAR_KEYS.forEach((k, i) => { entry[k] = round(avg(bucket.cols[i])); });
    return entry;
  }).sort((a, b) => (b.year1 ?? -1) - (a.year1 ?? -1));

  // ── Commission-by-holding-year structure: avg of each Year column, ──
  // across every filtered row — the classic "does trail commission taper
  // off the longer you hold" curve.
  const holdingYearStructure = YEAR_KEYS.map((k, i) => ({
    label: i === 5 ? '6th Yr Onward' : `Year ${i + 1}`,
    avg: round(avg(rows.map((r) => r[k]))),
  }));

  // ── Distribution: how Year-1 commission % is spread across schemes ──
  const buckets = [
    { label: '0 – 0.25%', min: 0, max: 0.25 },
    { label: '0.25 – 0.5%', min: 0.25, max: 0.5 },
    { label: '0.5 – 0.75%', min: 0.5, max: 0.75 },
    { label: '0.75 – 1%', min: 0.75, max: 1 },
    { label: '1 – 1.5%', min: 1, max: 1.5 },
    { label: '1.5%+', min: 1.5, max: Infinity },
  ];
  const year1Values = rows.map((r) => r.year1).filter(isNum);
  const distribution = buckets.map((b) => ({
    label: b.label,
    count: year1Values.filter((v) => v >= b.min && v < b.max).length,
  }));

  const schemeSet = new Set(rows.map((r) => r.scheme));
  const amcSet = new Set(rows.map((r) => r.amc));
  const periodSet = new Set(rows.map((r) => r.period).filter(Boolean));

  return {
    filters: {
      amc: filters.amc || '',
      category: filters.category || '',
      arn: filters.arn || '',
      year: filters.year || '',
    },
    totals: {
      totalRecords: rows.length,
      totalSchemes: schemeSet.size,
      totalAmcs: amcSet.size,
      totalPeriods: periodSet.size,
    },
    yearlyTrend,
    amcComparison,
    categoryComparison,
    holdingYearStructure,
    distribution,
  };
}

/** Filter option lists for the page's dropdowns, always unfiltered. */
function getFilterMeta() {
  const rows = oldBrokerageService.getAll();
  const amcs = [...new Set(rows.map((r) => r.amc).filter(Boolean))].sort();
  const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  const years = [...new Set(rows.map(periodYear).filter(Boolean))].sort((a, b) => b - a);
  // scheme -> amc, for the scheme-explorer search box (name + amc only,
  // full history is fetched separately/on demand so this stays lightweight)
  const schemeMap = new Map();
  rows.forEach((r) => {
    if (r.scheme && !schemeMap.has(r.scheme)) schemeMap.set(r.scheme, r.amc || '');
  });
  const schemes = [...schemeMap.entries()]
    .map(([scheme, amc]) => ({ scheme, amc }))
    .sort((a, b) => a.scheme.localeCompare(b.scheme));

  return { amcs, categories, years, schemes };
}

/**
 * Every period on record for one scheme (optionally scoped to one AMC, in
 * case two AMCs happen to use the same scheme name), oldest first — powers
 * the scheme-explorer trend chart + table on the analysis page.
 */
function getSchemeHistory(schemeName, amcName) {
  const needle = (schemeName || '').trim().toLowerCase();
  if (!needle) return [];
  const amcNeedle = (amcName || '').trim().toLowerCase();

  return oldBrokerageService.getAll()
    .filter((r) => (r.scheme || '').trim().toLowerCase() === needle
      && (!amcNeedle || (r.amc || '').trim().toLowerCase() === amcNeedle))
    .sort((a, b) => (a.periodFrom || '').localeCompare(b.periodFrom || ''))
    .map((r) => ({
      period: r.period,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      ongoing: !!r.ongoing,
      amc: r.amc,
      category: r.category,
      arn: r.arn,
      year1: r.year1, year2: r.year2, year3: r.year3,
      year4: r.year4, year5: r.year5, year6: r.year6,
    }));
}

module.exports = { computeSummary, getFilterMeta, getSchemeHistory };
