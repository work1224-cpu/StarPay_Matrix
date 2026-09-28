document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('amcMenuToggle');
  const panel = document.getElementById('amcMenuPanel');
  const closeButton = document.getElementById('amcMenuClose');

  if (!toggle || !panel) return;

  function openMenu() {
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', () => {
    if (panel.hidden) openMenu(); else closeMenu();
  });

  closeButton?.addEventListener('click', closeMenu);

  document.addEventListener('click', (event) => {
    if (!panel.contains(event.target) && event.target !== toggle) {
      closeMenu();
    }
  });
});
