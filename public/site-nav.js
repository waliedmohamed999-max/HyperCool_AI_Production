// Public site: mobile menu toggle. Plain, dependency-free, CSP-safe (script-src 'self').
(function () {
  'use strict';
  var header = document.getElementById('site-header');
  var toggle = document.getElementById('nav-toggle');
  if (!header || !toggle) return;
  function setOpen(open) {
    header.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', function () { setOpen(!header.classList.contains('menu-open')); });
  header.querySelectorAll('nav a').forEach(function (link) { link.addEventListener('click', function () { setOpen(false); }); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { setOpen(false); toggle.focus(); } });
  window.addEventListener('resize', function () { if (window.innerWidth > 1080) setOpen(false); });
})();
