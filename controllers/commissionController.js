/**
 * controllers/commissionController.js
 *
 * Commission Structure Upload endpoints for the MAIN StarPay Matrix table
 * — /api/upload/commission, /api/upload/brokerage-matrix,
 * /api/download/demo-commission-file.
 * (Split out of the former monolithic controllers/apiController.js.)
 */

const path = require('path');
const fs = require('fs');
const cacheService = require('../services/cacheService');
const { parseCommissionExcel } = require('../services/excelUploadService');
const commissionOverrideService = require('../services/commissionOverrideService');
const { canonicalizeAMC } = require('../helpers/normalizer');
const logger = require('../helpers/logger');

/**
 * POST /api/upload/commission
 * "Commission Structure Upload" — Scheme Name + Year 1/2/3/4/5-Onward
 * columns for ONE AMC (AMC name supplied separately in the form, not
 * read from the file). Updates only that AMC's commission data —
 * every other AMC's data is left untouched.
 * Body: multipart/form-data — fields "amc" (text) + "file"
 */
function uploadCommission(req, res) {
  const amc = (req.body && req.body.amc || '').trim();
  const isAllAmcs = !amc || amc === '__all__';
  if (!isAllAmcs && !amc) {
    return res.status(400).json({ success: false, message: 'Please select/enter the AMC name this file belongs to.' });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded. Attach an .xlsx/.xls file under field name "file".' });
  }
  try {
    const rows = parseCommissionExcel(req.file.buffer);
    const scopeLabel = isAllAmcs ? '__all__' : amc;
    const rowsWithScope = rows.map(r => ({ ...r, amc: scopeLabel }));
    const added = commissionOverrideService.setForAMC(scopeLabel, rowsWithScope, req.file.originalname);

    // Re-stamp Year 1-4/Onward on every matching scheme already in the cache.
    // For an "All AMCs" upload, ignore AMC scoping and apply by scheme name across the whole matrix.
    const existing = cacheService.getSchemes();
    let applied = 0;
    const updated = existing.map(s => {
      const forced = commissionOverrideService.get(s.schemeName);
      if (!forced) return s;
      if (!isAllAmcs && canonicalizeAMC(s.amc) !== canonicalizeAMC(amc)) return s;
      applied++;
      const ber = s.regularBER;
      const calcRatio = (commission, ber) => {
        if (commission === null || commission === undefined || ber === null || ber === undefined || ber === 0) return null;
        return commission / ber;
      };
      return {
        ...s,
        year1:      forced.year1 !== undefined ? forced.year1 : null,
        year2:      forced.year2 !== undefined ? forced.year2 : null,
        year3:      forced.year3 !== undefined ? forced.year3 : null,
        year4:      forced.year4 !== undefined ? forced.year4 : null,
        yearOnward: forced.yearOnward !== undefined ? forced.yearOnward : null,
        year6Onward: forced.year6Onward !== undefined ? forced.year6Onward : null,
        c1: calcRatio(forced.year1, ber),
        c2: calcRatio(forced.year2, ber),
        c3: calcRatio(forced.year3, ber),
        c4: calcRatio(forced.year4, ber),
        c5: calcRatio(forced.yearOnward, ber),
        c6: calcRatio(forced.year6Onward, ber),
      };
    });
    if (applied > 0) cacheService.setSchemes(updated);

    logger.info('Commission Structure upload applied', { amc: scopeLabel, filename: req.file.originalname, count: added, isAllAmcs });
    res.json({
      success: true,
      message: `Loaded Year 1-4/Onward commission data for ${added} "${scopeLabel === '__all__' ? 'All AMCs' : amc}" schemes from "${req.file.originalname}". ${applied ? `Applied immediately to ${applied} matching schemes already on screen.` : 'It will apply automatically once this AMC\'s scheme data is loaded (via AMFI).'}`,
      count: added,
    });
  } catch (err) {
    logger.error('Commission Structure upload failed', { amc, error: err.message });
    res.status(400).json({ success: false, message: err.message || 'Failed to parse uploaded file.' });
  }
}

/**
 * POST /api/upload/brokerage-matrix
 *
 * "Old Brokerage Data" format upload for the MAIN StarPay Matrix table.
 * Same Excel shape as the Old Brokerage Data page's "Commission Structure
 * Upload" (AMC, Data Period (Validity), Scheme Name, ARN No., Category,
 * 1st-6th Year %) — but unlike that page, this one is multi-AMC in a
 * single file, and the same firm legitimately has several ARNs × several
 * Data Periods stacked in the sheet.
 *
 * For each AMC found in the file we:
 *   1. take its MOST RECENT Data Period only (older quarters in the same
 *      file are ignored for this purpose — the main table always reflects
 *      "what's current"),
 *   2. take ONE ARN's rows for that AMC+period (different ARNs under the
 *      same AMC+period carry the same commission structure, so any one is
 *      representative — we pick whichever ARN has the most scheme rows),
 *   3. re-stamp Year 1-4/5th/6th-Onward on that AMC's schemes only.
 *
 * Every other AMC already on the table — including ones simply absent
 * from this file — is left completely untouched.
 * Body: multipart/form-data — field "file" only (no AMC needed; it's
 * read straight from the sheet).
 */
function uploadBrokerageMatrix(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded. Attach an .xlsx/.xls file under field name "file".' });
  }
  try {
    const { parseOldBrokerageExcel, pickLatestPerAMC } = require('../services/Oldbrokerageuploadservice');
    const parsedRows = parseOldBrokerageExcel(req.file.buffer);
    const perAmc = pickLatestPerAMC(parsedRows);

    const summary = [];
    const updatedAmcCanonicals = new Set();

    for (const { amc, period, arn, rows } of perAmc.values()) {
      if (!rows.length) continue;
      const added = commissionOverrideService.setForAMC(amc, rows.map(r => ({ ...r, amc })), req.file.originalname);
      updatedAmcCanonicals.add(canonicalizeAMC(amc) || amc);
      summary.push({ amc, period, arn: arn || '(no ARN in sheet)', schemeCount: added });
    }

    // Re-stamp Year 1-4/5th/6th-Onward on every scheme of the AMCs we just
    // touched — every other AMC's rows pass through unchanged.
    const existing = cacheService.getSchemes();
    let applied = 0;
    const updated = existing.map(s => {
      const schemeAmcCanonical = canonicalizeAMC(s.amc) || s.amc;
      if (!updatedAmcCanonicals.has(schemeAmcCanonical)) return s;
      const forced = commissionOverrideService.get(s.schemeName);
      if (!forced) return s;
      applied++;
      const ber = s.regularBER;
      const calcRatio = (commission, berVal) => {
        if (commission === null || commission === undefined || berVal === null || berVal === undefined || berVal === 0) return null;
        return commission / berVal;
      };
      return {
        ...s,
        year1:       forced.year1 !== undefined ? forced.year1 : null,
        year2:       forced.year2 !== undefined ? forced.year2 : null,
        year3:       forced.year3 !== undefined ? forced.year3 : null,
        year4:       forced.year4 !== undefined ? forced.year4 : null,
        yearOnward:  forced.yearOnward !== undefined ? forced.yearOnward : null,
        year6Onward: forced.year6Onward !== undefined ? forced.year6Onward : null,
        c1: calcRatio(forced.year1, ber),
        c2: calcRatio(forced.year2, ber),
        c3: calcRatio(forced.year3, ber),
        c4: calcRatio(forced.year4, ber),
        c5: calcRatio(forced.yearOnward, ber),
        c6: calcRatio(forced.year6Onward, ber),
      };
    });
    if (applied > 0) cacheService.setSchemes(updated);

    logger.info('Old Brokerage Data (multi-AMC) upload applied to main table', {
      filename: req.file.originalname,
      amcsUpdated: summary.length,
      schemesAppliedOnScreen: applied,
      summary,
    });
                                                                                                                                                                                                                                                              
    res.json({
      success: true,
      message: `Updated ${summary.length} AMC${summary.length === 1 ? '' : 's'} from "${req.file.originalname}" — each using its latest Data Period. ${applied ? `Applied immediately to ${applied} matching schemes already on screen.` : 'Values will apply automatically once matching schemes are loaded (via AMFI).'} Every other AMC's data is unchanged.`,
      amcsUpdated: summary.length,
      appliedToSchemes: applied,
      details: summary,
    });
  } catch (err) {
    logger.error('Old Brokerage Data (multi-AMC) upload failed', { error: err.message });
    res.status(400).json({ success: false, message: err.message || 'Failed to parse uploaded file.' });
  }
}

/**
 * GET /api/download/demo-commission-file
 * Serves the sample "Mutual Fund Brokerage Consolidated" Excel file that
 * shows admins the expected format for Commission Structure Upload.
 * Admin-only (see routes/api.js requireAuth('admin')).
 */
function downloadDemoCommissionFile(req, res) {
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
    logger.error('Demo commission file missing on disk', { filePath });
    return res.status(404).json({ success: false, message: 'Demo file not found on server.' });
  }

  const fileName = path.basename(filePath);
  res.download(filePath, fileName, (err) => {
    if (err && !res.headersSent) {
      logger.error('Demo file download failed', { error: err.message });
    }
  });
}

module.exports = {
  uploadCommission,
  uploadBrokerageMatrix,
  downloadDemoCommissionFile,
};
