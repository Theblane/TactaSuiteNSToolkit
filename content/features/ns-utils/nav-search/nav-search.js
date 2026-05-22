/**
 * nav-search.js
 * TactaSuite NS Toolkit — Navigation Search (Content Script)
 *
 * @author Blane Maher
 *
 * Adds a keyboard-driven command-palette-style search overlay for quick
 * navigation across NetSuite pages. Triggered by Ctrl+Shift+K (or
 * Cmd+Shift+K on Mac).
 *
 * Search sources:
 *   1. Built-in page list (nav-search-pages.js) — ~75 common NS pages.
 *   2. Recent pages — last 20 visited pages stored in chrome.storage.local.
 *
 * Features:
 *   - Fuzzy matching against title, URL path, and keywords.
 *   - Keyboard navigation (Up/Down arrows, Enter, Escape).
 *   - Category badges on each result.
 *   - Tracks page visits for the "Recent" section.
 *
 * Auto-activates on all NetSuite pages.
 *
 * @fileoverview Content script for the Navigation Search feature.
 */
(function () {
    'use strict';

    // Guard against double-init.
    if (window.__tactaNavSearchLoaded) return;
    window.__tactaNavSearchLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} Storage key for recent pages */
    var RECENT_PAGES_KEY = 'tacta_nav_search_recent';

    /** @type {number} Maximum number of recent pages to store */
    var MAX_RECENT = 20;

    /** @type {number} Maximum results to display at once */
    var MAX_RESULTS = 10;

    /** @type {boolean} True if the user is on macOS */
    var IS_MAC = navigator.platform ? /Mac/i.test(navigator.platform) :
                 navigator.userAgent ? /Mac/i.test(navigator.userAgent) : false;

    // ────────────────────────────────────────────────────────────────
    // State
    // ────────────────────────────────────────────────────────────────

    /** @type {HTMLElement|null} Backdrop overlay element */
    var _backdrop = null;

    /** @type {HTMLInputElement|null} Search input element */
    var _input = null;

    /** @type {HTMLElement|null} Results list container */
    var _resultsList = null;

    /** @type {boolean} Whether the overlay is currently open */
    var _isOpen = false;

    /** @type {number} Index of the currently selected result */
    var _selectedIndex = 0;

    /** @type {Array<Object>} Current filtered results */
    var _currentResults = [];

    /** @type {Array<Object>} Recent page entries from storage */
    var _recentPages = [];

    /** @type {Array<Object>} Built-in page list */
    var _builtinPages = [];

    // ────────────────────────────────────────────────────────────────
    // Page Data Loading
    // ────────────────────────────────────────────────────────────────

    /**
     * Loads the built-in page list from the data file. Uses fetch() to read
     * the file as text in the isolated content script world only as a fallback.
     * The registry normally injects nav-search-pages.js before this script.
     */
    function loadBuiltinPages() {
        // If already loaded from a prior call, skip.
        if (_builtinPages.length > 0) return;

        if (Array.isArray(window.__tactaNavSearchPages)) {
            _builtinPages = window.__tactaNavSearchPages.slice();
            return;
        }

        var url = chrome.runtime.getURL('content/features/ns-utils/nav-search/nav-search-pages.js');
        fetch(url)
            .then(function (response) { return response.text(); })
            .then(function (text) {
                _builtinPages = parseBuiltinPagesSource(text);
            })
            .catch(function (err) {
                console.warn('[Tacta Toolkit] Failed to load nav-search pages data:', err);
            });
    }

    function parseBuiltinPagesSource(text) {
        var pages = [];
        var entryRegex = /\{\s*title:\s*'([^']*)',\s*path:\s*'([^']*)',\s*category:\s*'([^']*)',\s*keywords:\s*\[([^\]]*)\]\s*\}/g;
        var match;
        while ((match = entryRegex.exec(text))) {
            pages.push({
                title: match[1],
                path: match[2],
                category: match[3],
                keywords: parseKeywordList(match[4])
            });
        }
        return pages;
    }

    function parseKeywordList(raw) {
        var keywords = [];
        raw.replace(/'([^']*)'/g, function (_m, value) {
            keywords.push(value);
        });
        return keywords;
    }

    /**
     * Loads recent pages from chrome.storage.local.
     * @returns {Promise<void>}
     */
    function loadRecentPages() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(RECENT_PAGES_KEY, function (result) {
                    _recentPages = result[RECENT_PAGES_KEY] || [];
                    resolve();
                });
            } catch (_) {
                _recentPages = [];
                resolve();
            }
        });
    }

    /**
     * Saves the recent pages list to chrome.storage.local.
     */
    function saveRecentPages() {
        try {
            var items = {};
            items[RECENT_PAGES_KEY] = _recentPages;
            chrome.storage.local.set(items);
        } catch (_) { /* storage unavailable */ }
    }

    /**
     * Records the current page visit in the recent pages list.
     * Deduplicates by path and caps the list at MAX_RECENT entries.
     */
    function trackPageVisit() {
        var title = document.title || '';
        var path = window.location.pathname + window.location.search;

        // Skip generic or unhelpful pages.
        if (!title || title === 'NetSuite' || path === '/app/center/card.nl') return;

        // Clean up the title (remove " - NetSuite" suffix).
        title = title.replace(/\s*[-|]\s*NetSuite\s*$/i, '').trim();
        if (!title) return;

        // Remove existing entry for this path (to move it to front).
        _recentPages = _recentPages.filter(function (p) {
            return p.path !== path;
        });

        // Add at the front.
        _recentPages.unshift({
            title: title,
            path: path,
            category: 'Recent',
            keywords: [],
            visitedAt: Date.now()
        });

        // Cap size.
        if (_recentPages.length > MAX_RECENT) {
            _recentPages = _recentPages.slice(0, MAX_RECENT);
        }

        saveRecentPages();
    }

    // ────────────────────────────────────────────────────────────────
    // Fuzzy Matching
    // ────────────────────────────────────────────────────────────────

    /**
     * Scores how well a query matches a page entry. Returns a numeric
     * score where higher = better match. Returns 0 for no match.
     *
     * The algorithm checks for:
     *   1. Exact substring match in title (highest score).
     *   2. Substring match in keywords.
     *   3. Substring match in URL path.
     *   4. Token-based matching (all query tokens appear somewhere).
     *
     * @param {string} query - Lowercase search query.
     * @param {Object} page - Page entry with title, path, keywords.
     * @returns {number} Match score (0 = no match).
     */
    function scoreMatch(query, page) {
        if (!query) return 1; // Empty query matches everything equally.

        var title = (page.title || '').toLowerCase();
        var path = (page.path || '').toLowerCase();
        var keywords = (page.keywords || []).join(' ').toLowerCase();
        var combined = title + ' ' + keywords + ' ' + path;

        var score = 0;

        // Exact title match.
        if (title === query) return 1000;

        // Title starts with query.
        if (title.startsWith(query)) score += 100;

        // Title contains query as substring.
        if (title.includes(query)) score += 50;

        // Keywords contain query.
        if (keywords.includes(query)) score += 30;

        // Path contains query.
        if (path.includes(query)) score += 10;

        // Token matching: split query into words and check each.
        if (score === 0) {
            var tokens = query.split(/\s+/).filter(Boolean);
            var matchCount = 0;
            for (var i = 0; i < tokens.length; i++) {
                if (combined.includes(tokens[i])) {
                    matchCount++;
                }
            }
            if (matchCount === tokens.length) {
                score += 20 + matchCount * 5;
            } else if (matchCount > 0) {
                score += matchCount * 3;
            }
        }

        return score;
    }

    /**
     * Highlights matching text in a title string by wrapping matched
     * portions in <mark> elements.
     *
     * @param {string} title - The original title.
     * @param {string} query - The lowercase search query.
     * @returns {string} HTML string with <mark> highlights.
     */
    function highlightMatch(title, query) {
        if (!query) return _escapeHtml(title);

        var lower = title.toLowerCase();
        var idx = lower.indexOf(query);
        if (idx === -1) {
            // Try highlighting individual tokens.
            var tokens = query.split(/\s+/).filter(Boolean);
            var result = title;
            for (var i = 0; i < tokens.length; i++) {
                var tokenIdx = result.toLowerCase().indexOf(tokens[i]);
                if (tokenIdx !== -1) {
                    result = result.substring(0, tokenIdx) +
                             '<mark>' + _escapeHtml(result.substring(tokenIdx, tokenIdx + tokens[i].length)) + '</mark>' +
                             result.substring(tokenIdx + tokens[i].length);
                }
            }
            return result;
        }

        return _escapeHtml(title.substring(0, idx)) +
               '<mark>' + _escapeHtml(title.substring(idx, idx + query.length)) + '</mark>' +
               _escapeHtml(title.substring(idx + query.length));
    }

    /**
     * Escapes HTML special characters in a string.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ────────────────────────────────────────────────────────────────
    // Search & Filter
    // ────────────────────────────────────────────────────────────────

    /**
     * Filters and scores all available pages against the current query,
     * then sorts by score (descending) and returns the top results.
     *
     * @param {string} query - The user's search input (raw).
     * @returns {Array<Object>} Sorted array of matching page entries.
     */
    function search(query) {
        var q = (query || '').toLowerCase().trim();

        // Combine built-in pages and recent pages, deduplicating by path.
        var seen = {};
        var allPages = [];

        // Recent pages first (they get a small score bonus).
        for (var i = 0; i < _recentPages.length; i++) {
            var rp = _recentPages[i];
            if (!seen[rp.path]) {
                seen[rp.path] = true;
                allPages.push(Object.assign({}, rp, { _isRecent: true }));
            }
        }

        // Built-in pages.
        for (var j = 0; j < _builtinPages.length; j++) {
            var bp = _builtinPages[j];
            if (!seen[bp.path]) {
                seen[bp.path] = true;
                allPages.push(bp);
            }
        }

        // Score and filter.
        var scored = [];
        for (var k = 0; k < allPages.length; k++) {
            var page = allPages[k];
            var s = scoreMatch(q, page);
            if (s > 0) {
                scored.push({
                    page: page,
                    score: s + (page._isRecent ? 5 : 0)
                });
            }
        }

        // Sort by score descending, then alphabetically by title.
        scored.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return (a.page.title || '').localeCompare(b.page.title || '');
        });

        // Return top results.
        var results = [];
        var limit = Math.min(scored.length, MAX_RESULTS);
        for (var m = 0; m < limit; m++) {
            results.push(scored[m].page);
        }

        return results;
    }

    // ────────────────────────────────────────────────────────────────
    // DOM Construction
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates the magnifying glass SVG icon.
     * @returns {HTMLElement}
     */
    function createSearchIcon() {
        var wrapper = document.createElement('span');
        wrapper.className = 'tacta-nav-search__search-icon';
        wrapper.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';
        return wrapper;
    }

    /**
     * Builds the full overlay DOM structure.
     */
    function buildOverlay() {
        if (_backdrop) return; // Already built.

        // Backdrop.
        _backdrop = document.createElement('div');
        _backdrop.className = 'tacta-nav-search__backdrop';

        // Container.
        var container = document.createElement('div');
        container.className = 'tacta-nav-search__container';

        // Input wrapper.
        var inputWrapper = document.createElement('div');
        inputWrapper.className = 'tacta-nav-search__input-wrapper';

        inputWrapper.appendChild(createSearchIcon());

        _input = document.createElement('input');
        _input.className = 'tacta-nav-search__input';
        _input.type = 'text';
        _input.placeholder = 'Search NetSuite pages...';
        _input.setAttribute('autocomplete', 'off');
        _input.setAttribute('spellcheck', 'false');
        inputWrapper.appendChild(_input);

        var shortcutHint = document.createElement('span');
        shortcutHint.className = 'tacta-nav-search__shortcut-hint';
        shortcutHint.textContent = 'Esc';
        inputWrapper.appendChild(shortcutHint);

        container.appendChild(inputWrapper);

        // Results.
        _resultsList = document.createElement('div');
        _resultsList.className = 'tacta-nav-search__results';
        _resultsList.setAttribute('role', 'listbox');
        container.appendChild(_resultsList);

        // Footer.
        var footer = document.createElement('div');
        footer.className = 'tacta-nav-search__footer';

        var keys = document.createElement('div');
        keys.className = 'tacta-nav-search__footer-keys';

        keys.innerHTML =
            '<span class="tacta-nav-search__footer-key"><kbd class="tacta-nav-search__kbd">&uarr;&darr;</kbd> navigate</span>' +
            '<span class="tacta-nav-search__footer-key"><kbd class="tacta-nav-search__kbd">Enter</kbd> open</span>' +
            '<span class="tacta-nav-search__footer-key"><kbd class="tacta-nav-search__kbd">Esc</kbd> close</span>';
        footer.appendChild(keys);

        var brand = document.createElement('span');
        brand.textContent = 'Tacta Toolkit';
        brand.style.opacity = '0.5';
        footer.appendChild(brand);

        container.appendChild(footer);
        _backdrop.appendChild(container);

        // Event listeners.
        _input.addEventListener('input', onInputChange);
        _input.addEventListener('keydown', onInputKeyDown);
        _backdrop.addEventListener('click', onBackdropClick);

        document.body.appendChild(_backdrop);
    }

    /**
     * Renders the current results into the results list.
     * @param {string} query - The current search query for highlighting.
     */
    function renderResults(query) {
        if (!_resultsList) return;
        _resultsList.innerHTML = '';

        var q = (query || '').toLowerCase().trim();

        if (_currentResults.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'tacta-nav-search__empty';
            empty.textContent = q ? 'No pages found for "' + query + '"' : 'Type to search NetSuite pages...';
            _resultsList.appendChild(empty);
            return;
        }

        // Group results: recent first (if showing default), then others.
        var hasQuery = q.length > 0;
        var recentSection = false;
        var otherSection = false;

        for (var i = 0; i < _currentResults.length; i++) {
            var page = _currentResults[i];

            // Section headers (only when no query — show sections).
            if (!hasQuery) {
                if (page.category === 'Recent' && !recentSection) {
                    recentSection = true;
                    var recentHeader = document.createElement('div');
                    recentHeader.className = 'tacta-nav-search__section-header';
                    recentHeader.textContent = 'Recent';
                    _resultsList.appendChild(recentHeader);
                } else if (page.category !== 'Recent' && !otherSection) {
                    otherSection = true;
                    // Only show "Pages" header if there were recent pages above.
                    if (recentSection) {
                        var pagesHeader = document.createElement('div');
                        pagesHeader.className = 'tacta-nav-search__section-header';
                        pagesHeader.textContent = 'Pages';
                        _resultsList.appendChild(pagesHeader);
                    }
                }
            }

            var item = document.createElement('div');
            item.className = 'tacta-nav-search__result';
            if (i === _selectedIndex) {
                item.classList.add('tacta-nav-search__result--selected');
            }
            item.setAttribute('role', 'option');
            item.setAttribute('data-index', String(i));

            // Content block.
            var content = document.createElement('div');
            content.className = 'tacta-nav-search__result-content';

            var title = document.createElement('div');
            title.className = 'tacta-nav-search__result-title';
            title.innerHTML = highlightMatch(page.title || '', q);
            content.appendChild(title);

            var pathDisplay = document.createElement('div');
            pathDisplay.className = 'tacta-nav-search__result-path';
            pathDisplay.textContent = page.path || '';
            content.appendChild(pathDisplay);

            item.appendChild(content);

            // Category badge.
            var badge = document.createElement('span');
            badge.className = 'tacta-nav-search__badge tacta-nav-search__badge--' + (page.category || 'Record');
            badge.textContent = page.category || 'Page';
            item.appendChild(badge);

            // Click handler.
            item.addEventListener('click', createResultClickHandler(i));
            item.addEventListener('mouseenter', createResultHoverHandler(i));

            _resultsList.appendChild(item);
        }
    }

    /**
     * Creates a click handler for a result at the given index.
     * @param {number} index
     * @returns {Function}
     */
    function createResultClickHandler(index) {
        return function (event) {
            event.stopPropagation();
            navigateToResult(index);
        };
    }

    /**
     * Creates a mouseenter handler for a result at the given index.
     * @param {number} index
     * @returns {Function}
     */
    function createResultHoverHandler(index) {
        return function () {
            _selectedIndex = index;
            updateSelectedState();
        };
    }

    /**
     * Updates the visual selected state without re-rendering all results.
     */
    function updateSelectedState() {
        if (!_resultsList) return;
        var items = _resultsList.querySelectorAll('.tacta-nav-search__result');
        for (var i = 0; i < items.length; i++) {
            if (i === _selectedIndex) {
                items[i].classList.add('tacta-nav-search__result--selected');
                // Scroll into view if needed.
                items[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                items[i].classList.remove('tacta-nav-search__result--selected');
            }
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Navigation
    // ────────────────────────────────────────────────────────────────

    /**
     * Navigates to the page at the given result index.
     * @param {number} index
     */
    function navigateToResult(index) {
        var page = _currentResults[index];
        if (!page) return;

        closeOverlay();

        var url = page.path;
        // Ensure absolute URL.
        if (url.startsWith('/')) {
            url = window.location.origin + url;
        }

        window.location.href = url;
    }

    // ────────────────────────────────────────────────────────────────
    // Open / Close
    // ────────────────────────────────────────────────────────────────

    /**
     * Opens the search overlay.
     */
    function openOverlay() {
        if (_isOpen) return;

        buildOverlay();
        _isOpen = true;

        // Reset state.
        _input.value = '';
        _selectedIndex = 0;

        // Load data and show default results.
        loadRecentPages().then(function () {
            _currentResults = search('');
            renderResults('');
        });

        // Show overlay with animation.
        requestAnimationFrame(function () {
            _backdrop.classList.add('tacta-nav-search--open');
            _input.focus();
        });
    }

    /**
     * Closes the search overlay.
     */
    function closeOverlay() {
        if (!_isOpen) return;
        _isOpen = false;

        _backdrop.classList.remove('tacta-nav-search--open');
    }

    /**
     * Toggles the overlay open/closed.
     */
    function toggleOverlay() {
        if (_isOpen) {
            closeOverlay();
        } else {
            openOverlay();
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Event Handlers
    // ────────────────────────────────────────────────────────────────

    /**
     * Handles input changes — re-runs the search and updates results.
     */
    function onInputChange() {
        var query = _input.value;
        _selectedIndex = 0;
        _currentResults = search(query);
        renderResults(query);
    }

    /**
     * Handles keyboard navigation within the search input.
     * @param {KeyboardEvent} event
     */
    function onInputKeyDown(event) {
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                if (_currentResults.length > 0) {
                    _selectedIndex = (_selectedIndex + 1) % _currentResults.length;
                    updateSelectedState();
                }
                break;

            case 'ArrowUp':
                event.preventDefault();
                if (_currentResults.length > 0) {
                    _selectedIndex = (_selectedIndex - 1 + _currentResults.length) % _currentResults.length;
                    updateSelectedState();
                }
                break;

            case 'Enter':
                event.preventDefault();
                if (_currentResults.length > 0) {
                    navigateToResult(_selectedIndex);
                }
                break;

            case 'Escape':
                event.preventDefault();
                closeOverlay();
                break;
        }
    }

    /**
     * Handles clicks on the backdrop (outside the container) — closes overlay.
     * @param {MouseEvent} event
     */
    function onBackdropClick(event) {
        // Only close if clicking the backdrop itself, not the container.
        if (event.target === _backdrop) {
            closeOverlay();
        }
    }

    /**
     * Global keyboard shortcut handler: Ctrl+Shift+K (or Cmd+Shift+K on Mac).
     * @param {KeyboardEvent} event
     */
    function onGlobalKeyDown(event) {
        var modKey = IS_MAC ? event.metaKey : event.ctrlKey;

        if (modKey && event.shiftKey && event.key === 'K') {
            event.preventDefault();
            event.stopPropagation();
            toggleOverlay();
        }

        // Also close on Escape if the overlay is open (catches Escape
        // even when the input doesn't have focus).
        if (event.key === 'Escape' && _isOpen) {
            event.preventDefault();
            closeOverlay();
        }
    }

    // ────────────────────────────────────────────────────────────────
    // Initialization
    // ────────────────────────────────────────────────────────────────

    /**
     * Initializes the Navigation Search feature.
     */
    function init() {
        // Load built-in page data.
        loadBuiltinPages();

        // Load recent pages from storage.
        loadRecentPages();

        // Track the current page visit.
        trackPageVisit();

        // Attach global keyboard shortcut.
        document.addEventListener('keydown', onGlobalKeyDown, true);

        // Inject CSS.
        var cssUrl = chrome.runtime.getURL('content/features/ns-utils/nav-search/nav-search.css');
        if (!document.querySelector('link[href="' + cssUrl + '"]')) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = cssUrl;
            (document.head || document.documentElement).appendChild(link);
        }

        console.log('[Tacta Toolkit] Navigation Search activated. Press ' +
                    (IS_MAC ? 'Cmd' : 'Ctrl') + '+Shift+K to open.');
    }

    // Run when DOM is ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
