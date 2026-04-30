/**
 * Tactacam NS Toolkit — Feature Loader (page-specific)
 *
 * Secondary content script injected on specific URL patterns (search pages,
 * transaction pages, script pages, workflow pages) via manifest content_scripts.
 *
 * While the router.js handles generic auto-injection for all /app/* pages,
 * feature-loader.js supplements it for pages where features need to load
 * based on specific URL patterns rather than detected page types.  This is
 * useful when:
 *   - A feature needs its scripts earlier (document_end on a narrow match).
 *   - A feature only applies to a URL shape that the page detector might
 *     classify too broadly.
 *
 * Pattern → feature mappings are defined in PAGE_FEATURES below.
 */
(function () {
  'use strict';

  // Guard against double-init (the manifest may match more than one pattern
  // for the same page, and router.js also runs on /app/*).
  if (window.__tactaFeatureLoaderRan) return;
  window.__tactaFeatureLoaderRan = true;

  // ---------------------------------------------------------------------------
  // Page-pattern → feature mappings
  // ---------------------------------------------------------------------------

  /**
   * Each entry maps a URL test to the feature IDs that should be considered
   * for injection.  The feature must still be enabled in storage; this list
   * only declares *eligibility*.
   */
  const PAGE_FEATURES = [
    {
      test: /\/app\/common\/search\/search\.nl/i,
      features: ['field-finder', 'quick-search-creation', 'saved-search-export']
    },
    {
      test: /\/app\//i,
      features: ['quick-search-creation']
    },
    {
      test: /\/app\/common\/search\/searchresults\.nl/i,
      features: ['saved-search-export', 'fixed-headers']
    },
    {
      test: /\/app\/accounting\/transactions\//i,
      features: ['transaction-tree', 'field-help', 'script-analyzer', 'fixed-headers']
    },
    {
      test: /\/app\/common\/scripting\/script\.nl/i,
      features: ['script-analyzer']
    },
    {
      test: /\/app\/common\/workflow\/setup\//i,
      features: ['workflow-colors']
    }
  ];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Features that have been built and have files on disk.
  const IMPLEMENTED = new Set([
    'field-explorer', 'field-help', 'account-color', 'nav-search',
    'better-page-titles', 'fixed-headers', 'record-object', 'field-finder', 'quick-search-creation',
    'saved-search-export', 'script-analyzer', 'script-explorer', 'transaction-tree', 'split-view',
    'workflow-colors', 'pdf-tools', 'csv-viewer', 'suiteql-runner'
  ]);

  // Features in category subfolders override the default path.
  const FL_PATH_OVERRIDES = {
    'account-color': 'content/features/ns-utils/account-color',
    'nav-search':    'content/features/ns-utils/nav-search'
  };

  function _flBasePath(id) { return FL_PATH_OVERRIDES[id] || `content/features/${id}`; }
  function scriptPath(id) { return `${_flBasePath(id)}/${id}.js`;  }
  function stylePath(id)  { return `${_flBasePath(id)}/${id}.css`; }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  async function run() {
    const url = window.location.href;

    // Determine which features are eligible for this URL.
    const eligible = new Set();
    for (const mapping of PAGE_FEATURES) {
      if (mapping.test.test(url)) {
        mapping.features.forEach((id) => eligible.add(id));
      }
    }

    if (eligible.size === 0) return;

    // Check meeting mode.
    try {
      const data = await chrome.storage.local.get('meetingMode');
      if (data.meetingMode === true) return;
    } catch (_) { /* proceed */ }

    // Check feature states.
    let featureStates = {};
    try {
      const data = await chrome.storage.local.get('featureStates');
      featureStates = data.featureStates || {};
    } catch (_) { /* empty */ }

    // Inject each eligible, enabled feature via background service worker (in parallel).
    const toInject = [...eligible].filter(
      (featureId) => IMPLEMENTED.has(featureId) && featureStates[featureId] === true
    );

    const results = await Promise.allSettled(
      toInject.map((featureId) =>
        chrome.runtime.sendMessage({
          action: 'injectFeatureFiles',
          featureId: featureId,
          css: [stylePath(featureId)],
          js: [scriptPath(featureId)]
        })
      )
    );

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        console.warn(`[Tacta FeatureLoader] Failed to load "${toInject[idx]}":`, result.reason);
      }
    });
  }

  // Execute once the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
