/**
 * helpers/logger.js
 * Simple structured logger
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function formatMessage(level, message, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

const logger = {
  error: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.error) console.error(formatMessage('error', msg, meta));
  },
  warn: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.warn) console.warn(formatMessage('warn', msg, meta));
  },
  info: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.info) console.log(formatMessage('info', msg, meta));
  },
  debug: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.debug) console.log(formatMessage('debug', msg, meta));
  },
};

module.exports = logger;
