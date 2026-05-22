/**
 * field-explorer.js
 * TactaSuite NS Toolkit - Field Explorer (Content Script)
 *
 * @author Blane Maher
 *
 * Inspects all fields on the current NetSuite record page.
 * Creates a sidebar panel using TactaDOM.createSidebar() and communicates
 * with the page-world script (field-explorer-client.js) via TactaNSBridge.
 *
 * Activation: popup message 'activateFeature' with featureId 'field-explorer'.
 *
 * @fileoverview Field Explorer content script for the TactaSuite NS Toolkit.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaFieldExplorerLoaded) return;
    window.__tactaFieldExplorerLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} CSS class scope for this feature */
    var SCOPE_CLASS = 'tacta-field-explorer';

    /** @type {number} Max characters to show for field values before truncating */
    var VALUE_TRUNCATE_LENGTH = 80;

    /** @type {string[]} Filter categories */
    var FILTER_OPTIONS = ['All', 'Body Fields', 'Sublist Fields', 'Hidden Fields'];

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {{ sidebar: HTMLElement, body: HTMLElement, close: Function }|null} */
    var _sidebarInstance = null;

    /** @type {{ bodyFields: Array, sublists: Object }|null} */
    var _fieldData = null;

    /** @type {string} Current search term */
    var _searchTerm = '';

    /** @type {string} Current active filter */
    var _activeFilter = 'All';

    /** @type {string|null} Currently expanded field ID */
    var _expandedFieldId = null;

    // ────────────────────────────────────────────────────────────────
    // Service worker communication
    // ────────────────────────────────────────────────────────────────

    /**
     * Sends a message to the background service worker and returns
     * the response. All page-world operations (N/currentRecord access)
     * are handled by the service worker via chrome.scripting.executeScript
     * with world:'MAIN'.
     */
    function _sendToBackground(payload) {
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

    /**
     * Requests all field data from the current record.
     * Uses two strategies in parallel:
     *   1. Service worker (SS1 APIs via chrome.scripting in MAIN world)
     *   2. XML fetch (append &xml=T to page URL — same as NetSuite Field Explorer extension)
     * Results are merged: XML catches fields the DOM scan misses.
     * @returns {Promise<Object>} Field data payload
     */
    function _requestFieldData() {
        return Promise.all([
            _sendToBackground({ action: 'getRecordFields' }).catch(function () { return { bodyFields: [], sublists: {} }; }),
            _fetchXmlFields().catch(function () { return null; })
        ]).then(function (results) {
            var apiData = results[0] || { bodyFields: [], sublists: {} };
            var xmlData = results[1];

            if (xmlData) {
                _mergeXmlFields(apiData, xmlData);
            }

            return apiData;
        });
    }

    /**
     * Fetches the record XML by appending &xml=T to the current page URL.
     * Parses it into { bodyFields: {id: value}, sublists: {name: [{...}, ...]} }
     */
    function _fetchXmlFields() {
        var url = window.location.href;
        // Only works on record pages with an ID
        if (!/[?&]id=\d/i.test(url) && !/\/app\//.test(url)) {
            return Promise.resolve(null);
        }

        var xmlUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'xml=T';

        return fetch(xmlUrl, { credentials: 'same-origin' })
            .then(function (resp) {
                if (!resp.ok) return null;
                return resp.text();
            })
            .then(function (text) {
                if (!text) return null;
                try {
                    var parser = new DOMParser();
                    var doc = parser.parseFromString(text, 'text/xml');
                    var recordEl = doc.querySelector('record');
                    if (!recordEl) return null;

                    var result = { bodyFields: {}, sublists: {} };

                    // Body fields: direct children of <record> that aren't <machine>
                    for (var i = 0; i < recordEl.children.length; i++) {
                        var child = recordEl.children[i];
                        if (child.tagName === 'machine') {
                            // Sublist
                            var slName = child.getAttribute('name');
                            if (slName) {
                                var lines = child.querySelectorAll('line');
                                var slLines = [];
                                for (var li = 0; li < lines.length; li++) {
                                    var lineData = {};
                                    for (var fi = 0; fi < lines[li].children.length; fi++) {
                                        lineData[lines[li].children[fi].tagName] = lines[li].children[fi].textContent || '';
                                    }
                                    slLines.push(lineData);
                                }
                                result.sublists[slName] = slLines;
                            }
                        } else {
                            result.bodyFields[child.tagName] = child.textContent || '';
                        }
                    }

                    return result;
                } catch (e) {
                    return null;
                }
            });
    }

    /**
     * Merges XML-fetched field data into the API result.
     * Adds any fields found in XML that aren't already in the API data.
     */
    function _mergeXmlFields(apiData, xmlData) {
        if (!xmlData) return;

        // Index existing body fields by ID
        var existingIds = {};
        for (var b = 0; b < apiData.bodyFields.length; b++) {
            existingIds[apiData.bodyFields[b].id] = true;
        }

        // Add body fields from XML that aren't in API data
        var xmlKeys = Object.keys(xmlData.bodyFields || {});
        for (var k = 0; k < xmlKeys.length; k++) {
            var key = xmlKeys[k];
            if (key.charAt(0) === '_') continue; // Skip _recordType, _id, _fields etc.
            if (existingIds[key]) {
                // Update value if API had null
                for (var eb = 0; eb < apiData.bodyFields.length; eb++) {
                    if (apiData.bodyFields[eb].id === key && apiData.bodyFields[eb].value === null) {
                        apiData.bodyFields[eb].value = xmlData.bodyFields[key];
                    }
                }
                continue;
            }
            apiData.bodyFields.push({
                id: key,
                label: '',
                type: 'unknown',
                value: xmlData.bodyFields[key],
                text: null,
                isMandatory: false,
                isDisabled: false,
                isHidden: true // XML-only fields are likely hidden
            });
        }

        // Add sublists from XML that aren't in API data
        var xmlSlNames = Object.keys(xmlData.sublists || {});
        for (var s = 0; s < xmlSlNames.length; s++) {
            var slName = xmlSlNames[s];
            if (apiData.sublists[slName] && apiData.sublists[slName].fields && apiData.sublists[slName].fields.length > 0) {
                continue; // Already have this sublist with fields
            }

            var xmlLines = xmlData.sublists[slName];
            if (!xmlLines || xmlLines.length === 0) continue;

            // Build field list from the first line's keys
            var firstLine = xmlLines[0];
            var fieldKeys = Object.keys(firstLine);
            var fields = [];
            for (var fi = 0; fi < fieldKeys.length; fi++) {
                fields.push({
                    id: fieldKeys[fi],
                    label: '',
                    type: 'unknown',
                    value: firstLine[fieldKeys[fi]],
                    text: null,
                    isMandatory: false,
                    isDisabled: false,
                    isHidden: false
                });
            }

            apiData.sublists[slName] = {
                fields: fields,
                lineCount: xmlLines.length
            };
        }
    }

    // ────────────────────────────────────────────────────────────────
    // UI Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Opens the Field Explorer sidebar and begins loading field data.
     */
    function activate() {
        try {
            // Close existing sidebar if open
            if (_sidebarInstance) {
                _sidebarInstance.close();
                _sidebarInstance = null;
            }

            // Reset state
            _fieldData = null;
            _searchTerm = '';
            _activeFilter = 'All';
            _expandedFieldId = null;

            if (typeof TactaDOM === 'undefined' || !TactaDOM.createSidebar) {
                console.error('[TactaFE] TactaDOM not available — shared/dom-utils.js was not injected before field-explorer.js.');
                return;
            }

            // Inject feature CSS
            if (TactaDOM.injectStylesheet) {
                TactaDOM.injectStylesheet(chrome.runtime.getURL('content/features/field-explorer/field-explorer.css'));
            }

            // Create sidebar
            _sidebarInstance = TactaDOM.createSidebar({
                title: 'Field Explorer',
                width: 420,
                overlay: false,
                onClose: function () {
                    _sidebarInstance = null;
                    _fieldData = null;
                }
            });

            if (!_sidebarInstance || !_sidebarInstance.sidebar) {
                console.error('[TactaFE] createSidebar returned no sidebar element.');
                return;
            }

            // Add the scoping class
            _sidebarInstance.sidebar.classList.add(SCOPE_CLASS);

            // Show loading state
            _showLoading();

            // Fetch field data
            _requestFieldData()
                .then(function (data) {
                    _fieldData = data;
                    _buildUI();
                })
                .catch(function (err) {
                    _showError(err.message || 'Failed to load field data.');
                });
        } catch (e) {
            console.error('[TactaFE] activate() threw:', e);
            if (typeof TactaDOM !== 'undefined' && TactaDOM.showToast) {
                TactaDOM.showToast('Field Explorer failed to open: ' + (e.message || e), 'error', 4000);
            }
        }
    }

    /**
     * Shows a loading spinner in the sidebar body.
     */
    function _showLoading() {
        if (!_sidebarInstance) return;
        _sidebarInstance.body.innerHTML = '';

        var wrapper = TactaDOM.createElement('div', {
            className: 'tacta-fe-loading'
        }, [
            TactaDOM.createElement('div', { className: 'tacta-spinner' }),
            TactaDOM.createElement('div', {
                className: 'tacta-fe-loading-text',
                textContent: 'Scanning record fields...'
            })
        ]);

        _sidebarInstance.body.appendChild(wrapper);
    }

    /**
     * Shows an error message in the sidebar body.
     * @param {string} message
     */
    function _showError(message) {
        if (!_sidebarInstance) return;
        _sidebarInstance.body.innerHTML = '';

        var wrapper = TactaDOM.createElement('div', {
            className: 'tacta-fe-error'
        }, [
            TactaDOM.createElement('div', {
                className: 'tacta-fe-error-icon',
                innerHTML: '<svg viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="2" width="32" height="32"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>'
            }),
            TactaDOM.createElement('div', {
                className: 'tacta-fe-error-text',
                textContent: message
            }),
            TactaDOM.createElement('button', {
                className: 'tacta-btn tacta-btn-sm',
                textContent: 'Retry',
                events: {
                    click: function () {
                        _showLoading();
                        _requestFieldData()
                            .then(function (data) {
                                _fieldData = data;
                                _buildUI();
                            })
                            .catch(function (err) {
                                _showError(err.message || 'Failed to load field data.');
                            });
                    }
                }
            })
        ]);

        _sidebarInstance.body.appendChild(wrapper);
    }

    /**
     * Builds the complete Field Explorer UI after field data is loaded.
     */
    function _buildUI() {
        if (!_sidebarInstance || !_fieldData) return;
        _sidebarInstance.body.innerHTML = '';

        // Summary bar
        var totalBody = _fieldData.bodyFields ? _fieldData.bodyFields.length : 0;
        var totalSublist = 0;
        var sublistIds = _fieldData.sublists ? Object.keys(_fieldData.sublists) : [];
        for (var s = 0; s < sublistIds.length; s++) {
            var sl = _fieldData.sublists[sublistIds[s]];
            totalSublist += sl.fields ? sl.fields.length : 0;
        }
        var totalHidden = 0;
        if (_fieldData.bodyFields) {
            for (var h = 0; h < _fieldData.bodyFields.length; h++) {
                if (_fieldData.bodyFields[h].isHidden) totalHidden++;
            }
        }

        var summaryBar = TactaDOM.createElement('div', {
            className: 'tacta-fe-summary'
        }, [
            _createStatBadge(totalBody + totalSublist, 'Total'),
            _createStatBadge(totalBody, 'Body'),
            _createStatBadge(totalSublist, 'Sublist'),
            _createStatBadge(totalHidden, 'Hidden')
        ]);

        _sidebarInstance.body.appendChild(summaryBar);

        // Toolbar: search + action buttons
        var searchInput = TactaDOM.createElement('input', {
            className: 'tacta-input tacta-fe-search',
            placeholder: 'Search fields by ID or label...',
            events: {
                input: function (e) {
                    _searchTerm = e.target.value.trim().toLowerCase();
                    _renderFieldList();
                }
            }
        });

        var copyBtn = TactaDOM.createElement('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Copy All IDs',
            title: 'Copy all field IDs to clipboard',
            events: {
                click: _copyAllFieldIds
            }
        });

        var exportBtn = TactaDOM.createElement('button', {
            className: 'tacta-btn tacta-btn-sm',
            textContent: 'Export JSON',
            title: 'Export all field data as JSON',
            events: {
                click: _exportJSON
            }
        });

        var toolbar = TactaDOM.createElement('div', {
            className: 'tacta-fe-toolbar'
        }, [
            searchInput,
            TactaDOM.createElement('div', {
                className: 'tacta-fe-toolbar-actions'
            }, [copyBtn, exportBtn])
        ]);

        _sidebarInstance.body.appendChild(toolbar);

        // Filter buttons
        var filterBar = TactaDOM.createElement('div', {
            className: 'tacta-fe-filters'
        });

        for (var f = 0; f < FILTER_OPTIONS.length; f++) {
            (function (filterName) {
                var btn = TactaDOM.createElement('button', {
                    className: 'tacta-fe-filter-btn' + (filterName === _activeFilter ? ' tacta-active' : ''),
                    textContent: filterName,
                    dataset: { filter: filterName },
                    events: {
                        click: function () {
                            _activeFilter = filterName;
                            // Update active states
                            var allBtns = filterBar.querySelectorAll('.tacta-fe-filter-btn');
                            for (var b = 0; b < allBtns.length; b++) {
                                allBtns[b].classList.toggle('tacta-active', allBtns[b].dataset.filter === filterName);
                            }
                            _renderFieldList();
                        }
                    }
                });
                filterBar.appendChild(btn);
            })(FILTER_OPTIONS[f]);
        }

        _sidebarInstance.body.appendChild(filterBar);

        // Field list container
        var fieldListContainer = TactaDOM.createElement('div', {
            className: 'tacta-fe-field-list',
            id: 'tacta-fe-field-list'
        });

        _sidebarInstance.body.appendChild(fieldListContainer);

        // Render initial list
        _renderFieldList();
    }

    /**
     * Creates a small stat badge element.
     * @param {number} count
     * @param {string} label
     * @returns {HTMLElement}
     */
    function _createStatBadge(count, label) {
        return TactaDOM.createElement('div', {
            className: 'tacta-fe-stat'
        }, [
            TactaDOM.createElement('span', {
                className: 'tacta-fe-stat-count',
                textContent: String(count)
            }),
            TactaDOM.createElement('span', {
                className: 'tacta-fe-stat-label',
                textContent: label
            })
        ]);
    }

    /**
     * Renders the filtered/searched field list into the container.
     */
    function _renderFieldList() {
        var container = document.getElementById('tacta-fe-field-list');
        if (!container || !_fieldData) return;
        container.innerHTML = '';

        var fields = _getFilteredFields();

        if (fields.length === 0) {
            container.appendChild(TactaDOM.createElement('div', {
                className: 'tacta-fe-empty',
                textContent: 'No fields match the current filter.'
            }));
            return;
        }

        for (var i = 0; i < fields.length; i++) {
            container.appendChild(_createFieldCard(fields[i]));
        }
    }

    /**
     * Applies the current search term and filter to produce a flat field list.
     * @returns {Array<Object>}
     */
    function _getFilteredFields() {
        var results = [];

        // Body fields
        if (_fieldData.bodyFields && (_activeFilter === 'All' || _activeFilter === 'Body Fields' || _activeFilter === 'Hidden Fields')) {
            for (var b = 0; b < _fieldData.bodyFields.length; b++) {
                var bf = _fieldData.bodyFields[b];
                bf._source = 'body';

                if (_activeFilter === 'Hidden Fields' && !bf.isHidden) continue;

                if (_searchTerm && !_matchesSearch(bf)) continue;

                results.push(bf);
            }
        }

        // Sublist fields
        if (_fieldData.sublists && (_activeFilter === 'All' || _activeFilter === 'Sublist Fields')) {
            var sublistIds = Object.keys(_fieldData.sublists);
            for (var s = 0; s < sublistIds.length; s++) {
                var slId = sublistIds[s];
                var sl = _fieldData.sublists[slId];
                if (!sl.fields) continue;

                for (var sf = 0; sf < sl.fields.length; sf++) {
                    var field = sl.fields[sf];
                    field._source = 'sublist';
                    field._sublistId = slId;
                    field._lineCount = sl.lineCount;

                    if (_searchTerm && !_matchesSearch(field)) continue;

                    results.push(field);
                }
            }
        }

        return results;
    }

    /**
     * Checks whether a field matches the current search term.
     * @param {Object} field
     * @returns {boolean}
     */
    function _matchesSearch(field) {
        if (!_searchTerm) return true;
        var id = (field.id || '').toLowerCase();
        var label = (field.label || '').toLowerCase();
        return id.indexOf(_searchTerm) >= 0 || label.indexOf(_searchTerm) >= 0;
    }

    /**
     * Creates a field card element.
     * @param {Object} field - Field metadata object
     * @returns {HTMLElement}
     */
    function _createFieldCard(field) {
        var isExpanded = _expandedFieldId === _getFieldUniqueKey(field);

        var cardClasses = 'tacta-fe-card';
        if (field.isMandatory) cardClasses += ' tacta-fe-card--mandatory';
        if (field.isHidden) cardClasses += ' tacta-fe-card--hidden';
        if (field.isDisabled) cardClasses += ' tacta-fe-card--disabled';
        if (isExpanded) cardClasses += ' tacta-fe-card--expanded';

        var card = TactaDOM.createElement('div', {
            className: cardClasses,
            dataset: { fieldId: field.id || '' }
        });

        // Header row: field ID + type badge
        var fieldIdEl = TactaDOM.createElement('span', {
            className: 'tacta-fe-card-id',
            textContent: field.id || '(unknown)',
            title: 'Click to copy field ID',
            events: {
                click: function (e) {
                    e.stopPropagation();
                    TactaDOM.copyToClipboard(field.id || '').then(function (ok) {
                        if (ok) TactaDOM.showToast('Copied: ' + field.id, 'success', 2000);
                    });
                }
            }
        });

        var typeBadge = TactaDOM.createElement('span', {
            className: 'tacta-fe-card-type',
            textContent: field.type || 'unknown'
        });

        var headerRow = TactaDOM.createElement('div', {
            className: 'tacta-fe-card-header'
        }, [fieldIdEl, typeBadge]);

        card.appendChild(headerRow);

        // Label row
        if (field.label) {
            card.appendChild(TactaDOM.createElement('div', {
                className: 'tacta-fe-card-label',
                textContent: field.label
            }));
        }

        // Value row
        var displayValue = _formatDisplayValue(field.value, field.text);
        if (displayValue) {
            card.appendChild(TactaDOM.createElement('div', {
                className: 'tacta-fe-card-value',
                textContent: displayValue
            }));
        }

        // Status indicators
        var indicators = [];
        if (field.isMandatory) indicators.push('Mandatory');
        if (field.isDisabled) indicators.push('Disabled');
        if (field.isHidden) indicators.push('Hidden');
        if (field._source === 'sublist') indicators.push('Sublist: ' + field._sublistId);

        if (indicators.length > 0) {
            var indicatorRow = TactaDOM.createElement('div', {
                className: 'tacta-fe-card-indicators'
            });
            for (var ind = 0; ind < indicators.length; ind++) {
                var badgeClass = 'tacta-fe-indicator';
                if (indicators[ind] === 'Mandatory') badgeClass += ' tacta-fe-indicator--mandatory';
                if (indicators[ind] === 'Hidden') badgeClass += ' tacta-fe-indicator--hidden';
                if (indicators[ind] === 'Disabled') badgeClass += ' tacta-fe-indicator--disabled';
                if (indicators[ind].indexOf('Sublist') === 0) badgeClass += ' tacta-fe-indicator--sublist';

                indicatorRow.appendChild(TactaDOM.createElement('span', {
                    className: badgeClass,
                    textContent: indicators[ind]
                }));
            }
            card.appendChild(indicatorRow);
        }

        // Expanded details
        if (isExpanded) {
            card.appendChild(_createExpandedDetails(field));
        }

        // Click to expand/collapse — but not when interacting with override controls
        card.addEventListener('click', function (e) {
            if (e.target.closest('.tacta-fe-override-section, .tacta-fe-options-table')) return;
            var key = _getFieldUniqueKey(field);
            if (_expandedFieldId === key) {
                _expandedFieldId = null;
            } else {
                _expandedFieldId = key;
            }
            _renderFieldList();
        });

        return card;
    }

    /**
     * Generates a unique key for a field (body or sublist).
     * @param {Object} field
     * @returns {string}
     */
    function _getFieldUniqueKey(field) {
        if (field._source === 'sublist' && field._sublistId) {
            return field._sublistId + '.' + field.id;
        }
        return 'body.' + field.id;
    }

    /**
     * Formats a display value, preferring text over raw value.
     * @param {*} value
     * @param {*} text
     * @returns {string}
     */
    function _formatDisplayValue(value, text) {
        var display = '';
        if (text && text !== value) {
            display = String(text);
            if (value !== null && value !== undefined && value !== '') {
                display += ' (' + String(value) + ')';
            }
        } else if (value !== null && value !== undefined && value !== '') {
            display = String(value);
        }

        if (display.length > VALUE_TRUNCATE_LENGTH) {
            display = display.substring(0, VALUE_TRUNCATE_LENGTH) + '...';
        }

        return display;
    }

    /**
     * Creates the expanded details section for a field card.
     * @param {Object} field
     * @returns {HTMLElement}
     */
    function _createExpandedDetails(field) {
        var details = TactaDOM.createElement('div', {
            className: 'tacta-fe-card-details'
        });

        var properties = [
            { key: 'Field ID', value: field.id },
            { key: 'Label', value: field.label },
            { key: 'Type', value: field.type },
            { key: 'Raw Value', value: field.value },
            { key: 'Display Text', value: field.text },
            { key: 'Hidden', value: field.isHidden ? 'Yes' : 'No' },
            { key: 'Source', value: field._source === 'sublist' ? 'Sublist (' + field._sublistId + ')' : 'Body Field' }
        ];

        if (field._lineCount !== undefined) {
            properties.push({ key: 'Line Count', value: String(field._lineCount) });
        }

        for (var p = 0; p < properties.length; p++) {
            var prop = properties[p];
            var val = prop.value;
            if (val === null || val === undefined) val = '(empty)';

            var row = TactaDOM.createElement('div', {
                className: 'tacta-fe-detail-row'
            }, [
                TactaDOM.createElement('span', {
                    className: 'tacta-fe-detail-key',
                    textContent: prop.key
                }),
                TactaDOM.createElement('span', {
                    className: 'tacta-fe-detail-value',
                    textContent: String(val)
                })
            ]);

            details.appendChild(row);
        }

        // Toggleable Mandatory / Disabled rows
        details.appendChild(_createToggleRow('Mandatory', field.isMandatory, function (e) {
            e.stopPropagation();
            var newVal = !field.isMandatory;
            _sendToBackground({ action: 'setFieldAttribute', fieldId: field.id, attr: 'mandatory', value: newVal })
                .then(function () {
                    field.isMandatory = newVal;
                    _renderFieldList();
                    TactaDOM.showToast(field.id + ' mandatory: ' + newVal, 'success', 2000);
                })
                .catch(function (err) { TactaDOM.showToast('Error: ' + err.message, 'error', 3000); });
        }));

        details.appendChild(_createToggleRow('Disabled', field.isDisabled, function (e) {
            e.stopPropagation();
            var newVal = !field.isDisabled;
            _sendToBackground({ action: 'setFieldAttribute', fieldId: field.id, attr: 'disabled', value: newVal })
                .then(function () {
                    field.isDisabled = newVal;
                    _renderFieldList();
                    TactaDOM.showToast(field.id + ' disabled: ' + newVal, 'success', 2000);
                })
                .catch(function (err) { TactaDOM.showToast('Error: ' + err.message, 'error', 3000); });
        }));

        // ── Override value section ──────────────────────────────────
        var overrideSection = TactaDOM.createElement('div', {
            className: 'tacta-fe-override-section'
        });

        var overrideLabel = TactaDOM.createElement('div', {
            className: 'tacta-fe-detail-key',
            textContent: 'Override Value'
        });
        overrideSection.appendChild(overrideLabel);

        var isSelectType = /select|list\/record|multi-select/i.test(field.type || '');

        // For select/list fields, show a dropdown; for others, a text input
        var overrideInput;
        var optionsContainer;

        if (isSelectType) {
            // Select dropdown — populated async
            overrideInput = TactaDOM.createElement('select', {
                className: 'tacta-fe-override-select'
            });
            overrideInput.appendChild(TactaDOM.createElement('option', {
                value: '',
                textContent: 'Loading options...'
            }));

            // Options list below dropdown
            optionsContainer = TactaDOM.createElement('div', {
                className: 'tacta-fe-options-list'
            });
            optionsContainer.innerHTML = '<div class="tacta-fe-options-loading"><div class="tacta-spinner-sm"></div> Loading select options...</div>';

            // Fetch select options
            _requestSelectOptions(field.id, field._sublistId, field._source === 'sublist' ? 0 : undefined)
                .then(function (result) {
                    overrideInput.innerHTML = '';
                    overrideInput.appendChild(TactaDOM.createElement('option', {
                        value: '',
                        textContent: '-- Select --'
                    }));

                    optionsContainer.innerHTML = '';

                    if (result && result.options && result.options.length > 0) {
                        // Populate dropdown
                        for (var o = 0; o < result.options.length; o++) {
                            var opt = result.options[o];
                            var optEl = TactaDOM.createElement('option', {
                                value: opt.value,
                                textContent: opt.text + ' (' + opt.value + ')'
                            });
                            if (String(opt.value) === String(field.value)) {
                                optEl.selected = true;
                            }
                            overrideInput.appendChild(optEl);
                        }

                        // Build options reference table
                        var optHeader = TactaDOM.createElement('div', {
                            className: 'tacta-fe-detail-key',
                            style: { marginTop: '6px' },
                            textContent: 'Available Options (' + result.options.length + ')'
                        });
                        optionsContainer.appendChild(optHeader);

                        var optTable = TactaDOM.createElement('div', {
                            className: 'tacta-fe-options-table'
                        });

                        for (var oi = 0; oi < result.options.length; oi++) {
                            var optRow = result.options[oi];
                            var isCurrent = String(optRow.value) === String(field.value);
                            var rowEl = TactaDOM.createElement('div', {
                                className: 'tacta-fe-options-row' + (isCurrent ? ' tacta-fe-options-row--current' : '')
                            }, [
                                TactaDOM.createElement('span', {
                                    className: 'tacta-fe-options-value',
                                    textContent: optRow.value
                                }),
                                TactaDOM.createElement('span', {
                                    className: 'tacta-fe-options-text',
                                    textContent: optRow.text
                                })
                            ]);
                            optTable.appendChild(rowEl);
                        }
                        optionsContainer.appendChild(optTable);
                    } else {
                        optionsContainer.innerHTML = '<div class="tacta-fe-options-loading" style="color:var(--tacta-text-muted)">No select options available.</div>';
                    }
                })
                .catch(function () {
                    overrideInput.innerHTML = '<option value="">Failed to load options</option>';
                    optionsContainer.innerHTML = '';
                });
        } else {
            // Text input for non-select fields
            overrideInput = TactaDOM.createElement('input', {
                type: 'text',
                className: 'tacta-fe-override-input',
                value: (field.value !== null && field.value !== undefined) ? String(field.value) : '',
                placeholder: 'Enter new value...',
                spellcheck: false
            });
        }

        var setBtn = TactaDOM.createElement('button', {
            className: 'tacta-btn tacta-btn-sm tacta-fe-override-btn',
            textContent: 'Set',
            events: {
                click: function (e) {
                    e.stopPropagation();
                    var newVal = overrideInput.value;
                    _setFieldValue(field, newVal);
                }
            }
        });

        var overrideRow = TactaDOM.createElement('div', {
            className: 'tacta-fe-override-row'
        }, [overrideInput, setBtn]);
        overrideSection.appendChild(overrideRow);

        if (isSelectType && optionsContainer) {
            overrideSection.appendChild(optionsContainer);
        }

        details.appendChild(overrideSection);

        // ── Custom field metadata section ──────────────────────────────
        var isCustomField = /^(custbody|custentity|custitem|custevent|custcol|custrecord)/.test(field.id || '');
        if (isCustomField) {
            var customSection = TactaDOM.createElement('div', {
                className: 'tacta-fe-custom-section'
            });
            var customLoading = TactaDOM.createElement('div', {
                className: 'tacta-fe-custom-loading',
                innerHTML: '<div class="tacta-spinner tacta-spinner--sm"></div> Loading field definition...'
            });
            customSection.appendChild(customLoading);
            details.appendChild(customSection);

            // Fetch custom field metadata async
            _sendToBackground({ action: 'getCustomFieldMeta', fieldId: field.id })
                .then(function (meta) {
                    customSection.innerHTML = '';
                    if (!meta || !meta.isCustom) return;

                    // Field definition link
                    if (meta.definitionUrl) {
                        var defRow = TactaDOM.createElement('div', { className: 'tacta-fe-detail-row' }, [
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Definition' }),
                            TactaDOM.createElement('a', {
                                className: 'tacta-fe-link',
                                textContent: meta.definitionLabel || 'Open Field Definition',
                                href: meta.definitionUrl,
                                target: '_blank'
                            })
                        ]);
                        customSection.appendChild(defRow);
                    }

                    // Custom field type
                    if (meta.customFieldType) {
                        customSection.appendChild(TactaDOM.createElement('div', { className: 'tacta-fe-detail-row' }, [
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Custom Type' }),
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-value', textContent: meta.customFieldType })
                        ]));
                    }

                    // Formula
                    if (meta.isFormula && meta.formula) {
                        customSection.appendChild(TactaDOM.createElement('div', { className: 'tacta-fe-detail-row tacta-fe-detail-row--formula' }, [
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Formula' }),
                            TactaDOM.createElement('code', { className: 'tacta-fe-formula-value', textContent: meta.formula })
                        ]));
                    }

                    // Source list link
                    if (meta.sourceListUrl) {
                        customSection.appendChild(TactaDOM.createElement('div', { className: 'tacta-fe-detail-row' }, [
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Source List' }),
                            TactaDOM.createElement('a', {
                                className: 'tacta-fe-link',
                                textContent: 'Open Source List',
                                href: meta.sourceListUrl,
                                target: '_blank'
                            })
                        ]));
                    }

                    // Source record type link
                    if (meta.sourceRecordUrl) {
                        customSection.appendChild(TactaDOM.createElement('div', { className: 'tacta-fe-detail-row' }, [
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Source Record' }),
                            TactaDOM.createElement('a', {
                                className: 'tacta-fe-link',
                                textContent: 'Open Record List',
                                href: meta.sourceRecordUrl,
                                target: '_blank'
                            })
                        ]));
                    }

                    // Help text
                    if (meta.helpText) {
                        customSection.appendChild(TactaDOM.createElement('div', { className: 'tacta-fe-detail-row tacta-fe-detail-row--help' }, [
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Help' }),
                            TactaDOM.createElement('span', { className: 'tacta-fe-detail-value tacta-fe-help-text', textContent: meta.helpText })
                        ]));
                    }
                })
                .catch(function () {
                    customSection.innerHTML = '';
                });
        }

        // ── Source record link for select/list fields ──────────────────
        var isSelectType2 = /select|list\/record|multi-select/i.test(field.type || '');
        if (isSelectType2 && field.value) {
            var sourceSection = TactaDOM.createElement('div', {
                className: 'tacta-fe-source-section'
            });
            details.appendChild(sourceSection);

            _sendToBackground({ action: 'getFieldSourceLink', fieldId: field.id })
                .then(function (linkData) {
                    if (!linkData || !linkData.sourceUrl) return;
                    var linkRow = TactaDOM.createElement('div', { className: 'tacta-fe-detail-row' }, [
                        TactaDOM.createElement('span', { className: 'tacta-fe-detail-key', textContent: 'Source Record' }),
                        TactaDOM.createElement('a', {
                            className: 'tacta-fe-link',
                            textContent: 'Open Source',
                            href: linkData.sourceUrl + (linkData.sourceUrl.indexOf('?') >= 0 ? '&' : '?') + 'id=' + field.value,
                            target: '_blank'
                        })
                    ]);
                    sourceSection.appendChild(linkRow);
                })
                .catch(function () {
                    // Silently fail — source link is optional
                });
        }

        return details;
    }

    /**
     * Creates a detail row with a clickable toggle link.
     */
    function _createToggleRow(label, currentValue, onClick) {
        var valueEl = TactaDOM.createElement('span', {
            className: 'tacta-fe-detail-value tacta-fe-toggle-link',
            textContent: currentValue ? 'Yes' : 'No',
            title: 'Click to toggle',
            events: { click: onClick }
        });
        if (currentValue) valueEl.classList.add('tacta-fe-toggle--on');

        return TactaDOM.createElement('div', {
            className: 'tacta-fe-detail-row'
        }, [
            TactaDOM.createElement('span', {
                className: 'tacta-fe-detail-key',
                textContent: label
            }),
            valueEl
        ]);
    }

    /**
     * Requests select options for a field via the service worker.
     */
    function _requestSelectOptions(fieldId, sublistId, line) {
        return _sendToBackground({
            action: 'getSelectOptions',
            fieldId: fieldId,
            sublistId: sublistId || null,
            line: line !== undefined ? line : null
        });
    }

    /**
     * Sets a field value via the service worker and refreshes the card.
     */
    function _setFieldValue(field, newValue) {
        _sendToBackground({
            action: 'setFieldValue',
            fieldId: field.id,
            value: newValue,
            sublistId: field._sublistId || null,
            line: (field._source === 'sublist') ? 0 : null
        })
            .then(function (result) {
                if (result && result.success) {
                    // Update field data in our cache
                    field.value = result.newValue;
                    field.text = result.newText;
                    TactaDOM.showToast('Set ' + field.id + ' = ' + (result.newText || result.newValue), 'success', 3000);
                    _renderFieldList();
                } else if (result && result.error) {
                    TactaDOM.showToast('Error: ' + result.error, 'error', 4000);
                }
            })
            .catch(function (err) {
                TactaDOM.showToast('Failed: ' + (err.message || err), 'error', 4000);
            });
    }

    // ────────────────────────────────────────────────────────────────
    // Actions
    // ────────────────────────────────────────────────────────────────

    /**
     * Copies all field IDs to clipboard as a newline-separated list.
     */
    function _copyAllFieldIds() {
        if (!_fieldData) return;

        var ids = [];

        if (_fieldData.bodyFields) {
            for (var b = 0; b < _fieldData.bodyFields.length; b++) {
                if (_fieldData.bodyFields[b].id) {
                    ids.push(_fieldData.bodyFields[b].id);
                }
            }
        }

        if (_fieldData.sublists) {
            var sublistIds = Object.keys(_fieldData.sublists);
            for (var s = 0; s < sublistIds.length; s++) {
                var sl = _fieldData.sublists[sublistIds[s]];
                if (sl.fields) {
                    for (var f = 0; f < sl.fields.length; f++) {
                        if (sl.fields[f].id) {
                            ids.push(sublistIds[s] + '.' + sl.fields[f].id);
                        }
                    }
                }
            }
        }

        TactaDOM.copyToClipboard(ids.join('\n')).then(function (ok) {
            if (ok) {
                TactaDOM.showToast(ids.length + ' field IDs copied', 'success', 2500);
            } else {
                TactaDOM.showToast('Failed to copy field IDs', 'error', 3000);
            }
        });
    }

    /**
     * Exports all field data as a downloadable JSON file.
     */
    function _exportJSON() {
        if (!_fieldData) return;

        var json = JSON.stringify(_fieldData, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);

        var pageType = '';
        try {
            pageType = (window.__tactaPageInfo && window.__tactaPageInfo.recordType)
                ? window.__tactaPageInfo.recordType
                : 'record';
        } catch (_) {
            pageType = 'record';
        }

        var a = document.createElement('a');
        a.href = url;
        a.download = 'field-explorer-' + pageType + '-' + Date.now() + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        TactaDOM.showToast('Field data exported as JSON', 'success', 2500);
    }

    // ────────────────────────────────────────────────────────────────
    // Activation listener
    // ────────────────────────────────────────────────────────────────

    /**
     * Listen for feature activation events dispatched by the router.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'field-explorer') {
            activate();
        }
    });

    /**
     * Also listen for direct chrome.runtime messages from the popup.
     */
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function (message) {
            if (message.action === 'activateFeature' && message.featureId === 'field-explorer') {
                activate();
            }
        });
    }

})();
