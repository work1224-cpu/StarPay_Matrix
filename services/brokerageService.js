/**
 * services/brokerageService.js
 *
 * Serves the distributor brokerage / trail-commission data extracted from
 * AMC brokerage-structure PDFs (source: Mutual_Fund_Brokerage_Consolidated.xlsx).
 * This is fully static (bundled JSON) — no AMFI fetch, no network dependency,
 * so it always loads instantly regardless of AMFI's live-data status.
 */

const data = require('./brokerageData.json');

let allKnownAMCs = [];
try {
  allKnownAMCs = require('./allAMCs.json');
} catch (e) {
  allKnownAMCs = [];
}

function getAll() {
  return data;
}

function getAMCs() {
  // Union of AMCs that have real scheme data + every AMC we have any
  // knowledge of at all (e.g. HDFC, whose source is only a partial notice
  // with no usable rows) — so pickers/dropdowns always show the full list.
  return [...new Set([...data.map(r => r.amc), ...allKnownAMCs])].sort();
}

function getCategories() {
  return [...new Set(data.map(r => r.category).filter(Boolean))].sort();
}

function getStatus() {
  return {
    total: data.length,
    amcCount: getAMCs().length,
    source: 'Mutual_Fund_Brokerage_Consolidated.xlsx (AMC brokerage-structure PDFs)',
  };
}

module.exports = { getAll, getAMCs, getCategories, getStatus };
