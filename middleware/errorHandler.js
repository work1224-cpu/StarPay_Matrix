/**
 * middleware/errorHandler.js
 * Centralized error handling middleware.
 */

const logger = require('../helpers/logger');

/**
 * 404 handler – must be registered after all routes.
 */
function notFound(req, res, next) {
  const err = new Error(`Not Found: ${req.originalUrl}`);
  err.status = 404;
  next(err);
}

/**
 * Global error handler.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  logger.error('Unhandled error', { status, message, path: req.originalUrl });

  if (req.xhr || req.path.startsWith('/api')) {
    return res.status(status).json({ success: false, message });
  }

  // Use try/catch to avoid a cascade if error.ejs itself fails to render
  try {
    res.status(status).render('error', {
      title: `Error ${status}`,
      status,
      message,
    });
  } catch (renderErr) {
    // Fallback to plain HTML so we never get the misleading
    // "Failed to lookup view" message
    logger.error('errorHandler: failed to render error.ejs', { error: renderErr.message });
    res.status(status).send(`
      <!DOCTYPE html>
      <html><head><title>Error ${status}</title></head>
      <body style="font-family:sans-serif;padding:2rem;max-width:600px;margin:auto">
        <h1>Error ${status}</h1>
        <p>${message}</p>
        <a href="/">← Back to Home</a>
      </body></html>
    `);
  }
}

module.exports = { notFound, errorHandler };