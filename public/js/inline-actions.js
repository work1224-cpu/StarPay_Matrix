/**
 * public/js/inline-actions.js
 *
 * Replaces inline onclick="fn()" / onsubmit="fn(event)" attributes (which a
 * strict Content-Security-Policy blocks) with a single delegated listener.
 * Elements instead carry:
 *   data-onclick="fnName"              -> calls window.fnName()
 *   data-onclick="fnName" data-onclick-arg="literal"  -> window.fnName('literal')
 *   data-onclick="fnName" data-onclick-event="1"      -> window.fnName(event)
 *   data-onsubmit="fnName"             -> calls window.fnName(event) on submit
 *
 * Deliberately does NOT use eval() or the Function() constructor — it only
 * ever calls a real, already-declared global function by name, so this is
 * fully compatible with a script-src 'self' CSP (no 'unsafe-eval' needed).
 * Must load after the page's own <script> (which declares these functions
 * on window), so it's placed at the end of partials/footer.ejs.
 */
(function () {
  document.addEventListener('click', function (event) {
    const el = event.target.closest('[data-onclick]');
    if (!el) return;

    const fnName = el.getAttribute('data-onclick');
    const fn = window[fnName];
    if (typeof fn !== 'function') {
      console.error('inline-actions: no such handler on window:', fnName);
      return;
    }

    if (el.hasAttribute('data-onclick-event')) {
      fn(event);
    } else if (el.hasAttribute('data-onclick-arg')) {
      fn(el.getAttribute('data-onclick-arg'));
    } else {
      fn();
    }
  });

  document.addEventListener('submit', function (event) {
    const el = event.target.closest('[data-onsubmit]');
    if (!el) return;

    const fnName = el.getAttribute('data-onsubmit');
    const fn = window[fnName];
    if (typeof fn !== 'function') {
      console.error('inline-actions: no such handler on window:', fnName);
      return;
    }
    fn(event);
  });
})();
