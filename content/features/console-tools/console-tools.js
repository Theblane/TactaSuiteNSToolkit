/**
 * console-tools.js
 * Extension-world bootstrap for the NetSuite console helper surface.
 */
(function () {
  'use strict';

  if (window.__tactaConsoleToolsLoaded) return;
  window.__tactaConsoleToolsLoaded = true;

  function announce() {
    if (window.TactaDOM && window.TactaDOM.showToast) {
      window.TactaDOM.showToast('Console helpers available as window.TactaNSKit', 'info', 2500);
    }
  }

  window.addEventListener('tacta:consoleToolsReady', announce, { once: true });
})();
