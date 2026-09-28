/**
 * public/js/csrf.js
 *
 * Wraps window.fetch so every non-GET request automatically carries the
 * CSRF token (read from the readable `csrfToken` cookie the server sets)
 * as an X-CSRF-Token header. Loaded on every page via partials/header.ejs,
 * before any other script, so all existing `fetch(...)` calls across the
 * app get this for free without needing to be rewritten individually.
 */
(function () {
  function readCsrfCookie() {
    const match = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return originalFetch(input, init);
    }

    const options = Object.assign({}, init);
    const headers = new Headers(options.headers || {});
    if (!headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', readCsrfCookie());
    }
    options.headers = headers;
    return originalFetch(input, options);
  };
})();
