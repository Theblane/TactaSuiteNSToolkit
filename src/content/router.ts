/**
 * TactaSuite NS Toolkit - Content Script Router
 *
 * @author Blane Maher
 */

import { FeatureDefinition } from '../background/modules/feature-registry';
import { PageDescriptor } from './ns-page-detector';

declare global {
    interface Window {
        __tactaRouterLoaded?: boolean;
        __tactaActivatedFeatures: Set<string>;
        __tactaPageInfo?: PageDescriptor;
        TactaThemeManager?: { init: () => void };
        TactaPageDetector?: { detect: () => PageDescriptor };
        TactaDOM?: { injectStylesheet: (url: string) => Promise<void> };
    }
}

(function () {
  'use strict';

  if (window.__tactaRouterLoaded) return;
  window.__tactaRouterLoaded = true;
  window.__tactaActivatedFeatures = window.__tactaActivatedFeatures || new Set<string>();

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

  function onReady(fn: () => void): void {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  async function getFeatureContext() {
    let features: FeatureDefinition[] = [];
    let featureStates: Record<string, boolean> = {};
    let meetingMode = false;

    try {
      features = await sendMessage({ action: 'getFeatures' }) || [];
    } catch (_) {
      features = [];
    }

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

  async function activateFeature(feature: FeatureDefinition, data?: any): Promise<void> {
    if (!feature || !feature.id) return;
    if (window.__tactaActivatedFeatures.has(feature.id)) {
      window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
        detail: { featureId: feature.id, data: data }
      }));
      return;
    }

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
      detail: { featureId: feature.id, data: data }
    }));
  }

  onReady(async () => {
    const context = await getFeatureContext();
    if (context.meetingMode) return;

    if (window.TactaThemeManager) {
      window.TactaThemeManager.init();
    }

    if (!window.TactaPageDetector) return;
    const pageInfo = window.TactaPageDetector.detect();
    window.__tactaPageInfo = pageInfo;

    const autoFeatures = context.features.filter((feature) => {
      return feature.trigger === 'auto' &&
        isFeatureEnabled(feature, context.featureStates) &&
        Array.isArray(feature.pageTypes) &&
        feature.pageTypes.indexOf(pageInfo.type) !== -1;
    });

    const results = await Promise.allSettled(autoFeatures.map((feature) => {
      return activateFeature(feature).catch((err) => {
        throw new Error(feature.id + ': ' + (err.message || err));
      });
    }));

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        console.warn('[Tacta Toolkit] Failed to load feature "' + autoFeatures[idx].id + '":', result.reason);
      }
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === 'activateFeature' && message.featureId) {
      getFeatureContext()
        .then((context) => {
          if (context.meetingMode) throw new Error('Meeting mode is enabled.');
          const feature = context.features.find((f) => f.id === message.featureId);
          if (!feature) throw new Error('Unknown feature: ' + message.featureId);
          if (!isFeatureEnabled(feature, context.featureStates)) {
            throw new Error('Feature is disabled: ' + message.featureId);
          }
          return activateFeature(feature, message.data);
        })
        .then(() => { sendResponse({ success: true }); })
        .catch((err) => { sendResponse({ error: err.message }); });
      return true;
    }

    if (message.action === 'getPageInfo') {
      sendResponse(window.__tactaPageInfo || null);
      return false;
    }
  });
})();
