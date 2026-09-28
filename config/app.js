/**
 * config/app.js
 * Central application configuration
 */
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT) || 3000,
  env: process.env.NODE_ENV || 'development',

  // AMFI Data Source URLs
  amfi: {
    terUrl: process.env.AMFI_TER_URL || 'https://www.amfiindia.com/ter-of-mf-schemes',
    navUrl: process.env.AMFI_NAV_URL || 'https://portal.amfiindia.com/spages/NAVAll.txt',
  },

  // Cache settings
  cache: {
    refreshIntervalMinutes: parseInt(process.env.CACHE_REFRESH_INTERVAL) || 30,
  },

  // HTTP Request settings
  request: {
    timeout: parseInt(process.env.REQUEST_TIMEOUT) || 30000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      Connection: 'keep-alive',
    },
  },

  // Matching confidence threshold (0-100)
  matching: {
    minConfidence: 80,
  },
};

module.exports = config;
