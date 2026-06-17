/**
 * TactaSuite NS Toolkit — Background Service Worker
 *
 * @author Blane Maher
 */

import { FEATURES, FeatureDefinition } from './modules/feature-registry';
import { 
    initDefaults, 
    getFeatureStates, 
    setFeatureState, 
    setFeatureStates, 
    getMeetingMode, 
    setMeetingMode 
} from './modules/storage-manager';
import { setupContextMenus } from './modules/context-menu-manager';

declare const require: any;
declare const getDropdown: any;
declare const nlapiGetField: any;
declare const nlapiGetFieldValue: any;
declare const nlapiGetFieldValues: any;
declare const nlapiGetFieldText: any;
declare const nlapiGetFieldTexts: any;
declare const nlapiGetLineItemCount: any;
declare const nlapiGetLineItemValue: any;
declare const nlapiGetLineItemText: any;
declare const nlapiSetFieldValue: any;
declare const nlapiSetLineItemValue: any;
declare const nlapiSetFieldMandatory: any;
declare const nlapiSetFieldDisabled: any;

declare global {
  interface Window {
    currentRecord?: any;
  }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    await initDefaults(FEATURES);
  }

  setupContextMenus();
  setupDeclarativeContent();
});

// ---------------------------------------------------------------------------
// DeclarativeContent rules
// ---------------------------------------------------------------------------

function setupDeclarativeContent(): void {
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

chrome.runtime.onMessage.addListener((message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  return true;
});

async function handleMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (message.action) {
    case 'getFeatures':
      return FEATURES;

    case 'getFeatureStates':
      return getFeatureStates();

    case 'setFeatureState':
      await setFeatureState(message.featureId, message.enabled);
      return { success: true };

    case 'setFeatureStates':
      await setFeatureStates(message.states);
      return { success: true };

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

    case 'getMeetingMode':
      return getMeetingMode();

    case 'setMeetingMode':
      await setMeetingMode(message.enabled);
      return { success: true };

    case 'getPageInfo': {
      const pageTabId = message.tabId || sender?.tab?.id;
      if (!pageTabId) throw new Error('No tab ID available');
      return getPageInfo(pageTabId);
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
      throw new Error(`Unknown background action: ${message.action}`);
  }
}

async function executeFeatureScripts(feature: FeatureDefinition, tabId: number): Promise<{ success: boolean }> {
  // Ensure shared dependencies are available
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['shared/ns-utils.js', 'shared/storage-utils.js', 'shared/dom-utils.js']
  });

  // Inject page-world scripts first
  if (feature.injectScripts?.length) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/ns-bridge.js'],
      world: 'MAIN'
    }).catch(() => {});
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

  // Send activation signal
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

async function executeSuiteQL(tabId: number, query: string, params?: any[]): Promise<any> {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('No query provided.');
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [query.trim(), params || null],
    func: (queryString, queryParams) => {
      return new Promise((resolve) => {
        // @ts-ignore
        if (typeof require !== 'function') {
          resolve({ error: 'NetSuite require() is not available on this page.' });
          return;
        }
        try {
          // @ts-ignore
          require(['N/query'], (queryModule) => {
            try {
              const startTime = performance.now();
              const PAGE_SIZE = 5000;
              const MAX_ROWS = 200000;

              const firstOpts: any = { query: queryString };
              if (queryParams && Array.isArray(queryParams) && queryParams.length > 0) {
                firstOpts.params = queryParams;
              }
              const firstResultSet = queryModule.runSuiteQL(firstOpts);

              let columns: string[] = [];
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
                  const pageOpts: any = { query: pagedSql };
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
            } catch (e: any) {
              resolve({ error: e.message || String(e) });
            }
          }, (err: any) => {
            resolve({ error: 'Failed to load N/query: ' + (err?.message || String(err)) });
          });
        } catch (e: any) {
          resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
      });
    }
  });

  const result: any = results?.[0]?.result;
  if (!result) throw new Error('No result returned from page execution.');
  if (result.error) throw new Error(result.error);
  return result;
}

async function nsRunInPage(tabId: number, func: any, args: any[]): Promise<any> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  });
  const result: any = results?.[0]?.result;
  if (result === undefined) throw new Error('No result from page.');
  if (result && result.error) throw new Error(result.error);
  return result;
}

async function getPageInfo(tabId: number): Promise<any> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pageWindow = window as any;
      if (typeof pageWindow.TactaPageDetector !== 'undefined') {
        return pageWindow.TactaPageDetector.detect();
      }
      return null;
    }
  });

  return results?.[0]?.result ?? null;
}

// ---------------------------------------------------------------------------
// Page-world functions for nsRunInPage (copied from JS)
// ---------------------------------------------------------------------------

function feGetRecordFieldsFn(): any {
  function normType(t: any): any {
    if (!t) return 'Unknown';
    const m: Record<string, string> = {
      text: 'Free-Form Text',
      textarea: 'Text Area',
      richtext: 'Rich Text',
      email: 'Email',
      url: 'URL',
      phone: 'Phone',
      integer: 'Integer',
      float: 'Decimal',
      currency: 'Currency',
      percent: 'Percent',
      date: 'Date',
      datetime: 'Date/Time',
      checkbox: 'Check Box',
      select: 'List/Record',
      multiselect: 'Multi-Select',
      radio: 'Radio',
      inlinehtml: 'Inline HTML',
      longtext: 'Long Text'
    };
    return m[String(t).toLowerCase()] || t;
  }

  function cleanLabel(text: any): string {
    return String(text || '').replace(/\s+/g, ' ').replace(/[*:]\s*$/g, '').trim();
  }

  function fieldDomIds(fid: string): string[] {
    const ids = [fid, fid + '_display', fid + '_val', fid + '_fs_lbl', fid + '_lbl', fid + '_label', fid + '_fs', 'inpt_' + fid];
    if (fid && fid.charAt(fid.length - 1) === '_') {
      const trimmed = fid.slice(0, -1);
      ids.push(trimmed + '_display', trimmed + '_val', trimmed + '_fs_lbl', trimmed + '_lbl', trimmed + '_label', trimmed + '_fs');
    }
    return ids;
  }

  function normalizeBodyFieldId(id: any): string {
    if (!id) return '';
    let fid = String(id);
    if (fid.indexOf('inpt_') === 0) fid = fid.substring(5);
    [
      '_display',
      '_fs_lbl',
      '_label',
      '_lbl',
      '_help',
      '_err',
      '_popup_link',
      '_popup',
      '_arrow',
      '_val',
      '_fs',
      '_hdn'
    ].some((suffix) => {
      if (fid.slice(-suffix.length) === suffix) {
        fid = fid.slice(0, -suffix.length);
        return true;
      }
      return false;
    });
    if (!fid || /^(sys_|__|submitter|wfSR|nsapiPI|nsapiFC|nsapiLC|nsapiPS|nsapiVF|nsapiRC|hddn|uir-)/.test(fid)) return '';
    if (/row\d+$/.test(fid)) return '';
    return fid;
  }

  function getDomFieldLabel(fid: string): string {
    const ids = fieldDomIds(fid);
    for (let i = 0; i < ids.length; i++) {
      const labelEl = document.getElementById(ids[i] + '_fs_lbl') ||
        document.getElementById(ids[i] + '_lbl') ||
        document.querySelector('label[for="' + ids[i] + '"]');
      if (labelEl) {
        const label = cleanLabel(labelEl.textContent);
        if (label) return label;
      }
    }
    for (let j = 0; j < ids.length; j++) {
      const el = document.getElementById(ids[j]);
      if (!el) continue;
      const row = el.closest('tr, .uir-field-wrapper, .uir-field');
      if (!row) continue;
      const labelCandidate = row.querySelector('.smalltextnolink, .smalltext, .uir-label span, .uir-label, label');
      const label = labelCandidate ? cleanLabel(labelCandidate.textContent) : '';
      if (label) return label;
    }
    return '';
  }

  function getSS2CurrentRecord(): any {
    try {
      if (window.currentRecord && typeof window.currentRecord.getFields === 'function') return window.currentRecord;
    } catch (_) {}
    try {
      if (typeof require === 'function') {
        let record: any = null;
        require(['N/currentRecord'], function (mod: any) {
          try { record = mod && typeof mod.get === 'function' ? mod.get() : null; } catch (_) {}
        });
        if (record && typeof record.getFields === 'function') return record;
      }
    } catch (_) {}
    return null;
  }

  const result: any = { bodyFields: [], sublists: {} };
  const currentRecord = getSS2CurrentRecord();

  const seen: Record<string, boolean> = {};
  const fieldIds: string[] = [];
  const formEls = document.querySelectorAll('#main_form [id]');
  for (let i = 0; i < formEls.length; i++) {
    const el: any = formEls[i];
    const rawId = el.id || '';
    const tagName = String(el.tagName || '').toLowerCase();
    const isFieldControl = tagName === 'input' || tagName === 'select' || tagName === 'textarea';
    const isFieldDecoration = /(_display|_fs_lbl|_label|_lbl|_val|_fs)$/.test(rawId);
    if (!isFieldControl && !isFieldDecoration) continue;

    const id = normalizeBodyFieldId(rawId);
    if (!id || seen[id]) continue;
    if (el.closest('.uir-machine-table-container, .uir-sublist')) continue;
    seen[id] = true;
    fieldIds.push(id);
  }

  try {
    if (currentRecord && typeof currentRecord.getFields === 'function') {
      const ss2Ids = currentRecord.getFields();
      for (let j = 0; j < ss2Ids.length; j++) {
        if (!seen[ss2Ids[j]]) {
          fieldIds.push(ss2Ids[j]);
          seen[ss2Ids[j]] = true;
        }
      }
    }
  } catch (_) {}

  for (let i = 0; i < fieldIds.length; i++) {
    const fid = fieldIds[i];
    let label = '';
    let type: any = 'unknown';
    let value: any = null;
    let text: any = null;
    let isMandatory = false;
    let isDisabled = false;
    let isHidden = false;

    try {
      if (typeof nlapiGetField === 'function') {
        const f = nlapiGetField(fid);
        if (f) {
          try { label = f.getLabel ? f.getLabel() : ''; } catch (_) {}
          try { type = f.getType ? f.getType() : ''; } catch (_) {}
          try { isMandatory = f.isMandatory ? f.isMandatory() : (f.required || false); } catch (_) {}
          try { isDisabled = f.isDisabled ? f.isDisabled() : (f.disabled || false); } catch (_) {}
          try { isHidden = f.isHidden ? f.isHidden() : false; } catch (_) {}
        }
      }
    } catch (_) {}

    try {
      if ((!label || !type || type === 'unknown') && currentRecord && typeof currentRecord.getField === 'function') {
        const f2 = currentRecord.getField({ fieldId: fid });
        if (f2) {
          if (!label) label = cleanLabel(f2.label || f2.name || '');
          if (!type) type = f2.type || '';
          if (!isMandatory && f2.isMandatory !== undefined) isMandatory = !!f2.isMandatory;
          if (!isDisabled && f2.isDisabled !== undefined) isDisabled = !!f2.isDisabled;
        }
      }
    } catch (_) {}

    try {
      if (typeof nlapiGetFieldValues === 'function') {
        const multiVals = nlapiGetFieldValues(fid);
        if (multiVals && multiVals.length > 0) value = multiVals.join(', ');
      }
    } catch (_) {}
    if (value === null) {
      try { if (typeof nlapiGetFieldValue === 'function') value = nlapiGetFieldValue(fid); } catch (_) {}
    }
    try {
      if (typeof nlapiGetFieldTexts === 'function') {
        const multiTexts = nlapiGetFieldTexts(fid);
        if (multiTexts && multiTexts.length > 0) text = multiTexts.join(', ');
      }
    } catch (_) {}
    if (!text) {
      try { if (typeof nlapiGetFieldText === 'function') text = nlapiGetFieldText(fid); } catch (_) {}
    }

    if (!isHidden || !isDisabled) {
      const el: any = document.getElementById(fid) || document.getElementById(fid + '_display')
        || document.getElementById(fid + '_val') || document.getElementById(fid + '_fs_lbl')
        || document.getElementById('inpt_' + fid)
        || (fid.charAt(fid.length - 1) === '_' ? document.getElementById(fid.slice(0, -1) + '_val') || document.getElementById(fid.slice(0, -1) + '_fs_lbl') : null);
      if (el) {
        if (!isHidden) {
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') isHidden = true;
          if (!isHidden) {
            const row = el.closest('tr');
            if (row) {
              const rs = window.getComputedStyle(row);
              if (rs.display === 'none' || rs.visibility === 'hidden') isHidden = true;
            }
          }
        }
        if (!isDisabled && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly)) isDisabled = true;
      }
      if (!el) {
        const lbl = document.querySelector('label[for="' + fid + '"], label[for="' + fid + '_display"]');
        const rowEl = lbl ? lbl.closest('tr') : null;
        if (rowEl) {
          const rs = window.getComputedStyle(rowEl);
          isHidden = (rs.display === 'none' || rs.visibility === 'hidden');
        }
      }
    }

    if (!label) label = getDomFieldLabel(fid);

    type = normType(type);
    if (value !== null && value !== undefined && typeof value === 'object') {
      try { value = JSON.parse(JSON.stringify(value)); } catch (_) { value = String(value); }
    }

    result.bodyFields.push({
      id: fid,
      label,
      type,
      value: value === undefined ? null : value,
      text: text || null,
      isMandatory,
      isDisabled,
      isHidden
    });
  }

  const slSeen: Record<string, boolean> = {};

  function trySublist(name: string): void {
    if (!name || slSeen[name]) return;
    try {
      if (typeof nlapiGetLineItemCount === 'function') {
        const c = nlapiGetLineItemCount(name);
        if (c >= 0) {
          slSeen[name] = true;
          return;
        }
      }
    } catch (_) {}
    try {
      if (window.currentRecord && typeof window.currentRecord.getLineCount === 'function') {
        const c = window.currentRecord.getLineCount({ sublistId: name });
        if (c >= 0) {
          slSeen[name] = true;
          return;
        }
      }
    } catch (_) {}
  }

  document.querySelectorAll('.uir-machine-table-container[id]').forEach((el: any) => {
    const m = el.id.match(/^(.+?)_splits$/);
    if (m && m[1]) trySublist(m[1]);
  });

  document.querySelectorAll('[id$="_subtab"], [id$="subtab"]').forEach((el: any) => {
    const m = el.id.match(/^(.+?)_?subtab$/);
    if (m && m[1]) trySublist(m[1]);
  });

  document.querySelectorAll('div[id^="div__body"]').forEach((el: any) => {
    const name = el.id.replace(/^div__body/, '').replace(/tab$/, '');
    if (name) trySublist(name);
  });

  document.querySelectorAll('.uir-machine-headerrow').forEach((el) => {
    const table: any = el.closest('table[id]');
    if (table) {
      const m = table.id.match(/^(.+?)(?:_splits|_layer|header)$/);
      if (m && m[1]) trySublist(m[1]);
    }
  });

  [
    'item',
    'line',
    'expense',
    'apply',
    'deposit',
    'partners',
    'salesteam',
    'addresses',
    'addressbook',
    'links',
    'mediaitem',
    'payment',
    'contacts',
    'recmachcustrecord',
    'custpage',
    'inventoryassignment',
    'billingschedule',
    'revrecschedule',
    'installment'
  ].forEach(trySublist);

  Object.keys(slSeen).forEach((slId) => {
    let lc = 0;
    try {
      if (typeof nlapiGetLineItemCount === 'function') lc = nlapiGetLineItemCount(slId);
    } catch (_) {}
    if (lc <= 0) {
      try {
        if (window.currentRecord) lc = window.currentRecord.getLineCount({ sublistId: slId });
      } catch (_) {}
    }

    const fields: any[] = [];
    const fieldSeen: Record<string, boolean> = {};

    document.querySelectorAll('#' + slId + '_splits .uir-machine-headerrow td[data-field]').forEach((td: any) => {
      const f = td.getAttribute('data-field');
      if (f && !fieldSeen[f]) {
        fieldSeen[f] = true;
        const meta: any = { id: f, label: (td.textContent || '').trim(), type: 'unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false };
        if (lc > 0) {
          try { if (typeof nlapiGetLineItemValue === 'function') meta.value = nlapiGetLineItemValue(slId, f, 1); } catch (_) {}
          try { if (typeof nlapiGetLineItemText === 'function') meta.text = nlapiGetLineItemText(slId, f, 1); } catch (_) {}
        }
        fields.push(meta);
      }
    });

    if (fields.length === 0) {
      document.querySelectorAll('tr[id="' + slId + 'header"] td, #' + slId + '_header .listheadertd').forEach((td: any) => {
        const f = td.getAttribute('data-field');
        if (f && !fieldSeen[f]) {
          fieldSeen[f] = true;
          fields.push({ id: f, label: (td.textContent || '').trim(), type: 'unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false });
        }
      });
    }

    if (fields.length === 0) {
      const firstRow = document.querySelector('#' + slId + '_splits .uir-machine-row-odd, #' + slId + '_splits .uir-machine-row-even, #' + slId + 'row0');
      if (firstRow) {
        firstRow.querySelectorAll('input[id], select[id], textarea[id], span[id]').forEach((inp: any) => {
          const fName = inp.id.replace(new RegExp('^' + slId + '_'), '').replace(/_\d+$/, '').replace(/_display$/, '');
          if (fName && !fieldSeen[fName] && fName !== slId) {
            fieldSeen[fName] = true;
            let val: any = null;
            let txt: any = null;
            try { if (typeof nlapiGetLineItemValue === 'function' && lc > 0) val = nlapiGetLineItemValue(slId, fName, 1); } catch (_) {}
            try { if (typeof nlapiGetLineItemText === 'function' && lc > 0) txt = nlapiGetLineItemText(slId, fName, 1); } catch (_) {}
            fields.push({ id: fName, label: '', type: 'unknown', value: val, text: txt, isMandatory: false, isDisabled: false, isHidden: false });
          }
        });
      }
    }

    try {
      if (window.currentRecord && typeof window.currentRecord.getSublistFields === 'function') {
        const ss2Fields = window.currentRecord.getSublistFields({ sublistId: slId }) || [];
        for (let fi = 0; fi < ss2Fields.length; fi++) {
          if (!fieldSeen[ss2Fields[fi]]) {
            fieldSeen[ss2Fields[fi]] = true;
            const meta: any = { id: ss2Fields[fi], label: '', type: 'unknown', value: null, text: null, isMandatory: false, isDisabled: false, isHidden: false };
            try {
              const sf = window.currentRecord.getSublistField({ sublistId: slId, fieldId: ss2Fields[fi], line: 0 });
              if (sf) {
                meta.label = sf.label || '';
                meta.type = normType(sf.type || '');
              }
            } catch (_) {}
            if (lc > 0) {
              try { meta.value = window.currentRecord.getSublistValue({ sublistId: slId, fieldId: ss2Fields[fi], line: 0 }); } catch (_) {}
              try { meta.text = window.currentRecord.getSublistText({ sublistId: slId, fieldId: ss2Fields[fi], line: 0 }); } catch (_) {}
            }
            fields.push(meta);
          }
        }
      }
    } catch (_) {}

    result.sublists[slId] = { fields, lineCount: lc };
  });

  return result;
}

function feGetSelectOptionsFn(fieldId: string, sublistId?: string, line?: number) {
  // @ts-ignore
  if (!fieldId) return {fieldId, options:[]};
  const options: any[] = [];

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

  if (options.length === 0) {
    try {
      const inpt = document.getElementsByName('inpt_' + fieldId)[0];
      // @ts-ignore
      if (inpt && typeof getDropdown === 'function') {
        // @ts-ignore
        const dd = getDropdown(inpt);
        if (dd && dd.valueArray) {
          for (let i = 0; i < dd.valueArray.length; i++) {
            if (dd.valueArray[i]) options.push({ value: String(dd.valueArray[i]), text: dd.textArray[i] || String(dd.valueArray[i]) });
          }
        }
      }
    } catch(_) {}
  }

  if (options.length === 0) {
    try {
      // @ts-ignore
      if (window.currentRecord && typeof window.currentRecord.getField === 'function') {
        // @ts-ignore
        const field = sublistId
          // @ts-ignore
          ? window.currentRecord.getSublistField({ sublistId, fieldId, line: (line != null ? line : 0) })
          // @ts-ignore
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

  if (options.length === 0) {
    try {
      // @ts-ignore
      if (typeof nlapiGetField === 'function') {
        // @ts-ignore
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

function feSetFieldValueFn(fieldId: string, value: any, sublistId?: string, line?: number) {
  if (!fieldId) return {error:'fieldId required'};

  try {
    // @ts-ignore
    if (sublistId && line != null && typeof nlapiSetLineItemValue === 'function') {
      // @ts-ignore
      nlapiSetLineItemValue(sublistId, fieldId, line + 1, value);
      // @ts-ignore
      const newValue = typeof nlapiGetLineItemValue === 'function' ? nlapiGetLineItemValue(sublistId, fieldId, line + 1) : value;
      // @ts-ignore
      const newText = typeof nlapiGetLineItemText === 'function' ? nlapiGetLineItemText(sublistId, fieldId, line + 1) : null;
      return { success: true, fieldId, newValue, newText };
      // @ts-ignore
    } else if (typeof nlapiSetFieldValue === 'function') {
      // @ts-ignore
      nlapiSetFieldValue(fieldId, value, true, false);
      // @ts-ignore
      const newValue = typeof nlapiGetFieldValue === 'function' ? nlapiGetFieldValue(fieldId) : value;
      // @ts-ignore
      const newText = typeof nlapiGetFieldText === 'function' ? nlapiGetFieldText(fieldId) : null;
      return { success: true, fieldId, newValue, newText };
    }
  } catch(e: any) { return { error: e.message }; }

  return { error: 'No NetSuite API available to set field value' };
}

function feSetFieldAttributeFn(fieldId: string, attr: string, value: any) {
  if (!fieldId || !attr) return { error: 'fieldId and attr required' };
  try {
    if (attr === 'mandatory') {
      // @ts-ignore
      if (typeof nlapiSetFieldMandatory === 'function') {
        // @ts-ignore
        nlapiSetFieldMandatory(fieldId, !!value);
        return { success: true, fieldId, attr, value: !!value };
      }
    } else if (attr === 'disabled') {
      // @ts-ignore
      if (typeof nlapiSetFieldDisabled === 'function') {
        // @ts-ignore
        nlapiSetFieldDisabled(fieldId, !!value);
        return { success: true, fieldId, attr, value: !!value };
      }
    }
  } catch(e: any) { return { error: e.message }; }
  return { error: 'API not available for ' + attr };
}

function previewSavedSearchFn(searchDef: any) {
    return new Promise((resolve) => {
        // @ts-ignore
        if (typeof require !== 'function') {
            resolve({ error: 'NetSuite require() is not available on this page.' });
            return;
        }
        try {
            // @ts-ignore
            require(['N/search'], (searchModule) => {
                try {
                    const searchObj = searchModule.create({
                        type: searchDef.type,
                        filters: searchDef.filters || [],
                        columns: (searchDef.columns || []).map((col: any) => {
                            const colDef: any = { name: col.name };
                            if (col.join) colDef.join = col.join;
                            if (col.summary) colDef.summary = searchModule.Summary[col.summary];
                            if (col.formula) colDef.formula = col.formula;
                            if (col.formulatype) colDef.formulaType = col.formulatype;
                            if (col.sort) colDef.sort = searchModule.Sort[col.sort];
                            if (col.label) colDef.label = col.label;
                            return searchModule.createColumn(colDef);
                        })
                    });

                    const results: any[] = [];
                    const columns: string[] = [];
                    let colsBuilt = false;
                    const MAX_PREVIEW = 500;

                    const pagedData = searchObj.runPaged({ pageSize: 1000 });

                    if (pagedData.count === 0) {
                        for (const col of searchDef.columns || []) {
                            columns.push(col.label || col.name);
                        }
                        resolve({ columns, rows: [], count: 0 });
                        return;
                    }

                    pagedData.pageRanges.forEach(function(pageRange: any) {
                        if (results.length >= MAX_PREVIEW) return;
                        const page = pagedData.fetch({ index: pageRange.index });
                        page.data.forEach(function(result: any) {
                            if (results.length >= MAX_PREVIEW) return;
                            const row: any = {};
                            searchObj.columns.forEach(function(col: any) {
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
                } catch (e: any) {
                    resolve({ error: e.message || String(e) });
                }
            }, (err: any) => {
                resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
            });
        } catch (e: any) {
            resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
    });
}

function createSavedSearchFn(searchDef: any, title: string) {
    return new Promise((resolve) => {
        // @ts-ignore
        if (typeof require !== 'function') {
            resolve({ error: 'NetSuite require() is not available on this page.' });
            return;
        }
        try {
            // @ts-ignore
            require(['N/search'], (searchModule) => {
                try {
                    const searchObj = searchModule.create({
                        type: searchDef.type,
                        title: title,
                        filters: searchDef.filters || [],
                        columns: (searchDef.columns || []).map((col: any) => {
                            const colDef: any = { name: col.name };
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
                } catch (e: any) {
                    resolve({ error: e.message || String(e) });
                }
            }, (err: any) => {
                resolve({ error: 'Failed to load N/search: ' + (err?.message || String(err)) });
            });
        } catch (e: any) {
            resolve({ error: 'require() failed: ' + (e.message || String(e)) });
        }
    });
}

function getCustomFieldMetaFn(fieldId: string) {
  if (!fieldId) return { error: 'fieldId required' };

  var defPage: string | null = null;
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
    return Promise.resolve({ fieldId: fieldId, isCustom: true, customType: 'customrecord', defPage: null });
  } else {
    return Promise.resolve({ fieldId: fieldId, isCustom: false });
  }

  return new Promise(function(resolve) {
    var xhr = new XMLHttpRequest();
    xhr.onload = function() {
      var result: any = { fieldId: fieldId, isCustom: true, customType: defPage };
      try {
        var html = xhr.responseText;
        if (!html) { resolve(result); return; }

        var fieldIndex = html.indexOf('>' + fieldId + '<');
        if (fieldIndex <= 0) { resolve(result); return; }

        var tdIndex = html.lastIndexOf('<td', fieldIndex);
        tdIndex = html.lastIndexOf('<td', tdIndex - 1);
        tdIndex = html.lastIndexOf('<td', tdIndex - 1);
        var linkEnd = html.indexOf('<', tdIndex + 4);
        var linkHtml = html.substring(tdIndex, linkEnd + 4);

        var hrefMatch = linkHtml.match(/href="([^"]+)"/);
        if (hrefMatch && hrefMatch[1]) {
          result.definitionUrl = hrefMatch[1];
          var labelMatch = linkHtml.match(/>([^<]+)</);
          if (labelMatch) result.definitionLabel = labelMatch[1].trim();
        }

        var afterFieldId = html.indexOf('<td', fieldIndex + 1);
        afterFieldId = html.indexOf('<td', afterFieldId + 1);
        if (afterFieldId > 0) {
          var typeStart = html.indexOf('>', afterFieldId) + 1;
          var typeEnd = html.indexOf('</td>', typeStart);
          if (typeEnd > typeStart) {
            result.customFieldType = html.substring(typeStart, typeEnd).replace(/<[^>]+>/g, '').trim();
          }
        }

        if (result.definitionUrl) {
          var xmlXhr = new XMLHttpRequest();
          xmlXhr.onload = function() {
            try {
              var xmlText = xmlXhr.responseText;
              if (xmlText) {
                var parser = new DOMParser();
                var xmlDoc = parser.parseFromString(xmlText, 'text/xml');
                if (xmlDoc) {
                  var isFormulaEl = xmlDoc.getElementsByTagName('isformula')[0];
                  if (isFormulaEl && isFormulaEl.textContent === 'T') {
                    result.isFormula = true;
                    var defaultValEl = xmlDoc.getElementsByTagName('defaultvalue')[0];
                    if (defaultValEl) result.formula = defaultValEl.textContent;
                  }
                  var staticListEl = xmlDoc.getElementsByTagName('staticlistrecordtype')[0];
                  if (staticListEl && staticListEl.textContent && parseInt(staticListEl.textContent) > 0) {
                    result.sourceListId = staticListEl.textContent;
                    result.sourceListUrl = '/app/common/custom/custlist.nl?id=' + staticListEl.textContent + '&e=T&ord=T';
                  }
                  var selectRecTypeEl = xmlDoc.getElementsByTagName('selectrecordtype')[0];
                  if (selectRecTypeEl && selectRecTypeEl.textContent && parseInt(selectRecTypeEl.textContent) > 0) {
                    result.sourceRecordTypeId = selectRecTypeEl.textContent;
                    result.sourceRecordUrl = '/app/common/custom/custrecordentrylist.nl?rectype=' + selectRecTypeEl.textContent;
                  }
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

function getFieldSourceLinkFn(fieldId: string) {
  if (!fieldId) return { fieldId: fieldId, sourceUrl: null };

  var result: any = { fieldId: fieldId, sourceUrl: null, sourceLabel: null };

  try {
    // @ts-ignore
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

  if (!result.sourceUrl) {
    try {
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

  if (!result.sourceUrl) {
    try {
      // @ts-ignore
      var currentVal = typeof nlapiGetFieldValue === 'function' ? nlapiGetFieldValue(fieldId) : null;
      // @ts-ignore
      var field = typeof nlapiGetField === 'function' ? nlapiGetField(fieldId) : null;
      if (currentVal && field) {
        result.currentValueId = currentVal;
      }
    } catch(_) {}
  }

  return result;
}

async function assertFeatureCanRun(featureId: string): Promise<void> {
  const [states, meetingMode] = await Promise.all([
    getFeatureStates(),
    getMeetingMode()
  ]);

  if (!states[featureId]) {
    throw new Error(`Feature "${featureId}" is disabled in toolkit settings.`);
  }

  const feature = FEATURES.find(f => f.id === featureId);
  if (meetingMode && feature?.trigger === 'auto') {
    throw new Error(`Feature "${featureId}" suppressed by Meeting Mode.`);
  }
}
