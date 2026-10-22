/**
 * NetSuite TactaSuite - Claude Desktop bridge settings UI
 *
 * @author Blane Maher
 *
 * Self-contained settings card. Renders into #bridgeCard (options page) if
 * present. Talks to the service worker via chrome.runtime messages:
 *   getBridgeSettings / setBridgeSettings / generateBridgeToken / getBridgeStatus
 *
 * The companion itself (companion/tacta-bridge.mjs) is installed and launched
 * by the user's desktop MCP client; this card produces the config snippet and
 * the pairing token the companion needs.
 */
(function () {
  'use strict';

  const CARD_ID = 'bridgeCard';
  const LOOPBACK_ORIGIN = 'http://127.0.0.1/*';
  // Companion is distributed with the source, not inside the installed
  // extension (the browser cannot drop a file on disk or run Node). Users
  // download the single zero-dependency file from the public repo.
  const COMPANION_RAW_URL = 'https://raw.githubusercontent.com/Theblane/TactaSuiteNSToolkit/main/companion/tacta-bridge.mjs';
  const COMPANION_VIEW_URL = 'https://github.com/Theblane/TactaSuiteNSToolkit/blob/main/companion/tacta-bridge.mjs';

  function send(action, extra) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action, ...(extra || {}) }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function statusBadge(status) {
    const map = {
      connected: ['Connected', 'ok'],
      connecting: ['Connecting…', 'warn'],
      reconnecting: ['Reconnecting…', 'warn'],
      stopped: ['Disabled', 'off'],
      error: ['Not connected', 'err']
    };
    const [label, kind] = map[status.state] || ['Unknown', 'off'];
    return '<span class="tacta-br-badge tacta-br-badge-' + kind + '">' + esc(label) + '</span>';
  }

  function configSnippet(settings, extId) {
    const cfg = {
      mcpServers: {
        'netsuite-tactasuite': {
          command: 'node',
          args: ['C:\\\\path\\\\to\\\\companion\\\\tacta-bridge.mjs'],
          env: {
            TACTA_BRIDGE_TOKEN: settings.token || '<generate a token first>',
            TACTA_BRIDGE_PORT: String(settings.port || 8787),
            TACTA_BRIDGE_EXT_ID: extId || ''
          }
        }
      }
    };
    // Pretty-print but keep the escaped backslashes readable for the user.
    return JSON.stringify(cfg, null, 2).replace(/\\\\\\\\/g, '\\\\');
  }

  function render(container, data) {
    const { settings, status, extensionId } = data;
    const connected = status.state === 'connected';

    container.innerHTML =
      '<div class="tacta-br-head">' +
        '<label class="tacta-br-enable">' +
          '<input type="checkbox" id="brEnabled"' + (settings.enabled ? ' checked' : '') + '>' +
          '<span>Enable the local bridge</span>' +
        '</label>' +
        statusBadge(status) +
      '</div>' +
      (status.lastError && settings.enabled
        ? '<p class="tacta-br-error">' + esc(status.lastError) + '</p>' : '') +

      '<div class="tacta-br-grid">' +
        '<div class="tacta-br-row">' +
          '<label class="tacta-br-label" for="brToken">Pairing token</label>' +
          '<div class="tacta-br-inline">' +
            '<input type="text" id="brToken" class="tacta-br-input tacta-br-mono" readonly value="' + esc(settings.token) + '" placeholder="No token yet">' +
            '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brGen">Generate</button>' +
            '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brCopyToken">Copy</button>' +
          '</div>' +
          '<span class="tacta-br-hint">Shared secret the companion must present. Keep it private.</span>' +
        '</div>' +

        '<div class="tacta-br-row">' +
          '<label class="tacta-br-label" for="brPort">Loopback port</label>' +
          '<input type="number" id="brPort" class="tacta-br-input tacta-br-port" min="1024" max="65535" value="' + esc(settings.port || 8787) + '">' +
          '<span class="tacta-br-hint">Must match TACTA_BRIDGE_PORT in the companion config.</span>' +
        '</div>' +

        '<div class="tacta-br-row tacta-br-row-toggle">' +
          '<div>' +
            '<span class="tacta-br-label">Allow write queries</span>' +
            '<span class="tacta-br-hint">Off = read-only (SELECT / WITH only). Recommended.</span>' +
          '</div>' +
          '<label class="tacta-toggle">' +
            '<input type="checkbox" id="brAllowWrites"' + (settings.allowWrites ? ' checked' : '') + '>' +
            '<span class="tacta-toggle-track"></span>' +
          '</label>' +
        '</div>' +
      '</div>' +

      '<div class="tacta-br-actions">' +
        '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brGrant">Grant local access</button>' +
        '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brRefresh">Refresh status</button>' +
      '</div>' +

      '<details class="tacta-br-setup"' + (settings.enabled && !connected ? ' open' : '') + '>' +
        '<summary>Setup: install the companion and configure Claude Desktop</summary>' +
        '<div class="tacta-br-download">' +
          '<a class="tacta-opt-btn tacta-opt-btn-primary" id="brDownload" href="' + esc(COMPANION_RAW_URL) + '" download="tacta-bridge.mjs" target="_blank" rel="noreferrer">Download the companion</a>' +
          '<span class="tacta-br-hint">One zero-dependency file (<code>tacta-bridge.mjs</code>). ' +
            'If it opens in a tab instead of downloading, use your browser\'s Save As, ' +
            'or get it from <a href="' + esc(COMPANION_VIEW_URL) + '" target="_blank" rel="noreferrer">GitHub</a>.</span>' +
        '</div>' +
        '<ol class="tacta-br-steps">' +
          '<li>Install <a href="https://nodejs.org" target="_blank" rel="noreferrer">Node.js</a> (18 or newer) if you do not have it.</li>' +
          '<li>Download <code>tacta-bridge.mjs</code> (button above) and save it to a stable folder on your PC. There is nothing to install - it has no dependencies.</li>' +
          '<li>Generate a token above and click <strong>Grant local access</strong>.</li>' +
          '<li>Add the block below to your Claude Desktop config ' +
            '(<code>%APPDATA%\\Claude\\claude_desktop_config.json</code>), fixing the path to the file.</li>' +
          '<li>Restart Claude Desktop. Open your NetSuite tab. The status above turns <em>Connected</em>.</li>' +
        '</ol>' +
        '<div class="tacta-br-snippet-head">' +
          '<span>Claude Desktop config</span>' +
          '<button type="button" class="tacta-opt-btn tacta-opt-btn-secondary" id="brCopyCfg">Copy</button>' +
        '</div>' +
        '<pre class="tacta-br-snippet" id="brSnippet">' + esc(configSnippet(settings, extensionId)) + '</pre>' +
        '<p class="tacta-br-hint">Extension ID: <span class="tacta-br-mono">' + esc(extensionId) + '</span></p>' +
      '</details>';

    wire(container, data);
  }

  function wire(container, data) {
    const $ = (id) => container.querySelector('#' + id);
    const toast = (msg) => flash(container, msg);

    async function persist(patch) {
      const res = await send('setBridgeSettings', { settings: patch });
      // Re-render with fresh settings + status.
      const fresh = await send('getBridgeSettings');
      render(container, fresh);
      return res;
    }

    $('brEnabled').addEventListener('change', async (e) => {
      const enable = e.target.checked;
      if (enable) {
        // Need a token and loopback permission to be useful.
        const current = data.settings;
        if (!current.token) { toast('Generate a pairing token first.'); e.target.checked = false; return; }
        const granted = await ensurePermission();
        if (!granted) { toast('Local access was not granted.'); e.target.checked = false; return; }
      }
      await persist({ enabled: enable });
    });

    $('brGen').addEventListener('click', async () => {
      const { token } = await send('generateBridgeToken');
      await persist({ token });
      toast('New token generated. Update your Claude Desktop config.');
    });

    $('brCopyToken').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('brToken').value || '');
      toast('Token copied.');
    });

    $('brPort').addEventListener('change', async (e) => {
      const port = Math.max(1024, Math.min(65535, parseInt(e.target.value, 10) || 8787));
      await persist({ port });
    });

    $('brAllowWrites').addEventListener('change', async (e) => {
      await persist({ allowWrites: e.target.checked });
    });

    $('brGrant').addEventListener('click', async () => {
      const granted = await ensurePermission();
      toast(granted ? 'Local access granted.' : 'Local access was not granted.');
    });

    $('brRefresh').addEventListener('click', async () => {
      await send('restartBridge');
      const fresh = await send('getBridgeSettings');
      render(container, fresh);
    });

    $('brCopyCfg').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('brSnippet').textContent || '');
      toast('Config copied.');
    });
  }

  function ensurePermission() {
    return new Promise((resolve) => {
      chrome.permissions.request({ origins: [LOOPBACK_ORIGIN] }, (granted) => {
        resolve(!!granted && !chrome.runtime.lastError);
      });
    });
  }

  let toastTimer = null;
  function flash(container, msg) {
    let el = container.querySelector('.tacta-br-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tacta-br-toast';
      container.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function injectStyles() {
    if (document.getElementById('tacta-br-styles')) return;
    const style = document.createElement('style');
    style.id = 'tacta-br-styles';
    style.textContent = [
      '.tacta-opt-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--tacta-surface-2,#eef1f4);color:var(--tacta-text-muted,#667085);vertical-align:middle;margin-left:6px}',
      '.tacta-opt-bridge{display:flex;flex-direction:column;gap:14px;position:relative}',
      '.tacta-br-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.tacta-br-enable{display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer}',
      '.tacta-br-badge{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px}',
      '.tacta-br-badge-ok{background:rgba(118,192,67,.15);color:#3f8a1f}',
      '.tacta-br-badge-warn{background:rgba(245,170,40,.15);color:#a86a00}',
      '.tacta-br-badge-err{background:rgba(224,70,70,.13);color:#c0392b}',
      '.tacta-br-badge-off{background:var(--tacta-surface-2,#eef1f4);color:var(--tacta-text-muted,#667085)}',
      '.tacta-br-error{margin:0;font-size:13px;color:#c0392b}',
      '.tacta-br-grid{display:flex;flex-direction:column;gap:14px}',
      '.tacta-br-row{display:flex;flex-direction:column;gap:6px}',
      '.tacta-br-row-toggle{flex-direction:row;align-items:center;justify-content:space-between}',
      '.tacta-br-label{font-weight:600;font-size:13px}',
      '.tacta-br-hint{font-size:12px;color:var(--tacta-text-muted,#667085)}',
      '.tacta-br-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.tacta-br-input{flex:1;min-width:180px;padding:7px 10px;border:1px solid var(--tacta-border,#d0d5dd);border-radius:6px;background:var(--tacta-surface,#fff);color:var(--tacta-text,#1a1a1a)}',
      '.tacta-br-port{max-width:120px}',
      '.tacta-br-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
      '.tacta-br-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.tacta-br-setup{border:1px solid var(--tacta-border,#d0d5dd);border-radius:8px;padding:10px 14px;background:var(--tacta-surface-2,#f7f9fb)}',
      '.tacta-br-setup summary{cursor:pointer;font-weight:600}',
      '.tacta-br-download{display:flex;flex-direction:column;gap:6px;margin:12px 0;padding:12px;border:1px solid var(--tacta-border,#d0d5dd);border-radius:8px;background:var(--tacta-surface,#fff)}',
      '.tacta-br-download a.tacta-opt-btn{align-self:flex-start;text-decoration:none;display:inline-flex;align-items:center}',
      '.tacta-br-steps{margin:10px 0;padding-left:20px;font-size:13px;line-height:1.6}',
      '.tacta-br-snippet-head{display:flex;align-items:center;justify-content:space-between;margin-top:8px}',
      '.tacta-br-snippet{margin:6px 0 0;padding:12px;border-radius:6px;background:var(--tacta-code-bg,#0f1115);color:var(--tacta-code-text,#e6e6e6);font-family:ui-monospace,Consolas,monospace;font-size:12px;overflow:auto;white-space:pre}',
      '.tacta-br-toast{position:absolute;right:0;bottom:-8px;transform:translateY(100%);background:var(--tacta-text,#1a1a1a);color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none}',
      '.tacta-br-toast.show{opacity:1}'
    ].join('');
    document.head.appendChild(style);
  }

  async function init() {
    const container = document.getElementById(CARD_ID);
    if (!container) return;
    injectStyles();
    try {
      const data = await send('getBridgeSettings');
      render(container, data);
    } catch (e) {
      container.innerHTML = '<p class="tacta-br-error">Could not load bridge settings: ' + esc(e.message) + '</p>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
