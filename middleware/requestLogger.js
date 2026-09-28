/**
 * middleware/requestLogger.js
 * HTTP request logger middleware using morgan.
 */

const morgan = require('morgan');

const format = process.env.NODE_ENV === 'production'
  ? 'combined'
  : ':method :url :status :response-time ms';

module.exports = morgan(format);
