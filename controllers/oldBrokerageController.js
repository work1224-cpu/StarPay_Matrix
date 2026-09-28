/**
 * controllers/oldBrokerageController.js
 *
 * "Old Brokerage Data" page endpoints — /api/old-brokerage/*.
 * (Split out of the former monolithic controllers/apiController.js.)
 */

const XLSX = require('xlsx');
const cacheService = require('../services/cacheService');
const { canonicalizeAMC, normalizeSchemeName } = require('../helpers/normalizer');
const oldBrokerageService = require('../services/oldBrokerageService');
const oldBrokerageOverrideService = require('../services/oldBrokerageOverrideService');
const syncService = require('../services/syncService');
const { parseOldBrokerageExcel } = require('../services/Oldbrokerageuploadservice');
const logger = require('../helpers/logger');

/**
 * Builds a lookup index of CURRENT regularBER% per scheme, straight from
 * the main StarPay Matrix table (cacheService) — used to auto-calculate
 * C/B 1-6yr ratios on the Old Brokerage Data table. Keyed by canonical AMC
 * + normalized scheme name (same normalization used everywhere else in
 * this codebase for cross-page scheme matching, see helpers/normalizer.js).
 */
function buildBERIndex() {
  const index = new Map();
  for (const s of cacheService.getSchemes()) {
    if (s.regularBER === null || s.regularBER === undefined) continue;
    const schemeKey = normalizeSchemeName(s.schemeName);
    if (!schemeKey) continue;
    const key = `${canonicalizeAMC(s.amc) || s.amc}|${schemeKey}`;
    if (!index.has(key)) index.set(key, s.regularBER);
  }
  return index;
}

function lookupBER(index, amc, scheme) {
  const key = `${canonicalizeAMC(amc) || amc}|${normalizeSchemeName(scheme)}`;
  return index.has(key) ? index.get(key) : null;
}

/**
 * GET /api/old-brokerage
 * "Old Brokerage Data" page — date-wise historical brokerage/trail structures
 * read live from data/demo/Mutual_Fund_Brokerage_Consolidated_Verified.xlsx.
 * No server-side filtering (same pattern as /api/schemes) — the client does
 * AMC/category/search/date-range filtering instantly against the full set.
 *
 * Every row is additionally stamped with `ber` and `c1`..`c6` (Commission /
 * BER ratio for Year 1-6) computed on the fly from the scheme's CURRENT BER%
 * on the main StarPay Matrix table — NOT the historical row's own data,
 * since BER% doesn't change per old quarter, only the commission % does.
 * These are always derived fresh (never stored), so they automatically
 * track whatever the main table's BER currently is.
 */
/**
 * Computes the exact array the "All Brokerage Data" page table shows —
 * every historical record enriched with the scheme's current BER% and
 * Year 1-6 Commission/BER ratios. Shared by GET /api/old-brokerage and by
 * the "Save Sync" snapshot (services/syncService.js), so a saved snapshot
 * is always byte-for-byte what an operator was looking at on screen.
 */
function computeOldBrokerageTable() {
  const berIndex = buildBERIndex();
  return oldBrokerageService.getAll().map(r => {
    const ber = lookupBER(berIndex, r.amc, r.scheme);
    const ratio = v => (v !== null && v !== undefined && ber) ? v / ber : null;
    return {
      ...r,
      ber,
      c1: ratio(r.year1),
      c2: ratio(r.year2),
      c3: ratio(r.year3),
      c4: ratio(r.year4),
      c5: ratio(r.year5),
      c6: ratio(r.year6),
    };
  });
}

/**
 * GET /api/old-brokerage
 * "Old Brokerage Data" page — date-wise historical brokerage/trail structures
 * read live from data/demo/Mutual_Fund_Brokerage_Consolidated_Verified.xlsx.
 * No server-side filtering (same pattern as /api/schemes) — the client does
 * AMC/category/search/date-range filtering instantly against the full set.
 *
 * Every row is additionally stamped with `ber` and `c1`..`c6` (Commission /
 * BER ratio for Year 1-6) computed on the fly from the scheme's CURRENT BER%
 * on the main StarPay Matrix table — NOT the historical row's own data,
 * since BER% doesn't change per old quarter, only the commission % does.
 * These are always derived fresh (never stored), so they automatically
 * track whatever the main table's BER currently is.
 */
function getOldBrokerage(req, res) {
  try {
    const data = computeOldBrokerageTable();
    res.json({
      success: true,
      data,
      meta: oldBrokerageService.getMeta(),
    });
  } catch (err) {
    logger.error('Failed to load Old Brokerage Data', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to load Old Brokerage Data.' });
  }
}

/**
 * GET /api/old-brokerage/sync/old
 * Returns the "All Brokerage Data" portion of the last "Save Sync"
 * snapshot (services/syncService.js), in the same shape as
 * GET /api/old-brokerage, so the existing table/filters continue to work
 * unchanged when an operator restores it.
 */
function getOldBrokerageManualSync(req, res) {
  const snapshot = syncService.getOldBrokerageSnapshot();
  if (!snapshot) {
    return res.status(404).json({ success: false, message: 'No saved sync copy is available yet.' });
  }
  return res.json({
    success: true,
    data: snapshot.rows,
    savedAt: snapshot.meta.savedAt,
    stale: true,
    staleReason: 'Showing the manually saved sync copy.',
    meta: oldBrokerageService.getMeta(),
  });
}

/**
 * POST /api/old-brokerage/update
 * Admin-only: upserts one Old Brokerage Data row, keyed by (amc, scheme,
 * period). Used by TWO features on the page:
 *  - the inline "Edit" button (touches Year 1-6 on an EXISTING row)
 *  - the "+ Add New Scheme" manual-entry form (creates a brand-new
 *    AMC + Scheme + Data Period row with no Excel upload needed at all)
 * Either way it's just an upsert — see oldBrokerageOverrideService.set()
 * and oldBrokerageService.getAll(), which appends any override whose key
 * has no matching row in the base Excel as a new row on the table.
 */
function updateOldBrokerage(req, res) {
  try {
    const { amc, scheme, period, values } = req.body || {};
    if (!amc || !scheme || !period) {
      return res.status(400).json({ success: false, message: 'AMC, Scheme Name and Data Period are all required.' });
    }
    if (Object.prototype.hasOwnProperty.call(values || {}, 'arn') && String(values.arn || '').trim() && !oldBrokerageService.hasAllowedArn(values.arn)) {
      return res.status(400).json({
        success: false,
        message: 'Only these ARN numbers are supported: 280532, 50111, 1182, 1183, 1184, 117196, 13025.',
      });
    }
    for (const [key, val] of Object.entries(values || {})) {
      if (key === 'category' || key === 'arn') continue;
      if (val !== null && val !== undefined && (isNaN(val) || !isFinite(val))) {
        return res.status(400).json({ success: false, message: `Invalid value for ${key}` });
      }
    }
    const saved = oldBrokerageOverrideService.set(amc, scheme, period, values || {});
    return res.json({ success: true, message: 'Old Brokerage Data updated.', data: saved });
  } catch (err) {
    logger.error('Old Brokerage Data update failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to update Old Brokerage Data.' });
  }
}

/**
 * POST /api/old-brokerage/delete
 * Admin-only: permanently removes ONE Old Brokerage Data row, keyed by
 * (amc, scheme, period) — the same identity used everywhere else on this
 * page. Works whether the row originally came from the base Excel file or
 * from an admin upload/manual entry: a tombstone key is recorded so a row
 * sourced from the (read-only) Excel file never resurfaces on the next
 * load, and any override/upload entry for that exact key is discarded
 * outright. See oldBrokerageOverrideService.removeRow / isDeleted.
 */
function deleteOldBrokerage(req, res) {
  try {
    const { amc, scheme, period } = req.body || {};
    if (!amc || !scheme || !period) {
      return res.status(400).json({ success: false, message: 'AMC, Scheme Name and Data Period are all required.' });
    }
    oldBrokerageOverrideService.removeRow(amc, scheme, period);
    return res.json({ success: true, message: `Deleted "${scheme}" (${period}).` });
  } catch (err) {
    logger.error('Old Brokerage Data delete failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to delete Old Brokerage Data row.' });
  }
}

/**
 * POST /api/old-brokerage/upload
 * "Commission Structure Upload" for the Old Brokerage Data page.
 * Body: multipart/form-data — field "file" (.xlsx/.xls).
 * Unlike the main page's upload, the AMC is NOT supplied separately — it's
 * read straight from the file's own AMC column (forward-filled), because
 * one file can legitimately carry several AMCs' data for a quarter.
 * Each row is upserted by (amc, scheme, period) — see
 * oldBrokerageOverrideService.bulkUpsert for why the period matters here:
 * the same scheme uploaded again under a NEW period is a new row, not an
 * overwrite of the old one.
 */
function uploadOldBrokerage(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded. Attach an .xlsx/.xls file under field name "file".' });
  }
  try {
    const selectedAmc = String(req.body.amc || '__all__').trim();
    const isAllAmcs = !selectedAmc || selectedAmc === '__all__';
    const defaultAmc = !isAllAmcs ? selectedAmc : null;
    const parsedRows = parseOldBrokerageExcel(req.file.buffer, defaultAmc);
    const normalizeAmc = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const selectedRows = isAllAmcs
      ? parsedRows
      : parsedRows.filter(row => normalizeAmc(row.amc) === normalizeAmc(selectedAmc));

    if (!selectedRows.length) {
      return res.status(400).json({
        success: false,
        message: `No rows for AMC "${selectedAmc}" were found in the uploaded file. No data was changed.`,
      });
    }
    const rows = selectedRows.filter(row => oldBrokerageService.hasAllowedArn(row.arn));
    const skipped = selectedRows.length - rows.length;
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: 'No rows matched the supported ARN numbers: 280532, 50111, 1182, 1183, 1184, 117196, 13025. No data was changed.',
      });
    }
    const { added, updated } = oldBrokerageOverrideService.bulkUpsert(rows, req.file.originalname);

    logger.info('Old Brokerage Data upload applied', { filename: req.file.originalname, amc: isAllAmcs ? 'all' : selectedAmc, added, updated });
    res.json({
      success: true,
      message: `Loaded ${rows.length} row(s) for ${isAllAmcs ? 'all AMCs' : selectedAmc} from "${req.file.originalname}" — ${added} new date-period record(s) added, ${updated} existing one(s) refreshed.`,
      added,
      updated,
      total: rows.length,
      skipped,
    });
  } catch (err) {
    logger.error('Old Brokerage Data upload failed', { error: err.message });
    res.status(400).json({ success: false, message: err.message || 'Failed to parse uploaded file.' });
  }
}

/**
 * GET /api/old-brokerage/demo-download
 * Generates (on the fly) a sample "Old Brokerage Data Upload" template so
 * admins can see the expected column layout. Deliberately includes the
 * SAME scheme name appearing under TWO different "Data Period" values, to
 * show exactly how to encode multiple quarters for one scheme (each
 * period is its own row — see the module doc-comment in
 * oldBrokerageOverrideService.js).
 */
function downloadOldBrokerageDemoFile(req, res) {
  try {
    const fs = require('fs');
    const path = require('path');
    const primaryPath = path.join(__dirname, '..', 'data', 'demo', 'Old_Brokerage_Data_Consolidated_UPDATED (3).xlsx');
    let filePath = primaryPath;
    if (!fs.existsSync(filePath)) {
      const demoDir = path.join(__dirname, '..', 'data', 'demo');
      if (fs.existsSync(demoDir)) {
        const files = fs.readdirSync(demoDir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
        const matched = files.find(f => f.toLowerCase().includes('old_brokerage_data_consolidated')) || files[0];
        if (matched) filePath = path.join(demoDir, matched);
      }
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Demo file not found.' });
    }
    const fileName = path.basename(filePath);
    return res.download(filePath, fileName, (err) => {
      if (err && !res.headersSent) {
        logger.error('Old Brokerage Data demo file download failed', { error: err.message });
      }
    });
  } catch (err) {
    logger.error('Old Brokerage Data demo file download failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to download demo file.' });
  }
}

module.exports = {
  getOldBrokerage,
  updateOldBrokerage,
  deleteOldBrokerage,
  uploadOldBrokerage,
  downloadOldBrokerageDemoFile,
  computeOldBrokerageTable,
  getOldBrokerageManualSync,
};