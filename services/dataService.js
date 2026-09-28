/**
 * services/dataService.js
 * Orchestrates TER + NAV fetch → merge → cache.
 * - Prevents concurrent refreshes
 * - Keeps serving stale data while refresh runs
 * - Period filter uses cache-first, fetches only on miss with timeout
 */

const { getTERData }    = require('./terService');
const { getNAVData }    = require('./navService');
const { mergeSchemes }  = require('./matchService');
const cacheService      = require('./cacheService');
const logger            = require('../helpers/logger');

let refreshInProgress = false;
let navCache          = null;
let navCacheTime      = 0;
const NAV_TTL_MS      = 4 * 60 * 60 * 1000; // reuse NAV for 4 hours

async function getCachedNAVData() {
  const now = Date.now();
  if (navCache && (now - navCacheTime) < NAV_TTL_MS) {
    logger.info('Using cached NAV data');
    return navCache;
  }
  navCache     = await getNAVData();
  navCacheTime = now;
  return navCache;
}

// If a fresh refresh returns fewer than this fraction of the currently
// cached scheme count, we treat it as a broken/partial response (AMFI
// pagination glitch, bot-block returning a stub page, etc.) rather than
// genuine data — and keep serving the last known-good cache instead of
// overwriting it. AMFI's universe doesn't shrink by more than a small
// amount day to day, so a big drop is a strong signal something went wrong
// in the fetch, not that thousands of schemes were actually delisted.
const MIN_ACCEPTABLE_FRACTION = 0.5;
const MIN_ABSOLUTE_SCHEMES = 500; // below this in absolute terms is never plausible for "all AMCs"

/** Full refresh — runs in background, never blocks page load */
async function refreshData() {
  if (refreshInProgress) {
    logger.warn('Refresh already in progress – skipping');
    return;
  }

  refreshInProgress = true;
  // Note: don't call setStatus('loading') — it won't overwrite 'ready' anyway
  logger.info('Starting full data refresh...');

  try {
    const [terSchemes, navMap] = await Promise.all([
      getTERData(),
      getCachedNAVData(),
    ]);
    const merged = mergeSchemes(terSchemes, navMap);

    const previousCount = cacheService.isReady() ? cacheService.getSchemes().length : 0;
    const looksBroken =
      merged.length < MIN_ABSOLUTE_SCHEMES ||
      (previousCount > 0 && merged.length < previousCount * MIN_ACCEPTABLE_FRACTION);

    if (looksBroken && previousCount > 0) {
      // Don't let a suspiciously small/partial response overwrite a good
      // cache — this is exactly the "AMFI is down/broken" case, just one
      // that returned SOME data instead of erroring outright.
      logger.error(
        'Refresh produced a suspiciously small scheme count — keeping the previous cache instead of overwriting it',
        { newCount: merged.length, previousCount }
      );
    } else if (looksBroken) {
      // No previous cache to fall back to either — nothing safe to serve,
      // so surface it as an error same as any other refresh failure.
      logger.error('Refresh produced a suspiciously small scheme count and there is no previous cache to fall back to', { newCount: merged.length });
      cacheService.setStatus('error', `AMFI returned only ${merged.length} schemes — this looks like a partial/broken response, not real data.`);
    } else {
      cacheService.setSchemes(merged);
      logger.info('Data refresh complete', { schemes: merged.length });
    }
  } catch (err) {
    const msg = err.message || 'Unknown error';
    // Only set error status if we have no data at all
    if (!cacheService.isReady()) {
      cacheService.setStatus('error', msg);
    }
    logger.error('Data refresh failed', { error: msg });
  } finally {
    refreshInProgress = false;
  }
}

/**
 * Get schemes for a specific year/month period.
 * Returns cached period data instantly, or falls back to current
 * cache while fetching in the background.
 */
async function getSchemesForPeriod(year, month) {
  // 1. Check period-specific cache
  const cached = cacheService.getPeriodSchemes(year, month);
  if (cached) return cached;

  // 2. Fetch with a tight timeout — don't make the user wait forever
  const TIMEOUT_MS = 25000;
  const fetchPromise = (async () => {
    const [terSchemes, navMap] = await Promise.all([
      getTERData({ year, month }),
      getCachedNAVData(),
    ]);
    const schemes = mergeSchemes(terSchemes, navMap);
    cacheService.setPeriodSchemes(year, month, { schemes, lastRefreshed: new Date().toISOString() });
    return cacheService.getPeriodSchemes(year, month);
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Period data fetch timed out')), TIMEOUT_MS)
  );

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch (err) {
    // AMFI is slow/down for this period fetch — don't break the site.
    // Fall back to the last known-good data instead of throwing:
    //   a) the main (current period) cache if it has data, else
    //   b) whichever period snapshot we already have on disk.
    logger.warn('Live AMFI fetch for period failed — serving last cached copy instead', {
      year, month, error: err.message,
    });

    if (cacheService.isReady()) {
      return {
        schemes: cacheService.getSchemes(),
        lastRefreshed: cacheService.getStatus().lastRefreshed,
        stale: true,
        staleReason: `AMFI server slow/unavailable — showing last available data instead of ${month}/${year}`,
      };
    }

    // No usable data anywhere — surface the original error.
    throw err;
  }
}

module.exports = { refreshData, getSchemesForPeriod };