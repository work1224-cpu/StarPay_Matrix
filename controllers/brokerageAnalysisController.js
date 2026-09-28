/**
 * controllers/brokerageAnalysisController.js
 *
 * Page + API for /brokerage-analysis — cross-year, cross-AMC, cross-category
 * comparison and analysis of every scheme's trail/brokerage commission
 * structure (drawn from the same dataset behind "All Brokerage Data").
 */

const logger = require('../helpers/logger');
const { getSessionUser } = require('../services/userService');
const { getConfiguredAmcs } = require('../services/amcDocumentService');
const {
  computeSummary,
  getFilterMeta,
  getSchemeHistory,
} = require('../services/brokerageAnalysisService');

/**
 * GET /brokerage-analysis
 */
function renderBrokerageAnalysis(req, res, next) {
  try {
    const meta = getFilterMeta();
    res.render('brokerage-analysis', {
      title: 'Brokerage Data Analysis',
      currentUser: getSessionUser(req),
      amcs: getConfiguredAmcs(),
      activeAmcSlug: null,
      baAmcs: meta.amcs,
      baCategories: meta.categories,
      baYears: meta.years,
      baTotalSchemes: meta.schemes.length,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/brokerage-analysis
 * Query params: amc, category, arn, year — all optional.
 */
function getAnalysisSummary(req, res) {
  try {
    const summary = computeSummary({
      amc: req.query.amc,
      category: req.query.category,
      arn: req.query.arn,
      year: req.query.year,
    });
    return res.json({ success: true, ...summary });
  } catch (err) {
    logger.error('Failed to compute brokerage analysis summary', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to compute analysis data.' });
  }
}

/**
 * GET /api/brokerage-analysis/meta
 * Filter dropdown options (AMCs, categories, years, scheme→AMC list for the
 * scheme-explorer search box).
 */
function getAnalysisMeta(req, res) {
  try {
    return res.json({ success: true, ...getFilterMeta() });
  } catch (err) {
    logger.error('Failed to load brokerage analysis meta', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to load filter options.' });
  }
}

/**
 * GET /api/brokerage-analysis/scheme?scheme=...&amc=...
 * One scheme's full period-by-period commission history, oldest first.
 */
function getAnalysisSchemeHistory(req, res) {
  try {
    const scheme = String(req.query.scheme || '').trim();
    if (!scheme) {
      return res.status(400).json({ success: false, message: 'A scheme name is required.' });
    }
    const history = getSchemeHistory(scheme, req.query.amc);
    return res.json({ success: true, scheme, amc: req.query.amc || null, history });
  } catch (err) {
    logger.error('Failed to load scheme brokerage history', { error: err.message });
    return res.status(500).json({ success: false, message: 'Unable to load scheme history.' });
  }
}

module.exports = {
  renderBrokerageAnalysis,
  getAnalysisSummary,
  getAnalysisMeta,
  getAnalysisSchemeHistory,
};
