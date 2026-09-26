'use strict';
// Applies the colour theme saved in this browser before the first paint, so pages never flash the
// default. The palettes live in kit.css (html[data-theme="…"]); the picker is under Settings →
// Appearance. Loads after app-meta.js, which sets window.APP.slug (the storage key prefix).
(function () {
  try { const slug = (window.APP && window.APP.slug) || 'bracket'; const t = localStorage.getItem(slug + '.theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* storage blocked: default theme */ }
})();
