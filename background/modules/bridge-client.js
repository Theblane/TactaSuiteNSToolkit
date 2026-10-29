/**
 * NetSuite TactaSuite - Local bridge client (service worker side)
 *
 * @author Blane Maher
 *
 * Connects the extension OUT to the local companion's loopback WebSocket
 * server (see companion/tacta-bridge.mjs). The companion is launched by the
 * user's desktop MCP client (e.g. Claude Desktop) and forwards MCP tool calls
 * here; this module runs them against the live NetSuite tab using the existing
 * service-worker primitives and returns the result.
 *
 * Why a WebSocket the extension dials OUT: an open WebSocket keeps the MV3
 * service worker alive (Chrome 116+), and the extension cannot itself run a
 * server. The companion owns the loopback port; we connect to it.
 *
 * Security: loopback only, shared pairing token in the hello handshake,
 * read-only by default. No NetSuite-side setup, no OAuth - everything runs in
 * the user's already-signed-in session.
 *
 * Capabilities are injected by the service worker (deps) so this module does
 * not duplicate the page-execution logic:
 *   deps.executeSuiteQL(tabId, query, params)
 *   deps.getPageInfo(tabId)
 *   deps.getRecordFields(tabId)
 *   deps.findNetSuiteTab()        -> { id, url, title } | null
 *   deps.listNetSuiteTabs()       -> [{ id, url, title, active }]
 */

const BRIDGE_SETTINGS_KEY = 'tacta_bridge_settings';
const DEFAULT_PORT = 8787;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

// sandboxOnly: when true the bridge ignores production tabs and only acts on
// sandbox / release-preview tabs (hostname contains "-sb<n>." or "sandbox").
const DEFAULT_SETTINGS = { enabled: false, token: '', port: DEFAULT_PORT, allowWrites: false, sandboxOnly: false };

const SANDBOX_HOST_RE = /^https:\/\/[^/]*(-sb\d+\.|sandbox|-rp\.)/i;

/** True when a NetSuite tab URL is a sandbox or release-preview account. */
export function isSandboxUrl(url) {
  return SANDBOX_HOST_RE.test(String(url || ''));
}

// In-memory connection state (per service-worker lifetime).
let ws = null;
let deps = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let desiredEnabled = false;
let status = { state: 'stopped', since: Date.now(), lastError: null, port: DEFAULT_PORT };

function setStatus(state, extra) {
  status = { ...status, state, since: Date.now(), ...(extra || {}) };
}

export async function getBridgeSettings() {
  const stored = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[BRIDGE_SETTINGS_KEY] || {}) };
}

export async function setBridgeSettings(patch) {
  const current = await getBridgeSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: next });
  return next;
}

/** Generate a fresh random pairing token (URL-safe). */
export function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getBridgeStatus() {
  return { ...status, connected: !!ws && status.state === 'connected' };
}

/**
 * Start (or restart) the bridge using the given capability deps. Reads the
 * stored settings; connects only when enabled. Safe to call repeatedly
 * (onStartup, onInstalled, alarm, settings change).
 */
export async function startBridge(injectedDeps) {
  if (injectedDeps) deps = injectedDeps;
  const settings = await getBridgeSettings();
  desiredEnabled = !!settings.enabled;

  if (!desiredEnabled) {
    stopBridge();
    return getBridgeStatus();
  }
  if (!settings.token) {
    setStatus('error', { lastError: 'No pairing token set.', port: settings.port });
    return getBridgeStatus();
  }
  // Already connected or connecting: leave it.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return getBridgeStatus();
  }
  connect(settings);
  return getBridgeStatus();
}

export function stopBridge() {
  desiredEnabled = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  setStatus('stopped', { lastError: null });
}

function scheduleReconnect(settings) {
  if (!desiredEnabled) return;
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setStatus('reconnecting', { port: settings.port, retryInMs: delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    getBridgeSettings().then((s) => { if (desiredEnabled) connect(s); });
  }, delay);
}

function connect(settings) {
  const port = Number(settings.port) || DEFAULT_PORT;
  let socket;
  try {
    socket = new WebSocket('ws://127.0.0.1:' + port);
  } catch (e) {
    setStatus('error', { lastError: String(e && e.message || e), port });
    scheduleReconnect(settings);
    return;
  }
  ws = socket;
  setStatus('connecting', { port, lastError: null });

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      v: 1,
      type: 'hello',
      token: settings.token,
      extId: chrome.runtime.id,
      capabilities: { readOnly: !settings.allowWrites }
    }));
  });

  socket.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch (_) { return; }

    if (msg.type === 'welcome') {
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus('connected', { port, server: msg.version, lastError: null });
      return;
    }
    if (msg.type === 'error') {
      setStatus('error', { lastError: msg.message || 'Bridge rejected the connection.', port });
      return;
    }
    if (msg.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong', t: msg.t })); } catch (_) {}
      return;
    }
    if (msg.type === 'call' && msg.id) {
      const settingsNow = await getBridgeSettings();
      try {
        const data = await dispatchTool(msg.tool, msg.args || {}, settingsNow);
        safeSend(socket, { type: 'result', id: msg.id, ok: true, data });
      } catch (e) {
        safeSend(socket, { type: 'result', id: msg.id, ok: false, error: String(e && e.message || e) });
      }
    }
  });

  socket.addEventListener('close', () => {
    if (ws === socket) ws = null;
    if (desiredEnabled) scheduleReconnect(settings);
    else setStatus('stopped');
  });

  socket.addEventListener('error', () => {
    // 'close' fires after 'error'; record the reason for the status card.
    setStatus('error', { lastError: 'Could not reach the companion on 127.0.0.1:' + port + '. Is it running?', port });
  });
}

function safeSend(socket, obj) {
  try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj)); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tool dispatch - maps MCP tool names to the live-session primitives.
// ---------------------------------------------------------------------------

const READONLY_PREFIX = /^\s*(select|with)\b/i;
const FORBIDDEN = /\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke)\b/i;

/** Tabs the bridge may act on, honouring the Sandbox-only setting. */
async function allowedTabs(settings) {
  const tabs = await deps.listNetSuiteTabs();
  return settings && settings.sandboxOnly ? tabs.filter((t) => isSandboxUrl(t.url)) : tabs;
}

/** The tab to act on: the one being viewed, else the most recently used. */
async function requireTab(settings) {
  const tabs = await allowedTabs(settings);
  if (!tabs.length) {
    if (settings && settings.sandboxOnly) {
      throw new Error('No open NetSuite sandbox tab found. The bridge is set to Sandbox only; open a sandbox tab or change the setting in the extension.');
    }
    throw new Error('No open NetSuite tab found. Open your NetSuite instance in a browser tab and try again.');
  }
  const active = tabs.find((t) => t.active);
  if (active) return active;
  // listNetSuiteTabs does not expose lastAccessed; fall back to the service
  // worker's own pick when it is allowed, else the first allowed tab.
  const preferred = await deps.findNetSuiteTab();
  if (preferred && tabs.some((t) => t.id === preferred.id)) return preferred;
  return tabs[0];
}

async function dispatchTool(tool, args, settings) {
  if (!deps) throw new Error('Bridge not initialised.');

  switch (tool) {
    case 'netsuite_run_suiteql': {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('A SuiteQL query is required.');
      // Read-only guard: default read-only. SELECT/WITH only, no DML keywords.
      if (!settings.allowWrites) {
        if (!READONLY_PREFIX.test(query) || FORBIDDEN.test(query)) {
          throw new Error('Read-only bridge: only SELECT / WITH SuiteQL queries are allowed.');
        }
      }
      const tab = await requireTab(settings);
      return deps.executeSuiteQL(tab.id, query, Array.isArray(args.params) ? args.params : null);
    }

    case 'netsuite_get_current_page': {
      const tab = await requireTab(settings);
      const info = await deps.getPageInfo(tab.id);
      return { tabUrl: tab.url, tabTitle: tab.title, page: info };
    }

    case 'netsuite_get_current_record_fields': {
      const tab = await requireTab(settings);
      return deps.getRecordFields(tab.id);
    }

    case 'netsuite_list_tabs': {
      const tabs = await allowedTabs(settings);
      return { tabs, sandboxOnly: !!settings.sandboxOnly };
    }

    default:
      throw new Error('Unknown tool: ' + tool);
  }
}
