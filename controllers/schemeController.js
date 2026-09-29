/**
 * controllers/schemeController.js
 *
 * Scheme/TER data endpoints — /api/schemes, /api/amcs, /api/categories,
 * /api/types, /api/status, /api/dashboard, /api/periods, /api/months,
 * /api/refresh, /api/sync/*, /api/schemes/update.
 *
 * KEY DESIGN: /api/schemes does NO filtering — returns ALL schemes.
 * All filtering (amc, category, type, search, nsdl, amfi) is done
 * client-side in JS for instant response. Server only handles
 * year/month period changes which require a fresh AMFI fetch.
 *
 * (Split out of the former monolithic controllers/apiController.js.)
 */

const cacheService = require('../services/cacheService');
const { refreshData, getSchemesForPeriod } = require('../services/dataService');
const { getFinancialYears, getTERMonths, getCurrentFinancialYear } = require('../services/terService');
const { getConfiguredAmcs } = require('../services/amcDocumentService');
const logger = require('../helpers/logger');
const launchDateService = require('../services/launchDateService');
const launchDateOverrideService = require('../services/launchDateOverrideService');
const oldBrokerageService = require('../services/oldBrokerageService');
const oldBrokerageOverrideService = require('../services/oldBrokerageOverrideService');
const syncService = require('../services/syncService');

/**
 * Calculate Commission to BER Ratio
 */
function calcRatio(commission, ber) {
  if (commission === null || commission === undefined || ber === null || ber === undefined || ber === 0) return null;
  return commission / ber;
}

/**
 * Slim down each scheme to only what the UI needs — cuts payload ~60%
 * Also calculates C/B (Commission to BER) ratios on the fly
 *
 * schemeArnMap: Map of normalized scheme name -> { period, arn } — that
 * scheme's OWN true latest distributor-commission validity window, since
 * different schemes (even within the same AMC) can change on different
 * dates. Falls back to '' when this scheme has no old-brokerage record.
 */
const commissionOverrideService = require('../services/commissionOverrideService');

/**
 * slimScheme
 *
 * schemeArnMap: Map of normalized scheme name -> { period, arn, year1..
 * year6Onward } — that scheme's OWN true latest distributor-commission
 * validity window and commission percentages, since different schemes
 * (even within the same AMC) can change on different dates. Falls back to
 * '' / null when this scheme has no old-brokerage record.
 *
 * Commission Year 1-6 values: a manual "Commission Structure Upload"
 * (commissionOverrideService) always wins when a LIVE override currently
 * exists for this scheme, since that is a deliberate, reviewed action by
 * an admin/data-operator. This is checked directly against
 * commissionOverrideService rather than trusting s.year1/s.c1 on the
 * cached scheme object, because that object can carry stale values level
 * left over from an earlier server run/upload that has since been
 * superseded or cleared — trusting it blindly would let old data outlive
 * the override that produced it. When no live manual override exists, the
 * scheme's Year 1-6 and C/B values are filled in automatically from the
 * Old Brokerage Data archive — the same source that already powers the
 * ARN No. / Date Period columns.
 */
function slimScheme(s, i, schemeArnMap) {
  const ber = s.regularBER;
  const brokerageInfo = schemeArnMap ? schemeArnMap.get(oldBrokerageService.normSchemeName(s.schemeName)) : null;
  const liveOverride = commissionOverrideService.get(s.schemeName);

  const pick = (manualVal, autoVal) => (manualVal !== undefined && manualVal !== null) ? manualVal : (autoVal !== undefined && autoVal !== null ? autoVal : null);

  const year1      = pick(liveOverride && liveOverride.year1,      brokerageInfo && brokerageInfo.year1);
  const year2      = pick(liveOverride && liveOverride.year2,      brokerageInfo && brokerageInfo.year2);
  const year3      = pick(liveOverride && liveOverride.year3,      brokerageInfo && brokerageInfo.year3);
  const year4      = pick(liveOverride && liveOverride.year4,      brokerageInfo && brokerageInfo.year4);
  const yearOnward = pick(liveOverride && liveOverride.yearOnward, brokerageInfo && brokerageInfo.yearOnward);
  const year6Onward= pick(liveOverride && liveOverride.year6Onward,brokerageInfo && brokerageInfo.year6Onward);

  return {
    srNo: i + 1,
    nsdlCode: s.nsdlCode,
    amfiCode: s.amfiCode,
    schemeName: s.schemeName,
    launchDate: s.launchDate,
    amc: s.amc,
    schemeType: s.schemeType,
    schemeCategory: s.schemeCategory,
    regularBER: s.regularBER,
    terDiff: s.terDiff,
    berDiff: s.berDiff,
    brokeragePeriod: brokerageInfo ? brokerageInfo.period : '',
    brokerageArn: brokerageInfo ? brokerageInfo.arn : '',
    year1,
    year2,
    year3,
    year4,
    yearOnward,
    year6Onward,
    c1: calcRatio(year1, ber),
    c2: calcRatio(year2, ber),
    c3: calcRatio(year3, ber),
    c4: calcRatio(year4, ber),
    c5: calcRatio(yearOnward, ber),
    c6: calcRatio(year6Onward, ber),
  };
}

/**
 * Computes the exact array the Home page table shows — every scheme,
 * slimmed and enriched with its ARN No. / Date Period and Year 1-6
 * commission % / C-B ratios. Shared by GET /api/schemes and by the
 * "Save Sync" snapshot (services/syncService.js), so a saved snapshot is
 * always byte-for-byte what an operator was looking at on screen.
 */
function computeHomeTable() {
  const schemes = cacheService.getSchemes();
  const schemeArnMap = oldBrokerageService.getLatestPeriodByScheme();
  return schemes.map((s, i) => slimScheme(s, i, schemeArnMap));
}

async function getSchemes(req, res) {
  try {
    const schemes = cacheService.getSchemes();

    // If cache is totally empty, tell client to retry
    if (schemes.length === 0) {
      const status = cacheService.getStatus();
      return res.status(503).json({
        success: false,
        message: status.status === 'loading'
          ? 'Data is loading, please retry in 30 seconds'
          : status.error || 'Data not available — try refreshing',
        status: status.status,
        retryAfter: 30,
      });
    }

    const { year, month } = req.query;
    let data          = schemes;
    let lastRefreshed = cacheService.getStatus().lastRefreshed;

    // Only hit AMFI when a specific period is requested
    if (year || month) {
      const selectedYear  = year  || getCurrentFinancialYear();
      const selectedMonth = month || (await getTERMonths(selectedYear))[0]?.value;

      if (!selectedMonth) {
        return res.status(404).json({
          success: false,
          message: 'No TER months found for this financial year',
        });
      }

      const periodData  = await getSchemesForPeriod(selectedYear, selectedMonth);
      data          = periodData.schemes;
      lastRefreshed = periodData.lastRefreshed;
      var isStale        = periodData.stale || false;
      var staleReason     = periodData.staleReason || null;
    }

    // Send slimmed payload with C/B ratios
    const schemeArnMap = oldBrokerageService.getLatestPeriodByScheme();
    res.json({
      success:       true,
      total:         data.length,
      lastRefreshed,
      stale:         typeof isStale !== 'undefined' ? isStale : false,
      staleReason:   typeof staleReason !== 'undefined' ? staleReason : null,
      data:          data.map((s, i) => slimScheme(s, i, schemeArnMap)),
    });

  } catch (err) {
    logger.error('Error in getSchemes', { error: err.message });
    res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
}

function getPeriods(req, res) {
  res.json({ success: true, data: getFinancialYears() });
}

async function getMonths(req, res) {
  try {
    const year   = req.query.year || getCurrentFinancialYear();
    const months = await getTERMonths(year);
    res.json({ success: true, year, data: months });
  } catch (err) {
    logger.error('Error in getMonths', { error: err.message });
    res.status(500).json({ success: false, message: 'Unable to load months' });
  }
}

function getAMCs(req, res) {
  const amcs = getConfiguredAmcs();
  logger.info('AMCs returned from catalog', { count: amcs.length });
  res.json({ success: true, data: amcs });
}

function getCategories(req, res) {
  res.json({ success: true, data: cacheService.getCategories() });
}

function getTypes(req, res) {
  res.json({ success: true, data: cacheService.getTypes() });
}

function getStatus(req, res) {
  const status = cacheService.getStatus();
  res.json({ success: true, ...status, totalSchemes: cacheService.getSchemes().length });
}

/**
 * POST /api/sync/save
 * Saves a known-good, operator-approved copy of BOTH the Home page table
 * and the "All Brokerage Data" (Old Brokerage Data) page table, into the
 * app's shared SQLite database (services/syncService.js). Intentionally
 * separate from the automatic in-memory cache written after every AMFI
 * scrape — this only ever changes when an operator deliberately presses
 * the button.
 */
async function saveManualSync(req, res) {
  try {
    const homeSchemes = computeHomeTable();
    // Required lazily (not at module top) to avoid a require-cycle, since
    // oldBrokerageController does not itself depend on schemeController but
    // both are wired independently from routes/api.js.
    const { computeOldBrokerageTable } = require('./oldBrokerageController');
    const oldBrokerageRows = computeOldBrokerageTable();
    const lastRefreshed = cacheService.getStatus().lastRefreshed;
    const savedBy = (req.user && req.user.username) || null;

    if (!homeSchemes.length) {
      return res.status(400).json({ success: false, message: 'There is no current data available to save.' });
    }

    const result = syncService.saveSnapshot({ homeSchemes, oldBrokerageRows, lastRefreshed, savedBy });
    return res.json({
      success: true,
      count: result.homeSchemeCount,
      oldBrokerageCount: result.oldBrokerageCount,
      savedAt: result.savedAt,
    });
  } catch (err) {
    logger.error('Save Sync failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to save the sync copy.' });
  }
}

/**
 * GET /api/sync/old
 * Returns the last manually saved copy of the Home page table, in exactly
 * the same compact shape as /api/schemes, so the existing filters/table
 * continue to work unchanged.
 */
function getManualSync(req, res) {
  const snapshot = syncService.getHomeSnapshot();
  if (!snapshot) {
    return res.status(404).json({ success: false, message: 'No saved sync copy is available yet.' });
  }

  return res.json({
    success: true,
    total: snapshot.rows.length,
    lastRefreshed: snapshot.meta.lastRefreshed,
    savedAt: snapshot.meta.savedAt,
    stale: true,
    staleReason: 'Showing the manually saved sync copy.',
    data: snapshot.rows,
  });
}

function getDashboard(req, res) {
  const schemes  = cacheService.getSchemes();
  const matched  = schemes.filter(s => s.amfiCode).length;
  const terDiffs = schemes.map(s => s.terDiff).filter(v => typeof v === 'number' && isFinite(v));
  res.json({
    success: true,
    ...cacheService.getStatus(),
    totalSchemes:    schemes.length,
    matchedSchemes:  matched,
    unmatchedSchemes: schemes.length - matched,
    amcCount:        getConfiguredAmcs().length,
    categoryCount:   cacheService.getCategories().length,
    typeCount:       cacheService.getTypes().length,
    averageTerDiff:  terDiffs.length
      ? Math.round(terDiffs.reduce((s, v) => s + v, 0) / terDiffs.length * 100) / 100
      : null,
  });
}

async function triggerRefresh(req, res) {
  logger.info('Manual refresh triggered');
  res.json({ success: true, message: 'Refresh started' });
  refreshData().catch(err => logger.error('Manual refresh error', { error: err.message }));
}

function clearOldBrokerageData(req, res) {
  try {
    const oldBrokerageRows = oldBrokerageService.getAll();
    const oldBrokerageResult = oldBrokerageOverrideService.clearAll(oldBrokerageRows);
    const result = cacheService.clearBrokerageData();
    syncService.clearSnapshot();
    return res.json({
      success: true,
      message: 'Old brokerage data cleared from Home and Old Brokerage tables.',
      ...result,
      oldBrokerageCount: oldBrokerageResult.removed,
    });
  } catch (err) {
    logger.error('Failed to clear old brokerage data', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to clear old brokerage data.' });
  }
}

function updateScheme(req, res) {
  try {
    const { schemeName, amc, nsdlCode, amfiCode, values } = req.body || {};

    if (values && values.launchDate !== undefined && values.launchDate !== null && values.launchDate !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.launchDate).trim())) {
        return res.status(400).json({ success: false, message: 'Launch date must be in YYYY-MM-DD format.' });
      }
    }

    const result = cacheService.updateSchemeValues({ schemeName, amc, nsdlCode, amfiCode, values });
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    logger.error('Scheme update failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to update scheme.' });
  }
}

function uploadLaunchDates(req, res) {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No launch-date Excel file uploaded.' });
  }
  try {
    const imported = launchDateService.parseLaunchDateWorkbook(req.file.buffer);
    const entries = [...imported.entries()].map(([schemeName, launchDate]) => ({ schemeName, launchDate }));
    const count = launchDateOverrideService.setMany(entries);
    cacheService.applyLaunchDateOverrides((schemeName) => launchDateOverrideService.get(schemeName));
    const matched = cacheService.getSchemes().filter((scheme) => launchDateOverrideService.get(scheme.schemeName)).length;
    return res.json({
      success: true,
      count,
      matched,
      message: `Imported ${count} launch dates. Applied immediately to ${matched} schemes in the current cache.`,
    });
  } catch (err) {
    logger.error('Launch date upload failed', { error: err.message });
    return res.status(400).json({ success: false, message: err.message || 'Failed to parse launch-date workbook.' });
  }
}

module.exports = {
  calcRatio,
  slimScheme,
  getSchemes,
  getPeriods,
  getMonths,
  getAMCs,
  getCategories,
  getTypes,
  getStatus,
  saveManualSync,
  getManualSync,
  getDashboard,
  triggerRefresh,
  clearOldBrokerageData,
  updateScheme,
  uploadLaunchDates,
};
