/**
 * suiteql-runner.js
 * Tactacam NS Toolkit - SuiteQL Runner (Content Script)
 *
 * Floating panel for running SuiteQL queries against NetSuite and building
 * saved searches with AI assistance. Communicates with the
 * background service worker for query execution and AI generation.
 *
 * Activation: 'tacta:featureActivated' custom event with featureId 'suiteql-runner'.
 *
 * @fileoverview SuiteQL Runner content script for the Tactacam NS Toolkit.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaSuiteQLRunnerLoaded) return;
    window.__tactaSuiteQLRunnerLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Feature identifier */
    var FEATURE_ID = 'suiteql-runner';

    /** @type {string} CSS class scope for this feature */
    var SCOPE_CLASS = 'tacta-suiteql-runner';

    /** @type {number} Default panel width */
    var DEFAULT_WIDTH = 800;

    /** @type {number} Default panel height */
    var DEFAULT_HEIGHT = 500;

    /** @type {string} Chrome storage key for panel state */
    var STORAGE_KEY_PANEL = 'tacta_sql_panel_state';

    /** @type {string} Chrome storage key for query history */
    var STORAGE_KEY_HISTORY = 'tacta_sql_history';

    /** @type {number} Maximum number of history entries to keep */
    var MAX_HISTORY = 20;

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {{ panel: HTMLElement, header: HTMLElement, body: HTMLElement, close: Function }|null} */
    var _panelInstance = null;

    /** @type {boolean} Whether the panel is minimized */
    var _isMinimized = false;

    /** @type {boolean} Whether the panel is maximized */
    var _isMaximized = false;

    /** @type {{ top: string, left: string, width: string, height: string }|null} */
    var _preMaximizeState = null;

    /** @type {string} Currently active tab: 'suiteql' or 'savedsearch' */
    var _activeTab = 'suiteql';

    /** @type {{ columns: string[], rows: object[], count: number, executionTime: number, truncated: boolean }|null} */
    var _suiteqlResults = null;

    /** @type {string|null} Current sort column for results */
    var _sortColumn = null;

    /** @type {boolean} Current sort direction */
    var _sortAsc = true;

    /** @type {string[]} Query history list */
    var _queryHistory = [];

    /** @type {boolean} Whether the history dropdown is visible */
    var _historyOpen = false;

    /** @type {boolean} Whether the AI section is collapsed */
    var _aiCollapsed = true;

    /** @type {{configured: boolean, mode: string, provider: string}|null} AI settings state */
    var _aiConfigured = null;

    /** @type {object|null} Current saved search definition */
    var _ssDefinition = null;

    /** @type {string|null} AI explanation text for saved search */
    var _ssExplanation = null;

    /** @type {{ columns: string[], rows: object[], count: number }|null} */
    var _ssPreviewResults = null;

    /** @type {boolean} Whether the SS definition is in edit mode */
    var _ssEditMode = false;

    // ── DOM references ──
    var _editorEl = null;
    var _statusEl = null;
    var _resultsHost = null;
    var _historyDropdown = null;
    var _aiExplanationEl = null;
    var _aiInputEl = null;
    var _ssPromptEl = null;
    var _ssDefinitionHost = null;
    var _ssResultsHost = null;
    var _ssExplanationEl = null;

    // ────────────────────────────────────────────────────────────────
    // Background Communication
    // ────────────────────────────────────────────────────────────────

    /**
     * Sends a message to the background service worker and returns the response.
     * @param {Object} payload - Message payload with 'action' key.
     * @returns {Promise<Object>}
     */
    function _sendMessage(payload) {
        return new Promise(function (resolve, reject) {
            try {
                chrome.runtime.sendMessage(payload, function (response) {
                    if (chrome.runtime.lastError) {
                        var msg = chrome.runtime.lastError.message || '';
                        if (msg.indexOf('Extension context invalidated') >= 0) {
                            reject(new Error('Extension was reloaded. Please refresh this page (F5) to reconnect.'));
                        } else {
                            reject(new Error(msg));
                        }
                        return;
                    }
                    if (response && response.error) {
                        reject(new Error(response.error));
                    } else {
                        resolve(response);
                    }
                });
            } catch (e) {
                if (String(e).indexOf('Extension context invalidated') >= 0) {
                    reject(new Error('Extension was reloaded. Please refresh this page (F5) to reconnect.'));
                } else {
                    reject(e);
                }
            }
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Storage Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Loads a value from chrome.storage.local.
     * @param {string} key
     * @returns {Promise<*>}
     */
    function _storageGet(key) {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(key, function (data) {
                    resolve(data[key] || null);
                });
            } catch (_) {
                resolve(null);
            }
        });
    }

    /**
     * Saves a value to chrome.storage.local.
     * @param {string} key
     * @param {*} value
     * @returns {Promise<void>}
     */
    function _storageSet(key, value) {
        return new Promise(function (resolve) {
            try {
                var data = {};
                data[key] = value;
                chrome.storage.local.set(data, function () { resolve(); });
            } catch (_) {
                resolve();
            }
        });
    }

    /**
     * Saves the current panel position and size.
     */
    function _savePanelState() {
        if (!_panelInstance) return;
        var panel = _panelInstance.panel;
        var rect = panel.getBoundingClientRect();
        _storageSet(STORAGE_KEY_PANEL, {
            top: panel.style.top || (rect.top + 'px'),
            left: panel.style.left || (rect.left + 'px'),
            width: panel.style.width || (rect.width + 'px'),
            height: panel.style.height || (rect.height + 'px')
        });
    }

    /**
     * Loads the saved panel state.
     * @returns {Promise<{ top: string, left: string, width: string, height: string }|null>}
     */
    function _loadPanelState() {
        return _storageGet(STORAGE_KEY_PANEL);
    }

    /**
     * Loads query history from storage.
     * @returns {Promise<void>}
     */
    function _loadHistory() {
        return _storageGet(STORAGE_KEY_HISTORY).then(function (hist) {
            _queryHistory = Array.isArray(hist) ? hist : [];
        });
    }

    /**
     * Saves query history to storage.
     * @returns {Promise<void>}
     */
    function _saveHistory() {
        return _storageSet(STORAGE_KEY_HISTORY, _queryHistory);
    }

    /**
     * Adds a query to the history (deduplicated, max 20 entries).
     * @param {string} query
     */
    function _addToHistory(query) {
        var trimmed = query.trim();
        if (!trimmed) return;

        // Remove duplicate if exists
        var idx = _queryHistory.indexOf(trimmed);
        if (idx >= 0) {
            _queryHistory.splice(idx, 1);
        }

        // Add to front
        _queryHistory.unshift(trimmed);

        // Cap at max
        if (_queryHistory.length > MAX_HISTORY) {
            _queryHistory = _queryHistory.slice(0, MAX_HISTORY);
        }

        _saveHistory();
    }

    // ────────────────────────────────────────────────────────────────
    // Utility Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Shorthand for TactaDOM.createElement.
     * @param {string} tag
     * @param {Object} [attrs]
     * @param {Array} [children]
     * @returns {HTMLElement}
     */
    function _el(tag, attrs, children) {
        return window.TactaDOM.createElement(tag, attrs, children);
    }

    /**
     * Escapes a string for safe HTML insertion.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(String(str)));
        return div.innerHTML;
    }

    /**
     * Generates CSV text from columns and row objects.
     * @param {string[]} columns
     * @param {object[]} rows
     * @returns {string}
     */
    function _generateCSV(columns, rows) {
        var lines = [];

        // Header
        lines.push(columns.map(function (col) {
            return _csvEscapeCell(col);
        }).join(','));

        // Data rows
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            lines.push(columns.map(function (col) {
                var val = row[col];
                return _csvEscapeCell(val === null || val === undefined ? '' : String(val));
            }).join(','));
        }

        return lines.join('\n');
    }

    /**
     * Escapes a CSV cell value.
     * @param {string} str
     * @returns {string}
     */
    function _csvEscapeCell(str) {
        if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0 || str.indexOf('\n') >= 0) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    /**
     * Triggers a file download in the browser.
     * @param {string} content - File content.
     * @param {string} filename - Desired filename.
     * @param {string} mimeType - MIME type.
     */
    function _downloadFile(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ────────────────────────────────────────────────────────────────
    // AI Configuration Check
    // ────────────────────────────────────────────────────────────────

    /**
     * Checks if AI is configured in extension settings.
     * @returns {Promise<{configured: boolean, mode: string, provider: string}>}
     */
    function _checkAIConfigured() {
        if (_aiConfigured !== null) return Promise.resolve(_aiConfigured);
        return _sendMessage({ action: 'getAISettings' }).then(function (settings) {
            var mode = settings && settings.mode ? settings.mode : 'manual';
            var provider = settings && settings.provider ? settings.provider : 'anthropic';
            _aiConfigured = {
                configured: mode === 'manual' || (mode === 'api' && !!settings.apiKey),
                mode: mode,
                provider: provider
            };
            return _aiConfigured;
        }).catch(function () {
            _aiConfigured = { configured: false, mode: 'off', provider: 'anthropic' };
            return _aiConfigured;
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Lifecycle
    // ────────────────────────────────────────────────────────────────

    /**
     * Shows the SuiteQL Runner panel (creates if needed, toggles if already open).
     */
    function _showPanel() {
        if (_panelInstance) {
            _closePanel();
            return;
        }

        if (!window.TactaDOM) {
            console.error('[Tacta SuiteQL Runner] TactaDOM not available.');
            return;
        }

        _loadHistory().then(function () {
            return _loadPanelState();
        }).then(function (savedState) {
            _createPanel(savedState);
        });
    }

    /**
     * Closes and destroys the panel.
     */
    function _closePanel() {
        if (_panelInstance) {
            _savePanelState();
            _panelInstance.close();
            _panelInstance = null;
        }
        _resetState();
    }

    /**
     * Resets all mutable state.
     */
    function _resetState() {
        _isMinimized = false;
        _isMaximized = false;
        _preMaximizeState = null;
        _activeTab = 'suiteql';
        _suiteqlResults = null;
        _sortColumn = null;
        _sortAsc = true;
        _historyOpen = false;
        _aiCollapsed = true;
        _ssDefinition = null;
        _ssExplanation = null;
        _ssPreviewResults = null;
        _ssEditMode = false;
        _editorEl = null;
        _statusEl = null;
        _resultsHost = null;
        _historyDropdown = null;
        _aiExplanationEl = null;
        _aiInputEl = null;
        _ssPromptEl = null;
        _ssDefinitionHost = null;
        _ssResultsHost = null;
        _ssExplanationEl = null;
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates and mounts the full panel UI.
     * @param {{ top: string, left: string, width: string, height: string }|null} savedState
     */
    function _createPanel(savedState) {
        // Calculate centered default position
        var defaultTop = Math.max(40, Math.floor((window.innerHeight - DEFAULT_HEIGHT) / 2));
        var defaultLeft = Math.max(40, Math.floor((window.innerWidth - DEFAULT_WIDTH) / 2));

        var posTop = (savedState && savedState.top) || (defaultTop + 'px');
        var posLeft = (savedState && savedState.left) || (defaultLeft + 'px');
        var width = (savedState && savedState.width) || (DEFAULT_WIDTH + 'px');
        var height = (savedState && savedState.height) || (DEFAULT_HEIGHT + 'px');

        // Create the panel via TactaDOM
        _panelInstance = window.TactaDOM.createPanel({
            title: 'SuiteQL Runner',
            width: parseInt(width, 10),
            height: parseInt(height, 10),
            position: { top: posTop, left: posLeft, right: 'auto' },
            resizable: true,
            draggable: true,
            closeOnClickOutside: false,
            onClose: function () {
                _savePanelState();
                _panelInstance = null;
                _resetState();
            }
        });

        // Add scope class
        _panelInstance.panel.classList.add(SCOPE_CLASS);

        // Replace header actions with minimize/maximize/close
        _buildHeaderActions();

        // Build tabs bar
        var tabsBar = _buildTabsBar();

        // Build tab contents
        var suiteqlTab = _buildSuiteQLTab();
        var savedSearchTab = _buildSavedSearchTab();

        // Assemble body
        _panelInstance.body.appendChild(tabsBar);
        _panelInstance.body.appendChild(suiteqlTab);
        _panelInstance.body.appendChild(savedSearchTab);

        // Set initial active tab
        _switchTab('suiteql');

        // Check AI configuration in background
        _checkAIConfigured();

        // Save state on drag end and resize end
        _panelInstance.panel.addEventListener('mouseup', function () {
            setTimeout(_savePanelState, 100);
        });
    }

    /**
     * Builds the header action buttons (minimize, maximize, close).
     */
    function _buildHeaderActions() {
        var actionsContainer = _panelInstance.header.querySelector('.tacta-panel-actions');
        if (!actionsContainer) return;

        // Remove existing close button — we will re-add it
        actionsContainer.innerHTML = '';

        // Minimize button
        var minimizeBtn = _el('button', {
            className: 'tacta-sql-header-btn',
            title: 'Minimize',
            innerHTML: '&#95;'
        });
        minimizeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _toggleMinimize();
        });

        // Maximize button
        var maximizeBtn = _el('button', {
            className: 'tacta-sql-header-btn',
            title: 'Maximize',
            innerHTML: '&#9744;'
        });
        maximizeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _toggleMaximize();
        });

        // Close button
        var closeBtn = _el('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _closePanel();
        });

        actionsContainer.appendChild(minimizeBtn);
        actionsContainer.appendChild(maximizeBtn);
        actionsContainer.appendChild(closeBtn);
    }

    /**
     * Toggles the minimized state.
     */
    function _toggleMinimize() {
        if (!_panelInstance) return;
        _isMinimized = !_isMinimized;
        _panelInstance.panel.classList.toggle('tacta-sql-panel-minimized', _isMinimized);

        if (_isMinimized && _isMaximized) {
            _toggleMaximize();
        }
    }

    /**
     * Toggles the maximized state.
     */
    function _toggleMaximize() {
        if (!_panelInstance) return;
        var panel = _panelInstance.panel;

        if (_isMaximized) {
            // Restore
            if (_preMaximizeState) {
                panel.style.top = _preMaximizeState.top;
                panel.style.left = _preMaximizeState.left;
                panel.style.width = _preMaximizeState.width;
                panel.style.height = _preMaximizeState.height;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            }
            panel.classList.remove('tacta-sql-panel-maximized');
            _isMaximized = false;
        } else {
            // Save current state
            _preMaximizeState = {
                top: panel.style.top,
                left: panel.style.left,
                width: panel.style.width,
                height: panel.style.height
            };
            panel.classList.add('tacta-sql-panel-maximized');
            _isMaximized = true;

            if (_isMinimized) {
                _isMinimized = false;
                panel.classList.remove('tacta-sql-panel-minimized');
            }
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Tabs
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds the tab navigation bar.
     * @returns {HTMLElement}
     */
    function _buildTabsBar() {
        var suiteqlTabBtn = _el('button', {
            className: 'tacta-tab',
            textContent: 'SuiteQL',
            dataset: { tab: 'suiteql' }
        });

        var savedSearchTabBtn = _el('button', {
            className: 'tacta-tab',
            textContent: 'Saved Search Builder',
            dataset: { tab: 'savedsearch' }
        });

        var tabsBar = _el('div', { className: 'tacta-tabs' }, [suiteqlTabBtn, savedSearchTabBtn]);

        tabsBar.addEventListener('click', function (e) {
            var tabBtn = e.target.closest('.tacta-tab');
            if (!tabBtn) return;
            var tabId = tabBtn.dataset.tab;
            if (tabId) _switchTab(tabId);
        });

        return tabsBar;
    }

    /**
     * Switches to the specified tab.
     * @param {string} tabId - 'suiteql' or 'savedsearch'
     */
    function _switchTab(tabId) {
        _activeTab = tabId;
        if (!_panelInstance) return;

        var body = _panelInstance.body;

        // Update tab buttons
        var tabBtns = body.querySelectorAll('.tacta-tab');
        for (var i = 0; i < tabBtns.length; i++) {
            tabBtns[i].classList.toggle('tacta-active', tabBtns[i].dataset.tab === tabId);
        }

        // Update tab content
        var tabContents = body.querySelectorAll('.tacta-tab-content');
        for (var j = 0; j < tabContents.length; j++) {
            tabContents[j].classList.toggle('tacta-active', tabContents[j].dataset.tab === tabId);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // SuiteQL Tab
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds the complete SuiteQL tab content.
     * @returns {HTMLElement}
     */
    function _buildSuiteQLTab() {
        var tabContent = _el('div', {
            className: 'tacta-tab-content',
            dataset: { tab: 'suiteql' }
        });

        // ── Query Editor ──
        _editorEl = _el('textarea', {
            className: 'tacta-sql-editor',
            placeholder: 'SELECT * FROM transaction WHERE rownum <= 10'
        });

        // Ctrl+Enter to run
        _editorEl.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                _executeQuery();
            }
            // Tab key inserts spaces instead of moving focus
            if (e.key === 'Tab') {
                e.preventDefault();
                var start = _editorEl.selectionStart;
                var end = _editorEl.selectionEnd;
                _editorEl.value = _editorEl.value.substring(0, start) + '    ' + _editorEl.value.substring(end);
                _editorEl.selectionStart = _editorEl.selectionEnd = start + 4;
            }
        });

        tabContent.appendChild(_editorEl);

        // ── Toolbar ──
        var runBtn = _el('button', {
            className: 'tacta-btn tacta-btn-primary tacta-btn-sm',
            innerHTML: '&#9654; Run'
        });
        runBtn.addEventListener('click', function () {
            _executeQuery();
        });

        // AI Assist toggle button
        var aiBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            innerHTML: 'AI Assist &#9662;'
        });
        aiBtn.addEventListener('click', function () {
            _toggleAISection();
        });

        // History button
        var historyWrapper = _el('div', { className: 'tacta-sql-history-wrapper' });
        var historyBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'History'
        });
        historyBtn.addEventListener('click', function () {
            _toggleHistory();
        });

        _historyDropdown = _el('div', { className: 'tacta-sql-history-dropdown' });
        historyWrapper.appendChild(historyBtn);
        historyWrapper.appendChild(_historyDropdown);

        _statusEl = _el('span', { className: 'tacta-sql-status' });

        var toolbarLeft = _el('div', { className: 'tacta-sql-toolbar-left' }, [runBtn, aiBtn, historyWrapper]);
        var toolbarRight = _el('div', { className: 'tacta-sql-toolbar-right' }, [_statusEl]);
        var toolbar = _el('div', { className: 'tacta-sql-toolbar' }, [toolbarLeft, toolbarRight]);

        tabContent.appendChild(toolbar);

        // ── AI Assist Section ──
        var aiSection = _buildAISection();
        tabContent.appendChild(aiSection);

        // ── Results Area ──
        _resultsHost = _el('div', { className: 'tacta-sql-results' });
        tabContent.appendChild(_resultsHost);

        // Close history dropdown when clicking outside
        document.addEventListener('mousedown', function (e) {
            if (_historyOpen && _historyDropdown && !_historyDropdown.contains(e.target) && !historyBtn.contains(e.target)) {
                _historyOpen = false;
                _historyDropdown.classList.remove('tacta-visible');
            }
        });

        return tabContent;
    }

    /**
     * Builds the collapsible AI Assist section.
     * @returns {HTMLElement}
     */
    function _buildAISection() {
        var section = _el('div', { className: 'tacta-sql-ai-section tacta-collapsed' });

        var arrow = _el('span', { className: 'tacta-sql-ai-arrow', innerHTML: '&#9654;' });
        var headerTitle = _el('span', { className: 'tacta-sql-ai-header-title' }, [arrow, 'AI Query Assistant']);
        var header = _el('div', { className: 'tacta-sql-ai-header' }, [headerTitle]);

        header.addEventListener('click', function () {
            _toggleAISection();
        });

        _aiInputEl = _el('textarea', {
            className: 'tacta-sql-ai-input',
            placeholder: 'Describe the data you want to query, e.g., "Show me all open sales orders from last 30 days"'
        });

        var generateBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Generate Query'
        });
        generateBtn.addEventListener('click', function () {
            _generateAIQuery();
        });

        _aiExplanationEl = _el('div', { className: 'tacta-sql-ai-explanation', style: { display: 'none' } });

        var aiActions = _el('div', { className: 'tacta-sql-ai-actions' }, [generateBtn]);
        var aiBody = _el('div', { className: 'tacta-sql-ai-body' }, [_aiInputEl, aiActions, _aiExplanationEl]);

        section.appendChild(header);
        section.appendChild(aiBody);

        return section;
    }

    /**
     * Toggles the AI Assist section open/closed.
     */
    function _toggleAISection() {
        _aiCollapsed = !_aiCollapsed;
        if (!_panelInstance) return;
        var section = _panelInstance.body.querySelector('.tacta-sql-ai-section');
        if (section) {
            section.classList.toggle('tacta-collapsed', _aiCollapsed);
        }
    }

    /**
     * Toggles the query history dropdown.
     */
    function _toggleHistory() {
        _historyOpen = !_historyOpen;
        if (!_historyDropdown) return;

        if (_historyOpen) {
            _renderHistory();
            _historyDropdown.classList.add('tacta-visible');
        } else {
            _historyDropdown.classList.remove('tacta-visible');
        }
    }

    /**
     * Renders the history dropdown items.
     */
    function _renderHistory() {
        if (!_historyDropdown) return;
        _historyDropdown.innerHTML = '';

        if (_queryHistory.length === 0) {
            _historyDropdown.appendChild(_el('div', {
                className: 'tacta-sql-history-empty',
                textContent: 'No query history yet'
            }));
            return;
        }

        for (var i = 0; i < _queryHistory.length; i++) {
            var item = _el('button', {
                className: 'tacta-sql-history-item',
                textContent: _queryHistory[i],
                dataset: { idx: String(i) }
            });
            item.addEventListener('click', function () {
                var idx = parseInt(this.dataset.idx, 10);
                if (_editorEl && _queryHistory[idx]) {
                    _editorEl.value = _queryHistory[idx];
                    _editorEl.focus();
                }
                _historyOpen = false;
                _historyDropdown.classList.remove('tacta-visible');
            });
            _historyDropdown.appendChild(item);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // SuiteQL Execution
    // ────────────────────────────────────────────────────────────────

    /**
     * Executes the current query in the editor.
     */
    function _executeQuery() {
        if (!_editorEl) return;
        var query = _editorEl.value.trim();
        if (!query) {
            _showStatus('Enter a query to execute', 'error');
            return;
        }

        _addToHistory(query);
        _showStatus('Executing...', '');
        _showResultsLoading();

        _sendMessage({ action: 'executeSuiteQL', query: query, params: null })
            .then(function (result) {
                _suiteqlResults = result;
                _sortColumn = null;
                _sortAsc = true;
                var rowCount = result.count || (result.rows ? result.rows.length : 0);
                var timeMs = result.executionTime || 0;
                _showStatus(rowCount + ' row' + (rowCount !== 1 ? 's' : '') + ', ' + timeMs + 'ms', 'success');
                _renderResults();
            })
            .catch(function (err) {
                _suiteqlResults = null;
                _showStatus('Error', 'error');
                _showResultsError(err.message || 'Query execution failed');
            });
    }

    /**
     * Updates the status bar text.
     * @param {string} text
     * @param {string} [type] - '', 'success', or 'error'
     */
    function _showStatus(text, type) {
        if (!_statusEl) return;
        _statusEl.textContent = text;
        _statusEl.className = 'tacta-sql-status';
        if (type === 'success') _statusEl.classList.add('tacta-sql-status--success');
        else if (type === 'error') _statusEl.classList.add('tacta-sql-status--error');
    }

    /**
     * Shows a loading spinner in the results area.
     */
    function _showResultsLoading() {
        if (!_resultsHost) return;
        _resultsHost.innerHTML = '';
        _resultsHost.appendChild(_el('div', { className: 'tacta-sql-loading' }, [
            _el('div', { className: 'tacta-spinner tacta-spinner--sm' }),
            _el('span', { textContent: 'Running query...' })
        ]));
    }

    /**
     * Shows an error message in the results area.
     * @param {string} message
     */
    function _showResultsError(message) {
        if (!_resultsHost) return;
        _resultsHost.innerHTML = '';
        _resultsHost.appendChild(_el('div', {
            className: 'tacta-sql-error',
            textContent: message
        }));
    }

    /**
     * Renders the query results table.
     */
    function _renderResults() {
        if (!_resultsHost || !_suiteqlResults) return;
        _resultsHost.innerHTML = '';

        var columns = _suiteqlResults.columns || [];
        var rows = _suiteqlResults.rows || [];

        if (columns.length === 0 || rows.length === 0) {
            _resultsHost.appendChild(_el('div', {
                className: 'tacta-sql-empty',
                textContent: 'Query returned no results'
            }));
            return;
        }

        // Sort rows if a sort column is active
        var sortedRows = rows.slice();
        if (_sortColumn !== null) {
            var col = _sortColumn;
            var asc = _sortAsc;
            sortedRows.sort(function (a, b) {
                var va = a[col];
                var vb = b[col];
                if (va === null || va === undefined) va = '';
                if (vb === null || vb === undefined) vb = '';

                // Try numeric comparison
                var na = Number(va);
                var nb = Number(vb);
                if (!isNaN(na) && !isNaN(nb)) {
                    return asc ? na - nb : nb - na;
                }

                // String comparison
                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
                if (va < vb) return asc ? -1 : 1;
                if (va > vb) return asc ? 1 : -1;
                return 0;
            });
        }

        // Build table
        var tableWrapper = _el('div', { className: 'tacta-table-wrapper' });
        var table = _el('table', { className: 'tacta-table' });

        // Thead
        var thead = _el('thead');
        var headRow = _el('tr');
        for (var h = 0; h < columns.length; h++) {
            var th = _el('th', {
                textContent: columns[h],
                className: 'tacta-sortable',
                dataset: { col: columns[h] }
            });

            // Sort indicator
            if (_sortColumn === columns[h]) {
                th.classList.add(_sortAsc ? 'tacta-sort-asc' : 'tacta-sort-desc');
            }

            th.addEventListener('click', (function (colName) {
                return function () {
                    if (_sortColumn === colName) {
                        _sortAsc = !_sortAsc;
                    } else {
                        _sortColumn = colName;
                        _sortAsc = true;
                    }
                    _renderResults();
                };
            })(columns[h]));

            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        // Tbody
        var tbody = _el('tbody');
        for (var r = 0; r < sortedRows.length; r++) {
            var tr = _el('tr');
            for (var c = 0; c < columns.length; c++) {
                var cellVal = sortedRows[r][columns[c]];
                var td = _el('td', {
                    textContent: cellVal === null || cellVal === undefined ? '' : String(cellVal),
                    title: cellVal === null || cellVal === undefined ? '' : String(cellVal)
                });
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        _resultsHost.appendChild(tableWrapper);

        // Truncation notice
        if (_suiteqlResults.truncated) {
            _resultsHost.appendChild(_el('div', {
                className: 'tacta-sql-truncated-notice',
                textContent: 'Results were truncated. Add a ROWNUM limit to your query to control the number of rows returned.'
            }));
        }

        // Action buttons
        var exportBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Export CSV'
        });
        exportBtn.addEventListener('click', function () {
            _exportResultsCSV();
        });

        var copyQueryBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Copy Query'
        });
        copyQueryBtn.addEventListener('click', function () {
            _copyCurrentQuery();
        });

        var actionsRow = _el('div', { className: 'tacta-sql-results-actions' }, [exportBtn, copyQueryBtn]);
        _resultsHost.appendChild(actionsRow);
    }

    /**
     * Exports the current results to CSV and triggers a download.
     */
    function _exportResultsCSV() {
        if (!_suiteqlResults || !_suiteqlResults.columns || !_suiteqlResults.rows) {
            if (window.TactaDOM) window.TactaDOM.showToast('No results to export', 'warning', 2000);
            return;
        }

        var csv = _generateCSV(_suiteqlResults.columns, _suiteqlResults.rows);
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        _downloadFile(csv, 'suiteql-results-' + timestamp + '.csv', 'text/csv;charset=utf-8;');

        if (window.TactaDOM) window.TactaDOM.showToast('CSV exported', 'success', 2000);
    }

    /**
     * Copies the current query to the clipboard.
     */
    function _copyCurrentQuery() {
        if (!_editorEl) return;
        var query = _editorEl.value.trim();
        if (!query) {
            if (window.TactaDOM) window.TactaDOM.showToast('No query to copy', 'warning', 2000);
            return;
        }

        if (window.TactaDOM && typeof window.TactaDOM.copyToClipboard === 'function') {
            window.TactaDOM.copyToClipboard(query).then(function (ok) {
                if (ok && window.TactaDOM) {
                    window.TactaDOM.showToast('Query copied to clipboard', 'success', 2000);
                }
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // AI Query Generation
    // ────────────────────────────────────────────────────────────────

    /**
     * Generates a SuiteQL query from the AI natural language input.
     */
    function _generateAIQuery() {
        if (!_aiInputEl) return;
        var prompt = _aiInputEl.value.trim();
        if (!prompt) {
            if (window.TactaDOM) window.TactaDOM.showToast('Enter a description of the data you want to query', 'warning', 2500);
            return;
        }

        _checkAIConfigured().then(function (aiState) {
            if (!aiState.configured) {
                _showAINoCfg();
                return;
            }

            _showAIExplanation('Generating query...');

            _sendMessage({
                action: 'aiGenerateQuery',
                prompt: prompt,
                context: {}
            }).then(function (result) {
                if (result && result.manual) {
                    _handleManualAIResult(result, 'SuiteQL prompt');
                    return;
                }
                if (result && result.query) {
                    if (_editorEl) {
                        _editorEl.value = result.query;
                        _editorEl.focus();
                    }
                    if (result.explanation) {
                        _showAIExplanation(result.explanation);
                    } else {
                        _hideAIExplanation();
                    }
                } else {
                    _showAIExplanation('AI could not generate a query. Please try rephrasing your request.');
                }
            }).catch(function (err) {
                _showAIExplanation('Error: ' + (err.message || 'AI generation failed'));
            });
        });
    }

    /**
     * Shows the AI explanation text.
     * @param {string} text
     */
    function _showAIExplanation(text) {
        if (!_aiExplanationEl) return;
        _aiExplanationEl.textContent = text;
        _aiExplanationEl.style.display = 'block';
    }

    /**
     * Hides the AI explanation.
     */
    function _hideAIExplanation() {
        if (!_aiExplanationEl) return;
        _aiExplanationEl.style.display = 'none';
    }

    /**
     * Shows a "not configured" message in the AI section.
     */
    function _showAINoCfg() {
        if (!_aiExplanationEl) return;
        var section = _aiExplanationEl.parentElement;
        if (!section) return;

        // Remove existing no-cfg notice
        var existing = section.querySelector('.tacta-sql-ai-nocfg');
        if (existing) existing.remove();

        var notice = _el('div', {
            className: 'tacta-sql-ai-nocfg',
            textContent: 'Set AI mode to Manual or configure an API key in Extension Settings to enable AI features.'
        });
        section.appendChild(notice);
    }

    function _handleManualAIResult(result, label) {
        if (!result || !result.prompt) return;
        if (window.TactaDOM && typeof window.TactaDOM.copyToClipboard === 'function') {
            window.TactaDOM.copyToClipboard(result.prompt).then(function (ok) {
                if (ok && window.TactaDOM) {
                    window.TactaDOM.showToast(label + ' copied', 'success', 2500);
                }
            });
        }
        _showAIExplanation(result.explanation || 'Manual prompt copied. Paste it into your AI app, then use the returned JSON to update the query.');
        _openManualProvider(result.provider);
    }

    function _openManualProvider(provider) {
        var urls = {
            anthropic: 'https://claude.ai/new',
            openai: 'https://chatgpt.com/',
            gemini: 'https://gemini.google.com/app'
        };
        var url = urls[provider];
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }

    // ────────────────────────────────────────────────────────────────
    // Saved Search Builder Tab
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds the complete Saved Search Builder tab.
     * @returns {HTMLElement}
     */
    function _buildSavedSearchTab() {
        var tabContent = _el('div', {
            className: 'tacta-tab-content',
            dataset: { tab: 'savedsearch' }
        });

        var builder = _el('div', { className: 'tacta-ss-builder' });

        // ── Prompt ──
        _ssPromptEl = _el('textarea', {
            className: 'tacta-ss-prompt',
            placeholder: 'Describe the saved search you want to build, e.g., "Find all customers with no orders in last 90 days"'
        });
        builder.appendChild(_ssPromptEl);

        // ── Actions ──
        var buildBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Build Search'
        });
        buildBtn.addEventListener('click', function () {
            _buildSavedSearch();
        });

        var ssActions = _el('div', { className: 'tacta-ss-actions' }, [buildBtn]);
        builder.appendChild(ssActions);

        // ── Explanation ──
        _ssExplanationEl = _el('div', { className: 'tacta-ss-explanation', style: { display: 'none' } });
        builder.appendChild(_ssExplanationEl);

        // ── Definition Host ──
        _ssDefinitionHost = _el('div', { className: 'tacta-ss-definition', style: { display: 'none' } });
        builder.appendChild(_ssDefinitionHost);

        // ── Results Host ──
        _ssResultsHost = _el('div', { className: 'tacta-ss-results', style: { display: 'none' } });
        builder.appendChild(_ssResultsHost);

        tabContent.appendChild(builder);
        return tabContent;
    }

    /**
     * Sends the saved search prompt to the AI and displays the result.
     */
    function _buildSavedSearch() {
        if (!_ssPromptEl) return;
        var prompt = _ssPromptEl.value.trim();
        if (!prompt) {
            if (window.TactaDOM) window.TactaDOM.showToast('Enter a description of the saved search', 'warning', 2500);
            return;
        }

        _checkAIConfigured().then(function (aiState) {
            if (!aiState.configured) {
                _showSSExplanation('Set AI mode to Manual or configure an API key in Extension Settings to enable AI features.');
                return;
            }

            _showSSExplanation('Generating saved search definition...');
            _ssDefinition = null;
            _ssPreviewResults = null;
            _hideSSDefinition();
            _hideSSResults();

            _sendMessage({
                action: 'aiGenerateSavedSearch',
                prompt: prompt
            }).then(function (result) {
                if (result && result.manual) {
                    _handleManualSavedSearchResult(result);
                    return;
                }
                if (result && result.searchDef) {
                    _ssDefinition = result.searchDef;
                    _ssExplanation = result.explanation || '';
                    _ssEditMode = false;
                    _showSSExplanation(_ssExplanation || 'Search definition generated successfully.');
                    _renderSSDefinition();
                } else {
                    _showSSExplanation('AI could not generate a search definition. Please try rephrasing your request.');
                }
            }).catch(function (err) {
                _showSSExplanation('Error: ' + (err.message || 'AI generation failed'));
            });
        });
    }

    /**
     * Shows the saved search explanation text.
     * @param {string} text
     */
    function _showSSExplanation(text) {
        if (!_ssExplanationEl) return;
        _ssExplanationEl.textContent = text;
        _ssExplanationEl.style.display = 'block';
    }

    function _handleManualSavedSearchResult(result) {
        if (!result || !result.prompt) return;
        if (window.TactaDOM && typeof window.TactaDOM.copyToClipboard === 'function') {
            window.TactaDOM.copyToClipboard(result.prompt).then(function (ok) {
                if (ok && window.TactaDOM) {
                    window.TactaDOM.showToast('Saved search prompt copied', 'success', 2500);
                }
            });
        }
        _showSSExplanation(result.explanation || 'Manual prompt copied. Paste it into your AI app, then use the returned JSON to build the saved search.');
        _openManualProvider(result.provider);
    }

    /**
     * Hides the SS definition section.
     */
    function _hideSSDefinition() {
        if (_ssDefinitionHost) {
            _ssDefinitionHost.style.display = 'none';
            _ssDefinitionHost.innerHTML = '';
        }
    }

    /**
     * Hides the SS results section.
     */
    function _hideSSResults() {
        if (_ssResultsHost) {
            _ssResultsHost.style.display = 'none';
            _ssResultsHost.innerHTML = '';
        }
    }

    /**
     * Renders the saved search definition display.
     */
    function _renderSSDefinition() {
        if (!_ssDefinitionHost || !_ssDefinition) return;
        _ssDefinitionHost.innerHTML = '';
        _ssDefinitionHost.style.display = 'flex';

        // ── Human-readable summary ──
        var summary = _el('div', { className: 'tacta-ss-definition-summary' });

        var recordType = _ssDefinition.type || _ssDefinition.recordType || 'unknown';
        summary.appendChild(_buildSummaryRow('Type:', recordType));

        // Filters
        var filters = _ssDefinition.filters || [];
        var filterText = Array.isArray(filters) ? _formatFilters(filters) : JSON.stringify(filters);
        summary.appendChild(_buildSummaryRow('Filters:', filterText));

        // Columns
        var columns = _ssDefinition.columns || [];
        var columnText = Array.isArray(columns) ? _formatColumns(columns) : JSON.stringify(columns);
        summary.appendChild(_buildSummaryRow('Columns:', columnText));

        _ssDefinitionHost.appendChild(summary);

        // ── JSON definition (editable or readonly) ──
        var jsonSection = _el('div', { className: 'tacta-ss-definition-json' });

        if (_ssEditMode) {
            var jsonEditor = _el('textarea', {
                className: 'tacta-sql-editor',
                value: JSON.stringify(_ssDefinition, null, 2)
            });
            jsonEditor.dataset.role = 'ss-json-editor';
            jsonSection.appendChild(jsonEditor);
        } else {
            var codeBlock = _el('pre', {
                className: 'tacta-code',
                textContent: JSON.stringify(_ssDefinition, null, 2)
            });
            jsonSection.appendChild(codeBlock);
        }

        _ssDefinitionHost.appendChild(jsonSection);

        // ── Action buttons ──
        var editBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: _ssEditMode ? 'Done Editing' : 'Edit Definition'
        });
        editBtn.addEventListener('click', function () {
            if (_ssEditMode) {
                // Save edits
                var editorTextarea = _ssDefinitionHost.querySelector('[data-role="ss-json-editor"]');
                if (editorTextarea) {
                    try {
                        _ssDefinition = JSON.parse(editorTextarea.value);
                    } catch (parseErr) {
                        if (window.TactaDOM) window.TactaDOM.showToast('Invalid JSON: ' + parseErr.message, 'error', 3000);
                        return;
                    }
                }
            }
            _ssEditMode = !_ssEditMode;
            _renderSSDefinition();
        });

        var previewBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Preview Results'
        });
        previewBtn.addEventListener('click', function () {
            _previewSavedSearch();
        });

        var saveBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Save to NetSuite'
        });
        saveBtn.addEventListener('click', function () {
            _promptAndSaveSavedSearch();
        });

        var actionsRow = _el('div', { className: 'tacta-ss-save-row' }, [editBtn, previewBtn, saveBtn]);
        _ssDefinitionHost.appendChild(actionsRow);
    }

    /**
     * Builds a summary label-value row.
     * @param {string} label
     * @param {string} value
     * @returns {HTMLElement}
     */
    function _buildSummaryRow(label, value) {
        return _el('div', { className: 'tacta-ss-definition-summary-row' }, [
            _el('span', { className: 'tacta-ss-definition-label', textContent: label }),
            _el('span', { className: 'tacta-ss-definition-value', textContent: value })
        ]);
    }

    /**
     * Formats a filters array into a readable string.
     * @param {Array} filters
     * @returns {string}
     */
    function _formatFilters(filters) {
        if (!filters || filters.length === 0) return '(none)';
        var parts = [];
        for (var i = 0; i < filters.length; i++) {
            var f = filters[i];
            if (typeof f === 'string') {
                // AND / OR operator
                parts.push(f.toUpperCase());
            } else if (Array.isArray(f)) {
                parts.push('[' + f.join(' ') + ']');
            } else if (f && typeof f === 'object') {
                var name = f.name || f.fieldId || '?';
                var op = f.operator || '?';
                var val = f.values ? f.values.join(', ') : (f.value !== undefined ? String(f.value) : '?');
                parts.push('[' + name + ' ' + op + ' ' + val + ']');
            }
        }
        return parts.join(' ');
    }

    /**
     * Formats a columns array into a readable string.
     * @param {Array} columns
     * @returns {string}
     */
    function _formatColumns(columns) {
        if (!columns || columns.length === 0) return '(none)';
        var names = [];
        for (var i = 0; i < columns.length; i++) {
            var col = columns[i];
            if (typeof col === 'string') {
                names.push(col);
            } else if (col && typeof col === 'object') {
                names.push(col.name || col.fieldId || JSON.stringify(col));
            }
        }
        return names.join(', ');
    }

    // ────────────────────────────────────────────────────────────────
    // Saved Search Preview
    // ────────────────────────────────────────────────────────────────

    /**
     * Previews the saved search by sending the definition to the background.
     */
    function _previewSavedSearch() {
        if (!_ssDefinition) {
            if (window.TactaDOM) window.TactaDOM.showToast('No search definition to preview', 'warning', 2000);
            return;
        }

        // If in edit mode, capture current JSON first
        if (_ssEditMode && _ssDefinitionHost) {
            var editorTextarea = _ssDefinitionHost.querySelector('[data-role="ss-json-editor"]');
            if (editorTextarea) {
                try {
                    _ssDefinition = JSON.parse(editorTextarea.value);
                } catch (parseErr) {
                    if (window.TactaDOM) window.TactaDOM.showToast('Invalid JSON: ' + parseErr.message, 'error', 3000);
                    return;
                }
            }
        }

        if (!_ssResultsHost) return;
        _ssResultsHost.style.display = 'flex';
        _ssResultsHost.innerHTML = '';
        _ssResultsHost.appendChild(_el('div', { className: 'tacta-sql-loading' }, [
            _el('div', { className: 'tacta-spinner tacta-spinner--sm' }),
            _el('span', { textContent: 'Previewing search...' })
        ]));

        _sendMessage({ action: 'previewSavedSearch', searchDef: _ssDefinition })
            .then(function (result) {
                _ssPreviewResults = result;
                _renderSSPreviewResults();
            })
            .catch(function (err) {
                if (!_ssResultsHost) return;
                _ssResultsHost.innerHTML = '';
                _ssResultsHost.appendChild(_el('div', {
                    className: 'tacta-sql-error',
                    textContent: 'Preview failed: ' + (err.message || 'Unknown error')
                }));
            });
    }

    /**
     * Renders the saved search preview results table.
     */
    function _renderSSPreviewResults() {
        if (!_ssResultsHost || !_ssPreviewResults) return;
        _ssResultsHost.innerHTML = '';
        _ssResultsHost.style.display = 'flex';

        var columns = _ssPreviewResults.columns || [];
        var rows = _ssPreviewResults.rows || [];

        if (columns.length === 0 || rows.length === 0) {
            _ssResultsHost.appendChild(_el('div', {
                className: 'tacta-sql-empty',
                textContent: 'Preview returned no results'
            }));
            return;
        }

        // Build table
        var tableWrapper = _el('div', { className: 'tacta-table-wrapper' });
        var table = _el('table', { className: 'tacta-table' });

        var thead = _el('thead');
        var headRow = _el('tr');
        for (var h = 0; h < columns.length; h++) {
            headRow.appendChild(_el('th', { textContent: columns[h] }));
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = _el('tbody');
        for (var r = 0; r < rows.length; r++) {
            var tr = _el('tr');
            for (var c = 0; c < columns.length; c++) {
                var cellVal = rows[r][columns[c]];
                tr.appendChild(_el('td', {
                    textContent: cellVal === null || cellVal === undefined ? '' : String(cellVal),
                    title: cellVal === null || cellVal === undefined ? '' : String(cellVal)
                }));
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        _ssResultsHost.appendChild(tableWrapper);

        // Count
        _ssResultsHost.appendChild(_el('div', {
            className: 'tacta-sql-status tacta-sql-status--success',
            textContent: (rows.length) + ' row' + (rows.length !== 1 ? 's' : '') + ' returned',
            style: { marginTop: '4px', fontSize: '11px' }
        }));
    }

    // ────────────────────────────────────────────────────────────────
    // Save Saved Search
    // ────────────────────────────────────────────────────────────────

    /**
     * Shows an inline title input and saves the search to NetSuite.
     */
    function _promptAndSaveSavedSearch() {
        if (!_ssDefinition) {
            if (window.TactaDOM) window.TactaDOM.showToast('No search definition to save', 'warning', 2000);
            return;
        }

        // If in edit mode, capture current JSON first
        if (_ssEditMode && _ssDefinitionHost) {
            var editorTextarea = _ssDefinitionHost.querySelector('[data-role="ss-json-editor"]');
            if (editorTextarea) {
                try {
                    _ssDefinition = JSON.parse(editorTextarea.value);
                } catch (parseErr) {
                    if (window.TactaDOM) window.TactaDOM.showToast('Invalid JSON: ' + parseErr.message, 'error', 3000);
                    return;
                }
            }
        }

        // Check if save row already exists
        if (!_ssDefinitionHost) return;
        var existingSaveInput = _ssDefinitionHost.querySelector('.tacta-ss-save-title-input');
        if (existingSaveInput) {
            existingSaveInput.focus();
            return;
        }

        // Find the save row and add inline input
        var saveRow = _ssDefinitionHost.querySelector('.tacta-ss-save-row');
        if (!saveRow) return;

        var titleInput = _el('input', {
            className: 'tacta-input tacta-ss-save-title-input',
            placeholder: 'Enter search title...',
            type: 'text'
        });

        var confirmBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm tacta-btn-primary',
            textContent: 'Confirm Save'
        });

        var cancelBtn = _el('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Cancel'
        });

        var inputRow = _el('div', { className: 'tacta-ss-save-row', style: { marginTop: '8px' } }, [titleInput, confirmBtn, cancelBtn]);

        saveRow.parentElement.appendChild(inputRow);
        titleInput.focus();

        // Enter key to confirm
        titleInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSave();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                inputRow.remove();
            }
        });

        cancelBtn.addEventListener('click', function () {
            inputRow.remove();
        });

        confirmBtn.addEventListener('click', function () {
            doSave();
        });

        function doSave() {
            var title = titleInput.value.trim();
            if (!title) {
                if (window.TactaDOM) window.TactaDOM.showToast('Enter a title for the saved search', 'warning', 2000);
                titleInput.focus();
                return;
            }

            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Saving...';

            _sendMessage({
                action: 'createSavedSearch',
                searchDef: _ssDefinition,
                title: title
            }).then(function (result) {
                inputRow.remove();
                if (result && result.success) {
                    var msg = 'Saved search created';
                    if (result.id) msg += ' (ID: ' + result.id + ')';
                    if (window.TactaDOM) window.TactaDOM.showToast(msg, 'success', 4000);
                } else {
                    if (window.TactaDOM) window.TactaDOM.showToast('Search saved', 'success', 3000);
                }
            }).catch(function (err) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Confirm Save';
                if (window.TactaDOM) window.TactaDOM.showToast('Save failed: ' + (err.message || 'Unknown error'), 'error', 4000);
            });
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Event Listener — Feature Activation
    // ────────────────────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            _showPanel();
        }
    });

})();
