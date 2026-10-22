/**
 * NetSuite TactaSuite - NetSuite AI Connector (MCP) client
 *
 * @author Blane Maher
 *
 * Makes the extension an MCP client of NetSuite's own AI Connector SuiteApp
 * ("NetSuite MCP Toolbox"), so the model's tool calls run inside the user's
 * NetSuite account, as the user, through NetSuite-supported tools
 * (ns_runCustomSuiteQL, ns_getRecord, ns_runSavedSearch, ns_createRecord ...).
 *
 * Auth: OAuth 2.0 Authorization Code + PKCE with a PUBLIC client integration
 * record (scope "mcp" = NetSuite AI Connector Service). The browser handles the
 * login through chrome.identity.launchWebAuthFlow; the redirect URI is the
 * extension's chromiumapp.org URL. Access tokens last 60 minutes and are
 * refreshed silently with the rotating refresh token (persisted on every use).
 *
 * Account targeting: derived from the NetSuite tab the assistant is open on
 * (4485744-sb2.app.netsuite.com -> 4485744-sb2.suitetalk.api.netsuite.com).
 * Each account has its own Client ID and its own tokens.
 *
 * Transport: MCP Streamable HTTP (JSON-RPC over POST). Responses may be plain
 * JSON or an SSE stream; both are handled. Sessions (Mcp-Session-Id) are kept
 * per account for the life of the service worker and re-created on 404.
 *
 * Storage (chrome.storage.local, never synced):
 *   tacta_mcp_settings = { accounts: { [accountId]: { clientId } }, allowWrites: false }
 *   tacta_mcp_tokens   = { [accountId]: { accessToken, expiresAt, refreshToken } }
 */

export const MCP_SETTINGS_KEY = 'tacta_mcp_settings';
export const MCP_TOKENS_KEY = 'tacta_mcp_tokens';
const MCP_SUITEAPP_PATH = '/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_SCOPE = 'mcp';
const TOOL_LIST_TTL_MS = 10 * 60 * 1000;
// Tools whose names suggest they change data. Hidden unless the user enables
// writes; when enabled, each call is confirmed in the chat panel first.
export const RE_WRITE_TOOL = /create|update|delete|remove|submit|attach|detach|transform|upload|execute|write|cancel|approve|void|insert|upsert|rename|move|purge|set[A-Z_]/i;

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * Account descriptor from a NetSuite page URL.
 * @param {string} url
 * @returns {{ accountId: string, uiOrigin: string, apiOrigin: string, mcpUrl: string, tokenUrl: string, authorizeUrl: string, label: string }|null}
 */
export function accountFromUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return null; }
  // 4485744.app.netsuite.com, 4485744-sb2.app.netsuite.com, 4485744-rp.app.netsuite.com
  const m = host.match(/^([a-z0-9]+(?:-[a-z0-9]+)?)\.app\.netsuite\.com$/);
  if (!m) return null;
  const accountId = m[1];
  const sb = accountId.match(/-(sb\d*|rp)$/i);
  return {
    accountId,
    uiOrigin: 'https://' + accountId + '.app.netsuite.com',
    apiOrigin: 'https://' + accountId + '.suitetalk.api.netsuite.com',
    mcpUrl: 'https://' + accountId + '.suitetalk.api.netsuite.com' + MCP_SUITEAPP_PATH,
    tokenUrl: 'https://' + accountId + '.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
    authorizeUrl: 'https://' + accountId + '.app.netsuite.com/app/login/oauth2/authorize.nl',
    label: sb ? accountId.split('-')[0] + ' ' + sb[1].toUpperCase() : accountId + ' PRODUCTION'
  };
}

async function accountForTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const acct = accountFromUrl(tab && tab.url || '');
  if (!acct) throw new Error('This tab is not a NetSuite account page, so the AI Connector account cannot be determined.');
  return acct;
}

// ---------------------------------------------------------------------------
// Settings and tokens
// ---------------------------------------------------------------------------

export async function getMcpSettings() {
  const data = await chrome.storage.local.get(MCP_SETTINGS_KEY);
  const s = data[MCP_SETTINGS_KEY] || {};
  return { accounts: (s.accounts && typeof s.accounts === 'object') ? s.accounts : {}, allowWrites: s.allowWrites === true };
}

async function saveMcpSettings(next) {
  const cur = await getMcpSettings();
  const merged = { accounts: { ...cur.accounts }, allowWrites: cur.allowWrites };
  if (typeof next.allowWrites === 'boolean') merged.allowWrites = next.allowWrites;
  if (next.accounts && typeof next.accounts === 'object') {
    for (const [acct, cfg] of Object.entries(next.accounts)) {
      if (!/^[a-z0-9-]+$/i.test(acct)) continue;
      const clientId = String((cfg && cfg.clientId) || '').trim();
      if (!clientId) { delete merged.accounts[acct]; continue; }
      if (!/^[A-Za-z0-9._~-]{16,200}$/.test(clientId)) throw new Error('Client ID for ' + acct + ' does not look like a NetSuite integration Client ID.');
      merged.accounts[acct] = { clientId };
    }
  }
  await chrome.storage.local.set({ [MCP_SETTINGS_KEY]: merged });
  return merged;
}

async function getTokens() {
  const data = await chrome.storage.local.get(MCP_TOKENS_KEY);
  return data[MCP_TOKENS_KEY] || {};
}

async function setAccountTokens(accountId, tok) {
  const all = await getTokens();
  if (tok) all[accountId] = tok; else delete all[accountId];
  await chrome.storage.local.set({ [MCP_TOKENS_KEY]: all });
}

// ---------------------------------------------------------------------------
// OAuth 2.0 Authorization Code + PKCE via chrome.identity
// ---------------------------------------------------------------------------

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function redirectUri() {
  return chrome.identity.getRedirectURL();
}

async function tokenRequest(acct, params) {
  const body = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(acct.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body });
  } catch (e) {
    throw new Error('Could not reach the NetSuite token endpoint for ' + acct.accountId + ' (' + e.message + ').');
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!res.ok || !json || !json.access_token) {
    const detail = (json && (json.error_description || json.error)) || text.slice(0, 200) || res.statusText;
    const err = new Error('NetSuite token request failed (' + res.status + '): ' + detail);
    err.status = res.status;
    throw err;
  }
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    refreshToken: json.refresh_token || params.refresh_token || ''
  };
}

/**
 * Interactive sign-in for one account. Must be triggered from a user action.
 * @param {Object} acct - from accountFromUrl
 * @param {string} clientId
 */
async function signIn(acct, clientId) {
  if (!chrome.identity || !chrome.identity.launchWebAuthFlow) throw new Error('chrome.identity is not available (is the "identity" permission in the manifest?).');
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const u = new URL(acct.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', DEFAULT_SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');

  const finalUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: u.toString(), interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!responseUrl) { reject(new Error('The NetSuite sign-in window was closed before it finished.')); return; }
      resolve(responseUrl);
    });
  });
  const ru = new URL(finalUrl);
  const code = ru.searchParams.get('code');
  const err = ru.searchParams.get('error');
  if (err) throw new Error('NetSuite refused the sign-in: ' + err + (ru.searchParams.get('error_description') ? ' - ' + ru.searchParams.get('error_description') : ''));
  if (!code) throw new Error('NetSuite did not return an authorization code.');
  if (ru.searchParams.get('state') !== state) throw new Error('OAuth state mismatch; sign-in aborted.');

  const tok = await tokenRequest(acct, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier
  });
  await setAccountTokens(acct.accountId, tok);
  sessions.delete(acct.accountId);
  return tok;
}

/**
 * A valid access token for the account, refreshing if needed.
 */
async function accessTokenFor(acct, clientId) {
  const all = await getTokens();
  const tok = all[acct.accountId];
  if (!tok || !tok.refreshToken) {
    const e = new Error('Not signed in to the NetSuite AI Connector for ' + acct.label + '. Open the AI Assistant settings and click "Sign in to NetSuite".');
    e.needsLogin = true;
    throw e;
  }
  if (tok.accessToken && tok.expiresAt - 60000 > Date.now()) return tok.accessToken;
  let fresh;
  try {
    fresh = await tokenRequest(acct, { grant_type: 'refresh_token', refresh_token: tok.refreshToken, client_id: clientId });
  } catch (e) {
    if (e.status === 400 || e.status === 401) {
      await setAccountTokens(acct.accountId, null);
      const err = new Error('The NetSuite AI Connector session for ' + acct.label + ' has expired. Sign in again from the AI Assistant settings.');
      err.needsLogin = true;
      throw err;
    }
    throw e;
  }
  // Refresh tokens rotate: persist the new one immediately.
  await setAccountTokens(acct.accountId, fresh);
  return fresh.accessToken;
}

// ---------------------------------------------------------------------------
// MCP Streamable HTTP client
// ---------------------------------------------------------------------------

const sessions = new Map(); // accountId -> { sessionId, serverInfo, tools, toolsAt }
let rpcId = 1;

function parseSse(text) {
  const messages = [];
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch (_) { /* skip non-JSON events */ }
  }
  return messages;
}

async function rpc(acct, clientId, method, params, opts) {
  opts = opts || {};
  const token = await accessTokenFor(acct, clientId);
  const sess = sessions.get(acct.accountId);
  const id = opts.notification ? undefined : rpcId++;
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION
  };
  if (sess && sess.sessionId) headers['Mcp-Session-Id'] = sess.sessionId;
  const body = opts.notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };

  let res;
  try {
    res = await fetch(acct.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Could not reach the NetSuite MCP server for ' + acct.label + ' (' + e.message + ').');
  }
  if (res.status === 404 && sess && !opts.retried) {
    // Session expired on the server: start over once.
    sessions.delete(acct.accountId);
    await initialize(acct, clientId);
    return rpc(acct, clientId, method, params, { ...opts, retried: true });
  }
  if (res.status === 401) {
    await setAccountTokens(acct.accountId, null);
    const e = new Error('NetSuite rejected the AI Connector token for ' + acct.label + '. Sign in again from the AI Assistant settings.');
    e.needsLogin = true;
    throw e;
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessions.set(acct.accountId, { ...(sessions.get(acct.accountId) || {}), sessionId: sid });
  if (opts.notification) { if (!res.ok && res.status !== 202) throw new Error('MCP notification failed: HTTP ' + res.status); return null; }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = (j.error && (j.error.message || JSON.stringify(j.error))) || (j.message) || detail; } catch (_) { /* keep text */ }
    const e = new Error('NetSuite MCP ' + method + ' failed (' + res.status + '): ' + detail);
    e.status = res.status;
    throw e;
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let msg = null;
  if (ctype.includes('text/event-stream')) {
    const all = parseSse(text);
    msg = all.find((m) => m && m.id === id) || all.find((m) => m && (m.result || m.error)) || null;
  } else {
    try { msg = JSON.parse(text); } catch (_) { msg = null; }
    if (Array.isArray(msg)) msg = msg.find((m) => m && m.id === id) || msg[0];
  }
  if (!msg) throw new Error('NetSuite MCP ' + method + ' returned no JSON-RPC response.');
  if (msg.error) throw new Error('NetSuite MCP ' + method + ' error: ' + (msg.error.message || JSON.stringify(msg.error)));
  return msg.result;
}

async function initialize(acct, clientId) {
  const existing = sessions.get(acct.accountId);
  if (existing && existing.initialized) return existing;
  sessions.delete(acct.accountId);
  const result = await rpc(acct, clientId, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'NetSuite TactaSuite', version: chrome.runtime.getManifest().version }
  });
  const sess = sessions.get(acct.accountId) || {};
  sess.initialized = true;
  sess.serverInfo = (result && result.serverInfo) || null;
  sess.protocolVersion = (result && result.protocolVersion) || MCP_PROTOCOL_VERSION;
  sessions.set(acct.accountId, sess);
  try { await rpc(acct, clientId, 'notifications/initialized', {}, { notification: true }); } catch (_) { /* some servers do not need it */ }
  return sess;
}

async function listTools(acct, clientId, force) {
  const sess = await initialize(acct, clientId);
  if (!force && sess.tools && sess.toolsAt && Date.now() - sess.toolsAt < TOOL_LIST_TTL_MS) return sess.tools;
  const tools = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await rpc(acct, clientId, 'tools/list', cursor ? { cursor } : {});
    for (const t of (result && result.tools) || []) tools.push(t);
    cursor = result && result.nextCursor;
    if (!cursor) break;
  }
  sess.tools = tools;
  sess.toolsAt = Date.now();
  sessions.set(acct.accountId, sess);
  return tools;
}

async function callTool(acct, clientId, name, args) {
  await initialize(acct, clientId);
  return rpc(acct, clientId, 'tools/call', { name, arguments: args || {} });
}

// ---------------------------------------------------------------------------
// Bridge for the AI provider
// ---------------------------------------------------------------------------

function isWriteTool(name) { return RE_WRITE_TOOL.test(name); }

/**
 * Normalizes an MCP tool result for the model and for the chat work log.
 * @param {Object} result - MCP tools/call result
 */
function normalizeToolResult(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  const texts = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  let forModel = null;
  let rows = null;
  let columns = null;
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    forModel = result.structuredContent;
  } else if (texts.length === 1) {
    try { forModel = JSON.parse(texts[0]); } catch (_) { forModel = { text: texts[0] }; }
  } else {
    forModel = { text: texts.join('\n') };
  }
  // Common shapes: { rows: [...] } / { items: [...] } / an array of objects
  const list = Array.isArray(forModel) ? forModel
    : (forModel && Array.isArray(forModel.rows)) ? forModel.rows
      : (forModel && Array.isArray(forModel.items)) ? forModel.items
        : (forModel && Array.isArray(forModel.results)) ? forModel.results : null;
  if (list && list.length && typeof list[0] === 'object' && list[0] !== null) {
    columns = Object.keys(list[0]).slice(0, 40);
    rows = list.slice(0, 500).map((r) => columns.map((c) => r[c]));
  }
  return { forModel, rows, columns, totalRows: list ? list.length : null, isError: !!(result && result.isError) };
}

/**
 * Resolves the MCP toolset for a tab: tool specs in Bedrock format plus an
 * executor. Returns null when the account has no Client ID configured.
 * Throws with needsLogin when the user has to sign in.
 * @param {number} tabId
 * @param {Function} confirmWrite - async (toolName, input) => boolean
 */
export async function mcpToolsetForTab(tabId, confirmWrite) {
  const acct = await accountForTab(tabId);
  const settings = await getMcpSettings();
  const cfg = settings.accounts[acct.accountId];
  if (!cfg || !cfg.clientId) return { acct, configured: false, tools: [], specs: [], allowWrites: settings.allowWrites };
  const tools = await listTools(acct, cfg.clientId, false);
  const visible = tools.filter((t) => settings.allowWrites || !isWriteTool(t.name));
  const specs = visible.map((t) => ({
    toolSpec: {
      name: t.name,
      description: String(t.description || '').slice(0, 2000) || ('NetSuite MCP tool ' + t.name),
      inputSchema: { json: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} } }
    }
  }));
  const names = new Set(visible.map((t) => t.name));
  return {
    acct,
    configured: true,
    allowWrites: settings.allowWrites,
    serverInfo: (sessions.get(acct.accountId) || {}).serverInfo || null,
    tools: visible,
    specs,
    has: (name) => names.has(name),
    isWrite: isWriteTool,
    call: async (name, input) => {
      if (isWriteTool(name)) {
        if (!settings.allowWrites) return { outcome: 'rejected: write tools are disabled', forModel: { error: 'Write tools are disabled in the extension settings.' }, isError: true };
        const ok = confirmWrite ? await confirmWrite(name, input) : false;
        if (!ok) return { outcome: 'declined by user', forModel: { error: 'The user declined this write. Do not retry it; explain what you wanted to change instead.' }, isError: true };
      }
      const result = await callTool(acct, cfg.clientId, name, input);
      const n = normalizeToolResult(result);
      return {
        outcome: n.isError ? 'error' : (n.totalRows !== null ? n.totalRows + ' row(s)' : 'ok'),
        forModel: n.forModel,
        rows: n.rows,
        columns: n.columns,
        totalRows: n.totalRows,
        isError: n.isError
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Message handler (settings page / chat panel)
// ---------------------------------------------------------------------------

async function statusForTab(tabId) {
  let acct = null;
  try { acct = await accountForTab(tabId); } catch (_) { acct = null; }
  const settings = await getMcpSettings();
  if (!acct) return { account: null, configured: false, signedIn: false, allowWrites: settings.allowWrites, redirectUri: redirectUri() };
  const cfg = settings.accounts[acct.accountId] || null;
  const tokens = await getTokens();
  const tok = tokens[acct.accountId] || null;
  const out = {
    account: acct.accountId,
    label: acct.label,
    mcpUrl: acct.mcpUrl,
    authorizeUrl: acct.authorizeUrl,
    redirectUri: redirectUri(),
    clientId: cfg ? cfg.clientId : '',
    configured: !!cfg,
    signedIn: !!(tok && tok.refreshToken),
    accessTokenExpiresAt: tok ? tok.expiresAt : null,
    allowWrites: settings.allowWrites,
    tools: null,
    serverInfo: null,
    error: null
  };
  if (out.configured && out.signedIn) {
    try {
      const tools = await listTools(acct, cfg.clientId, false);
      out.tools = tools.map((t) => ({ name: t.name, write: isWriteTool(t.name), description: String(t.description || '').slice(0, 160) }));
      out.serverInfo = (sessions.get(acct.accountId) || {}).serverInfo || null;
    } catch (e) {
      out.error = e.message;
      if (e.needsLogin) out.signedIn = false;
    }
  }
  return out;
}

/**
 * Handles mcp* messages. Returns undefined for other actions.
 */
export async function handleMcpMessage(message, sender, deps) {
  const tabIdOf = async () => {
    if (message.tabId) return message.tabId;
    if (sender && sender.tab && sender.tab.id) return sender.tab.id;
    if (deps && typeof deps.findNetSuiteTab === 'function') return deps.findNetSuiteTab();
    throw new Error('Open a NetSuite tab first; the AI Connector account is taken from it.');
  };
  switch (message.action) {
    case 'mcpStatus':
      return statusForTab(await tabIdOf());
    case 'mcpSaveSettings':
      return { success: true, settings: await saveMcpSettings(message.settings || {}) };
    case 'mcpSignIn': {
      const tabId = await tabIdOf();
      const acct = await accountForTab(tabId);
      const settings = await getMcpSettings();
      let clientId = settings.accounts[acct.accountId] && settings.accounts[acct.accountId].clientId;
      if (message.clientId) {
        await saveMcpSettings({ accounts: { [acct.accountId]: { clientId: message.clientId } } });
        clientId = String(message.clientId).trim();
      }
      if (!clientId) throw new Error('Enter the integration record Client ID for ' + acct.label + ' first.');
      await signIn(acct, clientId);
      return statusForTab(tabId);
    }
    case 'mcpSignOut': {
      const tabId = await tabIdOf();
      const acct = await accountForTab(tabId);
      await setAccountTokens(acct.accountId, null);
      sessions.delete(acct.accountId);
      return statusForTab(tabId);
    }
    case 'mcpRefreshTools': {
      const tabId = await tabIdOf();
      const acct = await accountForTab(tabId);
      const settings = await getMcpSettings();
      const cfg = settings.accounts[acct.accountId];
      if (!cfg) throw new Error('No Client ID configured for ' + acct.label + '.');
      await listTools(acct, cfg.clientId, true);
      return statusForTab(tabId);
    }
    default:
      return undefined;
  }
}
