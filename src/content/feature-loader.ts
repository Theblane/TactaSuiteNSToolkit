/**
 * TactaSuite NS Toolkit - URL Feature Loader
 *
 * @author Blane Maher
 */

import { FeatureDefinition } from '../background/modules/feature-registry';

declare global {
    interface Window {
        __tactaFeatureLoaderRan?: boolean;
        __tactaActivatedFeatures: Set<string>;
        TactaDOM?: { injectStylesheet: (url: string) => Promise<void> };
    }
}

(function () {
  'use strict';

  if (window.__tactaFeatureLoaderRan) return;
  window.__tactaFeatureLoaderRan = true;
  window.__tactaActivatedFeatures = window.__tactaActivatedFeatures || new Set<string>();

  const PAGE_FEATURES: { test: RegExp; features: string[] }[] = [
    {
      test: /\/app\/common\/search\/search\.nl/i,
      features: ['field-finder', 'quick-search-creation', 'saved-search-export', 'suitescript-exporter']
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
      features: ['script-analyzer', 'console-tools']
    },
    {
      test: /\/app\/common\/workflow\/setup\//i,
      features: ['workflow-colors', 'field-finder', 'console-tools']
    },
    {
      test: /\/app\/common\/dataset\//i,
      features: ['suitescript-exporter']
    },
    {
      test: /\/app\/common\/workbook\//i,
      features: ['suitescript-exporter']
    }
  ];

  function sendMessage(payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
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

  function isFeatureEnabled(feature: FeatureDefinition, featureStates: Record<string, boolean>): boolean {
    return Object.prototype.hasOwnProperty.call(featureStates, feature.id)
      ? featureStates[feature.id] === true
      : feature.defaultEnabled === true;
  }

  function splitStylesByMountTarget(styles: string[]): { headCss: string[]; shadowCss: string[] } {
    const globalStyles = [
      'account-color.css',
      'workflow-colors.css',
      'fixed-headers.css',
      'better-page-titles.css',
      'field-finder.css',
      'saved-search-export.css',
      'quick-search-creation.css',
      'suitescript-exporter.css',
      'transaction-tree.css',
      'field-help.css',
      'pdf-tools.css',
      'csv-viewer.css',
      'split-view.css',
      'script-content-search.css',
      'script-analyzer.css'
    ];
    const headCss: string[] = [];
    const shadowCss: string[] = [];

    for (const cssPath of styles) {
      const fileName = cssPath.split('/').pop() || cssPath;
      if (globalStyles.indexOf(fileName) !== -1) headCss.push(cssPath);
      else shadowCss.push(cssPath);
    }

    return { headCss, shadowCss };
  }

  async function loadContext() {
    let features: FeatureDefinition[] = [];
    let featureStates: Record<string, boolean> = {};
    let meetingMode = false;

    try {
      features = await sendMessage({ action: 'getFeatures' }) || [];
    } catch (_) {}

    try {
      featureStates = await sendMessage({ action: 'getFeatureStates' }) || {};
    } catch (_) {
      const data = await chrome.storage.local.get('featureStates');
      featureStates = data.featureStates || {};
    }

    try {
      meetingMode = await sendMessage({ action: 'getMeetingMode' });
    } catch (_) {
      const modeData = await chrome.storage.local.get('meetingMode');
      meetingMode = modeData.meetingMode === true;
    }

    return { features, featureStates, meetingMode: meetingMode === true };
  }

  async function activateFeature(feature: FeatureDefinition): Promise<void> {
    if (window.__tactaActivatedFeatures.has(feature.id)) return;

    if (feature.contentStyles && feature.contentStyles.length > 0) {
      const targets = splitStylesByMountTarget(feature.contentStyles);
      if (window.TactaDOM && typeof window.TactaDOM.injectStylesheet === 'function') {
        for (const cssPath of targets.shadowCss) {
          await window.TactaDOM.injectStylesheet(chrome.runtime.getURL(cssPath));
        }
      }
      if (targets.headCss.length > 0) {
        await sendMessage({
          action: 'injectFeatureFiles',
          featureId: feature.id,
          css: targets.headCss,
          js: [],
          injectScripts: []
        });
      }
    }

    await sendMessage({
      action: 'injectFeatureFiles',
      featureId: feature.id,
      css: [], // Don't inject into main doc anymore
      js: feature.contentScripts || [],
      injectScripts: feature.injectScripts || []
    });
    window.__tactaActivatedFeatures.add(feature.id);
    window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
      detail: { featureId: feature.id }
    }));
  }

  async function run(): Promise<void> {
    const eligible = new Set<string>();
    PAGE_FEATURES.forEach((mapping) => {
      if (mapping.test.test(window.location.href)) {
        mapping.features.forEach((id) => eligible.add(id));
      }
    });

    if (eligible.size === 0) return;

    const context = await loadContext();
    if (context.meetingMode) return;

    const toInject = context.features.filter((feature) => {
      return eligible.has(feature.id) && isFeatureEnabled(feature, context.featureStates);
    });

    const results = await Promise.allSettled(toInject.map((feature) => {
      return activateFeature(feature);
    }));

    results.forEach((result, idx) => {
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
