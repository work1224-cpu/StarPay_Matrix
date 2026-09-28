/**
 * helpers/normalizer.js
 * String normalization utilities for scheme name matching
 */

/**
 * Normalize a mutual fund scheme name for comparison.
 * Strips plan/option suffixes, extra spaces, and punctuation.
 * @param {string} name
 * @returns {string}
 */
function normalizeSchemeName(name) {
  if (!name || typeof name !== 'string') return '';

  let n = name.toLowerCase().trim();

  // Remove plan variants
  n = n.replace(/\b(regular|direct)\s*(plan)?\b/gi, '');

  // Remove option variants
  n = n.replace(/\b(growth|idcw|dividend|bonus|payout|reinvestment|sweep)\b/gi, '');

  // Remove common suffixes
  n = n.replace(/\b(option|plan|fund|scheme)\b/gi, '');

  // Remove parentheses and their contents
  n = n.replace(/\(.*?\)/g, '');

  // Remove all punctuation including hyphens
  n = n.replace(/[-–—]/g, ' ');
  n = n.replace(/[^\w\s]/g, '');

  // Collapse multiple spaces
  n = n.replace(/\s+/g, ' ').trim();

  return n;
}

/**
 * Calculate similarity score between two strings (0-100).
 * Uses a simple token-overlap approach.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarityScore(a, b) {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return Math.round((intersection / union) * 100);
}

/**
 * Extract AMC name from a scheme name (first few significant words).
 * @param {string} name
 * @returns {string}
 */
const KNOWN_AMCS = (() => {
  try {
    return require('../services/allAMCs.json') || [];
  } catch (e) {
    return [];
  }
})();

function normalizeAMCName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\band\b/g, '')
    .replace(/mutual\s*fund\b|mf\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AMC_CANONICAL_MAP = new Map(
  KNOWN_AMCS.map(amc => [normalizeAMCName(amc), amc])
);

function canonicalizeAMC(name) {
  const normalized = normalizeAMCName(name);
  if (!normalized) return '';
  if (AMC_CANONICAL_MAP.has(normalized)) return AMC_CANONICAL_MAP.get(normalized);

  for (const [key, canonical] of AMC_CANONICAL_MAP.entries()) {
    if (key === normalized || key.startsWith(normalized) || normalized.startsWith(key) || key.includes(normalized) || normalized.includes(key)) {
      return canonical;
    }
  }

  return String(name).trim();
}

function extractAMC(name) {
  if (!name) return '';
  // AMC name is typically the first part before "Mutual Fund"
  const match = name.match(/^(.*?)\s+(?:mutual\s+fund|mf)\b/i);
  if (match) return canonicalizeAMC(match[1].trim());
  // Fallback: first 3 words
  return canonicalizeAMC(name.split(/\s+/).slice(0, 3).join(' '));
}

module.exports = { normalizeSchemeName, similarityScore, extractAMC, normalizeAMCName, canonicalizeAMC };
