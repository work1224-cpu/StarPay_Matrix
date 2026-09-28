/**
 * services/matchService.js
 * Matches TER schemes with NAV records by scheme name similarity.
 * Confidence must exceed config threshold to avoid mismatches.
 */

const config = require('../config/app');
const logger = require('../helpers/logger');
const { normalizeSchemeName, similarityScore } = require('../helpers/normalizer');

/**
 * Build a lookup index from NAV map for fast matching.
 * key = normalized name, value = amfiCode
 */
function buildNAVIndex(navMap) {
  const index = new Map();
  for (const [code, record] of navMap) {
    const norm = normalizeSchemeName(record.schemeName);
    if (norm) {
      if (!index.has(norm)) index.set(norm, []);
      index.get(norm).push({ code, schemeName: record.schemeName });
    }
  }
  return index;
}

/**
 * Find best matching NAV record for a TER scheme.
 * @param {string} terSchemeName
 * @param {Map} navIndex
 * @returns {{ amfiCode, navSchemeName, confidence } | null}
 */
function findBestMatch(terSchemeName, navIndex) {
  const normTER = normalizeSchemeName(terSchemeName);
  if (!normTER) return null;

  // Exact match first
  if (navIndex.has(normTER)) {
    const candidates = navIndex.get(normTER);
    return { amfiCode: candidates[0].code, navSchemeName: candidates[0].schemeName, confidence: 100 };
  }

  // Fuzzy match: score all nav entries
  let best = null;
  let bestScore = 0;

  for (const [normNav, records] of navIndex) {
    const score = similarityScore(normTER, normNav);
    if (score > bestScore) {
      bestScore = score;
      best = { amfiCode: records[0].code, navSchemeName: records[0].schemeName, confidence: score };
    }
  }

  if (best && best.confidence >= config.matching.minConfidence) return best;
  return null;
}

/**
 * Merge TER scheme array with NAV map.
 * @param {Object[]} terSchemes
 * @param {Map} navMap
 * @returns {Object[]} Merged scheme array
 */
function mergeSchemes(terSchemes, navMap) {
  const navIndex = buildNAVIndex(navMap);
  const merged = [];
  let matchedCount = 0;
  let unmatchedCount = 0;

  terSchemes.forEach((scheme, idx) => {
    const match = findBestMatch(scheme.schemeName, navIndex);

    if (match) {
      const navRecord = navMap.get(match.amfiCode);
      matchedCount++;
      merged.push({
        srNo: idx + 1,
        nsdlCode:       scheme.nsdlCode,
        amfiCode:       match.amfiCode,
        schemeName:     scheme.schemeName,
        schemeType:     scheme.schemeType,
        schemeCategory: scheme.schemeCategory,
        amc:            scheme.amc,
        regularTER:     scheme.regularTER,
        directTER:      scheme.directTER,
        regularBER:     scheme.regularBER,
        directBER:      scheme.directBER,
        terDiff:        scheme.terDiff,
        berDiff:        scheme.berDiff,
        year1:          scheme.year1,
        year2:          scheme.year2,
        year3:          scheme.year3,
        year4:          scheme.year4,
        yearOnward:     scheme.yearOnward,
        year6Onward:    scheme.year6Onward,
        nav:            navRecord?.nav ?? null,
        navDate:        navRecord?.navDate ?? null,
        isin:           navRecord?.isin ?? null,
        matchConfidence: match.confidence,
      });
    } else {
      unmatchedCount++;
      // Still include TER-only schemes
      merged.push({
        srNo: idx + 1,
        nsdlCode:       scheme.nsdlCode,
        amfiCode:       null,
        schemeName:     scheme.schemeName,
        schemeType:     scheme.schemeType,
        schemeCategory: scheme.schemeCategory,
        amc:            scheme.amc,
        regularTER:     scheme.regularTER,
        directTER:      scheme.directTER,
        regularBER:     scheme.regularBER,
        directBER:      scheme.directBER,
        terDiff:        scheme.terDiff,
        berDiff:        scheme.berDiff,
        year1:          scheme.year1,
        year2:          scheme.year2,
        year3:          scheme.year3,
        year4:          scheme.year4,
        yearOnward:     scheme.yearOnward,
        year6Onward:    scheme.year6Onward,
        nav:            null,
        navDate:        null,
        isin:           null,
        matchConfidence: 0,
      });
    }
  });

  logger.info('Merge complete', { total: merged.length, matched: matchedCount, unmatched: unmatchedCount });
  return merged;
}

module.exports = { mergeSchemes };