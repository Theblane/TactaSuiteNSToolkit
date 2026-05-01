/**
 * Tactacam NS Toolkit - URL Feature Loader
 *
 * Supplemental URL-based loader for NetSuite pages where page detection can be
 * too broad. It still uses the background registry for feature file paths.
 */
(function () {
  'use strict';

  if (window.__tactaFeatureLoaderRan) return;
  window.__tactaFeatureLoaderRan = true;
  window.__tactaActivatedFeatures = window.__tactaActivatedFeatures || new Set();

  var PAGE_FEATURES = [
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

  function sendMessage(payload) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(payload, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  function isFeatureEnabled(feature, featureStates) {
    return Object.prototype.hasOwnProperty.call(featureStates, feature.id)
      ? featureStates[feature.id] === true
      : feature.defaultEnabled === true;
  }

  async function loadContext() {
    var features = [];
    var featureStates = {};
    var meetingMode = false;

    try {
      features = await sendMessage({ action: 'getFeatures' }) || [];
    } catch (_) {}

    try {
      featureStates = await sendMessage({ action: 'getFeatureStates' }) || {};
    } catch (_) {
      var data = await chrome.storage.local.get('featureStates');
      featureStates = data.featureStates || {};
    }

    try {
      meetingMode = await sendMessage({ action: 'getMeetingMode' });
    } catch (_) {
      var modeData = await chrome.storage.local.get('meetingMode');
      meetingMode = modeData.meetingMode === true;
    }

    return { features: features, featureStates: featureStates, meetingMode: meetingMode === true };
  }

  async function activateFeature(feature) {
    if (window.__tactaActivatedFeatures.has(feature.id)) return;
    await sendMessage({
      action: 'injectFeatureFiles',
      featureId: feature.id,
      css: feature.contentStyles || [],
      js: feature.contentScripts || [],
      injectScripts: feature.injectScripts || []
    });
    window.__tactaActivatedFeatures.add(feature.id);
    window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
      detail: { featureId: feature.id }
    }));
  }

  async function run() {
    var eligible = new Set();
    PAGE_FEATURES.forEach(function (mapping) {
      if (mapping.test.test(window.location.href)) {
        mapping.features.forEach(function (id) { eligible.add(id); });
      }
    });

    if (eligible.size === 0) return;

    var context = await loadContext();
    if (context.meetingMode) return;

    var toInject = context.features.filter(function (feature) {
      return eligible.has(feature.id) && isFeatureEnabled(feature, context.featureStates);
    });

    var results = await Promise.allSettled(toInject.map(function (feature) {
      return activateFeature(feature);
    }));

    results.forEach(function (result, idx) {
      if (result.status === 'rejected') {
        console.warn('[Tacta FeatureLoader] Failed to load "' + toInject[idx].id + '":', result.reason);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
