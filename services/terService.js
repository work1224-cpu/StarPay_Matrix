/**
 * services/terService.js - COMPLETE UPDATED VERSION
 * Fixed header detection to properly handle header rows appearing in the middle of data
 */

const axios = require('axios');
const config = require('../config/app');
const logger = require('../helpers/logger');
const {
  logMissingKnownAMCs,
  getKotakSchemesFromBrokerage,
  getForcedYearValues,
  latestSchemeRows,
  parseTERHTML,
} = require('./terParser');

const AMFI_ORIGIN = 'https://www.amfiindia.com';
// AMFI currently caps this endpoint at 100 rows even when a larger value is
// requested. Request its supported size and always honour meta.pageCount.
const DEFAULT_PAGE_SIZE = 100;
const FINANCIAL_YEAR_COUNT = 6;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const amfiClient = axios.create({
  timeout: config.request.timeout || 30000,
  headers: {
    ...config.request.headers,
    'Referer': 'https://www.amfiindia.com/ter-of-mf-schemes',
    'Origin': 'https://www.amfiindia.com',
    'Accept': 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  },
  withCredentials: true,
  maxRedirects: 5,
});

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await amfiClient.get(url, options);
      return response.data;
    } catch (err) {
      const isLastAttempt = attempt === retries;
      const status = err.response?.status || err.code || 'unknown';
      
      if (status === 404 || status === 400) {
        throw err;
      }
      
      if (!isLastAttempt) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`AMFI request failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`, { 
          url, 
          status,
          message: err.message 
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        logger.error(`AMFI request failed after ${retries} attempts`, { url, status, message: err.message });
        throw err;
      }
    }
  }
}

async function fetchTERPage() {
  logger.info('Fetching AMFI TER page...', { url: config.amfi.terUrl });
  return fetchWithRetry(config.amfi.terUrl, {
    responseType: 'text',
    headers: {
      ...config.request.headers,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
}

async function fetchAMFIJson(path, options = {}) {
  const url = new URL(path, AMFI_ORIGIN).toString();
  logger.debug('Fetching AMFI JSON', { url });
  return fetchWithRetry(url, {
    ...options,
    headers: {
      ...config.request.headers,
      Accept: 'application/json,text/plain,*/*',
      Referer: config.amfi.terUrl,
    },
  });
}

function getCurrentFinancialYear() {
  const now = new Date();
  const calendarYear = now.getFullYear();
  const month = now.getMonth() + 1;
  const startYear = month >= 4 ? calendarYear : calendarYear - 1;
  return `${startYear}-${startYear + 1}`;
}

function getFinancialYears(count = FINANCIAL_YEAR_COUNT) {
  const [currentStart] = getCurrentFinancialYear().split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const start = currentStart - i;
    return `${start}-${start + 1}`;
  });
}

async function getTERMonths(year = getCurrentFinancialYear()) {
  try {
    const months = await fetchAMFIJson(`/api/populate-ter-month?year=${encodeURIComponent(year)}`);
    if (!Array.isArray(months)) return [];
    return months
      .filter(month => month && month.MonthNumber && month.MonthYear)
      .map(month => ({
        label: month.MonthYear,
        value: month.MonthNumber,
      }));
  } catch (err) {
    logger.warn('Failed to fetch TER months', { year, message: err.message });
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, i) => {
      const m = currentMonth - i;
      const monthNum = m > 0 ? m : m + 12;
      const yearNum = m > 0 ? currentYear : currentYear - 1;
      return {
        label: `${new Date(yearNum, monthNum - 1).toLocaleString('default', { month: 'long' })} ${yearNum}`,
        value: monthNum,
      };
    });
  }
}

async function fetchLatestTERMonth(year = getCurrentFinancialYear()) {
  const months = await getTERMonths(year);
  if (!Array.isArray(months) || months.length === 0) {
    throw new Error('AMFI TER month API returned no months');
  }
  return months[0].value;
}

async function fetchAMCMap() {
  try {
    const html = await fetchTERPage();
    const map = new Map();
    const patterns = [
      /\\"mfId\\":\\"(\d+)\\",\\"mfName\\":\\"([^\\]+)\\"/g,
      /"mfId":"(\d+)","mfName":"([^"]+)"/g,
      /mfId:(\d+),mfName:"([^"]+)"/g,
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const id = String(match[1]);
        const name = match[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
        if (!map.has(id)) {
          map.set(id, name);
        }
      }
    }
    
    logger.info(`Found ${map.size} AMCs from page`);
    return map;
  } catch (err) {
    logger.warn('Failed to fetch AMC map', { message: err.message });
    return new Map();
  }
}

async function fetchTERDataPage(month, page, pageSize) {
  const query = new URLSearchParams({
    MF_ID: 'All',
    Month: month,
    strCat: '-1',
    strType: '-1',
    page: String(page),
    pageSize: String(pageSize),
  });
  return fetchAMFIJson(`/api/populate-te-rdata-revised?${query.toString()}`);
}

async function fetchTERRows(month) {
  const firstPage = await fetchTERDataPage(month, 1, DEFAULT_PAGE_SIZE);
  const rows = Array.isArray(firstPage.data) ? firstPage.data : [];
  const meta = firstPage.meta || {};
  const total = parseInt(meta.total, 10);
  // Do not calculate this only from our requested page size: AMFI may cap it
  // server-side (currently at 100), which previously caused us to fetch only
  // two pages out of the full 96-page result.
  const reportedPageCount = parseInt(meta.pageCount, 10);
  const pageCount = Number.isFinite(reportedPageCount) && reportedPageCount > 0
    ? reportedPageCount
    : total ? Math.ceil(total / (rows.length || DEFAULT_PAGE_SIZE)) : 1;

  logger.info(`Fetching TER data: ${total || rows.length} total rows, ${pageCount} pages`);

  const failedPages = [];

  for (let page = 2; page <= pageCount; page++) {
    let pageRows = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const nextPage = await fetchTERDataPage(month, page, DEFAULT_PAGE_SIZE);
        if (Array.isArray(nextPage.data)) {
          pageRows = nextPage.data;
        }
        break;
      } catch (err) {
        logger.warn(`Failed to fetch page ${page}/${pageCount} (attempt ${attempt}/${MAX_RETRIES})`, { message: err.message });
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        }
      }
    }

    if (pageRows) {
      rows.push(...pageRows);
      logger.debug(`Fetched page ${page}/${pageCount}, total rows: ${rows.length}`);
    } else {
      failedPages.push(page);
      logger.error(`Page ${page}/${pageCount} could not be fetched after ${MAX_RETRIES} attempts — some schemes will be missing from this refresh`);
    }

    if (page < pageCount) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (failedPages.length) {
    logger.error('TER fetch incomplete — some pages permanently failed', { failedPages, pageCount });
  }

  logger.info(`Total TER rows fetched: ${rows.length}`);
  return rows;
}


/**
 * Main function: fetch TER data from AMFI
 */
async function getTERData(options = {}) {
  try {
    const year = options.year || getCurrentFinancialYear();
    const month = options.month || await fetchLatestTERMonth(year);
    logger.info('Fetching AMFI TER API data...', { year, month });
    
    const amcMap = await fetchAMCMap();
    const rows = await fetchTERRows(month);
    
    if (!rows || rows.length === 0) {
      throw new Error('No data from API');
    }
    
    let schemes = latestSchemeRows(rows, amcMap);

    // Check if Kotak is missing from API response
    const hasKotak = schemes.some(s => s.amc && s.amc.toLowerCase().includes('kotak'));
    if (!hasKotak) {
      logger.warn('Kotak schemes missing from AMFI API - adding from brokerage data as fallback');
      const kotakFromBrokerage = getKotakSchemesFromBrokerage();
      if (kotakFromBrokerage.length > 0) {
        schemes = schemes.concat(kotakFromBrokerage);
        logger.info(`Added ${kotakFromBrokerage.length} Kotak schemes from brokerage data`);
      } else {
        logger.warn('No Kotak schemes found in brokerage data either');
      }
    }

    logger.info(`Parsed ${schemes.length} schemes`);
    logMissingKnownAMCs(schemes);
    
    return schemes.map(scheme => ({
      ...scheme,
      terYear: year,
      terMonth: month,
    }));
  } catch (err) {
    logger.warn('API failed - falling back to HTML parser', { message: err.message });
    
    try {
      const html = await fetchTERPage();
      let schemes = parseTERHTML(html);
      
      // Check if Kotak is missing from HTML parse too
      const hasKotak = schemes.some(s => s.amc && s.amc.toLowerCase().includes('kotak'));
      if (!hasKotak && schemes.length > 0) {
        logger.warn('Kotak schemes missing from HTML parse - adding from brokerage data');
        const kotakFromBrokerage = getKotakSchemesFromBrokerage();
        if (kotakFromBrokerage.length > 0) {
          schemes = schemes.concat(kotakFromBrokerage);
          logger.info(`Added ${kotakFromBrokerage.length} Kotak schemes from brokerage data`);
        }
      }
      
      if (schemes.length === 0) {
        // Return brokerage data as last resort
        const kotakFromBrokerage = getKotakSchemesFromBrokerage();
        if (kotakFromBrokerage.length > 0) {
          logger.info(`Returning ${kotakFromBrokerage.length} Kotak schemes from brokerage data as fallback`);
          return kotakFromBrokerage;
        }
        return [];
      }
      return schemes;
    } catch (htmlErr) {
      logger.error('Both API and HTML parsing failed');
      // Return brokerage data as last resort
      const kotakFromBrokerage = getKotakSchemesFromBrokerage();
      if (kotakFromBrokerage.length > 0) {
        logger.info(`Returning ${kotakFromBrokerage.length} Kotak schemes from brokerage data as last resort`);
        return kotakFromBrokerage;
      }
      return [];
    }
  }
}

module.exports = {
  getTERData,
  getTERMonths,
  getFinancialYears,
  getCurrentFinancialYear,
  getForcedYearValues,
};
