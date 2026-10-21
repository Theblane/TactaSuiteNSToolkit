/**
 * suiteql-runner.js
 * NetSuite TactaSuite - SuiteQL Runner (Content Script)
 *
 * @author Blane Maher
 *
 * Floating panel for running SuiteQL queries against NetSuite.
 * Communicates with the background service worker for query execution.
 *
 * Activation: 'tacta:featureActivated' custom event with featureId 'suiteql-runner'.
 *
 * @fileoverview SuiteQL Runner content script for the NetSuite TactaSuite.
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

    // ── DOM references ──
    var _editorEl = null;
    var _statusEl = null;
    var _resultsHost = null;
    var _historyDropdown = null;

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

    function _loadPanelState() {
        return _storageGet(STORAGE_KEY_PANEL);
    }

    function _loadHistory() {
        return _storageGet(STORAGE_KEY_HISTORY).then(function (hist) {
            _queryHistory = Array.isArray(hist) ? hist : [];
        });
    }

    function _saveHistory() {
        return _storageSet(STORAGE_KEY_HISTORY, _queryHistory);
    }

    function _addToHistory(query) {
        var trimmed = query.trim();
        if (!trimmed) return;

        var idx = _queryHistory.indexOf(trimmed);
        if (idx >= 0) {
            _queryHistory.splice(idx, 1);
        }

        _queryHistory.unshift(trimmed);

        if (_queryHistory.length > MAX_HISTORY) {
            _queryHistory = _queryHistory.slice(0, MAX_HISTORY);
        }

        _saveHistory();
    }

    // ────────────────────────────────────────────────────────────────
    // Utility Helpers
    // ────────────────────────────────────────────────────────────────

    function _el(tag, attrs, children) {
        return window.TactaDOM.createElement(tag, attrs, children);
    }

    function _generateCSV(columns, rows) {
        var lines = [];

        lines.push(columns.map(function (col) {
            return _csvEscapeCell(col);
        }).join(','));

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            lines.push(columns.map(function (col) {
                var val = row[col];
                return _csvEscapeCell(val === null || val === undefined ? '' : String(val));
            }).join(','));
        }

        return lines.join('\n');
    }

    function _csvEscapeCell(str) {
        if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0 || str.indexOf('\n') >= 0) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

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
    // Panel Lifecycle
    // ────────────────────────────────────────────────────────────────

    function _showPanel() {
        if (_panelInstance) {
            _closePanel();
            return;
        }

        if (!window.TactaDOM) {
            console.error('[TactaSuite SuiteQL Runner] TactaDOM not available.');
            return;
        }

        _loadHistory().then(function () {
            return _loadPanelState();
        }).then(function (savedState) {
            _createPanel(savedState);
        });
    }

    function _closePanel() {
        if (_panelInstance) {
            _savePanelState();
            _panelInstance.close();
            _panelInstance = null;
        }
        _resetState();
    }

    function _resetState() {
        _isMinimized = false;
        _isMaximized = false;
        _preMaximizeState = null;
        _suiteqlResults = null;
        _sortColumn = null;
        _sortAsc = true;
        _historyOpen = false;
        _editorEl = null;
        _statusEl = null;
        _resultsHost = null;
        _historyDropdown = null;
    }

    // ────────────────────────────────────────────────────────────────
    // Panel Construction
    // ────────────────────────────────────────────────────────────────

    function _createPanel(savedState) {
        var defaultTop = Math.max(40, Math.floor((window.innerHeight - DEFAULT_HEIGHT) / 2));
        var defaultLeft = Math.max(40, Math.floor((window.innerWidth - DEFAULT_WIDTH) / 2));

        var posTop = (savedState && savedState.top) || (defaultTop + 'px');
        var posLeft = (savedState && savedState.left) || (defaultLeft + 'px');
        var width = (savedState && savedState.width) || (DEFAULT_WIDTH + 'px');
        var height = (savedState && savedState.height) || (DEFAULT_HEIGHT + 'px');

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

        _panelInstance.panel.classList.add(SCOPE_CLASS);

        _buildHeaderActions();

        var content = _buildSuiteQLContent();
        _panelInstance.body.appendChild(content);

        _panelInstance.panel.addEventListener('mouseup', function () {
            setTimeout(_savePanelState, 100);
        });
    }

    function _buildHeaderActions() {
        var actionsContainer = _panelInstance.header.querySelector('.tacta-panel-actions');
        if (!actionsContainer) return;

        actionsContainer.innerHTML = '';

        var minimizeBtn = _el('button', {
            className: 'tacta-sql-header-btn',
            title: 'Minimize',
            innerHTML: '&#95;'
        });
        minimizeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _toggleMinimize();
        });

        var maximizeBtn = _el('button', {
            className: 'tacta-sql-header-btn',
            title: 'Maximize',
            innerHTML: '&#9744;'
        });
        maximizeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _toggleMaximize();
        });

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

    function _toggleMinimize() {
        if (!_panelInstance) return;
        _isMinimized = !_isMinimized;
        _panelInstance.panel.classList.toggle('tacta-sql-panel-minimized', _isMinimized);

        if (_isMinimized && _isMaximized) {
            _toggleMaximize();
        }
    }

    function _toggleMaximize() {
        if (!_panelInstance) return;
        var panel = _panelInstance.panel;

        if (_isMaximized) {
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
    // SuiteQL Content
    // ────────────────────────────────────────────────────────────────

    function _buildSuiteQLContent() {
        var container = _el('div', { className: 'tacta-tab-content tacta-active' });

        // ── Query Editor ──
        _editorEl = _el('textarea', {
            className: 'tacta-sql-editor',
            placeholder: 'SELECT * FROM transaction WHERE rownum <= 10'
        });

        _editorEl.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                _executeQuery();
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                var start = _editorEl.selectionStart;
                var end = _editorEl.selectionEnd;
                _editorEl.value = _editorEl.value.substring(0, start) + '    ' + _editorEl.value.substring(end);
                _editorEl.selectionStart = _editorEl.selectionEnd = start + 4;
            }
        });

        container.appendChild(_editorEl);

        // ── Toolbar ──
        var runBtn = _el('button', {
            className: 'tacta-btn tacta-btn-primary tacta-btn-sm',
            innerHTML: '&#9654; Run'
        });
        runBtn.addEventListener('click', function () {
            _executeQuery();
        });

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

        var toolbarLeft = _el('div', { className: 'tacta-sql-toolbar-left' }, [runBtn, historyWrapper]);
        var toolbarRight = _el('div', { className: 'tacta-sql-toolbar-right' }, [_statusEl]);
        var toolbar = _el('div', { className: 'tacta-sql-toolbar' }, [toolbarLeft, toolbarRight]);

        container.appendChild(toolbar);

        // ── Results Area ──
        _resultsHost = _el('div', { className: 'tacta-sql-results' });
        container.appendChild(_resultsHost);

        // Close history dropdown when clicking outside
        document.addEventListener('mousedown', function (e) {
            if (_historyOpen && _historyDropdown && !_historyDropdown.contains(e.target) && !historyBtn.contains(e.target)) {
                _historyOpen = false;
                _historyDropdown.classList.remove('tacta-visible');
            }
        });

        return container;
    }

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

    function _showStatus(text, type) {
        if (!_statusEl) return;
        _statusEl.textContent = text;
        _statusEl.className = 'tacta-sql-status';
        if (type === 'success') _statusEl.classList.add('tacta-sql-status--success');
        else if (type === 'error') _statusEl.classList.add('tacta-sql-status--error');
    }

    function _showResultsLoading() {
        if (!_resultsHost) return;
        _resultsHost.innerHTML = '';
        _resultsHost.appendChild(_el('div', { className: 'tacta-sql-loading' }, [
            _el('div', { className: 'tacta-spinner tacta-spinner--sm' }),
            _el('span', { textContent: 'Running query...' })
        ]));
    }

    function _showResultsError(message) {
        if (!_resultsHost) return;
        _resultsHost.innerHTML = '';
        _resultsHost.appendChild(_el('div', {
            className: 'tacta-sql-error',
            textContent: message
        }));
    }

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

        var sortedRows = rows.slice();
        if (_sortColumn !== null) {
            var col = _sortColumn;
            var asc = _sortAsc;
            sortedRows.sort(function (a, b) {
                var va = a[col];
                var vb = b[col];
                if (va === null || va === undefined) va = '';
                if (vb === null || vb === undefined) vb = '';

                var na = Number(va);
                var nb = Number(vb);
                if (!isNaN(na) && !isNaN(nb)) {
                    return asc ? na - nb : nb - na;
                }

                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
                if (va < vb) return asc ? -1 : 1;
                if (va > vb) return asc ? 1 : -1;
                return 0;
            });
        }

        var tableWrapper = _el('div', { className: 'tacta-table-wrapper' });
        var table = _el('table', { className: 'tacta-table' });

        var thead = _el('thead');
        var headRow = _el('tr');
        for (var h = 0; h < columns.length; h++) {
            var th = _el('th', {
                textContent: columns[h],
                className: 'tacta-sortable',
                dataset: { col: columns[h] }
            });

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

        if (_suiteqlResults.truncated) {
            _resultsHost.appendChild(_el('div', {
                className: 'tacta-sql-truncated-notice',
                textContent: 'Results were truncated. Add a ROWNUM limit to your query to control the number of rows returned.'
            }));
        }

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
    // Event Listener — Feature Activation
    // ────────────────────────────────────────────────────────────────

    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === FEATURE_ID) {
            _showPanel();
        }
    });

})();
