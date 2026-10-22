/**
 * NetSuite TactaSuite - AI Assistant Provider Module
 *
 * @author Blane Maher
 *
 * Handles every "ai*" message for the AI Assistant feature. Two providers:
 *
 *   1. Claude on Amazon Bedrock (Converse API, bearer API key). Full native
 *      tool-use loop: the model calls run_suiteql / record_catalog /
 *      get_current_record, the extension executes them against the live
 *      NetSuite tab, and the results are fed back until the model answers.
 *
 *   2. NetSuite's own AI through N/llm, reached via a RESTlet the user deploys
 *      in their account (docs/ai/tacta_rl_netsuite_llm.js). N/llm has no
 *      native tool calling, so this runs a 2-step pseudo-agent: step 1 asks
 *      for one read-only SuiteQL in a fenced sql block, the extension
 *      validates and runs it, step 2 sends the rows back for the answer.
 *
 * Every tool is enforced in code (read-only SQL validation, row caps,
 * masking), never by prompt alone. Settings and keys live only in
 * chrome.storage.local under "tacta_ai_settings" and are never synced.
 *
 * Usage from service-worker.js:
 *   import { handleAiMessage } from './modules/ai-provider.js';
 *   const aiResult = await handleAiMessage(message, sender, deps);
 *   if (aiResult !== undefined) return aiResult;
 *
 * deps = { executeSuiteQL(tabId, query), runInPage(tabId, func, args),
 *          getPageInfo(tabId), getRecordFields(tabId) }
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import { mcpToolsetForTab } from './netsuite-mcp.js';

export const AI_STORAGE_KEY = 'tacta_ai_settings';

export const AI_DEFAULT_SETTINGS = {
  provider: 'none',
  bedrock: {
    region: 'us-east-1',
    modelId: 'us.anthropic.claude-fable-5-1',
    // 'key'    - a Bedrock API key pasted into the settings (bearer token)
    // 'helper' - short-term tokens minted by tools/bedrock-token-helper from the
    //            AWS login already on this machine (Identity Center / SSO)
    auth: 'key',
    helperUrl: 'http://127.0.0.1:38790',
    apiKey: ''
  },
  netsuite: {
    scriptId: '',
    deployId: ''
  },
  maskSensitive: true,
  maxSteps: 8
};

const PROVIDERS = ['none', 'bedrock', 'netsuite'];
const MAX_STEPS_HARD_CAP = 20;
const DEFAULT_ROWS_TO_MODEL = 100;
const ROWS_HARD_CAP = 500;
const RECORD_FIELD_CAP = 150;
const CATALOG_TYPES_CAP = 300;
const CATALOG_FIELDS_CAP = 400;
const BEDROCK_MAX_TOKENS = 4096;
const NETSUITE_MAX_TOKENS = 2000;
const MASK_TOKEN = '[masked]';

/** Record catalog cache: origin -> array of { id, label }. Lives for the SW lifetime. */
const catalogTypesCache = new Map();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Reads settings from chrome.storage.local, merged over defaults.
 * @returns {Promise<Object>}
 */
async function getSettings() {
  const stored = await chrome.storage.local.get(AI_STORAGE_KEY);
  return normalizeSettings(stored && stored[AI_STORAGE_KEY]);
}

/**
 * Validates and normalizes a settings object. Unknown keys are dropped.
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const bed = src.bedrock && typeof src.bedrock === 'object' ? src.bedrock : {};
  const ns = src.netsuite && typeof src.netsuite === 'object' ? src.netsuite : {};

  let region = String(bed.region || AI_DEFAULT_SETTINGS.bedrock.region).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(region)) region = AI_DEFAULT_SETTINGS.bedrock.region;

  let modelId = String(bed.modelId || AI_DEFAULT_SETTINGS.bedrock.modelId).trim();
  if (!/^[A-Za-z0-9._:/-]+$/.test(modelId)) modelId = AI_DEFAULT_SETTINGS.bedrock.modelId;

  const auth = bed.auth === 'helper' ? 'helper' : 'key';
  let helperUrl = String(bed.helperUrl || AI_DEFAULT_SETTINGS.bedrock.helperUrl).trim().replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d{2,5})?$/.test(helperUrl)) helperUrl = AI_DEFAULT_SETTINGS.bedrock.helperUrl;

  let maxSteps = parseInt(src.maxSteps, 10);
  if (!maxSteps || maxSteps < 1) maxSteps = AI_DEFAULT_SETTINGS.maxSteps;
  if (maxSteps > MAX_STEPS_HARD_CAP) maxSteps = MAX_STEPS_HARD_CAP;

  return {
    provider: PROVIDERS.includes(src.provider) ? src.provider : 'none',
    bedrock: {
      region,
      modelId,
      auth,
      helperUrl,
      apiKey: typeof bed.apiKey === 'string' ? bed.apiKey.trim() : ''
    },
    netsuite: {
      scriptId: String(ns.scriptId || '').trim(),
      deployId: String(ns.deployId || '').trim()
    },
    maskSensitive: src.maskSensitive !== false,
    maxSteps
  };
}

/**
 * Persists settings (normalized) to chrome.storage.local.
 * @param {Object} settings
 * @returns {Promise<Object>} The stored, normalized settings.
 */
async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [AI_STORAGE_KEY]: normalized });
  return normalized;
}

/**
 * Content scripts run next to the NetSuite page; they never need the raw
 * API key. Extension pages (options/popup/onboarding) get it in full. An
 * options page opened as a tab DOES carry sender.tab, so trust is decided by
 * the sender URL being one of our own chrome-extension:// pages.
 * @param {Object} settings
 * @param {Object} sender
 * @returns {Object}
 */
function isExtensionPage(sender) {
  if (!sender) return true;
  if (!sender.tab) return true;
  const url = String(sender.url || sender.origin || '');
  return url.startsWith(chrome.runtime.getURL(''));
}

function redactForSender(settings, sender) {
  if (isExtensionPage(sender)) return settings;
  return {
    ...settings,
    bedrock: { ...settings.bedrock, apiKey: '', hasApiKey: !!settings.bedrock.apiKey }
  };
}

// ---------------------------------------------------------------------------
// Sensitive-data masking
// ---------------------------------------------------------------------------

const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const RE_TAXID = /\b(?:\d{3}-\d{2}-\d{4}|\d{2}-\d{7}|\d{9})\b/g;
const RE_PHONE = /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/g;

/**
 * Luhn check used to confirm a 13-19 digit run is a payment card number
 * rather than an arbitrary identifier.
 * @param {string} digits
 * @returns {boolean}
 */
function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Masks emails, phone numbers, 9-digit tax ids and card numbers in a string.
 * @param {string} str
 * @returns {string}
 */
function maskString(str) {
  let s = str;
  s = s.replace(RE_CARD, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? MASK_TOKEN : m;
  });
  s = s.replace(RE_EMAIL, MASK_TOKEN);
  s = s.replace(RE_TAXID, MASK_TOKEN);
  s = s.replace(RE_PHONE, MASK_TOKEN);
  return s;
}

/**
 * Recursively masks every string inside a value (arrays, objects, scalars).
 * @param {*} value
 * @returns {*}
 */
function maskDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = maskDeep(value[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tool definitions (shared by both providers)
// ---------------------------------------------------------------------------

const TOOL_SPECS = [
  {
    name: 'run_suiteql',
    description: 'Run a READ-ONLY SuiteQL SELECT against the NetSuite account the user is logged in to. ' +
      'Only SELECT / WITH statements are accepted; no semicolons, no DML or DDL. ' +
      'Use FETCH FIRST n ROWS ONLY (not LIMIT). Use BUILTIN.DF(field) to get display text for list fields. ' +
      'Returns { columns, rows, totalRows, returnedRows, truncated }.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The SuiteQL SELECT statement.' },
        maxRows: { type: 'integer', description: 'Max rows to return to you (default 100, hard cap 500).' }
      },
      required: ['query']
    }
  },
  {
    name: 'record_catalog',
    description: 'Look up the NetSuite Records Catalog (the same metadata the Analytics / SuiteQL UI uses). ' +
      'action "types" lists queryable record types (optionally filtered by substring). ' +
      'action "detail" returns the SuiteQL columns (id, label, dataType) and join names for one record type scriptId, ' +
      'for example "transaction", "customer", "item", "customrecord_xyz". Verify table and column names here before writing SQL.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['types', 'detail'] },
        scriptId: { type: 'string', description: 'Record type script id for action "detail".' },
        filter: { type: 'string', description: 'Optional case-insensitive substring to narrow the "types" list.' }
      },
      required: ['action']
    }
  },
  {
    name: 'get_current_record',
    description: 'Return the record the user is currently viewing in NetSuite: pageType, recordType, recordId ' +
      'and up to 150 body fields (id, label, type, value, display text). Use this before answering questions about "this record".',
    inputSchema: { type: 'object', properties: {} }
  }
];

// ---------------------------------------------------------------------------
// SuiteQL safety
// ---------------------------------------------------------------------------

const RE_FORBIDDEN_SQL = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant)\b/i;

/**
 * Validates that a statement is a single read-only SELECT / WITH.
 * @param {string} query
 * @returns {{ ok: boolean, reason?: string, query?: string }}
 */
export function validateReadOnlySql(query) {
  if (typeof query !== 'string') return { ok: false, reason: 'Query must be a string.' };
  const trimmed = query.trim().replace(/;\s*$/, '');
  if (!trimmed) return { ok: false, reason: 'Query is empty.' };
  if (!/^(select|with)\b/i.test(trimmed)) return { ok: false, reason: 'Only statements starting with SELECT or WITH are allowed.' };
  if (trimmed.includes(';')) return { ok: false, reason: 'Semicolons are not allowed (one statement only).' };
  const bad = trimmed.match(RE_FORBIDDEN_SQL);
  if (bad) return { ok: false, reason: 'Forbidden keyword in query: ' + bad[0].toUpperCase() + '. The assistant is read-only.' };
  return { ok: true, query: trimmed };
}

/**
 * Clamps a requested row count to [1, ROWS_HARD_CAP].
 * @param {*} n
 * @returns {number}
 */
function clampRows(n) {
  let v = parseInt(n, 10);
  if (!v || v < 1) v = DEFAULT_ROWS_TO_MODEL;
  if (v > ROWS_HARD_CAP) v = ROWS_HARD_CAP;
  return v;
}

// ---------------------------------------------------------------------------
// Page-world functions (serialised with Function.toString, must be self-contained)
// ---------------------------------------------------------------------------

/**
 * Fetches a same-origin URL inside the NetSuite tab so session cookies apply.
 * Returns { status, ok, body } or { error }.
 */
function pageFetchFn(path, method, jsonBody) {
  const init = {
    method: method || 'GET',
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  };
  if (jsonBody !== null && jsonBody !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(jsonBody);
  }
  const url = path.indexOf('http') === 0 ? path : (window.location.origin + path);
  return fetch(url, init)
    .then((r) => r.text().then((t) => ({ status: r.status, ok: r.ok, body: t, origin: window.location.origin })))
    .catch((e) => ({ error: 'Fetch failed: ' + (e && e.message ? e.message : String(e)) }));
}

/** Returns the page origin. */
function pageOriginFn() {
  return window.location.origin;
}

/**
 * Parses a pageFetchFn result as JSON, with a readable error on failure.
 * @param {Object} res
 * @param {string} what
 * @returns {Object}
 */
function parseFetchJson(res, what) {
  if (!res) throw new Error(what + ': no response from page.');
  const body = String(res.body || '');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    const looksLikeLogin = /login|<html/i.test(body.slice(0, 500));
    throw new Error(what + ' returned HTTP ' + res.status + (looksLikeLogin
      ? ' with an HTML page instead of JSON. Check the script/deploy ids, that the deployment is Released, and that your role is in its audience.'
      : ' with a non-JSON body: ' + body.slice(0, 200)));
  }
  if (!res.ok) {
    const msg = (parsed && parsed.error && (parsed.error.message || parsed.error.code)) || body.slice(0, 200);
    throw new Error(what + ' failed with HTTP ' + res.status + ': ' + msg);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

/**
 * Executes run_suiteql. Returns { outcome, rows, forModel }.
 */
async function toolRunSuiteQL(input, ctx) {
  const check = validateReadOnlySql(input && input.query);
  if (!check.ok) {
    return { outcome: 'rejected: ' + check.reason, rows: null, forModel: { error: check.reason, hint: 'Rewrite as a single read-only SELECT.' }, isError: true };
  }
  const maxRows = clampRows(input && input.maxRows);
  let result;
  try {
    result = await ctx.deps.executeSuiteQL(ctx.tabId, check.query);
  } catch (e) {
    return { outcome: 'error: ' + e.message, rows: null, forModel: { error: e.message, hint: 'Check table and column names with record_catalog.' }, isError: true };
  }
  const allRows = Array.isArray(result.rows) ? result.rows : [];
  const slice = allRows.slice(0, maxRows);
  const columns = Array.isArray(result.columns) && result.columns.length ? result.columns : (slice[0] ? Object.keys(slice[0]) : []);
  const forModel = {
    columns,
    rows: ctx.mask ? maskDeep(slice) : slice,
    totalRows: allRows.length,
    returnedRows: slice.length,
    truncated: allRows.length > slice.length || !!result.truncated,
    executionTimeMs: result.executionTime
  };
  return {
    outcome: 'ok: ' + allRows.length + ' row' + (allRows.length === 1 ? '' : 's') + (allRows.length > slice.length ? ' (' + slice.length + ' sent to model)' : ''),
    rows: slice,
    columns,
    totalRows: allRows.length,
    forModel,
    isError: false
  };
}

/**
 * Executes record_catalog. Returns { outcome, forModel }.
 */
async function toolRecordCatalog(input, ctx) {
  const action = String((input && input.action) || '').toLowerCase();
  if (action === 'types') {
    const origin = await ctx.deps.runInPage(ctx.tabId, pageOriginFn, []);
    let types = catalogTypesCache.get(origin);
    if (!types) {
      const path = '/app/recordscatalog/rcendpoint.nl?action=getRecordTypes&data=' +
        encodeURI(JSON.stringify({ structureType: 'FLAT' }));
      const res = await ctx.deps.runInPage(ctx.tabId, pageFetchFn, [path, 'GET', null]);
      const json = parseFetchJson(res, 'Records Catalog (types)');
      const data = Array.isArray(json.data) ? json.data : [];
      types = data.map((t) => ({ id: t.id, label: t.label || t.id })).filter((t) => t.id);
      catalogTypesCache.set(origin, types);
    }
    const filter = String((input && input.filter) || '').trim().toLowerCase();
    let list = filter
      ? types.filter((t) => String(t.id).toLowerCase().includes(filter) || String(t.label).toLowerCase().includes(filter))
      : types;
    const total = list.length;
    list = list.slice(0, CATALOG_TYPES_CAP);
    return {
      outcome: 'ok: ' + total + ' type' + (total === 1 ? '' : 's') + (filter ? ' matching "' + filter + '"' : '') + (total > list.length ? ' (' + list.length + ' sent)' : ''),
      forModel: { types: list, total, truncated: total > list.length, hint: total > list.length ? 'Pass a filter to narrow the list.' : undefined },
      isError: false
    };
  }
  if (action === 'detail') {
    const scriptId = String((input && input.scriptId) || '').trim();
    if (!/^[A-Za-z0-9_]+$/.test(scriptId)) {
      return { outcome: 'rejected: invalid scriptId', forModel: { error: 'scriptId must be a record type script id like "transaction" or "customrecord_xyz".' }, isError: true };
    }
    const path = '/app/recordscatalog/rcendpoint.nl?action=getRecordTypeDetail&data=' +
      encodeURI(JSON.stringify({ scriptId, detailType: 'SS_ANAL' }));
    const res = await ctx.deps.runInPage(ctx.tabId, pageFetchFn, [path, 'GET', null]);
    const json = parseFetchJson(res, 'Records Catalog (detail ' + scriptId + ')');
    const data = json.data || {};
    const allFields = Array.isArray(data.fields) ? data.fields : [];
    const fields = allFields
      .filter((f) => f && f.isColumn && !f.removed)
      .map((f) => ({ id: f.id, label: f.label || f.id, dataType: f.dataType || null }));
    const joins = (Array.isArray(data.joins) ? data.joins : [])
      .map((j) => (j && (j.label || j.id || j.name)) || null)
      .filter(Boolean);
    const sent = fields.slice(0, CATALOG_FIELDS_CAP);
    return {
      outcome: 'ok: ' + fields.length + ' column' + (fields.length === 1 ? '' : 's') + ', ' + joins.length + ' join' + (joins.length === 1 ? '' : 's'),
      forModel: { scriptId, label: data.label || scriptId, fields: sent, fieldsTotal: fields.length, truncated: fields.length > sent.length, joins },
      isError: false
    };
  }
  return { outcome: 'rejected: unknown action', forModel: { error: 'action must be "types" or "detail".' }, isError: true };
}

/**
 * Collects current-record context: page info plus trimmed body fields.
 * Shared by the tool executor and the system-prompt builder.
 */
async function collectCurrentRecord(ctx) {
  const info = (await ctx.deps.getPageInfo(ctx.tabId)) || {};
  let fields = [];
  let fieldsTotal = 0;
  let fieldError = null;
  try {
    const rf = await ctx.deps.getRecordFields(ctx.tabId);
    const body = rf && Array.isArray(rf.bodyFields) ? rf.bodyFields : [];
    fieldsTotal = body.length;
    fields = body.slice(0, RECORD_FIELD_CAP).map((f) => {
      const o = { id: f.id, label: f.label || '', type: f.type || '', value: f.value === undefined ? null : f.value };
      if (f.text !== null && f.text !== undefined && f.text !== '') o.text = f.text;
      return o;
    });
  } catch (e) {
    fieldError = e.message;
  }
  return {
    pageType: info.pageType || info.type || null,
    recordType: info.recordType || null,
    recordId: info.recordId || null,
    url: info.url || null,
    fields,
    fieldsTotal,
    fieldsTruncated: fieldsTotal > fields.length,
    fieldError
  };
}

/**
 * Executes get_current_record.
 */
async function toolGetCurrentRecord(input, ctx) {
  const rec = await collectCurrentRecord(ctx);
  const forModel = ctx.mask ? maskDeep(rec) : rec;
  const desc = rec.recordType ? rec.recordType + (rec.recordId ? ' #' + rec.recordId : '') : (rec.pageType || 'no record');
  return {
    outcome: 'ok: ' + desc + ', ' + rec.fields.length + ' field' + (rec.fields.length === 1 ? '' : 's') + (rec.fieldError ? ' (field scan: ' + rec.fieldError + ')' : ''),
    forModel,
    isError: false
  };
}

/**
 * Dispatches a tool call by name. Never throws; errors become results.
 * @returns {Promise<{ outcome: string, forModel: Object, isError: boolean, rows?: Array }>}
 */
async function executeMcpTool(name, input, ctx) {
  try {
    const r = await ctx.mcp.call(name, input || {});
    if (ctx.mask && r.forModel) r.forModel = maskDeep(r.forModel);
    if (ctx.mask && r.rows) r.rows = maskDeep(r.rows);
    return r;
  } catch (e) {
    return { outcome: 'error: ' + e.message, forModel: { error: e.message }, isError: true };
  }
}

async function executeTool(name, input, ctx) {
  try {
    if (name === 'run_suiteql') return await toolRunSuiteQL(input || {}, ctx);
    if (name === 'record_catalog') return await toolRecordCatalog(input || {}, ctx);
    if (name === 'get_current_record') return await toolGetCurrentRecord(input || {}, ctx);
    return { outcome: 'rejected: unknown tool', forModel: { error: 'Unknown tool "' + name + '".' }, isError: true };
  } catch (e) {
    return { outcome: 'error: ' + e.message, forModel: { error: e.message }, isError: true };
  }
}

/**
 * Shortens a tool input for the UI work log.
 * @param {*} input
 * @returns {string}
 */
function summarizeInput(input) {
  let s;
  try { s = typeof input === 'string' ? input : JSON.stringify(input); } catch (_) { s = String(input); }
  if (!s) return '';
  return s.length > 400 ? s.slice(0, 400) + '...' : s;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SCHEMA_HINTS = [
  'Common SuiteQL tables (verify with record_catalog before relying on a column):',
  '- transaction: id, tranid, type (SalesOrd, CustInvc, PurchOrd, ItemShip, RtnAuth, ...), trandate, entity, status, memo, foreigntotal, currency, createddate, lastmodifieddate, custbody_* fields',
  '- transactionline: transaction, id, linesequencenumber, item, quantity, rate, netamount, foreignamount, location, mainline (T/F), taxline (T/F), custcol_* fields',
  '- customer / vendor / employee / partner / contact: id, entityid, companyname, firstname, lastname, email, phone, isinactive, datecreated, custentity_* fields',
  '- entity: id, entityid, type (generic view across entity types)',
  '- item: id, itemid, displayname, itemtype, isinactive, custitem_* fields',
  '- systemnote: record, recordtypeid, date, field, oldvalue, newvalue, name (user), type',
  '- script, scriptdeployment, file, employee, location, subsidiary, department, classification, account, currency',
  '- custom records are their own tables named customrecord_<id> with columns id, name, isinactive, custrecord_* fields',
  'Syntax: Oracle-style. Use FETCH FIRST n ROWS ONLY (no LIMIT). BUILTIN.DF(col) returns display text for list/record columns. Booleans are \'T\'/\'F\'. Dates: TO_CHAR(col, \'YYYY-MM-DD\'), SYSDATE, ADD_MONTHS. String compare is case-sensitive unless you use UPPER().'
].join('\n');

/**
 * Builds the system prompt for either provider.
 * @param {Object} opts
 * @param {Object|null} opts.record - Current record context (already masked) or null.
 * @param {boolean} opts.nativeTools - True for Bedrock (real tool calling).
 * @returns {string}
 */
function buildSystemPrompt(opts) {
  const parts = [];
  parts.push('You are the NetSuite TactaSuite AI Assistant, a NetSuite data analyst working inside the NetSuite account the user is currently logged in to. ' +
    'Everything you say must be grounded in data read from THIS account through the tools provided; you are not a general chatbot.');
  parts.push('Rules:');
  parts.push(opts.mcp && opts.mcp.configured && opts.mcp.allowWrites
    ? '1. Treat data changes as exceptional: only when the user asks for one explicitly, after describing it, and through the confirmed write tools.'
    : '1. You are strictly READ-ONLY. Never attempt to create, update or delete anything. If asked to change data, explain how the user could do it in the NetSuite UI instead.');
  parts.push('2. Prefer running SuiteQL over assumptions. When you are unsure about a table or column name, verify it with record_catalog before guessing.');
  parts.push('3. Cite row counts and the record ids you looked at. Say clearly when a result set was truncated or empty.');
  parts.push('4. Answer in the same language the user writes in. Be concise and left-aligned plain text; use short bullet lists and simple tables when they help.');
  parts.push('5. Some values may appear as [masked]; this is deliberate privacy masking by the extension. Do not try to reconstruct them.');
  parts.push('6. Do not invent field values. If the data is not available, say so and suggest the query or page that would show it.');
  if (opts.mcp && opts.mcp.configured) {
    const names = opts.mcp.tools.map((t) => t.name);
    parts.push('Tools: you are connected to the NetSuite AI Connector (MCP) for account ' + opts.mcp.acct.label + '. Its tools run inside that account as the user: ' + names.join(', ') + '. ' +
      'Also available: get_current_record (what the user has on screen). Prefer ns_getSuiteQLMetadata (or the catalog tool) to verify tables and columns before writing SuiteQL. Call tools as needed, then give the final answer in plain text.');
    if (opts.mcp.allowWrites) {
      parts.push('Write tools are enabled, but every create/update/delete is shown to the user for confirmation before it runs. Only use them when the user explicitly asks to change data, state exactly what will change first, and never retry a declined write.');
    }
  } else if (opts.nativeTools) {
    parts.push('Tools: run_suiteql (read-only SELECT, max 500 rows), record_catalog (types / detail), get_current_record. Call tools as needed, then give the final answer in plain text.');
  }
  parts.push(SCHEMA_HINTS);
  if (opts.record && (opts.record.recordType || opts.record.recordId || opts.record.pageType)) {
    const r = opts.record;
    const lines = ['Current page context (provided by the extension):'];
    lines.push('- pageType: ' + (r.pageType || 'unknown'));
    if (r.recordType) lines.push('- recordType: ' + r.recordType);
    if (r.recordId) lines.push('- recordId (internal id): ' + r.recordId);
    if (r.fields && r.fields.length) {
      lines.push('- body fields (' + r.fields.length + (r.fieldsTruncated ? ' of ' + r.fieldsTotal : '') + '):');
      for (const f of r.fields) {
        const val = f.value === null || f.value === undefined ? '' : String(f.value);
        const txt = f.text ? ' (' + String(f.text) + ')' : '';
        lines.push('  ' + f.id + ' [' + (f.type || '?') + '] ' + (f.label ? '"' + f.label + '" ' : '') + '= ' + val.slice(0, 200) + txt.slice(0, 200));
      }
    } else if (r.fieldError) {
      lines.push('- body fields: not available (' + r.fieldError + ')');
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Bedrock provider (Converse API, bearer API key)
// ---------------------------------------------------------------------------

/**
 * Bedrock runtime origin for a region.
 * @param {string} region
 * @returns {string}
 */
export function bedrockOrigin(region) {
  return 'https://bedrock-runtime.' + region + '.amazonaws.com';
}

/** Origin match pattern for the local token helper, e.g. http://127.0.0.1:38790/* */
export function helperOriginPattern(helperUrl) {
  try { return new URL(helperUrl).origin + '/*'; } catch (_) { return 'http://127.0.0.1/*'; }
}

// Short-term token from the local helper, cached until shortly before expiry.
const helperToken = { url: '', token: '', expiresAt: 0 };

/**
 * Resolves the bearer token for a Bedrock call: the pasted API key, or a
 * short-term token minted by the local helper from the user's AWS login.
 * @param {Object} bedrock - settings.bedrock
 * @returns {Promise<string>}
 */
async function resolveBearer(bedrock) {
  if (bedrock.auth !== 'helper') {
    if (!bedrock.apiKey) throw new Error('No Bedrock API key saved. Open AI settings and add one, or switch to "Use my AWS login".');
    return bedrock.apiKey;
  }
  const now = Date.now();
  if (helperToken.token && helperToken.url === bedrock.helperUrl && helperToken.expiresAt - 60000 > now) {
    return helperToken.token;
  }
  let ok = false;
  try { ok = await chrome.permissions.contains({ origins: [helperOriginPattern(bedrock.helperUrl)] }); } catch (_) { ok = false; }
  if (!ok) throw new Error('The extension does not have permission to reach the local helper at ' + bedrock.helperUrl + '. Re-save the Bedrock settings to grant it.');
  let res;
  try {
    res = await fetch(bedrock.helperUrl + '/token', { headers: { 'X-Tacta-Helper': '1' }, cache: 'no-store' });
  } catch (e) {
    throw new Error('The local AWS token helper is not running at ' + bedrock.helperUrl + '. Start it with "npm start" in tools/bedrock-token-helper (see AI settings for the steps).');
  }
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  if (!res.ok || !json || !json.token) {
    throw new Error('The token helper could not mint a token: ' + ((json && json.error) || ('HTTP ' + res.status)));
  }
  helperToken.url = bedrock.helperUrl;
  helperToken.token = String(json.token);
  helperToken.expiresAt = Number(json.expiresAt) || (now + 60 * 60 * 1000);
  return helperToken.token;
}

/**
 * Checks the optional host permission for the Bedrock endpoint.
 * @param {string} region
 * @returns {Promise<boolean>}
 */
async function hasBedrockPermission(region) {
  try {
    return await chrome.permissions.contains({ origins: [bedrockOrigin(region) + '/*'] });
  } catch (_) {
    return false;
  }
}

/**
 * One Converse call. Throws readable errors on HTTP failures.
 * @param {Object} bedrock - settings.bedrock
 * @param {Object} body - { system, messages, toolConfig, inferenceConfig }
 * @returns {Promise<Object>} Converse response JSON.
 */
async function bedrockConverse(bedrock, body) {
  const bearer = await resolveBearer(bedrock);
  if (!(await hasBedrockPermission(bedrock.region))) {
    throw new Error('The extension does not have permission to reach ' + bedrockOrigin(bedrock.region) + '. Re-save the Bedrock settings to grant it.');
  }
  const url = bedrockOrigin(bedrock.region) + '/model/' + encodeURIComponent(bedrock.modelId) + '/converse';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + bearer,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error('Could not reach Bedrock (' + e.message + '). Check the region and your network.');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!res.ok) {
    const detail = (json && (json.message || json.Message)) || text.slice(0, 300) || res.statusText;
    const prefix = {
      400: 'Bedrock rejected the request (validation)',
      401: 'Bedrock rejected the token (expired AWS session? run aws sso login)',
      403: 'Bedrock denied access (key, model access or region)',
      404: 'Model not found in ' + bedrock.region,
      424: 'Bedrock model dependency failed',
      429: 'Bedrock is throttling requests',
      500: 'Bedrock internal error',
      503: 'Bedrock service unavailable'
    }[res.status] || ('Bedrock error ' + res.status);
    throw new Error(prefix + ': ' + detail);
  }
  if (!json) throw new Error('Bedrock returned an empty or non-JSON response.');
  return json;
}

/**
 * Converts UI chat messages to Converse messages, merging consecutive
 * same-role turns and guaranteeing the first turn is from the user.
 * @param {Array<{role: string, text: string}>} messages
 * @returns {Array}
 */
function toConverseMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length === 0 && role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push({ text: m.text });
    } else {
      out.push({ role, content: [{ text: m.text }] });
    }
  }
  return out;
}

/**
 * Adds Converse usage into an accumulator.
 */
function addUsage(acc, usage) {
  if (!usage) return acc;
  acc.inputTokens += usage.inputTokens || 0;
  acc.outputTokens += usage.outputTokens || 0;
  acc.totalTokens += usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0));
  acc.requests += 1;
  return acc;
}

/**
 * Full Bedrock tool-use loop.
 * @returns {Promise<{ text: string, steps: Array, usage: Object }>}
 */
async function chatBedrock(settings, messages, systemPrompt, ctx) {
  const bedrock = settings.bedrock;
  const convMessages = toConverseMessages(messages);
  if (!convMessages.length || convMessages[convMessages.length - 1].role !== 'user') {
    throw new Error('The last message must come from the user.');
  }
  // With the NetSuite AI Connector connected, its tools replace the local
  // SuiteQL / catalog tools; get_current_record stays (the page is local).
  const localSpecs = TOOL_SPECS
    .filter((t) => !(ctx.mcp && ctx.mcp.configured) || t.name === 'get_current_record')
    .map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } }));
  const toolConfig = { tools: localSpecs.concat(ctx.mcp && ctx.mcp.configured ? ctx.mcp.specs : []) };
  const steps = [];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };
  let finalText = '';
  let stopReason = null;

  for (let step = 0; step <= settings.maxSteps; step++) {
    const resp = await bedrockConverse(bedrock, {
      system: [{ text: systemPrompt }],
      messages: convMessages,
      toolConfig,
      inferenceConfig: { maxTokens: BEDROCK_MAX_TOKENS }
    });
    addUsage(usage, resp.usage);
    stopReason = resp.stopReason;
    const assistantMsg = (resp.output && resp.output.message) || { role: 'assistant', content: [] };
    const content = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    const textBlocks = content.filter((b) => b && typeof b.text === 'string').map((b) => b.text);
    const toolUses = content.filter((b) => b && b.toolUse).map((b) => b.toolUse);

    convMessages.push({ role: 'assistant', content });

    if (stopReason === 'tool_use' && toolUses.length) {
      if (step === settings.maxSteps) {
        finalText = (textBlocks.join('\n').trim() || '') +
          '\n\n[Step limit of ' + settings.maxSteps + ' reached before the model finished. Raise "max steps" in AI settings or ask a narrower question.]';
        break;
      }
      const results = [];
      for (const tu of toolUses) {
        const r = (ctx.mcp && ctx.mcp.configured && ctx.mcp.has(tu.name))
          ? await executeMcpTool(tu.name, tu.input, ctx)
          : await executeTool(tu.name, tu.input, ctx);
        const stepRec = { tool: tu.name, input: summarizeInput(tu.input), outcome: r.outcome };
        if (r.rows) { stepRec.rows = r.rows; stepRec.columns = r.columns; stepRec.totalRows = r.totalRows; }
        steps.push(stepRec);
        let json = r.forModel;
        if (json === null || typeof json !== 'object' || Array.isArray(json)) json = { value: json };
        results.push({ toolResult: { toolUseId: tu.toolUseId, content: [{ json }], status: r.isError ? 'error' : 'success' } });
      }
      convMessages.push({ role: 'user', content: results });
      continue;
    }

    finalText = textBlocks.join('\n').trim();
    if (stopReason === 'max_tokens') finalText += '\n\n[Response was cut off at the token limit.]';
    if (!finalText) finalText = '(The model returned no text. stopReason: ' + stopReason + ')';
    break;
  }

  return { text: finalText, steps, usage, stopReason };
}

// ---------------------------------------------------------------------------
// NetSuite N/llm provider (RESTlet, 2-step pseudo-agent)
// ---------------------------------------------------------------------------

/**
 * Builds the same-origin RESTlet path for the configured deployment.
 * @param {Object} ns - settings.netsuite
 * @param {Object} [extraParams]
 * @returns {string}
 */
function restletPath(ns, extraParams) {
  if (!ns.scriptId || !ns.deployId) throw new Error('NetSuite AI is not configured: script id and deploy id are required. Open AI settings.');
  let path = '/app/site/hosting/restlet.nl?script=' + encodeURIComponent(ns.scriptId) + '&deploy=' + encodeURIComponent(ns.deployId);
  if (extraParams) {
    for (const k of Object.keys(extraParams)) path += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(extraParams[k]));
  }
  return path;
}

/**
 * Calls the N/llm RESTlet inside the NetSuite tab (session cookie applies).
 * @returns {Promise<Object>} Parsed JSON body ({ text, usage } or ping result).
 */
async function callRestlet(ctx, ns, method, body, params) {
  const path = restletPath(ns, params);
  const res = await ctx.deps.runInPage(ctx.tabId, pageFetchFn, [path, method, body === undefined ? null : body]);
  const json = parseFetchJson(res, 'NetSuite AI RESTlet');
  if (json && json.error) {
    const e = json.error;
    throw new Error('NetSuite AI RESTlet error: ' + (e.name ? e.name + ' - ' : '') + (e.message || e.code || JSON.stringify(e)));
  }
  return json;
}

/**
 * Extracts the first fenced sql block from model text.
 * @param {string} text
 * @returns {string|null}
 */
function extractSqlBlock(text) {
  if (!text) return null;
  const m = text.match(/```(?:sql|suiteql)?\s*\n?([\s\S]*?)```/i);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  return null;
}

/**
 * 2-step pseudo-agent on N/llm.
 * @returns {Promise<{ text: string, steps: Array, usage: Object }>}
 */
async function chatNetSuite(settings, messages, systemPrompt, ctx) {
  const ns = settings.netsuite;
  const clean = (messages || []).filter((m) => m && typeof m.text === 'string' && m.text.trim());
  if (!clean.length || clean[clean.length - 1].role !== 'user') throw new Error('The last message must come from the user.');
  const question = clean[clean.length - 1].text;
  const history = clean.slice(0, -1).slice(-20).map((m) => ({ role: m.role === 'assistant' ? 'chatbot' : 'user', text: m.text }));

  const steps = [];
  const usage = { requests: 0, remainingFreeUsage: null };
  const noteUsage = (r) => {
    usage.requests += 1;
    if (r && r.usage && r.usage.remainingFreeUsage !== undefined) usage.remainingFreeUsage = r.usage.remainingFreeUsage;
    if (r && r.model) usage.model = r.model;
  };

  // Step 1: ask for one read-only SuiteQL (or a direct answer).
  const step1Preamble = systemPrompt + '\n\n' +
    'You cannot call tools directly. To look at data, reply with EXACTLY ONE read-only SuiteQL SELECT inside a fenced code block that starts with ```sql and ends with ```. ' +
    'Add at most two short sentences outside the block. Keep the query focused and include FETCH FIRST 100 ROWS ONLY unless aggregating. ' +
    'If the question needs no data (for example it is about NetSuite concepts, or the current page context above already answers it), reply with the final answer and no code block.';
  const step1 = await callRestlet(ctx, ns, 'POST', {
    prompt: question,
    preamble: step1Preamble,
    chatHistory: history,
    maxTokens: NETSUITE_MAX_TOKENS
  });
  noteUsage(step1);
  const step1Text = (step1 && step1.text) || '';
  const sql = extractSqlBlock(step1Text);

  if (!sql) {
    return { text: step1Text.trim() || '(NetSuite AI returned no text.)', steps, usage };
  }

  // Run the query through the same enforced tool path as Bedrock.
  const r = await executeTool('run_suiteql', { query: sql, maxRows: DEFAULT_ROWS_TO_MODEL }, ctx);
  const stepRec = { tool: 'run_suiteql', input: summarizeInput({ query: sql }), outcome: r.outcome };
  if (r.rows) { stepRec.rows = r.rows; stepRec.columns = r.columns; stepRec.totalRows = r.totalRows; }
  steps.push(stepRec);

  // Step 2: send the rows (or the error) back for the final answer.
  let resultText;
  try { resultText = JSON.stringify(r.forModel); } catch (_) { resultText = String(r.forModel); }
  if (resultText.length > 60000) resultText = resultText.slice(0, 60000) + '... [truncated]';

  const step2Preamble = systemPrompt + '\n\n' +
    'The extension already ran the SuiteQL you proposed. Below is the query and its JSON result (or error). ' +
    'Write the final answer to the user based on this data. State the row count, mention truncation, and do not propose further queries unless the result was an error (then suggest a corrected query in a ```sql block so the user can run it manually).';
  const step2Prompt = 'User question:\n' + question + '\n\nQuery that was run:\n```sql\n' + sql + '\n```\n\nResult JSON:\n' + resultText;
  const step2 = await callRestlet(ctx, ns, 'POST', {
    prompt: step2Prompt,
    preamble: step2Preamble,
    chatHistory: history,
    maxTokens: NETSUITE_MAX_TOKENS
  });
  noteUsage(step2);

  return { text: ((step2 && step2.text) || '').trim() || '(NetSuite AI returned no text.)', steps, usage };
}

// ---------------------------------------------------------------------------
// Tab resolution
// ---------------------------------------------------------------------------

/**
 * Finds a NetSuite tab when the caller (options page) could not supply one.
 * @param {number|undefined} tabId
 * @returns {Promise<number>}
 */
async function resolveNetSuiteTab(tabId) {
  if (tabId) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.url && /^https:\/\/[^/]+\.(netsuite|oracle)\.com\//.test(t.url)) return tabId;
    } catch (_) { /* fall through */ }
  }
  const tabs = await chrome.tabs.query({ url: ['https://*.netsuite.com/*', 'https://*.oracle.com/*'] });
  if (!tabs.length) throw new Error('No open NetSuite tab found. Open NetSuite in a tab and try again.');
  const active = tabs.find((t) => t.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  return active.id;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Handles AI Assistant messages. Returns undefined for actions it does not
 * own so the caller's switch can fall through.
 *
 * Actions:
 *   aiGetSettings                                   -> settings (key redacted for content scripts)
 *   aiSaveSettings  { settings }                    -> { success, settings }
 *   aiTestConnection { tabId? }                     -> { ok, provider, detail, latencyMs }
 *   aiChat { tabId?, messages, includeRecordContext } -> { text, steps, usage, provider, model }
 *
 * @param {Object} message
 * @param {Object} sender
 * @param {{ executeSuiteQL: Function, runInPage: Function, getPageInfo: Function, getRecordFields: Function }} deps
 * @returns {Promise<*>}
 */
export async function handleAiMessage(message, sender, deps) {
  if (!message || typeof message.action !== 'string' || message.action.indexOf('ai') !== 0) return undefined;

  switch (message.action) {
    case 'aiGetSettings': {
      const settings = await getSettings();
      return redactForSender(settings, sender);
    }

    case 'aiSaveSettings': {
      if (!isExtensionPage(sender)) throw new Error('AI settings can only be changed from the extension options page.');
      const incoming = message.settings || {};
      // Allow the UI to omit the key to keep the stored one (e.g. masked display).
      if (incoming.bedrock && incoming.bedrock.apiKey === undefined) {
        const current = await getSettings();
        incoming.bedrock = { ...incoming.bedrock, apiKey: current.bedrock.apiKey };
      }
      const saved = await saveSettings(incoming);
      return { success: true, settings: saved };
    }

    case 'aiTestConnection': {
      const settings = await getSettings();
      const started = Date.now();
      if (settings.provider === 'bedrock') {
        const resp = await bedrockConverse(settings.bedrock, {
          messages: [{ role: 'user', content: [{ text: 'Reply with the single word OK.' }] }],
          inferenceConfig: { maxTokens: 16 }
        });
        const txt = ((resp.output && resp.output.message && resp.output.message.content) || [])
          .map((b) => b.text || '').join('').trim();
        return {
          ok: true,
          provider: 'bedrock',
          detail: 'Bedrock responded from ' + settings.bedrock.modelId + ' in ' + settings.bedrock.region + (txt ? ' ("' + txt.slice(0, 40) + '")' : ''),
          latencyMs: Date.now() - started,
          usage: resp.usage || null
        };
      }
      if (settings.provider === 'netsuite') {
        const tabId = await resolveNetSuiteTab(message.tabId || (sender && sender.tab && sender.tab.id));
        const ctx = { tabId, deps };
        const ping = await callRestlet(ctx, settings.netsuite, 'GET', undefined, { ping: 'true' });
        const remaining = ping && ping.remainingFreeUsage !== undefined && ping.remainingFreeUsage !== null
          ? ', ' + ping.remainingFreeUsage + ' free N/llm requests remaining this month' : '';
        return {
          ok: true,
          provider: 'netsuite',
          detail: 'RESTlet reachable (role ' + (ping && ping.role !== undefined ? ping.role : '?') + remaining + ')',
          latencyMs: Date.now() - started,
          ping
        };
      }
      return { ok: false, provider: 'none', detail: 'No provider selected. Choose Bedrock or NetSuite AI and save first.' };
    }

    case 'aiChat': {
      const settings = await getSettings();
      if (settings.provider === 'none') throw new Error('No AI provider configured. Open AI settings to choose one.');
      const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
      if (!tabId) throw new Error('No tab ID available for the AI chat.');
      if (!deps || typeof deps.executeSuiteQL !== 'function' || typeof deps.runInPage !== 'function') {
        throw new Error('AI provider dependencies are not wired in the service worker.');
      }
      const ctx = { tabId, deps, mask: settings.maskSensitive !== false, mcp: null };
      const messages = Array.isArray(message.messages) ? message.messages : [];
      if (!messages.length) throw new Error('No messages to send.');

      // NetSuite AI Connector (MCP): the account comes from the tab. If it is
      // configured but the user is not signed in, say so instead of silently
      // falling back to the local tools.
      if (settings.provider === 'bedrock') {
        const confirmWrite = (toolName, input) => new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(tabId, { action: 'aiConfirmWrite', tool: toolName, input }, (resp) => {
              if (chrome.runtime.lastError) { resolve(false); return; }
              resolve(!!(resp && resp.approved));
            });
          } catch (_) { resolve(false); }
        });
        try {
          ctx.mcp = await mcpToolsetForTab(tabId, confirmWrite);
        } catch (e) {
          if (e.needsLogin) throw e;
          ctx.mcp = null;
          ctx.mcpError = e.message;
        }
      }

      let record = null;
      if (message.includeRecordContext) {
        try {
          record = await collectCurrentRecord(ctx);
          if (ctx.mask) record = maskDeep(record);
        } catch (e) {
          record = { pageType: null, recordType: null, recordId: null, fields: [], fieldError: e.message };
        }
      }
      const systemPrompt = buildSystemPrompt({ record, nativeTools: settings.provider === 'bedrock', mcp: ctx.mcp });

      const result = settings.provider === 'bedrock'
        ? await chatBedrock(settings, messages, systemPrompt, ctx)
        : await chatNetSuite(settings, messages, systemPrompt, ctx);

      return {
        text: result.text,
        steps: result.steps,
        usage: result.usage,
        provider: settings.provider,
        model: settings.provider === 'bedrock' ? settings.bedrock.modelId : (result.usage && result.usage.model) || 'NetSuite AI (N/llm)',
        masked: ctx.mask,
        recordContextIncluded: !!record,
        mcp: ctx.mcp && ctx.mcp.configured ? { account: ctx.mcp.acct.label, tools: ctx.mcp.tools.length, server: ctx.mcp.serverInfo && ctx.mcp.serverInfo.name } : (ctx.mcpError ? { error: ctx.mcpError } : null)
      };
    }

    default:
      return undefined;
  }
}
