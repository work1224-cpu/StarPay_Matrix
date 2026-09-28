/**
 * middleware/csrf.js
 *
 * Double-submit-cookie CSRF protection.
 *
 * How it works: every response sets a random, non-httpOnly `csrfToken`
 * cookie. A cross-site attacker's page can trigger a request to this app
 * (e.g. via an auto-submitting form) and the browser will attach the
 * cookie automatically — but the attacker's JS cannot *read* that cookie
 * (browsers enforce same-origin on cookie access), so it cannot also send
 * the matching value back as a header or hidden form field. Genuine
 * same-origin requests (our own pages/scripts) can read the cookie and
 * echo it back, so they pass.
 *
 * This app already sets its session cookie with `sameSite: 'lax'`, which
 * blocks the classic cross-site POST-with-cookies attack in modern
 * browsers on its own. This middleware is defense-in-depth on top of that
 * (older browsers, and any future sameSite relaxation).
 */

const crypto = require('node:crypto');

const CSRF_COOKIE = 'csrfToken';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').reduce((acc, item) => {
    const [key, ...rest] = item.split('=');
    if (!key) return acc;
    acc[key.trim()] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
  return cookies[name];
}

/** Ensures every visitor has a CSRF token cookie, and exposes it to EJS
 *  views (res.locals.csrfToken) for embedding in hidden form fields. */
function issueCsrfToken(req, res, next) {
  let token = readCookie(req, CSRF_COOKIE);
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, // page JS must be able to read this to attach it to fetch() headers
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
  res.locals.csrfToken = token;
  req.csrfToken = token;
  next();
}

/** Rejects state-changing requests whose token doesn't match the cookie. */
function verifyCsrfToken(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = readCookie(req, CSRF_COOKIE);
  const suppliedToken = req.get(CSRF_HEADER) || (req.body && req.body._csrf);

  if (!cookieToken || !suppliedToken || cookieToken !== suppliedToken) {
    const message = 'Your session form has expired. Please refresh the page and try again.';
    if (req.path.startsWith('/api') || !req.accepts('html')) {
      return res.status(403).json({ success: false, message });
    }
    return res.status(403).send(message);
  }

  next();
}

module.exports = { issueCsrfToken, verifyCsrfToken, CSRF_COOKIE, CSRF_HEADER };
