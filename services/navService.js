/**
 * services/navService.js
 * Fetches and parses NAVAll.txt from AMFI portal.
 *
 * Format of NAVAll.txt:
 *   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 * AMC header lines look like: "Open Ended Schemes( Debt Schemes )"
 */

const axios = require('axios');
const config = require('../config/app');
const logger = require('../helpers/logger');

/**
 * Fetch NAVAll.txt content as plain text.
 */
async function fetchNAVText() {
  logger.info('Fetching AMFI NAVAll.txt...', { url: config.amfi.navUrl });
  const response = await axios.get(config.amfi.navUrl, {
    timeout: config.request.timeout,
    headers: { ...config.request.headers, Accept: 'text/plain' },
    responseType: 'text',
  });
  return response.data;
}

/**
 * Parse NAVAll.txt into structured objects.
 * @param {string} text
 * @returns {Map<string, Object>}  key = amfiCode
 */
function parseNAVText(text) {
  const navMap = new Map(); // amfiCode → record
  const lines = text.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('Scheme Code')) continue;

    // Header/separator lines contain no semicolons or fewer than 5 fields
    const parts = line.split(';');
    if (parts.length < 5) continue;

    const [schemeCode, isin1, isin2, schemeName, nav, navDate] = parts;

    const code = (schemeCode || '').trim();
    if (!code || isNaN(parseInt(code))) continue; // Skip non-numeric codes (headers)

    navMap.set(code, {
      amfiCode:   code,
      isin:       (isin1 || isin2 || '').trim(),
      isin2:      (isin2 || '').trim(),
      schemeName: (schemeName || '').trim(),
      nav:        parseFloat(nav) || null,
      navDate:    (navDate || '').trim(),
    });
  }

  logger.info(`Parsed ${navMap.size} NAV entries`);
  return navMap;
}

/**
 * Main export: fetch + parse NAV data
 */
async function getNAVData() {
  try {
    const text = await fetchNAVText();
    return parseNAVText(text);
  } catch (err) {
    logger.error('Failed to fetch/parse NAV data', { message: err.message });
    throw err;
  }
}

module.exports = { getNAVData };
