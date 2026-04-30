/**
 * Tactacam NS Toolkit — Content Script Router
 *
 * Main content script injected on every /app/* page. Responsibilities:
 *   1. Wait for DOM ready.
 *   2. Abort if meeting mode is active.
 *   3. Classify the page with TactaPageDetector.
 *   4. Fetch feature toggle states from chrome.storage.
 *   5. Auto-inject enabled features whose pageTypes match the current page.
 *   6. Listen for messages from popup/background to activate on-demand features.
 */
(function () {
  'use strict';

  // Guard against double-init.
  if (window.__tactaRouterLoaded) return;
  window.__tactaRouterLoaded = true;

  // ---------------------------------------------------------------------------
  // Feature registry (lightweight mirror — only metadata needed for routing)
  // ---------------------------------------------------------------------------

  // The full registry lives in background/modules/feature-registry.js. To
  // avoid bundling an ES module in content scripts we duplicate the minimal
  // set of fields needed for routing. This list MUST stay in sync with the
  // background registry.  A build step or shared JSON would be cleaner, but
  // the extension currently has no build tooling.

  const FEATURE_META = [
    { id: 'field-explorer',         trigger: 'popup',       pageTypes: ['record-view','record-edit'] },
    { id: 'script-analyzer',        trigger: 'auto',        pageTypes: ['script-record','record-view','record-edit'] },
    { id: 'script-explorer',        trigger: 'popup',       pageTypes: ['script-record','suitelet','dashboard','other'] },
    { id: 'record-object',          trigger: 'popup',       pageTypes: ['record-view','record-edit'] },
    { id: 'suiteql-runner',         trigger: 'popup',       pageTypes: ['record-view','record-edit','search-results','search-edit','search-list','script-record','suitelet','dashboard','list','setup','other'] },
    { id: 'saved-search-export',    trigger: 'auto',        pageTypes: ['search-results','search-list'] },
    { id: 'field-finder',           trigger: 'auto',        pageTypes: ['search-edit'] },
    { id: 'quick-search-creation',  trigger: 'auto',        pageTypes: ['record-view','record-edit','search-results','search-edit','search-list','script-record','suitelet','dashboard','list','setup','other'] },
    { id: 'field-help',             trigger: 'auto',        pageTypes: ['record-view','record-edit','search-edit','search-results','search-list','script-record','suitelet','dashboard','list','setup','other'] },
    { id: 'transaction-tree',       trigger: 'auto',        pageTypes: ['record-view','record-edit'] },
    { id: 'split-view',             trigger: 'contextmenu', pageTypes: ['record-view','record-edit','search-results','search-edit','list','other'] },
    { id: 'fixed-headers',          trigger: 'auto',        pageTypes: ['record-view','record-edit','search-results','list'] },
    { id: 'account-color',          trigger: 'auto',        pageTypes: ['record-view','record-edit','search-results','search-edit','search-list','script-record','suitelet','dashboard','list','setup','other'] },
    { id: 'nav-search',             trigger: 'auto',        pageTypes: ['record-view','record-edit','search-results','search-edit','search-list','script-record','suitelet','dashboard','list','setup','other'] },
    { id: 'pdf-tools',              trigger: 'auto',        pageTypes: ['pdf-template'] },
    { id: 'csv-viewer',             trigger: 'auto',        pageTypes: ['csv-import'] },
    { id: 'workflow-colors',        trigger: 'auto',        pageTypes: ['workflow'] },
    { id: 'better-page-titles',     trigger: 'auto',        pageTypes: ['record-view','record-edit','search-results','search-edit','search-list','script-record','suitelet','dashboard','list','setup','other'] }
  ];

  // Map id -> paths for content scripts and styles. Follows a predictable
  // convention: content/features/<id>/<id>.js  and .css
  // Features in category subfolders override the default path via PATH_OVERRIDES.
  const PATH_OVERRIDES = {
    'account-color': 'content/features/ns-utils/account-color',
    'nav-search':    'content/features/ns-utils/nav-search'
  };

  function _basePath(id) { return PATH_OVERRIDES[id] || `content/features/${id}`; }
  function scriptPath(id)  { return `${_basePath(id)}/${id}.js`;  }
  function stylePath(id)   { return `${_basePath(id)}/${id}.css`; }
  function clientPath(id)  { return `${_basePath(id)}/${id}-client.js`; }

  // Features that ship a page-world (-client) script.
  const HAS_CLIENT_SCRIPT = new Set([
    'field-explorer', 'field-help', 'suiteql-runner', 'field-finder'
  ]);

  // Features that have been built and have files on disk.
  // Prevents ERR_FILE_NOT_FOUND for registered-but-unbuilt features.
  const IMPLEMENTED = new Set([
    'field-explorer', 'field-help', 'account-color', 'nav-search',
    'better-page-titles', 'fixed-headers', 'record-object', 'field-finder', 'quick-search-creation',
    'saved-search-export', 'script-analyzer', 'script-explorer', 'transaction-tree', 'split-view',
    'workflow-colors', 'pdf-tools', 'csv-viewer', 'suiteql-runner'
  ]);

  // ---------------------------------------------------------------------------
  // Injection helpers
  // ---------------------------------------------------------------------------

  /** Inject a CSS file by creating a <link> element. */
  function injectCSS(path) {
    const url  = chrome.runtime.getURL(path);
    if (document.querySelector(`link[href="${url}"]`)) return;
    const link = document.createElement('link');
    link.rel   = 'stylesheet';
    link.href  = url;
    (document.head || document.documentElement).appendChild(link);
  }

  /** Inject a page-world script via <script> tag (for -client.js files). */
  function injectPageScript(path) {
    return new Promise((resolve, reject) => {
      const url = chrome.runtime.getURL(path);
      if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
      const script  = document.createElement('script');
      script.src    = url;
      script.onload = resolve;
      script.onerror = reject;
      (document.head || document.documentElement).appendChild(script);
    });
  }

  /**
   * Load all resources for a single feature.
   * Content scripts are injected via the background service worker
   * (chrome.scripting.executeScript) so they stay in the extension world
   * and have access to chrome.* APIs.
   * Page-world client scripts are injected via <script> DOM tags.
   *
   * @param {string} featureId - The feature to activate.
   * @param {Object} [data]    - Optional payload (e.g. URL for split-view).
   */
  async function activateFeature(featureId, data) {
    if (!IMPLEMENTED.has(featureId)) {
      return; // Skip unbuilt features silently
    }

    // Ask the background to inject content scripts + styles via chrome.scripting
    // This keeps them in the extension world with full chrome.* API access.
    try {
      await chrome.runtime.sendMessage({
        action: 'injectFeatureFiles',
        featureId: featureId,
        css: [stylePath(featureId)],
        js: [scriptPath(featureId)]
      });
    } catch (err) {
      console.warn(`[Tacta Toolkit] Background injection failed for "${featureId}":`, err);
      return;
    }

    // Page-world client script (needs access to NS globals like require, nlapiGetField)
    if (HAS_CLIENT_SCRIPT.has(featureId)) {
      // Also inject ns-bridge.js first for page-world communication
      try {
        await injectPageScript('shared/ns-bridge.js');
      } catch (_) { /* may already be loaded */ }
      try {
        await injectPageScript(clientPath(featureId));
      } catch (err) {
        console.warn(`[Tacta Toolkit] Client script failed for "${featureId}":`, err);
      }
    }

    // Dispatch a custom event so the feature can pick up any activation data.
    window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
      detail: { featureId, data }
    }));
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(async () => {
    // 1. Check meeting mode — if active, do nothing.
    let meetingMode = false;
    try {
      const data = await chrome.storage.local.get('meetingMode');
      meetingMode = data.meetingMode === true;
    } catch (_) { /* storage unavailable — proceed normally */ }

    if (meetingMode) return;

    // 2. Detect page type.
    if (!window.TactaPageDetector) return;
    const pageInfo = window.TactaPageDetector.detect();

    // Store page info on window for other scripts to read.
    window.__tactaPageInfo = pageInfo;

    // 3. Get feature states.
    let featureStates = {};
    try {
      const data = await chrome.storage.local.get('featureStates');
      featureStates = data.featureStates || {};
    } catch (_) { /* default to empty — nothing auto-loads */ }

    // 4. Auto-inject matching, enabled features (in parallel).
    const autoFeatures = FEATURE_META.filter((meta) =>
      meta.trigger === 'auto' &&
      featureStates[meta.id] === true &&
      meta.pageTypes.includes(pageInfo.type)
    );

    const results = await Promise.allSettled(
      autoFeatures.map((meta) =>
        activateFeature(meta.id).catch((err) => {
          throw new Error(`${meta.id}: ${err.message || err}`);
        })
      )
    );

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        console.warn(`[Tacta Toolkit] Failed to load feature "${autoFeatures[idx].id}":`, result.reason);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Message listener (popup / background / context-menu activation)
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'activateFeature' && message.featureId) {
      activateFeature(message.featureId, message.data)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true; // async sendResponse
    }

    // Allow other scripts to query page info without going through background.
    if (message.action === 'getPageInfo') {
      sendResponse(window.__tactaPageInfo || null);
      return false;
    }
  });
})();
