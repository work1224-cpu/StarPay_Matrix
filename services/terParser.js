/**
 * services/terParser.js
 *
 * Pure parsing/normalization logic for AMFI TER data — turns raw API rows
 * or scraped HTML into this app's scheme shape. No HTTP calls live here;
 * see amfiClient fetch functions still in terService.js for that.
 * (Split out of the former monolithic terService.js.)
 */

const cheerio = require('cheerio');
const logger = require('../helpers/logger');
const { extractAMC, canonicalizeAMC } = require('../helpers/normalizer');
const commissionOverride = require('./commissionOverrideService');
const launchDateService = require('./launchDateService');
const launchDateOverride = require('./launchDateOverrideService');

// Load brokerage data for fallback
const brokerageData = require('./brokerageData.json');

function logMissingKnownAMCs(schemes) {
  try {
    const KNOWN_AMCS = require('./allAMCs.json') || [];
    const present = new Set(schemes.map(s => s.amc));
    const missing = KNOWN_AMCS.filter(amc => !present.has(amc));
    if (missing.length) {
      logger.warn('Known AMCs with ZERO schemes in this fetch (possible AMFI data gap)', { missing });
    }
  } catch (e) { /* allAMCs.json not present — nothing to check */ }
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    value = value.replace(/,/g, '').replace(/%/g, '').trim();
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function roundedDiff(a, b) {
  return a !== null && b !== null ? Math.round((a - b) * 100) / 100 : null;
}

function getFieldValue(row, fieldNames) {
  for (const field of fieldNames) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      return row[field];
    }
  }
  return null;
}

/** Manual admin correction (launchDateOverrideService) always wins over the
 *  automated reference-workbook lookup (launchDateService). */
function resolveLaunchDate(schemeName) {
  const override = launchDateOverride.get(schemeName);
  if (override) return override;
  return launchDateService.getLaunchDate(schemeName) || null;
}

/**
 * Get Kotak schemes from brokerage data as fallback when AMFI API doesn't return them
 */
function getKotakSchemesFromBrokerage() {
  try {
    const kotakSchemes = brokerageData
      .filter(item => item.amc && item.amc.toLowerCase().includes('kotak'))
      .map(item => ({
        nsdlCode: '',
        schemeName: item.scheme,
        schemeType: '',
        schemeCategory: item.category || '',
        amc: 'Kotak Mahindra Mutual Fund',
        regularTER: null,
        directTER: null,
        regularBER: null,
        directBER: null,
        terDiff: null,
        berDiff: null,
        year1: item.year1 !== undefined && item.year1 !== null ? parseFloat(item.year1) : null,
        year2: item.year2 !== undefined && item.year2 !== null ? parseFloat(item.year2) : null,
        year3: item.year3 !== undefined && item.year3 !== null ? parseFloat(item.year3) : null,
        year4: item.year4 !== undefined && item.year4 !== null ? parseFloat(item.year4) : null,
        yearOnward: item.yearOnward !== undefined && item.yearOnward !== null ? parseFloat(item.yearOnward) : null,
        year6Onward: item.yearOnward !== undefined && item.yearOnward !== null ? parseFloat(item.yearOnward) : null,
      }));
    
    logger.info(`Found ${kotakSchemes.length} Kotak schemes in brokerage data for fallback`);
    return kotakSchemes;
  } catch (err) {
    logger.warn('Failed to get Kotak schemes from brokerage data', { error: err.message });
    return [];
  }
}

/**
 * Ensures year6Onward is always populated.
 * If year6Onward is null/undefined, it uses yearOnward value.
 * If yearOnward is also null, it uses year4 value.
 */
function ensureYear6Onward(values) {
  if (!values) {
    return { year1: null, year2: null, year3: null, year4: null, yearOnward: null, year6Onward: null };
  }
  
  const result = { ...values };
  
  if ((result.year6Onward === null || result.year6Onward === undefined) && 
      result.yearOnward !== null && result.yearOnward !== undefined) {
    result.year6Onward = result.yearOnward;
  }
  
  if ((result.year6Onward === null || result.year6Onward === undefined) && 
      (result.yearOnward === null || result.yearOnward === undefined) &&
      result.year4 !== null && result.year4 !== undefined) {
    result.year6Onward = result.year4;
    result.yearOnward = result.year4;
  }
  
  return result;
}

function getForcedYearValues(schemeName) {
  if (!schemeName) return null;

  // Brokerage values must come only from an uploaded Excel override.
  const uploaded = commissionOverride.get(schemeName);
  if (uploaded) return ensureYear6Onward(uploaded);

  return null;
}

/**
 * Check if a row is a header row 
 * This handles "NSDL CODE II", "AMFI CODE II", "SCHEME NAME II" etc.
 */
function isHeaderRow(row) {
  // Get the scheme name field
  const schemeField = row.Scheme_Name || row.SCHEME_NAME || '';
  const nsdlField = row.NSDLSchemeCode || '';
  
  // CRITICAL: Check if NSDL field contains "NSDL CODE" or similar
  if (typeof nsdlField === 'string') {
    const lower = nsdlField.toLowerCase().trim();
    if (lower.includes('nsdl') || lower.includes('amfi') || lower.includes('code')) {
      return true;
    }
  }
  
  // Check scheme name field for header patterns
  if (typeof schemeField === 'string') {
    const lower = schemeField.toLowerCase().trim();
    // These are the exact header patterns from your image
    if (lower.includes('nsdl code')) return true;
    if (lower.includes('amfi code')) return true;
    if (lower.includes('scheme name')) return true;
    if (lower.includes('scheme type')) return true;
    if (lower.includes('ter diff')) return true;
    if (lower.includes('ber diff')) return true;
    if (lower.includes('1 yr')) return true;
    if (lower.includes('2 yr')) return true;
    if (lower.includes('3 yr')) return true;
    if (lower.includes('4 yr')) return true;
    if (lower.includes('5 yr')) return true;
    if (lower.includes('6 yr')) return true;
    
    // Check for "II" pattern (NSDL CODE II, AMFI CODE II)
    if (/^(nsdl|amfi|scheme)/i.test(lower) && lower.includes('ii')) {
      return true;
    }
  }
  
  return false;
}

function normalizeAPIRow(row, amcMap = new Map()) {
  // Skip header rows - THIS IS THE KEY FIX
  if (isHeaderRow(row)) {
    return null;
  }

  const regularTER = parseNumber(row.R_TER);
  const directTER = parseNumber(row.D_TER);
  const regularBER = parseNumber(getFieldValue(row, ['R_BER', 'R_BaseTER']));
  const directBER = parseNumber(getFieldValue(row, ['D_BER', 'D_BaseTER']));
  const schemeName = (row.Scheme_Name || row.SCHEME_NAME || '').trim();

  if (!schemeName || schemeName.length < 3) return null;
  if (/^NSDL|^AMFI|^SCHEME|^1\s*YR|^2\s*YR/i.test(schemeName)) return null;

  let amc = '';
  if (row.AMC) amc = String(row.AMC).trim();
  else if (row.MF_Name) amc = String(row.MF_Name).trim();
  else if (row.MF_ID && amcMap.has(String(row.MF_ID))) amc = amcMap.get(String(row.MF_ID));
  else amc = extractAMC(schemeName);

  let forcedYears = getForcedYearValues(schemeName);
  if (!forcedYears) forcedYears = {};
  forcedYears = ensureYear6Onward(forcedYears);

  return {
    nsdlCode: (row.NSDLSchemeCode || '').trim(),
    schemeName,
    schemeType: (row.SchemeType_Desc || '').trim(),
    schemeCategory: (row.SchemeCat_Desc || '').trim(),
    amc: canonicalizeAMC(amc),
    regularTER,
    directTER,
    regularBER,
    directBER,
    terDiff: roundedDiff(regularTER, directTER),
    berDiff: roundedDiff(regularBER, directBER),
    year1: forcedYears.year1 !== undefined ? forcedYears.year1 : null,
    year2: forcedYears.year2 !== undefined ? forcedYears.year2 : null,
    year3: forcedYears.year3 !== undefined ? forcedYears.year3 : null,
    year4: forcedYears.year4 !== undefined ? forcedYears.year4 : null,
    yearOnward: forcedYears.yearOnward !== undefined ? forcedYears.yearOnward : null,
    year6Onward: forcedYears.year6Onward !== undefined ? forcedYears.year6Onward : null,
    launchDate: resolveLaunchDate(schemeName),
    terDate: row.TER_Date || null,
    terMonth: row.Month || null,
    terYear: row.TER_Year || null,
  };
}

function latestSchemeRows(rows, amcMap = new Map()) {
  const byScheme = new Map();
  let currentAMC = '';

  for (const row of rows) {
    // CRITICAL: Skip header rows FIRST
    if (isHeaderRow(row)) {
      continue;
    }

    const schemeName = (row.Scheme_Name || row.SCHEME_NAME || '').trim();
    const nsdlCode = (row.NSDLSchemeCode || '').trim();
    
    // Check for AMC row
    if (!schemeName && !nsdlCode) {
      const rowValues = Object.values(row);
      for (const val of rowValues) {
        if (typeof val === 'string' && val.toLowerCase().includes('mutual fund')) {
          currentAMC = val.trim();
          break;
        }
      }
      continue;
    }

    if (!schemeName || schemeName.length < 3) continue;
    if (/^NSDL|^AMFI|^SCHEME|^1\s*YR|^2\s*YR/i.test(schemeName)) continue;

    if (!row.AMC && currentAMC) {
      row.AMC = currentAMC;
    }

    const key = (nsdlCode || schemeName).trim().toLowerCase();
    const existing = byScheme.get(key);
    const currentDate = new Date(row.TER_Date || 0).getTime();
    const existingDate = existing ? new Date(existing.TER_Date || 0).getTime() : -1;

    if (!existing || currentDate >= existingDate) {
      byScheme.set(key, row);
    }
  }

  const normalizedRows = [];
  for (const row of byScheme.values()) {
    const normalized = normalizeAPIRow(row, amcMap);
    if (normalized) {
      normalizedRows.push(normalized);
    }
  }

  // Ensure year6Onward is populated for all schemes
  return normalizedRows.map(scheme => {
    if (scheme.year6Onward === null || scheme.year6Onward === undefined) {
      if (scheme.yearOnward !== null && scheme.yearOnward !== undefined) {
        scheme.year6Onward = scheme.yearOnward;
      } else if (scheme.year4 !== null && scheme.year4 !== undefined) {
        scheme.year6Onward = scheme.year4;
        scheme.yearOnward = scheme.year4;
      }
    }
    return scheme;
  });
}

function getCell(cells, mappedIdx, fallbackIdx) {
  const idx = mappedIdx !== undefined ? mappedIdx : fallbackIdx;
  return (cells[idx] || '').trim();
}

/**
 * Parse TER data from HTML (fallback when API fails)
 */
function parseTERHTML(html) {
  const $ = cheerio.load(html);
  const schemes = [];
  let currentAMC = '';
  let currentType = '';
  let currentCategory = '';
  let headerMap = {};
  let targetTable = null;
  let headerRowFound = false;

  // Find the main table
  $('table').each((_, tbl) => {
    const rows = $(tbl).find('tr').length;
    if (!targetTable || rows > $(targetTable).find('tr').length) {
      targetTable = tbl;
    }
  });

  if (!targetTable) {
    logger.warn('No table found on AMFI TER page');
    return schemes;
  }

  $(targetTable).find('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length === 0) return;

    const cellTexts = [];
    cells.each((__, cell) => {
      cellTexts.push($(cell).text().trim());
    });

    const firstCell = cellTexts[0] || '';
    const secondCell = cellTexts[1] || '';
    const thirdCell = cellTexts[2] || '';

    // Check if this is a header row
    const isHeaderRow = (
      firstCell.toLowerCase().includes('nsdl') || 
      firstCell.toLowerCase().includes('scheme') ||
      secondCell.toLowerCase().includes('nsdl') ||
      secondCell.toLowerCase().includes('amfi') ||
      (thirdCell.toLowerCase().includes('scheme') && firstCell.toLowerCase().includes('code'))
    );

    if (isHeaderRow && !headerRowFound) {
      // Map header columns
      headerMap = {};
      cellTexts.forEach((text, i) => {
        const clean = text.toLowerCase().replace(/\s+/g, ' ').trim();
        if (/nsdl/.test(clean)) headerMap.nsdl = i;
        else if (/scheme\s*name/.test(clean)) headerMap.schemeName = i;
        else if (/scheme\s*type/.test(clean)) headerMap.schemeType = i;
        else if (/scheme\s*categ/.test(clean)) headerMap.schemeCategory = i;
        else if (/regular.*total|total.*regular/.test(clean)) headerMap.regularTER = i;
        else if (/direct.*total|total.*direct/.test(clean)) headerMap.directTER = i;
        else if (/regular.*base|base.*regular/.test(clean)) headerMap.regularBER = i;
        else if (/direct.*base|base.*direct/.test(clean)) headerMap.directBER = i;
        else if (/1\s*year|1st\s*year/.test(clean)) headerMap.year1 = i;
        else if (/2\s*year|2nd\s*year/.test(clean)) headerMap.year2 = i;
        else if (/3\s*year|3rd\s*year/.test(clean)) headerMap.year3 = i;
        else if (/4\s*year|4th\s*year/.test(clean)) headerMap.year4 = i;
        else if (/onward|5th\s*year/.test(clean)) headerMap.yearOnward = i;
        else if (/6th\s*year/.test(clean)) headerMap.year6Onward = i;
      });
      headerRowFound = true;
      return;
    }

    // Skip AMC/type/category header rows
    if (cells.length === 1 || (cells.length <= 3 && cellTexts[0].length > 5)) {
      const possibleAMC = cellTexts[0];
      if (/mutual\s*fund|mf|asset\s*management|open\s*ended|close\s*ended|interval/i.test(possibleAMC)) {
        if (/mutual\s*fund|mf|asset\s*management/i.test(possibleAMC)) {
          currentAMC = possibleAMC.trim();
        } else if (/open\s*ended|close\s*ended|interval/i.test(possibleAMC)) {
          currentType = possibleAMC.trim();
        }
        return;
      }
      if (possibleAMC.length > 3 && !/^[\d\s]+$/.test(possibleAMC)) {
        currentCategory = possibleAMC.trim();
        return;
      }
      return;
    }

    // Skip if we haven't found the header row yet
    if (!headerRowFound) return;

    // Safety check: skip if first cell contains NSDL and second contains AMFI (header row detected late)
    if (firstCell.toLowerCase().includes('nsdl') && secondCell.toLowerCase().includes('amfi')) {
      return;
    }

    // Extract data using the header map
    const nsdlCode = getCell(cellTexts, headerMap.nsdl, 0);
    const schemeName = getCell(cellTexts, headerMap.schemeName, 1);
    const schemeType = getCell(cellTexts, headerMap.schemeType, 2) || currentType;
    const schemeCategory = getCell(cellTexts, headerMap.schemeCategory, 3) || currentCategory;

    // Skip if scheme name is too short or looks like a header
    if (!schemeName || schemeName.length < 3) return;
    if (/^[A-Z\s]{3,}$/.test(schemeName) && schemeName.length < 20) return;

    const regularTER = parseNumber(getCell(cellTexts, headerMap.regularTER, 4));
    const directTER = parseNumber(getCell(cellTexts, headerMap.directTER, 5));
    const regularBER = parseNumber(getCell(cellTexts, headerMap.regularBER, 6));
    const directBER = parseNumber(getCell(cellTexts, headerMap.directBER, 7));

    const year1 = parseNumber(getCell(cellTexts, headerMap.year1, 8));
    const year2 = parseNumber(getCell(cellTexts, headerMap.year2, 9));
    const year3 = parseNumber(getCell(cellTexts, headerMap.year3, 10));
    const year4 = parseNumber(getCell(cellTexts, headerMap.year4, 11));
    const yearOnward = parseNumber(getCell(cellTexts, headerMap.yearOnward, 12));
    const year6Onward = parseNumber(getCell(cellTexts, headerMap.year6Onward, 13)) || yearOnward;

    schemes.push({
      nsdlCode: nsdlCode || '',
      schemeName,
      schemeType: schemeType || '',
      schemeCategory: schemeCategory || '',
      amc: canonicalizeAMC(currentAMC || extractAMC(schemeName)),
      regularTER,
      directTER,
      regularBER,
      directBER,
      terDiff: roundedDiff(regularTER, directTER),
      berDiff: roundedDiff(regularBER, directBER),
      year1,
      year2,
      year3,
      year4,
      yearOnward,
      year6Onward,
      launchDate: resolveLaunchDate(schemeName),
    });
  });

  return schemes;
}

module.exports = {
  logMissingKnownAMCs,
  parseNumber,
  roundedDiff,
  getFieldValue,
  getKotakSchemesFromBrokerage,
  ensureYear6Onward,
  getForcedYearValues,
  resolveLaunchDate,
  isHeaderRow,
  normalizeAPIRow,
  latestSchemeRows,
  getCell,
  parseTERHTML,
};
