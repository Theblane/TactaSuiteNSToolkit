/**
 * ai-settings-ui.js
 * NetSuite TactaSuite - AI Assistant Settings UI
 *
 * @author Blane Maher
 *
 * Renders the AI Assistant settings form into any container (options page,
 * or a compact variant inside the popup). Talks to the service worker with
 * aiGetSettings / aiSaveSettings / aiTestConnection. Keys are stored only in
 * chrome.storage.local (tacta_ai_settings) by the service worker.
 *
 * Exposes: window.TactaAISettingsUI.render(containerEl, { compact })
 *
 * Styling: self-contained <style> block using --tacta-* variables only.
 * All classes are prefixed tacta-ai-set-.
 */
(function () {
    'use strict';

    if (window.TactaAISettingsUI) return;

    var STYLE_ID = 'tacta-ai-set-styles';
    var RESTLET_FILE_NAME = 'tacta_rl_netsuite_llm.js';

    var MODEL_PRESETS = [
        { id: 'us.anthropic.claude-fable-5-1', label: 'Claude Fable 5.1 (default)' },
        { id: 'us.anthropic.claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
        { id: 'us.anthropic.claude-opus-5', label: 'Claude Opus 5' },
        { id: 'us.anthropic.claude-sonnet-5', label: 'Claude Sonnet 5' },
        { id: 'us.anthropic.claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
    ];

    var REGION_PRESETS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-central-1', 'eu-west-1', 'eu-west-3', 'ap-southeast-2', 'ap-northeast-1'];

    /**
     * Source of the N/llm RESTlet. Generated from docs/ai/tacta_rl_netsuite_llm.js;
     * regenerate this constant from that file whenever it changes.
     * @type {string}
     */
    var RESTLET_SOURCE = "/**\n * NetSuite TactaSuite - NetSuite AI (N/llm) RESTlet\n *\n * @NApiVersion 2.1\n * @NScriptType Restlet\n * @NModuleScope SameAccount\n * @author Blane Maher\n *\n * Thin JSON wrapper around N/llm.generateText so the TactaSuite Chrome\n * extension can use the NetSuite AI allotment of the account the user is\n * logged in to. The extension calls this RESTlet same-origin from the\n * NetSuite tab, so the normal session cookie and the user's role apply.\n *\n * GET  ?ping=true                 -> { ok: true, remainingFreeUsage, time }\n * POST { prompt, preamble, chatHistory, maxTokens, temperature, modelFamily }\n *                                 -> { text, model, usage: { remainingFreeUsage } }\n *\n * chatHistory items: { role: 'user' | 'chatbot', text: string }\n * Errors are always returned as JSON: { error: { name, message } }\n *\n * This script never writes to any record. It only forwards text to N/llm.\n */\ndefine(['N/llm', 'N/log', 'N/runtime'], (llm, log, runtime) => {\n\n    const MAX_PROMPT_CHARS = 100000;\n    const MAX_PREAMBLE_CHARS = 20000;\n    const MAX_HISTORY_ITEMS = 40;\n    const DEFAULT_MAX_TOKENS = 2000;\n    const MAX_MAX_TOKENS = 4000;\n\n    /**\n     * Builds the standard error envelope.\n     * @param {Error|string} err\n     * @returns {{ error: { name: string, message: string } }}\n     */\n    const errorJson = (err) => {\n        const e = err || {};\n        return {\n            error: {\n                name: String(e.name || 'ERROR'),\n                message: String(e.message || e || 'Unknown error')\n            }\n        };\n    };\n\n    /**\n     * Remaining free N/llm requests for this account this month, or null\n     * when the API is not available in this account version.\n     * @returns {number|null}\n     */\n    const remainingFreeUsage = () => {\n        try {\n            if (typeof llm.getRemainingFreeUsage === 'function') {\n                return llm.getRemainingFreeUsage();\n            }\n        } catch (e) {\n            log.debug('getRemainingFreeUsage failed', e.message);\n        }\n        return null;\n    };\n\n    /**\n     * Converts the extension's chat history into N/llm ChatMessage objects.\n     * @param {Array<{role: string, text: string}>} history\n     * @returns {Array} llm.ChatMessage[]\n     */\n    const buildChatHistory = (history) => {\n        if (!Array.isArray(history)) return [];\n        const trimmed = history.slice(-MAX_HISTORY_ITEMS);\n        const out = [];\n        trimmed.forEach((item) => {\n            if (!item || typeof item.text !== 'string' || !item.text.trim()) return;\n            const role = String(item.role || '').toLowerCase() === 'chatbot'\n                ? llm.ChatRole.CHATBOT\n                : llm.ChatRole.USER;\n            out.push(llm.createChatMessage({ role: role, text: item.text }));\n        });\n        return out;\n    };\n\n    /**\n     * Resolves an optional model family name against llm.ModelFamily.\n     * Unknown or missing values fall back to the NetSuite default.\n     * @param {string} name\n     * @returns {string|undefined}\n     */\n    const resolveModelFamily = (name) => {\n        if (!name || !llm.ModelFamily) return undefined;\n        const key = String(name).toUpperCase();\n        return llm.ModelFamily[key] || undefined;\n    };\n\n    /**\n     * GET handler. Used by the extension's \"Test\" button.\n     * @param {Object} params - Query string parameters.\n     * @returns {Object}\n     */\n    const get = (params) => {\n        try {\n            const user = runtime.getCurrentUser();\n            return {\n                ok: true,\n                ping: !!(params && params.ping),\n                user: user ? user.id : null,\n                role: user ? user.role : null,\n                remainingFreeUsage: remainingFreeUsage(),\n                time: new Date().toISOString()\n            };\n        } catch (e) {\n            log.error('tacta_rl_netsuite_llm GET failed', e);\n            return errorJson(e);\n        }\n    };\n\n    /**\n     * POST handler. Runs one N/llm.generateText call.\n     * @param {Object} body - Parsed JSON request body.\n     * @returns {Object}\n     */\n    const post = (body) => {\n        try {\n            const req = body || {};\n            if (typeof req.prompt !== 'string' || !req.prompt.trim()) {\n                return errorJson({ name: 'MISSING_PROMPT', message: 'Request body must include a non-empty \"prompt\" string.' });\n            }\n\n            const prompt = req.prompt.length > MAX_PROMPT_CHARS\n                ? req.prompt.slice(0, MAX_PROMPT_CHARS)\n                : req.prompt;\n\n            let preamble = typeof req.preamble === 'string' ? req.preamble : '';\n            if (preamble.length > MAX_PREAMBLE_CHARS) preamble = preamble.slice(0, MAX_PREAMBLE_CHARS);\n\n            let maxTokens = parseInt(req.maxTokens, 10);\n            if (!maxTokens || maxTokens < 1) maxTokens = DEFAULT_MAX_TOKENS;\n            if (maxTokens > MAX_MAX_TOKENS) maxTokens = MAX_MAX_TOKENS;\n\n            let temperature = parseFloat(req.temperature);\n            if (isNaN(temperature) || temperature < 0 || temperature > 1) temperature = 0.2;\n\n            const options = {\n                prompt: prompt,\n                chatHistory: buildChatHistory(req.chatHistory),\n                modelParameters: {\n                    maxTokens: maxTokens,\n                    temperature: temperature\n                }\n            };\n            if (preamble) options.preamble = preamble;\n\n            const family = resolveModelFamily(req.modelFamily);\n            if (family) options.modelFamily = family;\n\n            const started = Date.now();\n            const response = llm.generateText(options);\n\n            return {\n                text: response && typeof response.text === 'string' ? response.text : '',\n                model: response && response.model ? String(response.model) : null,\n                usage: {\n                    remainingFreeUsage: remainingFreeUsage(),\n                    elapsedMs: Date.now() - started\n                }\n            };\n        } catch (e) {\n            log.error('tacta_rl_netsuite_llm POST failed', e);\n            return errorJson(e);\n        }\n    };\n\n    return { get: get, post: post };\n});\n";

    // ── Styles ───────────────────────────────────────────────────────

    var CSS = [
        '.tacta-ai-set { font-family: var(--tacta-font-family); color: var(--tacta-text); font-size: var(--tacta-font-size-md); text-align: left; max-width: 760px; }',
        '.tacta-ai-set * { box-sizing: border-box; }',
        '.tacta-ai-set-card { background: var(--tacta-bg); border: 1px solid var(--tacta-border); border-radius: var(--tacta-radius-lg); padding: var(--tacta-space-lg); margin-bottom: var(--tacta-space-lg); }',
        '.tacta-ai-set-card-title { font-size: var(--tacta-font-size-lg); font-weight: 600; margin: 0 0 var(--tacta-space-xs) 0; }',
        '.tacta-ai-set-card-desc { color: var(--tacta-text-muted); font-size: var(--tacta-font-size-sm); margin: 0 0 var(--tacta-space-md) 0; line-height: var(--tacta-line-height); }',
        '.tacta-ai-set-row { display: flex; align-items: center; gap: var(--tacta-space-md); padding: var(--tacta-space-sm) 0; border-top: 1px solid var(--tacta-border); flex-wrap: wrap; }',
        '.tacta-ai-set-card-desc + .tacta-ai-set-row { border-top: none; }',
        '.tacta-ai-set-label { flex: 0 0 170px; font-size: var(--tacta-font-size-sm); color: var(--tacta-text-secondary); }',
        '.tacta-ai-set-label small { display: block; color: var(--tacta-text-muted); font-size: var(--tacta-font-size-xs); margin-top: 2px; }',
        '.tacta-ai-set-control { flex: 1 1 260px; display: flex; align-items: center; gap: var(--tacta-space-sm); min-width: 0; }',
        '.tacta-ai-set-input, .tacta-ai-set-select, .tacta-ai-set-num { padding: 7px 10px; font-family: var(--tacta-font-mono); font-size: var(--tacta-font-size-sm); color: var(--tacta-text); background: var(--tacta-bg-elevated); border: 1px solid var(--tacta-border); border-radius: var(--tacta-radius-md); outline: none; transition: border-color var(--tacta-transition-normal), box-shadow var(--tacta-transition-normal); }',
        '.tacta-ai-set-input { flex: 1; min-width: 0; }',
        '.tacta-ai-set-num { width: 80px; }',
        '.tacta-ai-set-select { font-family: var(--tacta-font-family); cursor: pointer; }',
        '.tacta-ai-set-input:focus, .tacta-ai-set-select:focus, .tacta-ai-set-num:focus { border-color: var(--tacta-border-focus); box-shadow: 0 0 0 2px var(--tacta-accent-muted); }',
        '.tacta-ai-set-input::placeholder { color: var(--tacta-text-muted); opacity: 0.6; }',
        '.tacta-ai-set-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; font-family: var(--tacta-font-family); font-size: var(--tacta-font-size-md); font-weight: 500; border-radius: var(--tacta-radius-md); border: 1px solid var(--tacta-border); background: var(--tacta-bg-elevated); color: var(--tacta-text-secondary); cursor: pointer; transition: all var(--tacta-transition-normal); white-space: nowrap; }',
        '.tacta-ai-set-btn:hover { background: var(--tacta-bg-hover); border-color: var(--tacta-border-light); color: var(--tacta-text); }',
        '.tacta-ai-set-btn:disabled { opacity: 0.5; cursor: default; }',
        '.tacta-ai-set-btn-primary { background: var(--tacta-accent); color: var(--tacta-text-inverse); border-color: var(--tacta-accent); }',
        '.tacta-ai-set-btn-primary:hover { background: var(--tacta-accent-hover); border-color: var(--tacta-accent-hover); box-shadow: var(--tacta-shadow-glow); color: var(--tacta-text-inverse); }',
        '.tacta-ai-set-btn-sm { padding: 5px 10px; font-size: var(--tacta-font-size-sm); }',
        '.tacta-ai-set-radios { display: flex; gap: var(--tacta-space-sm); flex-wrap: wrap; }',
        '.tacta-ai-set-radio { display: flex; align-items: flex-start; gap: var(--tacta-space-sm); padding: var(--tacta-space-sm) var(--tacta-space-md); border: 1px solid var(--tacta-border); border-radius: var(--tacta-radius-md); background: var(--tacta-bg-elevated); cursor: pointer; flex: 1 1 200px; transition: border-color var(--tacta-transition-fast); }',
        '.tacta-ai-set-radio:hover { border-color: var(--tacta-border-light); }',
        '.tacta-ai-set-radio.tacta-ai-set-radio-on { border-color: var(--tacta-accent); background: var(--tacta-accent-muted); }',
        '.tacta-ai-set-radio input { margin: 3px 0 0 0; accent-color: var(--tacta-accent); }',
        '.tacta-ai-set-radio-title { font-weight: 600; font-size: var(--tacta-font-size-sm); }',
        '.tacta-ai-set-radio-desc { color: var(--tacta-text-muted); font-size: var(--tacta-font-size-xs); margin-top: 2px; line-height: 1.4; }',
        '.tacta-ai-set-toggle { position: relative; width: 44px; height: 24px; flex-shrink: 0; display: inline-block; }',
        '.tacta-ai-set-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }',
        '.tacta-ai-set-toggle-track { position: absolute; inset: 0; background: var(--tacta-bg-active); border-radius: var(--tacta-radius-full); cursor: pointer; transition: background var(--tacta-transition-normal); border: 1px solid var(--tacta-border); }',
        '.tacta-ai-set-toggle-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; background: var(--tacta-text-muted); border-radius: 50%; transition: transform var(--tacta-transition-normal), background var(--tacta-transition-normal); }',
        '.tacta-ai-set-toggle input:checked + .tacta-ai-set-toggle-track { background: var(--tacta-accent); border-color: var(--tacta-accent); }',
        '.tacta-ai-set-toggle input:checked + .tacta-ai-set-toggle-track::after { transform: translateX(20px); background: var(--tacta-text); }',
        '.tacta-ai-set-toggle input:focus-visible + .tacta-ai-set-toggle-track { outline: 2px solid var(--tacta-accent); outline-offset: 2px; }',
        '.tacta-ai-set-status { font-size: var(--tacta-font-size-sm); color: var(--tacta-text-muted); }',
        '.tacta-ai-set-status.tacta-ai-set-ok { color: var(--tacta-success); }',
        '.tacta-ai-set-status.tacta-ai-set-err { color: var(--tacta-error); }',
        '.tacta-ai-set-status.tacta-ai-set-warn { color: var(--tacta-warning); }',
        '.tacta-ai-set-actions { display: flex; align-items: center; gap: var(--tacta-space-sm); flex-wrap: wrap; padding-top: var(--tacta-space-md); }',
        '.tacta-ai-set-result { flex: 1 1 100%; min-height: 18px; font-size: var(--tacta-font-size-sm); line-height: 1.4; }',
        '.tacta-ai-set-hidden { display: none !important; }',
        '.tacta-ai-set-guide details { border: 1px solid var(--tacta-border); border-radius: var(--tacta-radius-md); margin-top: var(--tacta-space-md); background: var(--tacta-bg-elevated); }',
        '.tacta-ai-set-guide summary { cursor: pointer; padding: var(--tacta-space-sm) var(--tacta-space-md); font-weight: 600; font-size: var(--tacta-font-size-sm); color: var(--tacta-text-secondary); }',
        '.tacta-ai-set-guide summary:hover { color: var(--tacta-text); }',
        '.tacta-ai-set-guide-body { padding: 0 var(--tacta-space-md) var(--tacta-space-md); }',
        '.tacta-ai-set-steps { margin: 0; padding-left: 22px; font-size: var(--tacta-font-size-sm); line-height: var(--tacta-line-height); color: var(--tacta-text-secondary); }',
        '.tacta-ai-set-steps li { margin: var(--tacta-space-sm) 0; }',
        '.tacta-ai-set-steps strong { color: var(--tacta-text); }',
        '.tacta-ai-set-steps code, .tacta-ai-set-faq code { font-family: var(--tacta-font-mono); font-size: var(--tacta-font-size-xs); background: var(--tacta-bg); border: 1px solid var(--tacta-border); border-radius: var(--tacta-radius-sm); padding: 1px 4px; }',
        '.tacta-ai-set-codewrap { margin: var(--tacta-space-sm) 0; }',
        '.tacta-ai-set-codebar { display: flex; align-items: center; justify-content: space-between; gap: var(--tacta-space-sm); margin-bottom: var(--tacta-space-xs); }',
        '.tacta-ai-set-codename { font-family: var(--tacta-font-mono); font-size: var(--tacta-font-size-xs); color: var(--tacta-text-muted); }',
        '.tacta-ai-set-code { display: block; max-height: 260px; overflow: auto; margin: 0; padding: var(--tacta-space-md); font-family: var(--tacta-font-mono); font-size: var(--tacta-font-size-xs); line-height: 1.45; color: var(--tacta-text-secondary); background: var(--tacta-bg); border: 1px solid var(--tacta-border); border-radius: var(--tacta-radius-md); white-space: pre; text-align: left; }',
        '.tacta-ai-set-faq { font-size: var(--tacta-font-size-sm); color: var(--tacta-text-secondary); line-height: var(--tacta-line-height); }',
        '.tacta-ai-set-faq dt { font-weight: 600; color: var(--tacta-text); margin-top: var(--tacta-space-sm); }',
        '.tacta-ai-set-faq dd { margin: 2px 0 0 0; color: var(--tacta-text-muted); }',
        '.tacta-ai-set-compact .tacta-ai-set-label { flex-basis: 120px; }',
        '.tacta-ai-set-compact .tacta-ai-set-card { padding: var(--tacta-space-md); margin-bottom: var(--tacta-space-md); }'
    ].join('\n');

    function ensureStyles(doc) {
        if (doc.getElementById(STYLE_ID)) return;
        var style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (doc.head || doc.documentElement).appendChild(style);
    }

    // ── Helpers ──────────────────────────────────────────────────────

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (k === 'className') node.className = v;
                else if (k === 'textContent') node.textContent = v;
                else if (k === 'events') Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
                else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (s) { node.style[s] = v[s]; });
                else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
            });
        }
        (children || []).forEach(function (c) {
            if (c === null || c === undefined) return;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function sendMessage(payload) {
        return new Promise(function (resolve, reject) {
            try {
                chrome.runtime.sendMessage(payload, function (response) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else if (response && response.error) reject(new Error(response.error));
                    else resolve(response);
                });
            } catch (e) { reject(e); }
        });
    }

    function bedrockOriginPattern(region) {
        return 'https://bedrock-runtime.' + region + '.amazonaws.com/*';
    }

    function permissionsContains(region) {
        return new Promise(function (resolve) {
            if (!chrome.permissions || !chrome.permissions.contains) { resolve(false); return; }
            try {
                chrome.permissions.contains({ origins: [bedrockOriginPattern(region)] }, function (ok) { resolve(!!ok && !chrome.runtime.lastError); });
            } catch (_) { resolve(false); }
        });
    }

    function permissionsRequest(region) {
        return new Promise(function (resolve, reject) {
            if (!chrome.permissions || !chrome.permissions.request) { reject(new Error('chrome.permissions is not available here.')); return; }
            try {
                chrome.permissions.request({ origins: [bedrockOriginPattern(region)] }, function (granted) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(!!granted);
                });
            } catch (e) { reject(e); }
        });
    }

    /**
     * Finds the tab the SW should use for tests: the active NetSuite tab if
     * there is one, else the most recently used NetSuite tab, else null.
     */
    function findNetSuiteTabId() {
        return new Promise(function (resolve) {
            if (!chrome.tabs || !chrome.tabs.query) { resolve(null); return; }
            var isNs = function (t) { return t && t.url && /^https:\/\/[^/]+\.(netsuite|oracle)\.com\//.test(t.url); };
            chrome.tabs.query({ active: true, currentWindow: true }, function (active) {
                if (chrome.runtime.lastError) { resolve(null); return; }
                if (active && active[0] && isNs(active[0])) { resolve(active[0].id); return; }
                chrome.tabs.query({ url: ['https://*.netsuite.com/*', 'https://*.oracle.com/*'] }, function (tabs) {
                    if (chrome.runtime.lastError || !tabs || !tabs.length) { resolve(null); return; }
                    tabs.sort(function (a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); });
                    var act = tabs.filter(function (t) { return t.active; })[0];
                    resolve((act || tabs[0]).id);
                });
            });
        });
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
        }
        return Promise.resolve(false);
    }

    function downloadText(filename, text) {
        var blob = new Blob([text], { type: 'text/javascript' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    }

    function setStatus(node, text, kind) {
        node.textContent = text || '';
        node.className = 'tacta-ai-set-status' + (kind ? ' tacta-ai-set-' + kind : '');
    }

    // ── Render ───────────────────────────────────────────────────────

    /**
     * Renders the settings UI into a container.
     * @param {HTMLElement} containerEl
     * @param {{ compact?: boolean }} [options]
     * @returns {{ reload: Function }}
     */
    function render(containerEl, options) {
        var opts = options || {};
        ensureStyles(containerEl.ownerDocument || document);
        containerEl.innerHTML = '';

        var root = el('div', { className: 'tacta-ai-set' + (opts.compact ? ' tacta-ai-set-compact' : '') });
        containerEl.appendChild(root);

        var state = { provider: 'none', bedrock: { region: 'us-east-1', modelId: 'us.anthropic.claude-fable-5-1', apiKey: '' }, netsuite: { scriptId: '', deployId: '' }, maskSensitive: true, maxSteps: 8 };

        // ── Provider card ──
        var providerCard = el('div', { className: 'tacta-ai-set-card' }, [
            el('h3', { className: 'tacta-ai-set-card-title', textContent: 'AI Assistant provider' }),
            el('p', { className: 'tacta-ai-set-card-desc', textContent: 'The assistant answers only with data it reads from the NetSuite account you are logged in to. Pick who runs the language model. Nothing is sent anywhere until you press Send in the assistant.' })
        ]);
        var radios = el('div', { className: 'tacta-ai-set-radios' });
        var radioDefs = [
            { value: 'none', title: 'Off', desc: 'AI Assistant shows a setup card only.' },
            { value: 'bedrock', title: 'Claude on Amazon Bedrock', desc: 'Your AWS account, Bedrock API key. Native tool calling, multi-step.' },
            { value: 'netsuite', title: 'NetSuite AI (N/llm)', desc: 'Runs inside NetSuite through a RESTlet you deploy. Uses the account\'s NetSuite AI allotment.' }
        ];
        var radioInputs = [];
        radioDefs.forEach(function (d) {
            var input = el('input', { type: 'radio', name: 'tacta-ai-set-provider', value: d.value });
            radioInputs.push(input);
            var label = el('label', { className: 'tacta-ai-set-radio' }, [
                input,
                el('div', null, [
                    el('div', { className: 'tacta-ai-set-radio-title', textContent: d.title }),
                    el('div', { className: 'tacta-ai-set-radio-desc', textContent: d.desc })
                ])
            ]);
            input.addEventListener('change', function () { state.provider = d.value; syncVisibility(); });
            radios.appendChild(label);
        });
        providerCard.appendChild(radios);
        root.appendChild(providerCard);

        // ── Bedrock card ──
        var regionInput = el('input', { className: 'tacta-ai-set-input', type: 'text', placeholder: 'us-east-1', list: 'tacta-ai-set-regions', spellcheck: 'false' });
        var regionList = el('datalist', { id: 'tacta-ai-set-regions' }, REGION_PRESETS.map(function (r) { return el('option', { value: r }); }));
        var modelSelect = el('select', { className: 'tacta-ai-set-select' }, MODEL_PRESETS.map(function (m) { return el('option', { value: m.id, textContent: m.label }); }).concat([el('option', { value: '', textContent: 'Custom model id...' })]));
        var modelInput = el('input', { className: 'tacta-ai-set-input', type: 'text', placeholder: 'us.anthropic.claude-fable-5-1', spellcheck: 'false' });
        var keyInput = el('input', { className: 'tacta-ai-set-input', type: 'password', placeholder: 'Bedrock API key (bearer token)', autocomplete: 'off', spellcheck: 'false' });
        var keyToggle = el('button', { className: 'tacta-ai-set-btn tacta-ai-set-btn-sm', type: 'button', textContent: 'Show' });
        var permStatus = el('span', { className: 'tacta-ai-set-status' });

        keyToggle.addEventListener('click', function () {
            var show = keyInput.type === 'password';
            keyInput.type = show ? 'text' : 'password';
            keyToggle.textContent = show ? 'Hide' : 'Show';
        });
        modelSelect.addEventListener('change', function () {
            if (modelSelect.value) modelInput.value = modelSelect.value;
            modelInput.focus();
        });
        modelInput.addEventListener('input', function () {
            var match = MODEL_PRESETS.some(function (m) { return m.id === modelInput.value.trim(); });
            modelSelect.value = match ? modelInput.value.trim() : '';
        });
        regionInput.addEventListener('change', function () { refreshPermStatus(); });

        var bedrockCard = el('div', { className: 'tacta-ai-set-card' }, [
            el('h3', { className: 'tacta-ai-set-card-title', textContent: 'Claude on Amazon Bedrock' }),
            el('p', { className: 'tacta-ai-set-card-desc', textContent: 'Calls POST https://bedrock-runtime.<region>.amazonaws.com/model/<model>/converse with your key as a bearer token. The key stays in this browser profile (chrome.storage.local, never synced). Saving asks Chrome for permission to reach that single Bedrock host.' }),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Region', el('small', { textContent: 'Where your Bedrock model access is enabled' })]),
                el('div', { className: 'tacta-ai-set-control' }, [regionInput, regionList])
            ]),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Model', el('small', { textContent: 'Pick a preset or type any Bedrock model / inference profile id' })]),
                el('div', { className: 'tacta-ai-set-control', style: { flexWrap: 'wrap' } }, [modelSelect, modelInput])
            ]),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['API key', el('small', { textContent: 'Bedrock API key (long-term or short-term)' })]),
                el('div', { className: 'tacta-ai-set-control' }, [keyInput, keyToggle])
            ]),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Host permission']),
                el('div', { className: 'tacta-ai-set-control' }, [permStatus])
            ])
        ]);
        root.appendChild(bedrockCard);

        // ── NetSuite card ──
        var scriptInput = el('input', { className: 'tacta-ai-set-input', type: 'text', placeholder: 'customscript_tacta_rl_netsuite_llm or 1234', spellcheck: 'false' });
        var deployInput = el('input', { className: 'tacta-ai-set-input', type: 'text', placeholder: 'customdeploy_tacta_rl_netsuite_llm or 1', spellcheck: 'false' });

        var copyBtn = el('button', { className: 'tacta-ai-set-btn tacta-ai-set-btn-sm', type: 'button', textContent: 'Copy' });
        var downloadBtn = el('button', { className: 'tacta-ai-set-btn tacta-ai-set-btn-sm', type: 'button', textContent: 'Download' });
        copyBtn.addEventListener('click', function () {
            copyText(RESTLET_SOURCE).then(function (ok) {
                copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
                setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1800);
            });
        });
        downloadBtn.addEventListener('click', function () { downloadText(RESTLET_FILE_NAME, RESTLET_SOURCE); });

        var codeBlock = el('div', { className: 'tacta-ai-set-codewrap' }, [
            el('div', { className: 'tacta-ai-set-codebar' }, [
                el('span', { className: 'tacta-ai-set-codename', textContent: RESTLET_FILE_NAME + ' (SuiteScript 2.1 RESTlet)' }),
                el('span', null, [copyBtn, ' ', downloadBtn])
            ]),
            el('pre', { className: 'tacta-ai-set-code', textContent: RESTLET_SOURCE })
        ]);

        var guideSteps = el('ol', { className: 'tacta-ai-set-steps' }, [
            el('li', null, [el('strong', { textContent: 'What this is. ' }), 'N/llm is NetSuite\'s built-in SuiteScript module for calling the language models Oracle hosts for NetSuite (NetSuite AI / Text Enhance). Prompts never leave Oracle\'s cloud. Every call draws on the account\'s monthly NetSuite AI allotment (free requests, then SuiteCloud Plus / paid usage as licensed). The RESTlet below is a thin JSON wrapper around ', el('code', { textContent: 'llm.generateText' }), '; it writes nothing.']),
            el('li', null, [el('strong', { textContent: 'Get the RESTlet code. ' }), 'Copy or download the file, then review it. It only forwards prompt / preamble / chat history to N/llm and returns ', el('code', { textContent: '{ text, usage }' }), '.', codeBlock]),
            el('li', null, [el('strong', { textContent: 'Create the Script record. ' }), 'In NetSuite go to Customization > Scripting > Scripts > New. Upload ', el('code', { textContent: RESTLET_FILE_NAME }), ' (into SuiteScripts in the File Cabinet) and click Create Script Record. Give it a name such as "TactaSuite NetSuite AI RESTlet" and note its script id (for example ', el('code', { textContent: 'customscript_tacta_rl_netsuite_llm' }), ').']),
            el('li', null, [el('strong', { textContent: 'Deploy it. ' }), 'On the script record click Deploy Script. Set Status to Released, Audience > Roles to the roles that should be allowed to use the assistant (or Select All Roles), Log Level to Error (Debug while testing). Save and note the deployment id (for example ', el('code', { textContent: 'customdeploy_tacta_rl_netsuite_llm' }), ').']),
            el('li', null, [el('strong', { textContent: 'Permissions and features. ' }), 'The role using the assistant needs the SuiteScript permission (Setup > Users/Roles > Manage Roles > Permissions > Setup > SuiteScript) and must be in the deployment audience. In Setup > Company > Enable Features > SuiteCloud, Client SuiteScript and Server SuiteScript must be on. N/llm itself needs the NetSuite AI prerequisites in Enable Features (the Generative AI / Text Enhance related options for your account version) and an account version where N/llm is available (2024.1 or later).']),
            el('li', null, [el('strong', { textContent: 'Connect. ' }), 'Paste the script id and deployment id below, click Save, then Test. Test performs a GET ping to the RESTlet from your open NetSuite tab using your current session and reports the remaining free N/llm requests.'])
        ]);

        var guide = el('div', { className: 'tacta-ai-set-guide' }, [
            el('details', { open: opts.compact ? null : true }, [
                el('summary', { textContent: 'Set up NetSuite AI (step by step)' }),
                el('div', { className: 'tacta-ai-set-guide-body' }, [guideSteps])
            ])
        ]);

        var netsuiteCard = el('div', { className: 'tacta-ai-set-card' }, [
            el('h3', { className: 'tacta-ai-set-card-title', textContent: 'NetSuite AI (N/llm)' }),
            el('p', { className: 'tacta-ai-set-card-desc', textContent: 'The extension calls the RESTlet same-origin from your NetSuite tab, so your logged-in session and role apply. No key is stored. N/llm has no native tool calling, so the assistant works in two steps: it proposes one read-only SuiteQL, the extension validates and runs it, then sends the rows back for the answer.' }),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Script id', el('small', { textContent: 'customscript_... or numeric id' })]),
                el('div', { className: 'tacta-ai-set-control' }, [scriptInput])
            ]),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Deployment id', el('small', { textContent: 'customdeploy_... or numeric id' })]),
                el('div', { className: 'tacta-ai-set-control' }, [deployInput])
            ]),
            guide
        ]);
        root.appendChild(netsuiteCard);

        // ── Privacy / behaviour card ──
        var maskInput = el('input', { type: 'checkbox' });
        var maskToggle = el('label', { className: 'tacta-ai-set-toggle' }, [maskInput, el('span', { className: 'tacta-ai-set-toggle-track' })]);
        var maskStatus = el('span', { className: 'tacta-ai-set-status' });
        maskInput.addEventListener('change', function () { maskStatus.textContent = maskInput.checked ? 'On' : 'Off (raw values are sent)'; });
        var stepsInput = el('input', { className: 'tacta-ai-set-num', type: 'number', min: '1', max: '20', step: '1' });

        var privacyCard = el('div', { className: 'tacta-ai-set-card' }, [
            el('h3', { className: 'tacta-ai-set-card-title', textContent: 'Privacy and limits' }),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Mask sensitive data', el('small', { textContent: 'Emails, phone numbers, 9-digit tax ids, card numbers become [masked] before leaving the browser' })]),
                el('div', { className: 'tacta-ai-set-control' }, [maskToggle, maskStatus])
            ]),
            el('div', { className: 'tacta-ai-set-row' }, [
                el('div', { className: 'tacta-ai-set-label' }, ['Max tool steps', el('small', { textContent: 'Bedrock only. Tool calls per answer, 1 to 20 (default 8)' })]),
                el('div', { className: 'tacta-ai-set-control' }, [stepsInput])
            ])
        ]);
        root.appendChild(privacyCard);

        // ── Actions ──
        var saveBtn = el('button', { className: 'tacta-ai-set-btn tacta-ai-set-btn-primary', type: 'button', textContent: 'Save' });
        var testBtn = el('button', { className: 'tacta-ai-set-btn', type: 'button', textContent: 'Test connection' });
        var resultLine = el('div', { className: 'tacta-ai-set-result tacta-ai-set-status' });
        var actions = el('div', { className: 'tacta-ai-set-actions' }, [saveBtn, testBtn, resultLine]);
        root.appendChild(actions);

        // ── FAQ ──
        if (!opts.compact) {
            var faq = el('div', { className: 'tacta-ai-set-card' }, [
                el('h3', { className: 'tacta-ai-set-card-title', textContent: 'What is sent, to whom, and when' }),
                el('dl', { className: 'tacta-ai-set-faq' }, [
                    el('dt', { textContent: 'When does anything leave the browser?' }),
                    el('dd', { textContent: 'Only when you press Send (or Ctrl+Enter) in the AI Assistant, and only to the provider you selected here. Opening the panel, typing, and the Test button (which sends a one-word prompt) are the only other triggers. Nothing runs in the background.' }),
                    el('dt', { textContent: 'What is sent?' }),
                    el('dd', { textContent: 'Your chat messages, a fixed system prompt, and if "Include this record" is checked, the current record type, internal id and up to 150 body field values. Tool results (SuiteQL rows capped at 500, Records Catalog metadata) are sent back to the model as the conversation progresses. With masking on, emails, phone numbers, 9-digit tax ids and card numbers are replaced with [masked] first.' }),
                    el('dt', { textContent: 'Bedrock: who receives it?' }),
                    el('dd', { textContent: 'Amazon Bedrock in the region you chose, under your own AWS account and Bedrock data policy. The extension talks directly to bedrock-runtime.<region>.amazonaws.com; there is no TactaSuite server in between.' }),
                    el('dt', { textContent: 'NetSuite AI: who receives it?' }),
                    el('dd', { textContent: 'Your own NetSuite account. The RESTlet runs under your session and role and calls N/llm, which uses Oracle-hosted models and your NetSuite AI allotment.' }),
                    el('dt', { textContent: 'Can the assistant change data?' }),
                    el('dd', { textContent: 'No. Every SuiteQL is validated in code: it must start with SELECT or WITH, contain no semicolons and no INSERT / UPDATE / DELETE / MERGE / DROP / ALTER / CREATE / TRUNCATE / GRANT. The Records Catalog and current-record tools are read-only. The RESTlet writes nothing.' }),
                    el('dt', { textContent: 'Where are my settings and key stored?' }),
                    el('dd', { textContent: 'In chrome.storage.local under tacta_ai_settings on this browser profile only. They are never synced to other devices and never sent to the model.' })
                ])
            ]);
            root.appendChild(faq);
        }

        // ── Behaviour ──

        function syncVisibility() {
            radioInputs.forEach(function (r) {
                r.checked = r.value === state.provider;
                r.parentNode.classList.toggle('tacta-ai-set-radio-on', r.checked);
            });
            bedrockCard.classList.toggle('tacta-ai-set-hidden', state.provider !== 'bedrock');
            netsuiteCard.classList.toggle('tacta-ai-set-hidden', state.provider !== 'netsuite');
            testBtn.disabled = state.provider === 'none';
        }

        function refreshPermStatus() {
            var region = regionInput.value.trim() || 'us-east-1';
            permissionsContains(region).then(function (ok) {
                setStatus(permStatus, ok
                    ? 'Granted for bedrock-runtime.' + region + '.amazonaws.com'
                    : 'Not granted for bedrock-runtime.' + region + '.amazonaws.com (Save will ask)', ok ? 'ok' : 'warn');
            });
        }

        function fillForm(s) {
            state = s;
            regionInput.value = s.bedrock.region || 'us-east-1';
            modelInput.value = s.bedrock.modelId || '';
            var preset = MODEL_PRESETS.some(function (m) { return m.id === modelInput.value; });
            modelSelect.value = preset ? modelInput.value : '';
            keyInput.value = s.bedrock.apiKey || '';
            scriptInput.value = s.netsuite.scriptId || '';
            deployInput.value = s.netsuite.deployId || '';
            maskInput.checked = s.maskSensitive !== false;
            maskStatus.textContent = maskInput.checked ? 'On' : 'Off (raw values are sent)';
            stepsInput.value = String(s.maxSteps || 8);
            syncVisibility();
            refreshPermStatus();
        }

        function collectForm() {
            return {
                provider: state.provider,
                bedrock: {
                    region: regionInput.value.trim().toLowerCase() || 'us-east-1',
                    modelId: modelInput.value.trim() || 'us.anthropic.claude-fable-5-1',
                    apiKey: keyInput.value.trim()
                },
                netsuite: {
                    scriptId: scriptInput.value.trim(),
                    deployId: deployInput.value.trim()
                },
                maskSensitive: maskInput.checked,
                maxSteps: parseInt(stepsInput.value, 10) || 8
            };
        }

        function load() {
            setStatus(resultLine, 'Loading settings...', null);
            return sendMessage({ action: 'aiGetSettings' }).then(function (s) {
                fillForm(s);
                setStatus(resultLine, '', null);
            }).catch(function (err) {
                setStatus(resultLine, 'Could not load AI settings: ' + err.message, 'err');
                syncVisibility();
            });
        }

        saveBtn.addEventListener('click', function () {
            var settings = collectForm();
            saveBtn.disabled = true;
            var permPromise = Promise.resolve(null);
            if (settings.provider === 'bedrock' && settings.bedrock.apiKey) {
                // Must run inside the click gesture, before any await.
                permPromise = permissionsRequest(settings.bedrock.region).then(function (granted) {
                    return granted ? 'granted' : 'denied';
                }, function (err) { return 'error:' + err.message; });
            }
            permPromise.then(function (permResult) {
                return sendMessage({ action: 'aiSaveSettings', settings: settings }).then(function (res) {
                    if (res && res.settings) fillForm(res.settings);
                    var msg = 'Saved.';
                    var kind = 'ok';
                    if (permResult === 'granted') msg += ' Bedrock host permission granted.';
                    else if (permResult === 'denied') { msg += ' Bedrock host permission was declined; chat will fail until you save again and allow it.'; kind = 'warn'; }
                    else if (permResult && permResult.indexOf('error:') === 0) { msg += ' Permission request failed: ' + permResult.slice(6) + ' (is optional_host_permissions set in the manifest?)'; kind = 'warn'; }
                    if (settings.provider === 'bedrock' && !settings.bedrock.apiKey) { msg += ' No API key entered yet.'; kind = 'warn'; }
                    if (settings.provider === 'netsuite' && (!settings.netsuite.scriptId || !settings.netsuite.deployId)) { msg += ' Script id and deployment id are both required.'; kind = 'warn'; }
                    setStatus(resultLine, msg, kind);
                    refreshPermStatus();
                });
            }).catch(function (err) {
                setStatus(resultLine, 'Save failed: ' + err.message, 'err');
            }).then(function () { saveBtn.disabled = false; });
        });

        testBtn.addEventListener('click', function () {
            testBtn.disabled = true;
            setStatus(resultLine, 'Testing saved settings...', null);
            findNetSuiteTabId().then(function (tabId) {
                return sendMessage({ action: 'aiTestConnection', tabId: tabId || undefined });
            }).then(function (res) {
                if (res && res.ok) setStatus(resultLine, 'OK: ' + res.detail + (res.latencyMs ? ' (' + res.latencyMs + ' ms)' : ''), 'ok');
                else setStatus(resultLine, 'Not ready: ' + ((res && res.detail) || 'unknown result'), 'warn');
            }).catch(function (err) {
                setStatus(resultLine, 'Test failed: ' + err.message, 'err');
            }).then(function () { testBtn.disabled = state.provider === 'none'; });
        });

        load();

        return { reload: load };
    }

    window.TactaAISettingsUI = { render: render, RESTLET_SOURCE: RESTLET_SOURCE, RESTLET_FILE_NAME: RESTLET_FILE_NAME };
})();
