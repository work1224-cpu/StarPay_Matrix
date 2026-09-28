/**
 * services/schedulerService.js
 * Schedules the AMFI data refresh at FIXED times during the day, instead
 * of hammering amfiindia.com every few minutes. Each run's result is
 * cached (see dataService.refreshData -> cacheService.setSchemes, which
 * also persists to disk) and served to every visitor for the rest of the
 * day — so even if AMFI's own server is slow or briefly down, the site
 * keeps serving the last successfully fetched copy instead of breaking
 * (refreshData's catch block only sets an error status when there is NO
 * cached data at all yet; an existing cache is never thrown away just
 * because one scheduled refresh failed).
 *
 * A manual "Refresh" button (admin/data-operator only, see apiController
 * triggerRefresh) is still available any time outside these fixed slots.
 */

const schedule = require('node-schedule');
const { refreshData } = require('./dataService');
const logger = require('../helpers/logger');

// 10 AM, 12 PM, 2 PM, 4 PM India time, every day.
const REFRESH_HOURS = [10, 12, 14, 16];
const TIMEZONE = 'Asia/Kolkata';

let jobs = [];

function startScheduler() {
  jobs = REFRESH_HOURS.map(hour => {
    const rule = new schedule.RecurrenceRule();
    rule.hour = hour;
    rule.minute = 0;
    rule.tz = TIMEZONE;

    return schedule.scheduleJob(rule, async () => {
      logger.info(`Scheduled refresh triggered (daily ${hour}:00 ${TIMEZONE})`);
      try {
        await refreshData();
      } catch (err) {
        // refreshData() already catches its own errors internally and
        // should never reject — this is a defensive backstop only, so a
        // future change to that guarantee can never crash the process via
        // an unhandled rejection inside a scheduled job.
        logger.error('Scheduled refresh threw unexpectedly', { error: err.message });
      }
    });
  });

  const times = REFRESH_HOURS.map(h => `${h}:00`).join(', ');
  logger.info(`Scheduler started – daily AMFI refresh at ${times} (${TIMEZONE})`);
}

function stopScheduler() {
  jobs.forEach(job => job && job.cancel());
  jobs = [];
  logger.info('Scheduler stopped');
}

module.exports = { startScheduler, stopScheduler };