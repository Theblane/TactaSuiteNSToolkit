/**
 * field-finder.js
 * Tactacam NS Toolkit - Field Finder (PAGE WORLD script)
 *
 * Enhances NetSuite's field dropdown selectors on Saved Search pages
 * with a filter textbox, field ID / type columns, and category filter
 * buttons (Standard, Custom, Related, Formula).
 *
 * Runs in the PAGE world (MAIN) so it can access NetSuite's internal
 * `dropdowns` and `machines` objects. Injected via <script> tag from
 * the content script or via chrome.scripting.executeScript.
 *
 * Modeled after NetSuite Field Finder 0.35 by npehdolgmmdncpmkoploaeljhkngjbne.
 */
(function () {
    'use strict';

    if (window.__tactaFieldFinderLoaded) return;
    window.__tactaFieldFinderLoaded = true;

    // Dropdown names that contain field lists in saved searches
    var FIELD_DROPDOWN_NAMES = [
        'rffield', 'filterfilter', 'sort1', 'sort2', 'sort3',
        'field', 'dffield', 'fffilter'
    ];

    // ────────────────────────────────────────────────────────────────
    // Field type classification
    // ────────────────────────────────────────────────────────────────

    function classifyField(fieldId, fieldName) {
        var id = (fieldId || '').toLowerCase();
        if (id.match(/^(custbody)/)) return 'Custom Body';
        if (id.match(/^(custcol)/)) return 'Custom Column';
        if (id.match(/^(custrecord|custentity|custitem)/)) return 'Custom';
        if (id.match(/_formula/)) return 'Formula';
        if ((fieldName || '').endsWith('Fields...')) return 'Related';
        return 'Standard';
    }

    function stripCustomLabel(text) {
        return (text || '').replace(/\((Custom Body|Custom Column|Custom)\)/i, '').trim();
    }

    function prettyFieldId(fieldId, searchType) {
        var strip = ['stdentity', 'stdbody', 'custom_', 'transaction_'];
        if (searchType) strip.push(searchType.toLowerCase() + '_');
        var pattern = new RegExp('(' + strip.join('|') + ')', 'g');
        return (fieldId || '').toLowerCase().replace(pattern, '');
    }

    // ────────────────────────────────────────────────────────────────
    // Enhance a single NS dropdown
    // ────────────────────────────────────────────────────────────────

    function enhanceDropdown(dd) {
        if (!dd || !dd.div || dd._tactaFieldFinderAttached) return;
        dd._tactaFieldFinderAttached = true;

        var searchType = '';
        try {
            var stEl = document.getElementById('searchtype');
            searchType = (stEl && stEl.value) || (typeof NS !== 'undefined' && NS.Core ? NS.Core.getURLParameter('searchtype') : '') || '';
        } catch (_) {}

        // Build the filter UI container
        var container = document.createElement('div');
        container.className = 'tacta-ff-container';

        // Search input
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'tacta-ff-input';
        input.placeholder = 'Filter by Name or ID...';
        input.setAttribute('autocomplete', 'off');
        input.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
        input.addEventListener('mouseup', function (e) { e.stopPropagation(); this.focus(); });
        input.addEventListener('dblclick', function (e) { e.preventDefault(); this.select(); });

        // Filter buttons
        var btnGroup = document.createElement('div');
        btnGroup.className = 'tacta-ff-btn-group';

        var categories = ['Standard', 'Custom', 'Related', 'Formula'];
        var activeFilters = {};
        var buttons = {};

        categories.forEach(function (cat) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tacta-ff-btn';
            btn.textContent = cat;
            btn.setAttribute('onpointerdown', 'event.preventDefault();');
            activeFilters[cat] = false;
            buttons[cat] = btn;

            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                activeFilters[cat] = !activeFilters[cat];
                btn.classList.toggle('tacta-ff-btn-active', activeFilters[cat]);
                filterOptions();
                input.focus();
            });

            btnGroup.appendChild(btn);
        });

        // Status bar
        var status = document.createElement('div');
        status.className = 'tacta-ff-status';

        container.appendChild(input);
        container.appendChild(btnGroup);
        container.appendChild(status);

        // Insert at top of dropdown div
        dd.div.insertBefore(container, dd.div.firstChild);

        // Widen the dropdown and make it a positioning context for ID overlays
        dd.div.style.width = '800px';
        dd.div.style.marginTop = '32px';
        dd.div.style.marginBottom = '25px';
        dd.div.style.position = 'relative';

        // Enhance each option with field ID / type columns
        var options = [];
        var hasCustom = false, hasRelated = false, hasFormula = false;

        for (var i = 0; i < dd.divArray.length; i++) {
            var optEl = dd.divArray[i];
            var fieldId = dd.valueArray[i] || '';
            var fieldName = stripCustomLabel(dd.textArray[i] || '');
            var fieldType = classifyField(fieldId, dd.textArray[i]);
            var prettyId = prettyFieldId(fieldId, searchType);

            if (fieldType === 'Custom Body' || fieldType === 'Custom Column' || fieldType === 'Custom') hasCustom = true;
            if (fieldType === 'Related') hasRelated = true;
            if (fieldType === 'Formula') hasFormula = true;

            // Clear original text, rebuild with columns
            while (optEl.firstChild) optEl.removeChild(optEl.firstChild);

            var nameSpan = document.createElement('span');
            nameSpan.className = 'tacta-ff-col tacta-ff-col-name';
            nameSpan.textContent = fieldName;

            var typeSpan = document.createElement('span');
            typeSpan.className = 'tacta-ff-col tacta-ff-col-type';
            typeSpan.textContent = fieldType;

            // Name and type stay inside the option (clicking selects the field)
            optEl.appendChild(nameSpan);
            optEl.appendChild(typeSpan);

            // ID span is appended to dd.div (NOT inside optEl) so clicking it
            // never triggers NS dropdown's selection handler. Absolutely positioned
            // to visually align with the option row.
            var idSpan = document.createElement('span');
            idSpan.className = 'tacta-ff-col tacta-ff-col-id tacta-ff-id-overlay';
            idSpan.textContent = (fieldType === 'Related') ? '' : prettyId;
            idSpan.title = 'Click to copy: ' + fieldId;

            (function (rawId, el, optionEl) {
                el.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();

                    var textToCopy = rawId;
                    try {
                        navigator.clipboard.writeText(textToCopy);
                    } catch (_) {
                        var ta = document.createElement('textarea');
                        ta.value = textToCopy;
                        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                    }

                    el.classList.add('tacta-ff-copied');
                    el.setAttribute('title', 'Copied: ' + textToCopy);
                    setTimeout(function () {
                        el.classList.remove('tacta-ff-copied');
                        el.setAttribute('title', 'Click to copy: ' + rawId);
                    }, 1200);
                });

                // Track this overlay with its option for show/hide during filtering
                el._tactaOptionEl = optionEl;
            })(fieldId, idSpan, optEl);

            dd.div.appendChild(idSpan);

            options.push({
                el: optEl,
                idOverlay: idSpan,
                fieldId: fieldId,
                fieldName: fieldName,
                prettyId: prettyId,
                fieldType: fieldType,
                hidden: false
            });
        }

        // Hide unused filter buttons
        if (!hasCustom) buttons['Custom'].style.display = 'none';
        if (!hasRelated) buttons['Related'].style.display = 'none';
        if (!hasFormula) buttons['Formula'].style.display = 'none';

        // Position all ID overlays to align with their option rows
        function positionIdOverlays() {
            var ddRect = dd.div.getBoundingClientRect();
            for (var j = 0; j < options.length; j++) {
                var opt = options[j];
                if (!opt.idOverlay || opt.hidden) continue;
                var optRect = opt.el.getBoundingClientRect();
                opt.idOverlay.style.top = (optRect.top - ddRect.top) + 'px';
            }
        }

        // Filter logic
        function filterOptions() {
            var term = (input.value || '').toLowerCase();
            var anyFilterActive = Object.keys(activeFilters).some(function (k) { return activeFilters[k]; });
            var shown = 0;
            var total = options.length;

            for (var i = 0; i < options.length; i++) {
                var opt = options[i];
                var visible = true;

                // Type filter
                if (anyFilterActive) {
                    var typeMatch = false;
                    if (activeFilters['Standard'] && opt.fieldType === 'Standard') typeMatch = true;
                    if (activeFilters['Custom'] && (opt.fieldType === 'Custom' || opt.fieldType === 'Custom Body' || opt.fieldType === 'Custom Column')) typeMatch = true;
                    if (activeFilters['Related'] && opt.fieldType === 'Related') typeMatch = true;
                    if (activeFilters['Formula'] && opt.fieldType === 'Formula') typeMatch = true;
                    if (!typeMatch) visible = false;
                }

                // Text filter
                if (visible && term) {
                    var nameMatch = opt.fieldName.toLowerCase().indexOf(term) >= 0;
                    var idMatch = opt.prettyId.toLowerCase().indexOf(term) >= 0;
                    if (!nameMatch && !idMatch) visible = false;
                }

                opt.el.style.display = visible ? '' : 'none';
                if (opt.idOverlay) opt.idOverlay.style.display = visible ? '' : 'none';
                opt.hidden = !visible;
                if (visible) shown++;

                // Highlight matches in name (inside optEl)
                if (visible && term) {
                    var regex = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
                    opt.el.querySelector('.tacta-ff-col-name').innerHTML = opt.fieldName.replace(regex, '<mark class="tacta-ff-highlight">$1</mark>');
                    // Highlight in ID overlay
                    if (opt.idOverlay && opt.fieldType !== 'Related') {
                        opt.idOverlay.innerHTML = opt.prettyId.replace(regex, '<mark class="tacta-ff-highlight">$1</mark>');
                    }
                } else {
                    opt.el.querySelector('.tacta-ff-col-name').textContent = opt.fieldName;
                    if (opt.idOverlay && opt.fieldType !== 'Related') {
                        opt.idOverlay.textContent = opt.prettyId;
                    }
                }
            }

            status.textContent = 'Showing ' + shown + ' of ' + total + ' fields';

            // Reposition overlays after visibility changes
            requestAnimationFrame(positionIdOverlays);
        }

        // Key handlers — must fully capture all keyboard events to prevent
        // NS dropdown's native typeahead from jumping the field list.
        // stopPropagation + stopImmediatePropagation + preventDefault on keydown
        // ensures NS never sees the keystrokes while the search input is focused.
        var _ffSearchFocused = false;

        input.addEventListener('focus', function () { _ffSearchFocused = true; });
        input.addEventListener('blur', function () { _ffSearchFocused = false; });

        // Capture on the dropdown container to intercept before NS handlers
        dd.div.addEventListener('keydown', function (e) {
            if (!_ffSearchFocused) return;
            // Allow Enter/Tab to select, Arrow keys to navigate — block everything else
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                e.stopImmediatePropagation();
                // Find first visible option and select it
                for (var i = 0; i < options.length; i++) {
                    if (!options[i].hidden) {
                        dd.setAndClose(i);
                        break;
                    }
                }
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopImmediatePropagation();
                // Navigate through visible options only
                var current = dd.indexOnDeck || 0;
                var dir = e.key === 'ArrowDown' ? 1 : -1;
                var next = current + dir;
                while (options[next]) {
                    if (!options[next].hidden) {
                        dd.respondToArrow(next - current);
                        break;
                    }
                    next += dir;
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                input.value = '';
                filterOptions();
                input.blur();
            } else {
                // Block NS from seeing regular keystrokes (typing, backspace, etc.)
                e.stopImmediatePropagation();
            }
        }, true); // useCapture = true to fire before NS handlers

        input.addEventListener('keydown', function (e) { e.stopPropagation(); });
        input.addEventListener('keypress', function (e) { e.stopPropagation(); e.stopImmediatePropagation(); });
        input.addEventListener('keyup', function (e) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
                filterOptions();
            }
        });

        // Auto-focus search on dropdown open + position overlays
        var origOpen = dd.open ? dd.open.bind(dd) : null;
        if (origOpen) {
            dd.open = function () {
                origOpen();
                input.value = '';
                filterOptions();
                setTimeout(function () {
                    input.focus();
                    positionIdOverlays();
                }, 10);
            };
        }

        // Reposition overlays on scroll within the dropdown
        dd.div.addEventListener('scroll', function () {
            requestAnimationFrame(positionIdOverlays);
        });

        // Also focus on click of the dropdown input
        if (dd.inpt) {
            dd.inpt.addEventListener('click', function () {
                if (!dd.div._tactaFFContainerPresent) {
                    dd.div.insertBefore(container, dd.div.firstChild);
                    dd.div._tactaFFContainerPresent = true;
                }
                setTimeout(function () {
                    input.focus();
                    positionIdOverlays();
                }, 10);
            });
        }
        dd.div._tactaFFContainerPresent = true;

        // Initial count
        filterOptions();
    }

    // ────────────────────────────────────────────────────────────────
    // Initialize
    // ────────────────────────────────────────────────────────────────

    function init() {
        if (typeof dropdowns === 'undefined') return;

        for (var name in dropdowns) {
            if (FIELD_DROPDOWN_NAMES.indexOf(dropdowns[name].name) >= 0) {
                try {
                    if (!dropdowns[name].div) dropdowns[name].buildDiv();
                    enhanceDropdown(dropdowns[name]);
                } catch (e) {
                    console.warn('[Tacta FieldFinder] Failed to enhance dropdown "' + name + '":', e);
                }
            }
        }
    }

    // Wait for NS form to be ready
    if (typeof NS !== 'undefined' && NS.form && NS.form.isInited && NS.event) {
        if (NS.form.isInited()) {
            init();
        } else {
            NS.event.once(NS.event.type.FORM_INITED, init);
        }
    } else {
        // Fallback: wait for DOM
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 500); });
        } else {
            setTimeout(init, 500);
        }
    }
})();
