/**
 * services/cacheService.js
 * In-memory cache + disk persistence.
 * Restart = instant serve from ter-cache.json, background refresh from AMFI.
 * The last successful snapshot remains usable even when AMFI is unavailable.
 */
const fs     = require('fs');
const path   = require('path');
const logger = require('../helpers/logger');
const { canonicalizeAMC } = require('../helpers/normalizer');

const DISK_PATH = process.env.TER_CACHE_PATH || path.join(__dirname, '..', 'ter-cache.json');
// A deliberately separate snapshot.  Unlike ter-cache.json this file is
// changed only when a data operator presses "Save Sync", so a failed live
// scrape can never replace it with partial data.
const MANUAL_SNAPSHOT_PATH = process.env.TER_MANUAL_SYNC_PATH || path.join(__dirname, '..', 'ter-manual-sync.json');
const KNOWN_AMCS = (() => {
  try { return require('./allAMCs.json') || []; } catch (e) { return []; }
})();

function normalizeSchemeName(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function mergeAMCs(discoveredAmcs = []) {
  // Get all AMCs from schemes
  const fromSchemes = discoveredAmcs
    .map(amc => {
      // Try to canonicalize, but if it fails, keep the original
      const canonical = canonicalizeAMC(amc);
      return canonical || amc;
    })
    .filter(Boolean);
  
  // Combine with known AMCs
  const all = [...new Set([...fromSchemes, ...KNOWN_AMCS])];
  
  // Sort alphabetically
  return all.sort((a, b) => a.localeCompare(b));
}

/**
 * Calculate Commission to BER Ratio
 */
function calcRatio(commission, ber) {
  if (commission === null || commission === undefined || ber === null || ber === undefined || ber === 0) return null;
  return commission / ber;
}

class CacheService {
  constructor() {
    this._store = {
      schemes: [], amcs: [], categories: [], types: [],
      periods: new Map(), lastRefreshed: null,
      status: 'empty', error: null,
    };
  }

  /** Persist to disk, asynchronously — callers use setImmediate() and never
   *  await this, so a failed/slow write can never block a request. */
  async _saveToDisk() {
    try {
      await fs.promises.writeFile(DISK_PATH, JSON.stringify({
        schemes: this._store.schemes, amcs: this._store.amcs,
        categories: this._store.categories, types: this._store.types,
        lastRefreshed: this._store.lastRefreshed,
        savedAt: new Date().toISOString(),
      }), 'utf8');
      logger.info('Disk cache saved', { count: this._store.schemes.length });
    } catch(e) { logger.warn('Disk cache save failed', { error: e.message }); }
  }

  /** Save the currently usable dataset as an operator-controlled fallback. */
  async saveManualSnapshot() {
    if (!this._store.schemes.length) {
      return { success: false, message: 'There is no current data available to save.' };
    }

    try {
      const savedAt = new Date().toISOString();
      await fs.promises.writeFile(MANUAL_SNAPSHOT_PATH, JSON.stringify({
        schemes: this._store.schemes,
        amcs: this._store.amcs,
        categories: this._store.categories,
        types: this._store.types,
        lastRefreshed: this._store.lastRefreshed,
        savedAt,
      }), 'utf8');
      logger.info('Manual sync snapshot saved', { count: this._store.schemes.length, savedAt });
      return { success: true, count: this._store.schemes.length, savedAt };
    } catch (e) {
      logger.error('Manual sync snapshot save failed', { error: e.message });
      return { success: false, message: 'Unable to save the sync copy.' };
    }
  }

  /** Read the operator-controlled snapshot without modifying live cache. */
  getManualSnapshot() {
    try {
      if (!fs.existsSync(MANUAL_SNAPSHOT_PATH)) {
        return { success: false, message: 'No saved sync copy is available yet.' };
      }
      const snapshot = JSON.parse(fs.readFileSync(MANUAL_SNAPSHOT_PATH, 'utf8'));
      if (!Array.isArray(snapshot.schemes) || !snapshot.schemes.length) {
        return { success: false, message: 'The saved sync copy is empty or invalid.' };
      }
      return { success: true, snapshot };
    } catch (e) {
      logger.error('Manual sync snapshot read failed', { error: e.message });
      return { success: false, message: 'Unable to read the saved sync copy.' };
    }
  }

  /** Load from disk. Returns true if usable data was found. */
  async loadFromDisk() {
    try {
      if (!fs.existsSync(DISK_PATH)) return false;
      const ageH = (Date.now() - fs.statSync(DISK_PATH).mtimeMs) / 3600000;
      const p = JSON.parse(fs.readFileSync(DISK_PATH, 'utf8'));
      if (!Array.isArray(p.schemes) || !p.schemes.length) return false;
      
      // Process schemes with C/B ratios
      const processedSchemes = (p.schemes || []).map(s => {
        const ber = s.regularBER;
        return {
          ...s,
          amc: canonicalizeAMC(s.amc) || s.amc,
          // Calculate C/B ratios if not already present
          c1: s.c1 !== undefined ? s.c1 : calcRatio(s.year1, ber),
          c2: s.c2 !== undefined ? s.c2 : calcRatio(s.year2, ber),
          c3: s.c3 !== undefined ? s.c3 : calcRatio(s.year3, ber),
          c4: s.c4 !== undefined ? s.c4 : calcRatio(s.year4, ber),
          c5: s.c5 !== undefined ? s.c5 : calcRatio(s.yearOnward, ber),
          c6: s.c6 !== undefined ? s.c6 : calcRatio(s.year6Onward, ber),
        };
      });

      
      this._store.schemes = processedSchemes;

      // Do not carry brokerage values from an old cache snapshot unless the
      // scheme still has a matching value from an uploaded Excel override.
      const commissionOverrideService = require('./commissionOverrideService');
      this._store.schemes = this._store.schemes.map((scheme) => {
        const override = commissionOverrideService.get(scheme.schemeName);
        if (!override) {
          return {
            ...scheme,
            year1: null, year2: null, year3: null, year4: null,
            yearOnward: null, year6Onward: null,
            c1: null, c2: null, c3: null, c4: null, c5: null, c6: null,
          };
        }
        return {
          ...scheme,
          year1: override.year1 ?? null,
          year2: override.year2 ?? null,
          year3: override.year3 ?? null,
          year4: override.year4 ?? null,
          yearOnward: override.yearOnward ?? null,
          year6Onward: override.year6Onward ?? null,
        };
      });

      // Reapply workbook and manual launch dates to disk-loaded snapshots
      // immediately; the background AMFI refresh may take several minutes.
      const launchDateService = require('./launchDateService');
      const launchDateOverrideService = require('./launchDateOverrideService');
      this._store.schemes = this._store.schemes.map((scheme) => {
        const launchDate = launchDateOverrideService.get(scheme.schemeName)
          || launchDateService.getLaunchDate(scheme.schemeName);
        return launchDate ? { ...scheme, launchDate } : scheme;
      });
      
      // Build AMC list from schemes
      const schemeAmcs = this._store.schemes.map(s => s.amc).filter(Boolean);
      this._store.amcs = mergeAMCs(schemeAmcs);
      
      this._store.categories    = p.categories || [];
      this._store.types         = p.types      || [];
      this._store.lastRefreshed = p.lastRefreshed;
      this._store.status        = 'ready';
      
      logger.info('Disk cache loaded', { 
        count: p.schemes.length, 
        ageH: ageH.toFixed(1),
        amcCount: this._store.amcs.length 
      });
      
      // Log sample AMCs for debugging
      logger.debug('AMCs loaded from disk', { sample: this._store.amcs.slice(0, 10) });
      
      return true;
    } catch(e) { 
      logger.warn('Disk cache load failed', { error: e.message }); 
      return false; 
    }
  }

  /**
   * Set schemes with automatic C/B ratio calculation
   */
  setSchemes(schemes) {
    const normalizedSchemes = schemes.map(s => {
      const ber = s.regularBER;
      const launchDateService = require('./launchDateService');
      const launchDateOverrideService = require('./launchDateOverrideService');
      const launchDate = launchDateOverrideService.get(s.schemeName)
        || launchDateService.getLaunchDate(s.schemeName)
        || s.launchDate
        || null;
      return {
        ...s,
        amc: canonicalizeAMC(s.amc) || s.amc,
        launchDate,
        // Calculate C/B ratios
        c1: calcRatio(s.year1, ber),
        c2: calcRatio(s.year2, ber),
        c3: calcRatio(s.year3, ber),
        c4: calcRatio(s.year4, ber),
        c5: calcRatio(s.yearOnward, ber),
        c6: calcRatio(s.year6Onward, ber),
      };
    });

    this._store.schemes = normalizedSchemes;
    
    // Build AMC list from schemes
    const schemeAmcs = normalizedSchemes.map(s => s.amc).filter(Boolean);
    this._store.amcs = mergeAMCs(schemeAmcs);
    
    this._store.categories = [...new Set(normalizedSchemes.map(s => s.schemeCategory).filter(Boolean))].sort();
    this._store.types = [...new Set(normalizedSchemes.map(s => s.schemeType).filter(Boolean))].sort();
    this._store.lastRefreshed = new Date().toISOString();
    this._store.status = 'ready';
    this._store.error = null;
    
    logger.info('Cache updated', { 
      count: normalizedSchemes.length,
      amcCount: this._store.amcs.length 
    });
    
    setImmediate(() => this._saveToDisk());
  }

  setPeriodSchemes(year, month, schemes) {
    if (!year||!month) return;
    // Process schemes with C/B ratios
    const processedSchemes = schemes.schemes.map(s => {
      const ber = s.regularBER;
      return {
        ...s,
        c1: calcRatio(s.year1, ber),
        c2: calcRatio(s.year2, ber),
        c3: calcRatio(s.year3, ber),
        c4: calcRatio(s.year4, ber),
        c5: calcRatio(s.yearOnward, ber),
        c6: calcRatio(s.year6Onward, ber),
      };
    });
    this._store.periods.set(`${year}|${month}`, { 
      schemes: processedSchemes, 
      lastRefreshed: new Date().toISOString() 
    });
  }

  /** Apply persisted launch-date overrides to all cached scheme snapshots. */
  applyLaunchDateOverrides(getOverride) {
    const apply = (scheme) => {
      const launchDate = getOverride(scheme.schemeName);
      return launchDate ? { ...scheme, launchDate } : scheme;
    };
    this._store.schemes = this._store.schemes.map(apply);
    for (const [periodKey, periodData] of this._store.periods.entries()) {
      this._store.periods.set(periodKey, {
        ...periodData,
        schemes: periodData.schemes.map(apply),
      });
    }
    setImmediate(() => this._saveToDisk());
  }

  /** Remove all stored commission values from the scheme matrix. */
  clearBrokerageData() {
    const clearFields = (scheme = {}) => ({
      ...scheme,
      year1: null,
      year2: null,
      year3: null,
      year4: null,
      yearOnward: null,
      year6Onward: null,
      c1: null,
      c2: null,
      c3: null,
      c4: null,
      c5: null,
      c6: null,
    });

    this._store.schemes = this._store.schemes.map(clearFields);
    for (const [periodKey, periodData] of this._store.periods.entries()) {
      this._store.periods.set(periodKey, {
        ...periodData,
        schemes: (periodData.schemes || []).map(clearFields),
      });
    }

    const commissionOverrideService = require('./commissionOverrideService');
    commissionOverrideService.clearAll();

    this._store.lastRefreshed = new Date().toISOString();
    this._store.status = 'ready';
    setImmediate(() => this._saveToDisk());
    // Do not leave an older manual snapshot that can restore the values just
    // cleared when the operator clicks "Get Old Sync Data".
    setImmediate(() => this.saveManualSnapshot());

    logger.info('Stored brokerage data cleared from cache');
    return { success: true, count: this._store.schemes.length };
  }

  /**
   * Update scheme values permanently. This updates the in-memory cache,
   * persists to disk, and ensures all users see the updated values.
   * C/B ratios are automatically recalculated.
   */
  updateSchemeValues({ schemeName, amc, nsdlCode, amfiCode, values }) {
    if (!schemeName && !nsdlCode && !amfiCode) {
      return { success: false, message: 'Scheme identifier is required.' };
    }

    const normalizedAmc = canonicalizeAMC(amc || '') || amc || '';
    const normalizedNsdl = String(nsdlCode || '').trim();
    const normalizedAmfi = String(amfiCode || '').trim();
    let matched = false;

    const updateEntry = (scheme) => {
      const sameNsdl = normalizedNsdl && String(scheme.nsdlCode || '').trim() === normalizedNsdl;
      const sameAmfi = normalizedAmfi && String(scheme.amfiCode || '').trim() === normalizedAmfi;
      const sameScheme = scheme.schemeName && schemeName && normalizeSchemeName(scheme.schemeName) === normalizeSchemeName(schemeName);
      const sameAmc = !normalizedAmc || (canonicalizeAMC(scheme.amc || '') || scheme.amc || '') === normalizedAmc;
      
      if (!sameAmc || !(sameNsdl || sameAmfi || sameScheme)) return scheme;

      matched = true;
      const updated = { ...scheme };

      const setNumericField = (field) => {
        if (values[field] === undefined) return;
        if (values[field] === null || values[field] === '') { updated[field] = null; return; }
        const n = parseFloat(values[field]);
        updated[field] = Number.isFinite(n) ? n : null;
      };

      // Update year values if provided
      setNumericField('year1');
      setNumericField('year2');
      setNumericField('year3');
      setNumericField('year4');
      setNumericField('yearOnward');
      setNumericField('year6Onward');

      // Also update TER/BER diff if provided (for completeness)
      setNumericField('terDiff');
      setNumericField('berDiff');

      // Launch Date is a plain ISO (YYYY-MM-DD) string, not a numeric field —
      // validated by the caller (controller) before we ever get here.
      if (values.launchDate !== undefined) {
        updated.launchDate = values.launchDate || null;
      }

      // --- IMPORTANT: Recalculate C/B ratios ---
      const ber = updated.regularBER;
      updated.c1 = calcRatio(updated.year1, ber);
      updated.c2 = calcRatio(updated.year2, ber);
      updated.c3 = calcRatio(updated.year3, ber);
      updated.c4 = calcRatio(updated.year4, ber);
      updated.c5 = calcRatio(updated.yearOnward, ber);
      updated.c6 = calcRatio(updated.year6Onward, ber);

      return updated;
    };

    // Update main cache
    this._store.schemes = this._store.schemes.map(updateEntry);

    // Update period-specific caches
    for (const [periodKey, periodData] of this._store.periods.entries()) {
      const updatedPeriodSchemes = periodData.schemes.map(updateEntry);
      this._store.periods.set(periodKey, {
        ...periodData,
        schemes: updatedPeriodSchemes,
      });
    }

    if (!matched) {
      return { success: false, message: 'Scheme not found.' };
    }

    // Update the commission override cache as well so uploads don't overwrite admin edits
    const commissionOverrideService = require('./commissionOverrideService');
    const schemeToUpdate = this._store.schemes.find(s => {
      const sameNsdl = normalizedNsdl && String(s.nsdlCode || '').trim() === normalizedNsdl;
      const sameAmfi = normalizedAmfi && String(s.amfiCode || '').trim() === normalizedAmfi;
      const sameScheme = s.schemeName && schemeName && normalizeSchemeName(s.schemeName) === normalizeSchemeName(schemeName);
      const sameAmc = !normalizedAmc || (canonicalizeAMC(s.amc || '') || s.amc || '') === normalizedAmc;
      return (sameNsdl || sameAmfi || sameScheme) && sameAmc;
    });

    if (schemeToUpdate) {
      // Save the updated values to commission overrides so they persist across uploads
      commissionOverrideService.setForScheme(
        schemeToUpdate.schemeName,
        {
          year1: schemeToUpdate.year1,
          year2: schemeToUpdate.year2,
          year3: schemeToUpdate.year3,
          year4: schemeToUpdate.year4,
          yearOnward: schemeToUpdate.yearOnward,
          year6Onward: schemeToUpdate.year6Onward,
          amc: schemeToUpdate.amc,
          regularBER: schemeToUpdate.regularBER,
        }
      );

      // Same idea for Launch Date: persist to the override store so a future
      // AMFI refresh (which re-derives launchDate from the reference
      // workbook) doesn't silently discard this manual correction.
      if (values.launchDate !== undefined) {
        const launchDateOverrideService = require('./launchDateOverrideService');
        launchDateOverrideService.set(schemeToUpdate.schemeName, schemeToUpdate.launchDate || '');
      }
    }

    this._store.lastRefreshed = new Date().toISOString();
    this._store.status = 'ready';
    setImmediate(() => this._saveToDisk());
    
    logger.info('Scheme updated permanently with C/B ratios', { 
      schemeName, 
      amc: normalizedAmc,
      values,
      c1: schemeToUpdate?.c1,
      c2: schemeToUpdate?.c2,
      c3: schemeToUpdate?.c3,
      c4: schemeToUpdate?.c4,
      c5: schemeToUpdate?.c5,
      c6: schemeToUpdate?.c6,
    });
    
    return { success: true, message: 'Scheme updated permanently with C/B ratios.' };
  }

  setStatus(status, error=null) {
    // Never downgrade from ready — keep serving stale data during background refresh
    if (status==='loading' && this._store.status==='ready') return;
    this._store.status=status; this._store.error=error;
  }

  getSchemes()           { return this._store.schemes; }
  getAMCs()              { return this._store.amcs || []; }
  getCategories()        { return this._store.categories; }
  getTypes()             { return this._store.types; }
  getPeriodSchemes(y,m)  { return this._store.periods.get(`${y}|${m}`)||null; }
  getStatus()            { return { status:this._store.status, lastRefreshed:this._store.lastRefreshed, error:this._store.error }; }
  isReady()              { return this._store.schemes.length > 0; }
}

module.exports = new CacheService();
