/**
 * ai-assistant.js
 * NetSuite TactaSuite - AI Assistant Sidebar (Content Script)
 *
 * @author Blane Maher
 *
 * Chat sidebar grounded in the NetSuite account the user is logged in to.
 * All model calls and tool execution happen in the background service
 * worker (background/modules/ai-provider.js) through the aiChat message;
 * this script only renders the conversation, the per-answer work log
 * (tool steps + SQL result rows) and the composer.
 *
 * Activation: popup dispatches 'tacta:featureActivated' with featureId
 * 'ai-assistant'. No MAIN-world injection needed.
 */
(function () {
    'use strict';

    if (window.__tactaAiAssistantLoaded) return;
    window.__tactaAiAssistantLoaded = true;

    var FEATURE_ID = 'ai-assistant';
    var SC = 'tacta-ai';
    var SIDEBAR_WIDTH = 420;
    var MAX_TABLE_ROWS = 50;
    var QUICK_PROMPTS = [
        'Summarize this record',
        'Find related transactions',
        'Which custom fields are empty?'
    ];
    var RECORD_PAGE_TYPES = { 'record-view': true, 'record-edit': true };

    var _sidebar = null;
    var _settings = null;
    var _pageInfo = null;
    var _messages = [];          // [{ role: 'user'|'assistant', text }]
    var _busy = false;
    var _ui = {};

    // ── Helpers ──────────────────────────────────────────────────────

    function el(tag, attrs, children) {
        return window.TactaDOM.createElement(tag, attrs, children);
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

    function detectPage() {
        var info = null;
        try {
            if (window.TactaPageDetector && typeof window.TactaPageDetector.detect === 'function') {
                info = window.TactaPageDetector.detect();
            }
        } catch (e) { info = null; }
        if (!info) info = {};
        if (!info.recordId) {
            var m = window.location.href.match(/[?&]id=(\d+)/);
            if (m) info.recordId = m[1];
        }
        if (!info.recordType) {
            var rt = window.location.pathname.match(/\/app\/[^?]*\/([a-z0-9_]+)\.nl$/i);
            if (rt && RECORD_PAGE_TYPES[info.pageType]) info.recordType = rt[1];
        }
        return info;
    }

    function providerLabel(settings) {
        if (!settings || settings.provider === 'none') return 'Not configured';
        if (settings.provider === 'bedrock') return 'Bedrock: ' + (settings.bedrock && settings.bedrock.modelId || 'Claude');
        return 'NetSuite AI (N/llm)';
    }

    function truncate(str, n) {
        var s = String(str === null || str === undefined ? '' : str);
        return s.length > n ? s.slice(0, n) + '...' : s;
    }

    function csvEscape(v) {
        var s = v === null || v === undefined ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function rowsToCsv(columns, rows) {
        var lines = [columns.map(csvEscape).join(',')];
        rows.forEach(function (r) {
            lines.push(columns.map(function (c) { return csvEscape(r[c]); }).join(','));
        });
        return lines.join('\n');
    }

    function scrollToBottom() {
        if (_ui.transcript) _ui.transcript.scrollTop = _ui.transcript.scrollHeight;
    }

    /**
     * Renders assistant text safely: fenced code blocks become <pre>, the
     * rest becomes paragraphs with preserved line breaks. No innerHTML with
     * model output.
     */
    function renderRichText(container, text) {
        var parts = String(text || '').split(/```[a-zA-Z]*\n?/);
        for (var i = 0; i < parts.length; i++) {
            var chunk = parts[i];
            if (!chunk) continue;
            if (i % 2 === 1) {
                container.appendChild(el('pre', { className: SC + '-code', textContent: chunk.replace(/\n$/, '') }));
            } else {
                var paras = chunk.split(/\n{2,}/);
                paras.forEach(function (p) {
                    if (!p.trim()) return;
                    var pEl = el('p', { className: SC + '-p' });
                    var lines = p.split('\n');
                    lines.forEach(function (line, idx) {
                        if (idx > 0) pEl.appendChild(document.createElement('br'));
                        pEl.appendChild(document.createTextNode(line));
                    });
                    container.appendChild(pEl);
                });
            }
        }
    }

    // ── Transcript rendering ─────────────────────────────────────────

    function addBubble(role, text) {
        var bubble = el('div', { className: SC + '-msg ' + SC + '-msg-' + role }, [
            el('div', { className: SC + '-msg-role', textContent: role === 'user' ? 'You' : 'Assistant' })
        ]);
        var body = el('div', { className: SC + '-msg-body' });
        if (role === 'assistant') renderRichText(body, text);
        else body.textContent = text;
        bubble.appendChild(body);
        _ui.transcript.appendChild(bubble);
        scrollToBottom();
        return bubble;
    }

    function addErrorBubble(text) {
        var bubble = el('div', { className: SC + '-msg ' + SC + '-msg-error' }, [
            el('div', { className: SC + '-msg-role', textContent: 'Error' }),
            el('div', { className: SC + '-msg-body', textContent: text })
        ]);
        _ui.transcript.appendChild(bubble);
        scrollToBottom();
    }

    function addThinkingBubble() {
        var bubble = el('div', { className: SC + '-msg ' + SC + '-msg-assistant ' + SC + '-msg-thinking' }, [
            el('div', { className: SC + '-msg-role', textContent: 'Assistant' }),
            el('div', { className: SC + '-msg-body ' + SC + '-thinking' }, [
                el('div', { className: 'tacta-spinner' }),
                el('span', { textContent: 'Working against ' + providerLabel(_settings) + '...' })
            ])
        ]);
        _ui.transcript.appendChild(bubble);
        scrollToBottom();
        return bubble;
    }

    function buildWorkLog(result) {
        var steps = Array.isArray(result.steps) ? result.steps : [];
        var details = el('details', { className: SC + '-worklog' });
        var usageTxt = '';
        if (result.usage) {
            if (result.usage.totalTokens) usageTxt = ', ' + result.usage.totalTokens + ' tokens';
            else if (result.usage.requests) usageTxt = ', ' + result.usage.requests + ' request' + (result.usage.requests === 1 ? '' : 's');
            if (result.usage.remainingFreeUsage !== null && result.usage.remainingFreeUsage !== undefined) usageTxt += ', ' + result.usage.remainingFreeUsage + ' free N/llm left';
        }
        details.appendChild(el('summary', {
            textContent: 'Work log: ' + steps.length + ' tool step' + (steps.length === 1 ? '' : 's') + usageTxt + (result.masked ? ', masking on' : ', masking off')
        }));

        if (!steps.length) {
            details.appendChild(el('div', { className: SC + '-step-empty', textContent: 'No tools were called for this answer.' }));
            return details;
        }

        steps.forEach(function (step, idx) {
            var ok = /^ok/.test(step.outcome || '');
            var stepEl = el('div', { className: SC + '-step' }, [
                el('div', { className: SC + '-step-head' }, [
                    el('span', { className: SC + '-step-idx', textContent: String(idx + 1) }),
                    el('span', { className: SC + '-step-tool', textContent: step.tool }),
                    el('span', { className: SC + '-step-outcome ' + (ok ? SC + '-ok' : SC + '-bad'), textContent: step.outcome || '' })
                ])
            ]);
            if (step.input) {
                stepEl.appendChild(el('pre', { className: SC + '-step-input', textContent: truncate(step.input, 400) }));
            }
            if (Array.isArray(step.rows) && step.rows.length) {
                var columns = Array.isArray(step.columns) && step.columns.length ? step.columns : Object.keys(step.rows[0]);
                var shown = step.rows.slice(0, MAX_TABLE_ROWS);
                var tableRows = shown.map(function (r) {
                    return columns.map(function (c) {
                        var v = r[c];
                        return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
                    });
                });
                var bar = el('div', { className: SC + '-rows-bar' }, [
                    el('span', { className: SC + '-rows-count', textContent: 'Showing ' + shown.length + ' of ' + (step.totalRows || step.rows.length) + ' row' + ((step.totalRows || step.rows.length) === 1 ? '' : 's') }),
                    el('button', {
                        className: 'tacta-btn tacta-btn-sm',
                        textContent: 'Copy CSV',
                        events: {
                            click: function () {
                                window.TactaDOM.copyToClipboard(rowsToCsv(columns, step.rows)).then(function (okCopy) {
                                    window.TactaDOM.showToast(okCopy ? 'CSV copied (' + step.rows.length + ' rows)' : 'Copy failed', okCopy ? 'success' : 'error', 2000);
                                });
                            }
                        }
                    })
                ]);
                stepEl.appendChild(bar);
                var table = window.TactaDOM.createTable(columns, tableRows, { sortable: true });
                var wrap = el('div', { className: SC + '-rows-wrap' }, [table.wrapper]);
                stepEl.appendChild(wrap);
            }
            details.appendChild(stepEl);
        });
        return details;
    }

    // ── Chat flow ────────────────────────────────────────────────────

    function setBusy(busy) {
        _busy = busy;
        if (_ui.sendBtn) _ui.sendBtn.disabled = busy;
        if (_ui.textarea) _ui.textarea.disabled = busy;
        if (_ui.quick) {
            Array.prototype.forEach.call(_ui.quick.querySelectorAll('button'), function (b) { b.disabled = busy; });
        }
    }

    function send(text) {
        var q = String(text || '').trim();
        if (!q || _busy) return;
        if (!_settings || _settings.provider === 'none') {
            addErrorBubble('No AI provider configured. Open AI settings first.');
            return;
        }
        _ui.textarea.value = '';
        _messages.push({ role: 'user', text: q });
        addBubble('user', q);
        var thinking = addThinkingBubble();
        setBusy(true);

        var includeRecord = !!(_ui.includeRecord && _ui.includeRecord.checked && !_ui.includeRecord.disabled);

        sendMessage({
            action: 'aiChat',
            messages: _messages.slice(),
            includeRecordContext: includeRecord
        }).then(function (result) {
            if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
            var text = (result && result.text) || '(no answer)';
            _messages.push({ role: 'assistant', text: text });
            var bubble = addBubble('assistant', text);
            bubble.appendChild(buildWorkLog(result || {}));
            scrollToBottom();
        }).catch(function (err) {
            if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
            // Drop the failed user turn so the next attempt is not duplicated.
            if (_messages.length && _messages[_messages.length - 1].role === 'user') _messages.pop();
            addErrorBubble(err.message || String(err));
        }).then(function () {
            setBusy(false);
            if (_ui.textarea) _ui.textarea.focus();
        });
    }

    // ── UI construction ──────────────────────────────────────────────

    function openSettings() {
        sendMessage({ action: 'openOptions', hash: 'ai' }).catch(function () {
            window.TactaDOM.showToast('Open the TactaSuite options page and choose the AI section.', 'info', 4000);
        });
    }

    function buildSetupCard() {
        return el('div', { className: SC + '-setup' }, [
            el('div', { className: SC + '-setup-title', textContent: 'AI Assistant is not set up yet' }),
            el('p', { className: SC + '-setup-text', textContent: 'Choose a provider in the TactaSuite options: Claude on Amazon Bedrock (your AWS key) or NetSuite AI through N/llm (a RESTlet you deploy in this account). The assistant only answers with data read from the NetSuite account you are logged in to, and nothing is sent until you press Send.' }),
            el('button', { className: 'tacta-btn tacta-btn-primary', textContent: 'Open AI settings', events: { click: openSettings } })
        ]);
    }

    // NetSuite AI Connector (MCP) status chip, filled asynchronously.
    function buildMcpChip() {
        var chip = el('span', { className: SC + '-chip ' + SC + '-chip-muted', textContent: 'NetSuite AI Connector: checking...' });
        if (!_settings || _settings.provider !== 'bedrock') { chip.textContent = 'NetSuite AI Connector: Bedrock provider only'; return chip; }
        sendMessage({ action: 'mcpStatus' }).then(function (s) {
            if (!s || !s.account) { chip.textContent = 'NetSuite AI Connector: not a NetSuite account tab'; return; }
            if (!s.configured) { chip.textContent = 'NetSuite AI Connector: not set up for ' + s.label + ' (local SuiteQL tools in use)'; return; }
            if (!s.signedIn) { chip.textContent = 'NetSuite AI Connector: sign in needed for ' + s.label; chip.classList.add(SC + '-chip-warn'); return; }
            if (s.error) { chip.textContent = 'NetSuite AI Connector: ' + s.error; chip.classList.add(SC + '-chip-warn'); return; }
            chip.classList.remove(SC + '-chip-muted');
            chip.textContent = 'NetSuite AI Connector: ' + s.label + ', ' + (s.tools ? s.tools.length : 0) + ' tools' + (s.allowWrites ? ' (writes on, confirmed)' : ' (read-only)');
        }).catch(function (err) { chip.textContent = 'NetSuite AI Connector: ' + err.message; });
        return chip;
    }

    // The service worker asks before running an MCP write tool.
    chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
        if (!message || message.action !== 'aiConfirmWrite') return false;
        try {
            var pretty = JSON.stringify(message.input || {}, null, 2);
            var content = el('div', { className: SC + '-confirm' }, [
                el('p', { textContent: 'The assistant wants to run a NetSuite tool that changes data:' }),
                el('div', { className: SC + '-confirm-tool', textContent: message.tool }),
                el('pre', { className: SC + '-confirm-input', textContent: pretty.length > 4000 ? pretty.slice(0, 4000) + '\n...' : pretty }),
                el('p', { className: SC + '-confirm-note', textContent: 'This runs in the NetSuite account you are logged in to, as you. Allow only if this is exactly what you asked for.' })
            ]);
            var done = false;
            var modal = window.TactaDOM.createModal({
                title: 'Confirm NetSuite change',
                content: content,
                closeOnOverlay: false,
                buttons: [
                    { label: 'Cancel', onClick: function () { if (!done) { done = true; sendResponse({ approved: false }); } modal.close(); } },
                    { label: 'Allow this change', className: 'tacta-btn-primary', onClick: function () { if (!done) { done = true; sendResponse({ approved: true }); } modal.close(); } }
                ],
                onClose: function () { if (!done) { done = true; sendResponse({ approved: false }); } }
            });
        } catch (e) {
            sendResponse({ approved: false });
        }
        return true;
    });

    function buildHeaderBar() {
        var isRecord = _pageInfo && RECORD_PAGE_TYPES[_pageInfo.pageType] && (_pageInfo.recordType || _pageInfo.recordId);
        var chipText = isRecord
            ? 'Record: ' + (_pageInfo.recordType || 'unknown') + (_pageInfo.recordId ? ' #' + _pageInfo.recordId : '')
            : 'Page: ' + ((_pageInfo && _pageInfo.pageType) || 'unknown') + ' (no record)';

        _ui.includeRecord = el('input', { type: 'checkbox', className: SC + '-include-cb' });
        _ui.includeRecord.checked = !!isRecord;
        _ui.includeRecord.disabled = !isRecord;

        var bar = el('div', { className: SC + '-bar' }, [
            el('div', { className: SC + '-provider' }, [
                el('span', { className: 'tacta-badge ' + (_settings.provider === 'none' ? 'tacta-badge--warning' : 'tacta-badge--accent'), textContent: _settings.provider === 'none' ? 'Off' : (_settings.provider === 'bedrock' ? 'Bedrock' : 'NetSuite AI') }),
                el('span', { className: SC + '-model', textContent: _settings.provider === 'bedrock' ? (_settings.bedrock.modelId || '') : (_settings.provider === 'netsuite' ? 'N/llm RESTlet' : '') }),
                el('button', { className: 'tacta-btn tacta-btn-sm ' + SC + '-settings-btn', textContent: 'Settings', title: 'Open AI settings', events: { click: openSettings } })
            ]),
            el('div', { className: SC + '-context' }, [
                buildMcpChip(),
                el('span', { className: SC + '-chip' + (isRecord ? '' : ' ' + SC + '-chip-muted'), textContent: chipText }),
                el('label', { className: SC + '-include' + (isRecord ? '' : ' ' + SC + '-include-disabled') }, [
                    _ui.includeRecord,
                    el('span', { textContent: 'Include this record' })
                ])
            ])
        ]);
        return bar;
    }

    function buildComposer() {
        _ui.quick = el('div', { className: SC + '-quick' }, QUICK_PROMPTS.map(function (p) {
            return el('button', { className: SC + '-quick-btn', textContent: p, events: { click: function () { send(p); } } });
        }));

        _ui.textarea = el('textarea', {
            className: 'tacta-input ' + SC + '-textarea',
            placeholder: 'Ask about this account or record. Ctrl+Enter to send.',
            rows: '3'
        });
        _ui.textarea.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                send(_ui.textarea.value);
            }
        });
        _ui.sendBtn = el('button', { className: 'tacta-btn tacta-btn-primary ' + SC + '-send', textContent: 'Send', events: { click: function () { send(_ui.textarea.value); } } });

        var hint = el('div', { className: SC + '-hint', textContent: 'Read-only. SuiteQL the model proposes is validated and run against this account; results and your messages go to the selected provider only when you send.' });

        return el('div', { className: SC + '-composer' }, [
            _ui.quick,
            el('div', { className: SC + '-input-row' }, [_ui.textarea, _ui.sendBtn]),
            hint
        ]);
    }

    function buildBody(body) {
        body.innerHTML = '';
        _ui = {};
        var shell = el('div', { className: SC + '-shell' });
        body.appendChild(shell);

        if (!_settings || _settings.provider === 'none') {
            shell.appendChild(buildSetupCard());
            return;
        }

        shell.appendChild(buildHeaderBar());
        _ui.transcript = el('div', { className: SC + '-transcript' });
        shell.appendChild(_ui.transcript);

        if (_messages.length) {
            _messages.forEach(function (m) { addBubble(m.role, m.text); });
        } else {
            _ui.transcript.appendChild(el('div', { className: SC + '-welcome', textContent: 'Ask a question about this account. With the NetSuite AI Connector signed in, the assistant uses NetSuite\'s own MCP tools (SuiteQL, records, saved searches, reports) inside this account; otherwise it falls back to read-only SuiteQL and the Records Catalog. Every step shows in the work log.' }));
        }

        shell.appendChild(buildComposer());
    }

    // ── Open / close ─────────────────────────────────────────────────

    function openSidebar() {
        if (!window.TactaDOM) {
            console.error('[Tacta AI Assistant] TactaDOM not available.');
            return;
        }
        if (window.TactaDOM.injectStylesheet) {
            try {
                window.TactaDOM.injectStylesheet(chrome.runtime.getURL('content/features/ai-assistant/ai-assistant.css')).catch(function () {});
            } catch (e) { /* ignore */ }
        }

        _pageInfo = detectPage();
        _sidebar = window.TactaDOM.createSidebar({
            title: 'AI Assistant',
            width: SIDEBAR_WIDTH,
            overlay: false,
            onClose: function () { _sidebar = null; _ui = {}; }
        });
        _sidebar.sidebar.classList.add(SC);
        var body = _sidebar.body;
        body.appendChild(el('div', { className: SC + '-loading' }, [
            el('div', { className: 'tacta-spinner' }),
            el('span', { textContent: 'Loading AI settings...' })
        ]));

        sendMessage({ action: 'aiGetSettings' }).then(function (settings) {
            _settings = settings || { provider: 'none' };
            if (!_sidebar) return;
            buildBody(body);
            if (_ui.textarea) _ui.textarea.focus();
        }).catch(function (err) {
            if (!_sidebar) return;
            body.innerHTML = '';
            body.appendChild(el('div', { className: SC + '-error', textContent: 'Could not load AI settings: ' + err.message }));
        });
    }

    function closeSidebar() {
        if (_sidebar) {
            _sidebar.close();
            _sidebar = null;
            _ui = {};
        }
    }

    // ── Activation ───────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            if (_sidebar) closeSidebar();
            else openSidebar();
        }
    });

})();
