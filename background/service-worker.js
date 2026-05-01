/**
 * Tactacam NS Toolkit — Background Service Worker
 *
 * No persistent in-memory state — all state in chrome.storage (MV3 best practice).
 *
 * Central coordinator for the extension. Manages feature states, handles
 * messages from popup/content scripts, sets up context menus, and controls
 * the declarativeContent rules that govern when the action icon is visible.
 */

import { FEATURES } from './modules/feature-registry.js';
import { initDefaults, getFeatureStates, setFeatureState, setFeatureStates, getMeetingMode, setMeetingMode } from './modules/storage-manager.js';
import { setupContextMenus } from './modules/context-menu-manager.js';

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    // Persist default feature toggles on first install (or after update adds
    // new features). Existing user preferences are preserved.
    await initDefaults(FEATURES);
  }

  // Context menus
  setupContextMenus();

  // DeclarativeContent — show the action icon only on *.netsuite.com pages
  setupDeclarativeContent();
});

// ---------------------------------------------------------------------------
// DeclarativeContent rules
// ---------------------------------------------------------------------------

function setupDeclarativeContent() {
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostSuffix: '.netsuite.com' }
          })
        ],
        actions: [new chrome.declarativeContent.ShowAction()]
      }
    ]);
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  // Return true to indicate an async sendResponse
  return true;
});

/**
 * Route an incoming message to the appropriate handler.
 *
 * @param {Object} message - The message payload; must include an `action` key.
 * @param {Object} sender  - Chrome message sender info (includes tab).
 * @returns {Promise<*>} Resolved value is sent back to the caller.
 */
async function handleMessage(message, sender) {
  switch (message.action) {
    // -- Feature registry -----------------------------------------------------
    case 'getFeatures':
      return FEATURES;

    // -- Feature toggles ----------------------------------------------------
    case 'getFeatureStates':
      return getFeatureStates();

    case 'setFeatureState':
      await setFeatureState(message.featureId, message.enabled);
      return { success: true };

    case 'setFeatureStates':
      await setFeatureStates(message.states);
      return { success: true };

    // -- AI test connection (from options page) -----------------------------
    case 'testAIConnection': {
      const aiSettings = await chrome.storage.local.get(['tacta_ai_api_key', 'tacta_ai_model']);
      const testKey = aiSettings.tacta_ai_api_key;
      if (!testKey) return { error: 'No API key configured' };
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': testKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: aiSettings.tacta_ai_model || 'claude-sonnet-4-5-20250514',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Reply with OK' }]
          })
        });
        if (resp.ok) return { success: true };
        const errData = await resp.json().catch(() => ({}));
        return { status: resp.status, error: errData.error?.message || resp.statusText };
      } catch (e) {
        return { error: e.message };
      }
    }

    // -- Inject specific files for a feature (from router) ------------------
    case 'injectFeatureFiles': {
      const tabId = message.tabId || sender?.tab?.id;
      if (!tabId) throw new Error('No tab ID available');
      if (message.featureId) {
        await assertFeatureCanRun(message.featureId);
      }
      if (message.css?.length) {
        await chrome.scripting.insertCSS({ target: { tabId }, files: message.css }).catch(e => console.warn('CSS injection failed:', e));
      }
      if (message.injectScripts?.length) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['shared/ns-bridge.js'],
          world: 'MAIN'
        }).catch(() => {});
        await chrome.scripting.executeScript({
          target: { tabId },
          files: message.injectScripts,
          world: 'MAIN'
        });
      }
      if (message.js?.length) {
        await chrome.scripting.executeScript({ target: { tabId }, files: message.js });
      }
      return { success: true };
    }

    // -- On-demand feature injection ----------------------------------------
    case 'executeFeature': {
      const feature = FEATURES.find((f) => f.id === message.featureId);
      if (!feature) {
        throw new Error(`Unknown feature: ${message.featureId}`);
      }
      await assertFeatureCanRun(feature.id);
      const targetTabId = message.tabId || sender?.tab?.id;
      if (!targetTabId) throw new Error('No tab ID available');
      return executeFeatureScripts(feature, targetTabId);
    }

    // -- Meeting mode -------------------------------------------------------
    case 'getMeetingMode':
      return getMeetingMode();

    case 'setMeetingMode':
      await setMeetingMode(message.enabled);
      return { success: true };

    // -- Page info ----------------------------------------------------------
    case 'getPageInfo':
      return getPageInfo(message.tabId);

    // -- SuiteQL execution (used by script-analyzer, transaction-tree, script-explorer)
    case 'executeSuiteQL': {
      const sqlTabId = message.tabId || sender?.tab?.id;
      if (!sqlTabId) throw new Error('No tab ID available');
      return executeSuiteQL(sqlTabId, message.query, message.params);
    }

    // -- Field Explorer operations (direct page-world injection) ------------
    case 'getRecordFields': {
      const feTabId = message.tabId || sender?.tab?.id;
      if (!feTabId) throw new Error('No tab ID available');
      return nsRunInPage(feTabId, feGetRecordFieldsFn, []);
    }

    case 'getSelectOptions': {
      const soTabId = message.tabId || sender?.tab?.id;
      if (!soTabId) throw new Error('No tab ID available');
      return nsRunInPage(soTabId, feGetSelectOptionsFn, [message.fieldId, message.sublistId, message.line]);
    }

    case 'setFieldValue': {
      const sfTabId = message.tabId || sender?.tab?.id;
      if (!sfTabId) throw new Error('No tab ID available');
      return nsRunInPage(sfTabId, feSetFieldValueFn, [message.fieldId, message.value, message.sublistId, message.line]);
    }

    case 'setFieldAttribute': {
      const saTabId = message.tabId || sender?.tab?.id;
      if (!saTabId) throw new Error('No tab ID available');
      return nsRunInPage(saTabId, feSetFieldAttributeFn, [message.fieldId, message.attr, message.value]);
    }

    // -- AI Settings (SuiteQL Runner) ----------------------------------------
    case 'getAISettings': {
      const data = await chrome.storage.local.get(['tacta_ai_api_key', 'tacta_ai_model']);
      return {
        apiKey: data.tacta_ai_api_key || '',
        model: data.tacta_ai_model || 'claude-sonnet-4-5-20250514'
      };
    }

    case 'setAISettings': {
      await chrome.storage.local.set({
        tacta_ai_api_key: message.apiKey || '',
        tacta_ai_model: message.model || 'claude-sonnet-4-5-20250514'
      });
      return { success: true };
    }

    // -- AI Generate SuiteQL Query ------------------------------------------
    case 'aiGenerateQuery': {
      return callClaudeAPI(message.prompt, 'suiteql', message.context);
    }

    // -- AI Generate Saved Search Definition --------------------------------
    case 'aiGenerateSavedSearch': {
      return callClaudeAPI(message.prompt, 'saved-search', message.context);
    }

    // -- Preview Saved Search (run without saving) --------------------------
    case 'previewSavedSearch': {
      const psTabId = message.tabId || sender?.tab?.id;
      if (!psTabId) throw new Error('No tab ID available');
      return nsRunInPage(psTabId, previewSavedSearchFn, [message.searchDef]);
    }

    // -- Create Saved Search ------------------------------------------------
    case 'createSavedSearch': {
      const csTabId = message.tabId || sender?.tab?.id;
      if (!csTabId) throw new Error('No tab ID available');
      return nsRunInPage(csTabId, createSavedSearchFn, [message.searchDef, message.title]);
    }

    // -- Custom field metadata (formula, source list, definition link) -----
    case 'getCustomFieldMeta': {
      const cfTabId = message.tabId || sender?.tab?.id;
      if (!cfTabId) throw new Error('No tab ID available');
      return nsRunInPage(cfTabId, getCustomFieldMetaFn, [message.fieldId]);
    }

    // -- Source record link for select/list fields -------------------------
    case 'getFieldSourceLink': {
      const slTabId = message.tabId || sender?.tab?.id;
      if (!slTabId) throw new Error('No tab ID available');
      return nsRunInPage(slTabId, getFieldSourceLinkFn, [message.fieldId]);
    }

    default:
      throw new Error(`Unrecognised action: ${message.action}`);
  }
}

async function assertFeatureCanRun(featureId) {
  const feature = FEATURES.find((f) => f.id === featureId);
  if (!feature) {
    throw new Error(`Unknown feature: ${featureId}`);
  }

  if (await getMeetingMode()) {
    throw new Error('Meeting mode is enabled.');
  }

  const states = await getFeatureStates();
  const enabled = featureId in states ? states[featureId] === true : feature.defaultEnabled === true;
  if (!enabled) {
    throw new Error(`Feature is disabled: ${featureId}`);
  }
}

// ---------------------------------------------------------------------------
// SuiteQL execution (used by script-analyzer, transaction-tree, script-explorer)
// ---------------------------------------------------------------------------

async function executeSuiteQL(tabId, query, params) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('No query provided.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [query.trim(), params || null],
    func: (queryString, queryParams) => {
      return new Promise((resolve) => {
        if (typeof require !== 'function') {
          resolve({ error: 'NetSuite require() is not available on this page.' });
          return;
        }
        try {
          require(['N/query'], (queryModule) => {
            try {
              const startTime = performance.now();
              const PAGE_SIZE = 5000;
              const MAX_ROWS = 200000;

              const firstOpts = { query: queryString };
              if (queryParams && Array.isArray(queryParams) && queryParams.length > 0) {
                firstOpts.params = queryParams;
              }
              const firstResultSet = queryModule.runSuiteQL(firstOpts);

              let columns = [];
              if (firstResultSet.columns && firstResultSet.columns.length > 0) {
                for (let c = 0; c < firstResultSet.columns.length; c++) {
                  const col = firstResultSet.columns[c];
                  columns.push(col.label || col.alias || ('column_' + c));
                }
              }

              let allRows = firstResultSet.asMappedResults();

              if (columns.length === 0 && allRows.length > 0) {
                columns = Object.keys(allRows[0]);
              }

              if (allRows.length >= PAGE_SIZE) {
                let currentBegin = PAGE_SIZE + 1;
                let moreRecords = true;
                while (moreRecords && allRows.length < MAX_ROWS) {
                  const rowEnd = currentBegin + PAGE_SIZE - 1;
                  const pagedSql =
                    'SELECT * FROM ( SELECT ROWNUM AS rownumber__, t__.* FROM ( ' +
                    queryString +
                    ' ) t__ ) WHERE rownumber__ BETWEEN ' + currentBegin + ' AND ' + rowEnd;
                  const pageOpts = { query: pagedSql };
                  if (queryParams && Array.isArray(queryParams) && queryParams.length > 0) {
                    pageOpts.params = queryParams;
                  }
                  const pageResult = queryModule.runSuiteQL(pageOpts);
                  const pageRows = pageResult.asMappedResults();
                  for (let r = 0; r < pageRows.length; r++) {
                    delete pageRows[r].rownumber__;
                    allRows.push(pageRows[r]);
                  }
                  if (pageRows.length < PAGE_SIZE) moreRecords = false;
                  currentBegin += PAGE_SIZE;
                }
              }

              columns = columns.filter(c => c !== 'rownumber__');
              const truncated = allRows.length >= MAX_ROWS;
              const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
              const executionTime = Math.round(performance.now() - startTime);

              resolve({ columns, rows, count: rows.length, executionTime, truncated });
            } catch (e) {
              resolve({ error: e.message || String(e) });
            }
          }, (err) => {
            resolve({ error: 'Failed to load N/query: ' + (err?.message || String(err)) });
          });
        } catch (e) {
          resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
      });
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('No result returned from page execution.');
  if (result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Generic page-world execution helper
// ---------------------------------------------------------------------------

async function nsRunInPage(tabId, func, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  });
  const result = results?.[0]?.result;
  if (result === undefined) throw new Error('No result from page.');
  if (result && result.error) throw new Error(result.error);
  return result;
}

// ---------------------------------------------------------------------------
// Feature injection
// ---------------------------------------------------------------------------

/**
 * Inject a feature's content scripts into the given tab using
 * chrome.scripting.executeScript.
 *
 * @param {Object} feature - A feature descriptor from the registry.
 * @param {number} tabId   - The target tab.
 */
async function executeFeatureScripts(feature, tabId) {
  // Ensure shared dependencies are available (they may already be loaded via
  // manifest content_scripts, but executeScript is idempotent for IIFEs that
  // guard against re-initialisation).
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['shared/ns-utils.js', 'shared/storage-utils.js', 'shared/dom-utils.js']
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['shared/theme-vars.css', 'shared/tactacam-ui.css']
  });

  // Inject feature stylesheets (ignore errors for missing files).
  if (feature.contentStyles?.length) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: feature.contentStyles
    }).catch(() => {});
  }

  // Inject page-world scripts first (so bridge handlers are ready before
  // content scripts try to communicate with them).
  if (feature.injectScripts?.length) {
    // Inject the bridge first
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/ns-bridge.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: feature.injectScripts,
      world: 'MAIN'
    });
  }

  // Inject content scripts (extension world).
  if (feature.contentScripts?.length) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: feature.contentScripts
    });
  }

  // Send activation signal so the feature knows to show its UI.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (featureId) => {
      window.dispatchEvent(new CustomEvent('tacta:featureActivated', {
        detail: { featureId }
      }));
    },
    args: [feature.id]
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// Page info
// ---------------------------------------------------------------------------

/**
 * Execute the page detector inside the given tab and return the result.
 *
 * @param {number} tabId - The target tab.
 * @returns {Promise<Object>} Parsed page info.
 */
async function getPageInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (typeof window.TactaPageDetector !== 'undefined') {
        return window.TactaPageDetector.detect();
      }
      return null;
    }
  });

  return results?.[0]?.result ?? null;
}

// ---------------------------------------------------------------------------
// Field Explorer page-world functions
// ---------------------------------------------------------------------------

function feGetRecordFieldsFn() {
  function ser(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') { try { return JSON.parse(JSON.stringify(v)); } catch(_) { return String(v); } }
    return v;
  }
  function normType(t) {
    if (!t) return 'Unknown';
    const m = {text:'Free-Form Text',textarea:'Text Area',richtext:'Rich Text',email:'Email',url:'URL',
      phone:'Phone',integer:'Integer',float:'Decimal',currency:'Currency',percent:'Percent',
      date:'Date',datetime:'Date/Time',checkbox:'Check Box',select:'List/Record',
      multiselect:'Multi-Select',radio:'Radio',inlinehtml:'Inline HTML',longtext:'Long Text'};
    return m[String(t).toLowerCase()] || t;
  }
  // Uses SuiteScript 1.0 globals (nlapiGetField, nlapiGetFieldValue) which are
  // always available on NS record pages — no require() needed. Same approach
  // as the NetSuite Advanced Field Help reference extension.

  const result = { bodyFields: [], sublists: {} };

  // Scan DOM for all field IDs
  const seen = {};
  const fieldIds = [];
  const formEls = document.querySelectorAll('#main_form input[id], #main_form select[id], #main_form textarea[id]');
  for (let i = 0; i < formEls.length; i++) {
    let id = formEls[i].id;
    if (!id || seen[id]) continue;
    if (/^(sys_|__|submitter|wfSR|nsapiPI|nsapiFC|nsapiLC|nsapiPS|nsapiVF|nsapiRC|hddn|uir-)|_display$|_lbl$|_label$|_help$|_err$|_fs$|_popup|_arrow|_hdn$/.test(id)) continue;
    if (/row\d+$/.test(id)) continue;
    // Skip sublist cells
    if (formEls[i].closest('.uir-machine-table-container, .uir-sublist')) continue;
    if (seen[id]) continue;
    seen[id] = true;
    fieldIds.push(id);
  }

  // Also try SS2 getFields() if available (catches hidden fields not in DOM)
  try {
    if (window.currentRecord && typeof window.currentRecord.getFields === 'function') {
      const ss2Ids = window.currentRecord.getFields();
      for (let j = 0; j < ss2Ids.length; j++) {
        if (!seen[ss2Ids[j]]) { fieldIds.push(ss2Ids[j]); seen[ss2Ids[j]] = true; }
      }
    }
  } catch(_) {}

  // Get metadata for each field using SS1 APIs
  for (let i = 0; i < fieldIds.length; i++) {
    const fid = fieldIds[i];
    let label = '', type = 'unknown', value = null, text = null;
    let isMandatory = false, isDisabled = false, isHidden = false;

    // SS1: nlapiGetField
    try {
      if (typeof nlapiGetField === 'function') {
        const f = nlapiGetField(fid);
        if (f) {
          try { label = f.getLabel ? f.getLabel() : ''; } catch(_) {}
          try { type = f.getType ? f.getType() : ''; } catch(_) {}
          try { isMandatory = f.isMandatory ? f.isMandatory() : (f.required || false); } catch(_) {}
          try { isDisabled = f.isDisabled ? f.isDisabled() : (f.disabled || false); } catch(_) {}
          try { isHidden = f.isHidden ? f.isHidden() : false; } catch(_) {}
        }
      }
    } catch(_) {}

    // SS1: values (try multi-select first, fall back to single)
    try {
      if (typeof nlapiGetFieldValues === 'function') {
        const multiVals = nlapiGetFieldValues(fid);
        if (multiVals && multiVals.length > 0) {
          value = multiVals.join(', ');
        }
      }
    } catch(_) {}
    if (value === null) {
      try { if (typeof nlapiGetFieldValue === 'function') value = nlapiGetFieldValue(fid); } catch(_) {}
    }
    try {
      if (typeof nlapiGetFieldTexts === 'function') {
        const multiTexts = nlapiGetFieldTexts(fid);
        if (multiTexts && multiTexts.length > 0) {
          text = multiTexts.join(', ');
        }
      }
    } catch(_) {}
    if (!text) {
      try { if (typeof nlapiGetFieldText === 'function') text = nlapiGetFieldText(fid); } catch(_) {}
    }

    // DOM hidden/disabled check — search multiple ID patterns NS uses
    if (!isHidden || !isDisabled) {
      const el = document.getElementById(fid) || document.getElementById(fid + '_display')
                || document.getElementById(fid + '_val') || document.getElementById(fid + '_fs_lbl')
                || document.getElementById('inpt_' + fid);
      if (el) {
        if (!isHidden) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') isHidden = true;
          if (!isHidden) {
            const row = el.closest('tr');
            if (row) { const rs = window.getComputedStyle(row); if (rs.display === 'none' || rs.visibility === 'hidden') isHidden = true; }
          }
        }
        // Check disabled from DOM if SS1 didn't report it
        if (!isDisabled && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly)) {
          isDisabled = true;
        }
      }
      // If element not found by any ID pattern, check if there's a containing row
      // with a label for this field — if yes, the field exists but uses non-standard rendering
      if (!el) {
        const lbl = document.querySelector('label[for="' + fid + '"], label[for="' + fid + '_display"]');
        const rowEl = lbl ? lbl.closest('tr') : null;
        if (rowEl) {
          const rs = window.getComputedStyle(rowEl);
          isHidden = (rs.display === 'none' || rs.visibility === 'hidden');
        }
        // Don't assume hidden just because we can't find the element —
        // many fields (view mode, inline text) have non-standard DOM IDs
      }
    }

    // DOM label fallback
    if (!label) {
      const lbl = document.querySelector('label[for="' + fid + '"], label[for="' + fid + '_display"]');
      if (lbl) label = (lbl.textContent || '').trim();
      if (!label) {
        const el2 = document.getElementById(fid) || document.getElementById(fid + '_display');
        if (el2) { const row = el2.closest('tr'); if (row) { const lc = row.querySelector('.smalltextnolink, .smalltext, .uir-label span'); if (lc) label = (lc.textContent || '').trim(); } }
      }
    }

    type = normType(type);
    if (value !== null && value !== undefined && typeof value === 'object') {
      try { value = JSON.parse(JSON.stringify(value)); } catch(_) { value = String(value); }
    }

    result.bodyFields.push({ id: fid, label, type, value: (value === undefined ? null : value), text: text || null, isMandatory, isDisabled, isHidden });
  }

  // Sublists — detect from DOM using multiple strategies
  const slSeen = {};

  function trySublist(name) {
    if (!name || slSeen[name]) return;
    // SS1 check
    try {
      if (typeof nlapiGetLineItemCount === 'function') {
        const c = nlapiGetLineItemCount(name);
        if (c >= 0) { slSeen[name] = true; return; }
      }
    } catch(_) {}
    // SS2 check via window.currentRecord
    try {
      if (window.currentRecord && typeof window.currentRecord.getLineCount === 'function') {
        const c = window.currentRecord.getLineCount({ sublistId: name });
        if (c >= 0) { slSeen[name] = true; return; }
      }
    } catch(_) {}
  }

  // Strategy 1: Look for sublist table containers (most reliable)
  document.querySelectorAll('.uir-machine-table-container[id]').forEach((el) => {
    // ID format: "item_splits" or similar
    const m = el.id.match(/^(.+?)_splits$/);
    if (m && m[1]) trySublist(m[1]);
  });

  // Strategy 2: Subtab elements
  document.querySelectorAll('[id$="_subtab"], [id$="subtab"]').forEach((el) => {
    const m = el.id.match(/^(.+?)_?subtab$/);
    if (m && m[1]) trySublist(m[1]);
  });

  // Strategy 3: div__body elements
  document.querySelectorAll('div[id^="div__body"]').forEach((el) => {
    const name = el.id.replace(/^div__body/, '').replace(/tab$/, '');
    if (name) trySublist(name);
  });

  // Strategy 4: Machine header rows (the actual sublist tables)
  document.querySelectorAll('.uir-machine-headerrow').forEach((el) => {
    const table = el.closest('table[id]');
    if (table) {
      const m = table.id.match(/^(.+?)(?:_splits|_layer|header)$/);
      if (m && m[1]) trySublist(m[1]);
    }
  });

  // Strategy 5: Known common sublist IDs
  ['item','line','expense','apply','deposit','partners','salesteam',
   'addresses','addressbook','links','mediaitem','payment','contacts',
   'recmachcustrecord','custpage','inventoryassignment','billingschedule',
   'revrecschedule','installment'].forEach(trySublist);

  // Build sublist field data
  Object.keys(slSeen).forEach((slId) => {
    let lc = 0;
    try {
      if (typeof nlapiGetLineItemCount === 'function') lc = nlapiGetLineItemCount(slId);
    } catch(_) {}
    if (lc <= 0) {
      try {
        if (window.currentRecord) lc = window.currentRecord.getLineCount({ sublistId: slId });
      } catch(_) {}
    }

    const fields = [];
    const fieldSeen = {};

    // Get field IDs from DOM headers (data-field attribute)
    document.querySelectorAll('#' + slId + '_splits .uir-machine-headerrow td[data-field]').forEach((td) => {
      const f = td.getAttribute('data-field');
      if (f && !fieldSeen[f]) {
        fieldSeen[f] = true;
        const meta = { id: f, label: (td.textContent || '').trim(), type: 'unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false };
        if (lc > 0) {
          try { if (typeof nlapiGetLineItemValue === 'function') meta.value = nlapiGetLineItemValue(slId, f, 1); } catch(_) {}
          try { if (typeof nlapiGetLineItemText === 'function') meta.text = nlapiGetLineItemText(slId, f, 1); } catch(_) {}
        }
        fields.push(meta);
      }
    });

    // Also scan header row by ID pattern: {sublistId}header
    if (fields.length === 0) {
      document.querySelectorAll('tr[id="' + slId + 'header"] td, #' + slId + '_header .listheadertd').forEach((td) => {
        const f = td.getAttribute('data-field');
        if (f && !fieldSeen[f]) {
          fieldSeen[f] = true;
          fields.push({ id: f, label: (td.textContent || '').trim(), type: 'unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false });
        }
      });
    }

    // Fallback: scan first data row for input/select elements
    if (fields.length === 0) {
      const firstRow = document.querySelector('#' + slId + '_splits .uir-machine-row-odd, #' + slId + '_splits .uir-machine-row-even, #' + slId + 'row0');
      if (firstRow) {
        firstRow.querySelectorAll('input[id], select[id], textarea[id], span[id]').forEach((inp) => {
          let fName = inp.id.replace(new RegExp('^' + slId + '_'), '').replace(/_\d+$/, '').replace(/_display$/, '');
          if (fName && !fieldSeen[fName] && fName !== slId) {
            fieldSeen[fName] = true;
            let val = null, txt = null;
            try { if (typeof nlapiGetLineItemValue === 'function' && lc > 0) val = nlapiGetLineItemValue(slId, fName, 1); } catch(_) {}
            try { if (typeof nlapiGetLineItemText === 'function' && lc > 0) txt = nlapiGetLineItemText(slId, fName, 1); } catch(_) {}
            fields.push({ id: fName, label: '', type: 'unknown', value: val, text: txt, isMandatory: false, isDisabled: false, isHidden: false });
          }
        });
      }
    }

    // SS2: try getSublistFields for any we missed
    try {
      if (window.currentRecord && typeof window.currentRecord.getSublistFields === 'function') {
        const ss2Fields = window.currentRecord.getSublistFields({ sublistId: slId }) || [];
        for (let fi = 0; fi < ss2Fields.length; fi++) {
          if (!fieldSeen[ss2Fields[fi]]) {
            fieldSeen[ss2Fields[fi]] = true;
            const meta = { id: ss2Fields[fi], label: '', type: 'unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false };
            try {
              const sf = window.currentRecord.getSublistField({ sublistId: slId, fieldId: ss2Fields[fi], line: 0 });
              if (sf) { meta.label = sf.label || ''; meta.type = normType(sf.type || ''); }
            } catch(_) {}
            if (lc > 0) {
              try { meta.value = window.currentRecord.getSublistValue({ sublistId: slId, fieldId: ss2Fields[fi], line: 0 }); } catch(_) {}
              try { meta.text = window.currentRecord.getSublistText({ sublistId: slId, fieldId: ss2Fields[fi], line: 0 }); } catch(_) {}
            }
            fields.push(meta);
          }
        }
      }
    } catch(_) {}

    result.sublists[slId] = { fields, lineCount: lc };
  });

  return result;
}

function feGetSelectOptionsFn(fieldId, sublistId, line) {
  if (!fieldId) return {fieldId, options:[]};
  const options = [];

  // Method 1: Read data-options from NS dropdown DOM element (same as reference extension)
  try {
    const dropdown = document.querySelector('.ns-dropdown[data-name="' + fieldId + '"]');
    if (dropdown) {
      const dataOpts = dropdown.getAttribute('data-options');
      if (dataOpts) {
        const parsed = JSON.parse(dataOpts);
        for (let i = 0; i < parsed.length; i++) {
          if (parsed[i].value) options.push({ value: String(parsed[i].value), text: parsed[i].text || String(parsed[i].value) });
        }
      }
    }
  } catch(_) {}

  // Method 2: Read from the native select dropdown (getDropdown pattern from reference)
  if (options.length === 0) {
    try {
      const inpt = document.getElementsByName('inpt_' + fieldId)[0];
      if (inpt && typeof getDropdown === 'function') {
        const dd = getDropdown(inpt);
        if (dd && dd.valueArray) {
          for (let i = 0; i < dd.valueArray.length; i++) {
            if (dd.valueArray[i]) options.push({ value: String(dd.valueArray[i]), text: dd.textArray[i] || String(dd.valueArray[i]) });
          }
        }
      }
    } catch(_) {}
  }

  // Method 3: SS2 field.getSelectOptions if window.currentRecord is available
  if (options.length === 0) {
    try {
      if (window.currentRecord && typeof window.currentRecord.getField === 'function') {
        const field = sublistId
          ? window.currentRecord.getSublistField({ sublistId, fieldId, line: (line != null ? line : 0) })
          : window.currentRecord.getField({ fieldId });
        if (field && typeof field.getSelectOptions === 'function') {
          const raw = field.getSelectOptions({ filter: undefined, operator: undefined });
          if (raw && raw.length) {
            for (let i = 0; i < raw.length; i++) options.push({ value: String(raw[i].value), text: raw[i].text || String(raw[i].value) });
          }
        }
      }
    } catch(_) {}
  }

  // Method 4: SS1 nlapiGetField().getSelectOptions()
  if (options.length === 0) {
    try {
      if (typeof nlapiGetField === 'function') {
        const f = nlapiGetField(fieldId);
        if (f && typeof f.getSelectOptions === 'function') {
          const raw = f.getSelectOptions();
          if (raw && raw.length) {
            for (let i = 0; i < raw.length; i++) options.push({ value: String(raw[i].getId()), text: raw[i].getText() || String(raw[i].getId()) });
          }
        }
      }
    } catch(_) {}
  }

  return { fieldId, options };
}

function feSetFieldValueFn(fieldId, value, sublistId, line) {
  if (!fieldId) return {error:'fieldId required'};

  // Use SS1 globals (always available, no require needed)
  try {
    if (sublistId && line != null && typeof nlapiSetLineItemValue === 'function') {
      nlapiSetLineItemValue(sublistId, fieldId, line + 1, value); // SS1 uses 1-based lines
      const newValue = typeof nlapiGetLineItemValue === 'function' ? nlapiGetLineItemValue(sublistId, fieldId, line + 1) : value;
      const newText = typeof nlapiGetLineItemText === 'function' ? nlapiGetLineItemText(sublistId, fieldId, line + 1) : null;
      return { success: true, fieldId, newValue, newText };
    } else if (typeof nlapiSetFieldValue === 'function') {
      nlapiSetFieldValue(fieldId, value, true, false);
      const newValue = typeof nlapiGetFieldValue === 'function' ? nlapiGetFieldValue(fieldId) : value;
      const newText = typeof nlapiGetFieldText === 'function' ? nlapiGetFieldText(fieldId) : null;
      return { success: true, fieldId, newValue, newText };
    }
  } catch(e) { return { error: e.message }; }

  return { error: 'No NetSuite API available to set field value' };
}

function feSetFieldAttributeFn(fieldId, attr, value) {
  if (!fieldId || !attr) return { error: 'fieldId and attr required' };
  try {
    if (attr === 'mandatory') {
      if (typeof nlapiSetFieldMandatory === 'function') {
        nlapiSetFieldMandatory(fieldId, !!value);
        return { success: true, fieldId, attr, value: !!value };
      }
    } else if (attr === 'disabled') {
      if (typeof nlapiSetFieldDisabled === 'function') {
        nlapiSetFieldDisabled(fieldId, !!value);
        return { success: true, fieldId, attr, value: !!value };
      }
    }
  } catch(e) { return { error: e.message }; }
  return { error: 'API not available for ' + attr };
}

// ---------------------------------------------------------------------------
// Claude AI API helper (SuiteQL Runner)
// ---------------------------------------------------------------------------

async function callClaudeAPI(userPrompt, mode, context) {
    const settings = await chrome.storage.local.get(['tacta_ai_api_key', 'tacta_ai_model']);
    const apiKey = settings.tacta_ai_api_key;
    if (!apiKey) throw new Error('Claude API key not configured. Go to Extension Settings to add your key.');

    const model = settings.tacta_ai_model || 'claude-sonnet-4-5-20250514';

    let systemPrompt;
    if (mode === 'suiteql') {
        systemPrompt = `You are a NetSuite SuiteQL expert. Generate a SuiteQL query based on the user's request.

SuiteQL is Oracle-based SQL used in NetSuite. Key differences from standard SQL:
- Use BUILTIN.DF() to get display/text values for foreign key fields (e.g., BUILTIN.DF(entity) for customer name)
- Use BUILTIN.CF() for currency formatting
- Table names: transaction, transactionline, customer, item, vendor, employee, account, subsidiary, department, location, classification, contact, entity, file, folder, note, message, customrecord_*, etc.
- Common transaction fields: id, tranid, type, entity, trandate, status, memo, amount, netamount, foreigntotal
- Common transactionline fields: transaction, item, quantity, rate, amount, line, subsidiary, department, location, class
- JOIN syntax: use standard SQL JOINs
- Date functions: TO_DATE('2024-01-01', 'YYYY-MM-DD'), ADD_MONTHS(SYSDATE, -3), TRUNC(SYSDATE)
- String functions: UPPER(), LOWER(), SUBSTR(), INSTR(), NVL(), NVL2()
- Pagination: use ROWNUM for limiting rows, or FETCH FIRST N ROWS ONLY
- Transaction types: 'SalesOrd', 'CustInvc', 'ItemShip', 'VendBill', 'PurchOrd', 'CashSale', 'CustPymt', 'Journal', 'Transfer', 'InvAdjst', etc.
- Transaction statuses vary by type. Use BUILTIN.DF(status) to see readable status.
- For custom records: customrecord_xxx with custom fields custrecord_xxx
- Always use table aliases for clarity
- No CREATE, INSERT, UPDATE, DELETE — SuiteQL is read-only

${context?.tables ? `\nAvailable custom tables in this account: ${context.tables.join(', ')}` : ''}

Respond with ONLY a JSON object (no markdown, no code fences):
{"query": "YOUR SQL HERE", "explanation": "Brief explanation of what the query does"}`;
    } else {
        systemPrompt = `You are a NetSuite Saved Search expert. Generate a saved search definition based on the user's request.

NetSuite saved searches use these components:
- type: The record type (e.g., "transaction", "customer", "item", "employee", "vendor", "salesorder", "invoice", "purchaseorder", "contact", "customrecord_xxx")
- filters: Array of filter expressions. Each filter is [fieldId, operator, value] or [fieldId, operator, value1, value2]. Filters are joined with "AND" or "OR" strings between them. Operators: "is", "isnot", "anyof", "noneof", "startswith", "contains", "doesnotcontain", "isempty", "isnotempty", "equalto", "notequalto", "lessthan", "greaterthan", "between", "within", "before", "after", "onorbefore", "onorafter", "haskeywords"
- columns: Array of column objects with: name (field ID), label (optional display name), sort (optional: "ASC" or "DESC"), summary (optional: "GROUP", "SUM", "COUNT", "AVG", "MIN", "MAX"), join (optional: join ID like "customer" or "item"), formula (optional: formula expression), formulatype (optional: "currency", "date", "float", "integer", "percent", "text")
- For joined fields, use the join property: { name: "email", join: "customer" }
- Common filters: ["mainline", "is", "T"], ["type", "anyof", "SalesOrd"], ["trandate", "within", "lastmonth"]
- Date filter values: "today", "yesterday", "lastweek", "lastmonth", "lastquarter", "lastyear", "thisweek", "thismonth", "thisquarter", "thisyear", "lastsevendays", "lastthirtydays", "lastsixtydays", "lastninetydays"

Respond with ONLY a JSON object (no markdown, no code fences):
{"searchDef": {"type": "record_type", "filters": [...], "columns": [...]}, "explanation": "Brief explanation of what this search finds"}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model,
            max_tokens: 2048,
            messages: [
                { role: 'user', content: userPrompt }
            ],
            system: systemPrompt
        })
    });

    if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 401) throw new Error('Invalid Claude API key. Check your key in Extension Settings.');
        if (response.status === 429) throw new Error('Rate limit exceeded. Please wait a moment and try again.');
        throw new Error(`Claude API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) throw new Error('No response from Claude API.');

    try {
        return JSON.parse(content);
    } catch {
        // If Claude returned markdown-wrapped JSON, try to extract it
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('Could not parse Claude response as JSON.');
    }
}

// ---------------------------------------------------------------------------
// Saved Search preview (page-world function for nsRunInPage)
// ---------------------------------------------------------------------------

function previewSavedSearchFn(searchDef) {
    return new Promise((resolve) => {
        if (typeof require !== 'function') {
            resolve({ error: 'NetSuite require() is not available on this page.' });
            return;
        }
        try {
            require(['N/search'], (searchModule) => {
                try {
                    const searchObj = searchModule.create({
                        type: searchDef.type,
                        filters: searchDef.filters || [],
                        columns: (searchDef.columns || []).map(col => {
                            const colDef = { name: col.name };
                            if (col.join) colDef.join = col.join;
                            if (col.summary) colDef.summary = searchModule.Summary[col.summary];
                            if (col.formula) colDef.formula = col.formula;
                            if (col.formulatype) colDef.formulaType = col.formulatype;
                            if (col.sort) colDef.sort = searchModule.Sort[col.sort];
                            if (col.label) colDef.label = col.label;
                            return searchModule.createColumn(colDef);
                        })
                    });

                    const results = [];
                    const columns = [];
                    let colsBuilt = false;
                    const MAX_PREVIEW = 500;

                    const pagedData = searchObj.runPaged({ pageSize: 1000 });

                    if (pagedData.count === 0) {
                        // Build columns from definition
                        for (const col of searchDef.columns || []) {
                            columns.push(col.label || col.name);
                        }
                        resolve({ columns, rows: [], count: 0 });
                        return;
                    }

                    pagedData.pageRanges.forEach(function(pageRange) {
                        if (results.length >= MAX_PREVIEW) return;
                        const page = pagedData.fetch({ index: pageRange.index });
                        page.data.forEach(function(result) {
                            if (results.length >= MAX_PREVIEW) return;
                            const row = {};
                            searchObj.columns.forEach(function(col, idx) {
                                const key = col.label || col.name;
                                if (!colsBuilt) columns.push(key);
                                const val = result.getValue(col);
                                const txt = result.getText(col);
                                row[key] = txt || val;
                            });
                            colsBuilt = true;
                            results.push(row);
                        });
                    });

                    resolve({ columns, rows: results, count: pagedData.count, truncated: pagedData.count > MAX_PREVIEW });
                } catch (e) {
                    resolve({ error: e.message || String(e) });
                }
            }, (err) => {
                resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
            });
        } catch (e) {
            resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
    });
}

// ---------------------------------------------------------------------------
// Saved Search creation (page-world function for nsRunInPage)
// ---------------------------------------------------------------------------

function createSavedSearchFn(searchDef, title) {
    return new Promise((resolve) => {
        if (typeof require !== 'function') {
            resolve({ error: 'NetSuite require() is not available on this page.' });
            return;
        }
        try {
            require(['N/search'], (searchModule) => {
                try {
                    const searchObj = searchModule.create({
                        type: searchDef.type,
                        title: title,
                        filters: searchDef.filters || [],
                        columns: (searchDef.columns || []).map(col => {
                            const colDef = { name: col.name };
                            if (col.join) colDef.join = col.join;
                            if (col.summary) colDef.summary = searchModule.Summary[col.summary];
                            if (col.formula) colDef.formula = col.formula;
                            if (col.formulatype) colDef.formulaType = col.formulatype;
                            if (col.sort) colDef.sort = searchModule.Sort[col.sort];
                            if (col.label) colDef.label = col.label;
                            return searchModule.createColumn(colDef);
                        })
                    });

                    const savedId = searchObj.save();
                    resolve({ id: savedId, success: true });
                } catch (e) {
                    resolve({ error: e.message || String(e) });
                }
            }, (err) => {
                resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
            });
        } catch (e) {
            resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
    });
}

// ---------------------------------------------------------------------------
// Custom field metadata (formula, source list, definition link)
// ---------------------------------------------------------------------------

function getCustomFieldMetaFn(fieldId) {
  if (!fieldId) return { error: 'fieldId required' };

  // Determine custom field type by prefix
  var defPage = null;
  if (fieldId.substring(0, 8) === 'custbody') {
    defPage = 'bodycustfields';
  } else if (fieldId.substring(0, 10) === 'custentity') {
    defPage = 'entitycustfields';
  } else if (fieldId.substring(0, 8) === 'custitem') {
    defPage = 'itemcustfields';
  } else if (fieldId.substring(0, 8) === 'custevent') {
    defPage = 'eventcustfields';
  } else if (fieldId.substring(0, 7) === 'custcol') {
    defPage = 'columncustfields';
  } else if (fieldId.substring(0, 10) === 'custrecord') {
    // Custom record fields — need the record type context
    return Promise.resolve({ fieldId: fieldId, isCustom: true, customType: 'customrecord', defPage: null });
  } else {
    return Promise.resolve({ fieldId: fieldId, isCustom: false });
  }

  return new Promise(function(resolve) {
    var xhr = new XMLHttpRequest();
    xhr.onload = function() {
      var result = { fieldId: fieldId, isCustom: true, customType: defPage };
      try {
        var html = xhr.responseText;
        if (!html) { resolve(result); return; }

        // Find the field in the list page HTML
        var fieldIndex = html.indexOf('>' + fieldId + '<');
        if (fieldIndex <= 0) { resolve(result); return; }

        // Extract the link to the field definition (3 <td> cells back from the field ID)
        var tdIndex = html.lastIndexOf('<td', fieldIndex);
        tdIndex = html.lastIndexOf('<td', tdIndex - 1);
        tdIndex = html.lastIndexOf('<td', tdIndex - 1);
        var linkEnd = html.indexOf('<', tdIndex + 4);
        var linkHtml = html.substring(tdIndex, linkEnd + 4);

        // Extract href from the link
        var hrefMatch = linkHtml.match(/href="([^"]+)"/);
        if (hrefMatch && hrefMatch[1]) {
          result.definitionUrl = hrefMatch[1];
          // Extract field label from the link text
          var labelMatch = linkHtml.match(/>([^<]+)</);
          if (labelMatch) result.definitionLabel = labelMatch[1].trim();
        }

        // Extract field type (2 <td> cells after the field ID)
        var afterFieldId = html.indexOf('<td', fieldIndex + 1);
        afterFieldId = html.indexOf('<td', afterFieldId + 1);
        if (afterFieldId > 0) {
          var typeStart = html.indexOf('>', afterFieldId) + 1;
          var typeEnd = html.indexOf('</td>', typeStart);
          if (typeEnd > typeStart) {
            result.customFieldType = html.substring(typeStart, typeEnd).replace(/<[^>]+>/g, '').trim();
          }
        }

        // If we have a definition URL, fetch the XML to get formula and source list info
        if (result.definitionUrl) {
          var xmlXhr = new XMLHttpRequest();
          xmlXhr.onload = function() {
            try {
              var xmlText = xmlXhr.responseText;
              if (xmlText) {
                var parser = new DOMParser();
                var xmlDoc = parser.parseFromString(xmlText, 'text/xml');
                if (xmlDoc) {
                  // Check if it's a formula field
                  var isFormulaEl = xmlDoc.getElementsByTagName('isformula')[0];
                  if (isFormulaEl && isFormulaEl.textContent === 'T') {
                    result.isFormula = true;
                    var defaultValEl = xmlDoc.getElementsByTagName('defaultvalue')[0];
                    if (defaultValEl) result.formula = defaultValEl.textContent;
                  }

                  // Check for static list (custom list)
                  var staticListEl = xmlDoc.getElementsByTagName('staticlistrecordtype')[0];
                  if (staticListEl && staticListEl.textContent && parseInt(staticListEl.textContent) > 0) {
                    result.sourceListId = staticListEl.textContent;
                    result.sourceListUrl = '/app/common/custom/custlist.nl?id=' + staticListEl.textContent + '&e=T&ord=T';
                  }

                  // Check for select record type (custom record)
                  var selectRecTypeEl = xmlDoc.getElementsByTagName('selectrecordtype')[0];
                  if (selectRecTypeEl && selectRecTypeEl.textContent && parseInt(selectRecTypeEl.textContent) > 0) {
                    result.sourceRecordTypeId = selectRecTypeEl.textContent;
                    result.sourceRecordUrl = '/app/common/custom/custrecordentrylist.nl?rectype=' + selectRecTypeEl.textContent;
                  }

                  // Check for help text / description
                  var helpEl = xmlDoc.getElementsByTagName('help')[0];
                  if (helpEl && helpEl.textContent) {
                    result.helpText = helpEl.textContent.trim();
                  }
                }
              }
            } catch(_) {}
            resolve(result);
          };
          xmlXhr.onerror = function() { resolve(result); };
          xmlXhr.open('GET', result.definitionUrl + '&xml=T');
          xmlXhr.send();
        } else {
          resolve(result);
        }
      } catch(_) {
        resolve(result);
      }
    };
    xhr.onerror = function() {
      resolve({ fieldId: fieldId, isCustom: true, customType: defPage });
    };
    xhr.open('GET', '/app/common/custom/' + defPage + '.nl?frame=B&segment=1%01000%01%021000');
    xhr.send();
  });
}

// ---------------------------------------------------------------------------
// Source record link for select/list fields
// ---------------------------------------------------------------------------

function getFieldSourceLinkFn(fieldId) {
  if (!fieldId) return { fieldId: fieldId, sourceUrl: null };

  var result = { fieldId: fieldId, sourceUrl: null, sourceLabel: null };

  // Method 1: Try the Sync function pattern (reference extension approach)
  try {
    var syncFn = window['Sync' + fieldId];
    if (syncFn) {
      var fnStr = syncFn.toString();
      var openIdx = fnStr.indexOf('nlOpenWindow(');
      if (openIdx > 0) {
        var quoteStart = fnStr.indexOf("'", openIdx + 13);
        var quoteEnd = fnStr.indexOf("'", quoteStart + 1);
        if (quoteStart > 0 && quoteEnd > quoteStart) {
          var url = fnStr.substring(quoteStart + 1, quoteEnd);
          result.sourceUrl = url.replace('target', 'target_');
        }
      }
    }
  } catch(_) {}

  // Method 2: Check for a visible link/icon next to the field
  if (!result.sourceUrl) {
    try {
      // NS often puts a popup link near select fields
      var el = document.getElementById(fieldId + '_popup_link') ||
               document.getElementById(fieldId + '_popup') ||
               document.querySelector('a[id*="' + fieldId + '"][onclick*="nlOpenWindow"]');
      if (el) {
        var onclick = el.getAttribute('onclick') || '';
        var urlMatch = onclick.match(/nlOpenWindow\('([^']+)'/);
        if (urlMatch) {
          result.sourceUrl = urlMatch[1].replace('target', 'target_');
        }
      }
    } catch(_) {}
  }

  // Method 3: For the current value, try to build a direct link
  if (!result.sourceUrl) {
    try {
      var currentVal = typeof nlapiGetFieldValue === 'function' ? nlapiGetFieldValue(fieldId) : null;
      var field = typeof nlapiGetField === 'function' ? nlapiGetField(fieldId) : null;
      if (currentVal && field) {
        // If the field is a record reference and we have an internal ID, we can build a link
        // but we'd need the record type which we don't reliably have
        result.currentValueId = currentVal;
      }
    } catch(_) {}
  }

  return result;
}
