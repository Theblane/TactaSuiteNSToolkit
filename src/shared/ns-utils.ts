/**
 * ns-utils.ts
 * NetSuite TactaSuite - NetSuite Utility Functions
 *
 * @author Blane Maher
 *
 * Provides helper functions for extracting context from NetSuite pages
 * and URLs. Works in both content script and page-world contexts.
 */

export namespace TactaNS {
    /**
     * Known sandbox URL patterns. A URL matching any of these is
     * considered non-production.
     */
    const SANDBOX_PATTERNS: RegExp[] = [
        /\.sandbox\./i,
        /-sb\d*\./i,
        /system\.sandbox/i,
        /\bsb\d+\b/i
    ];

    interface PageTypeRule {
        test: (u: URL) => boolean;
        type: string | ((u: URL) => string);
    }

    /**
     * Map of URL path segments / query patterns to human-readable page types.
     * Evaluated in order; first match wins.
     */
    const PAGE_TYPE_RULES: PageTypeRule[] = [
        { test: (u) => u.pathname.includes('/app/common/search/search.nl') && u.searchParams.get('e') === 'T', type: 'search-edit' },
        { test: (u) => u.pathname.includes('/app/common/search/searchresults.nl'), type: 'search-results' },
        { test: (u) => u.pathname.includes('/app/common/search/search.nl'), type: 'search-results' },
        { test: (u) => u.pathname.includes('/app/common/scripting/script.nl'), type: 'script-record' },
        { test: (u) => u.searchParams.get('compid') !== null && u.pathname.includes('/app/site/hosting/scriptlet.nl'), type: 'suitelet' },
        { test: (u) => u.pathname.includes('/app/center/card.nl'), type: 'dashboard' },
        { test: (u) => u.pathname.includes('/app/setup/'), type: 'setup' },
        { test: (u) => u.pathname.includes('/app/common/entity/') || u.pathname.includes('/app/accounting/transactions/'), type: _detectRecordMode },
        { test: (u) => u.searchParams.has('id') && u.searchParams.get('e') === 'T', type: 'record-edit' },
        { test: (u) => u.searchParams.has('id') && !u.searchParams.has('l'), type: 'record-view' },
        { test: (u) => u.pathname.includes('/app/common/custom/custrecord'), type: _detectRecordMode },
        { test: (u) => u.searchParams.has('rectype') || u.searchParams.has('type'), type: 'list' }
    ];

    // ────────────────────────────────────────────────────────────────
    // Helpers
    // ────────────────────────────────────────────────────────────────

    /**
     * Safely parses a URL string into a URL object.
     * Falls back to current location when no argument is provided.
     */
    function _safeUrl(url?: string): URL | null {
        try {
            return new URL(url || window.location.href);
        } catch (_) {
            return null;
        }
    }

    /**
     * Returns 'record-edit' or 'record-view' based on the `e` parameter.
     */
    function _detectRecordMode(u: URL): string {
        return u.searchParams.get('e') === 'T' ? 'record-edit' : 'record-view';
    }

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    /**
     * Extracts the NetSuite account ID from the current page.
     */
    export function getAccountId(url?: string): string | null {
        // Strategy 1: NS global API (only available in page world)
        if (!url) {
            try {
                // nlapiGetContext is available in SS1 page context
                // @ts-ignore
                if (typeof nlapiGetContext === 'function') {
                    // @ts-ignore
                    var ctx = nlapiGetContext();
                    if (ctx && typeof ctx.getCompany === 'function') {
                        return ctx.getCompany();
                    }
                }
            } catch (_) { /* not in page world */ }
        }

        // Strategy 2: compid query param
        var u = _safeUrl(url);
        if (u) {
            var compid = u.searchParams.get('compid');
            if (compid) return compid;
        }

        // Strategy 3: hostname (e.g., 1234567.app.netsuite.com or 1234567-sb1.app.netsuite.com)
        if (u) {
            var hostMatch = u.hostname.match(/^(\d[\w-]*)\./);
            if (hostMatch) return hostMatch[1];
        }

        // Strategy 4: cookie
        if (!url) {
            var cookieMatch = document.cookie.match(/(?:^|;\s*)compid=([^;]+)/);
            if (cookieMatch) return decodeURIComponent(cookieMatch[1]);
        }

        return null;
    }

    /**
     * Extracts the record type from a NetSuite URL.
     */
    export function getRecordType(url?: string): string | null {
        var u = _safeUrl(url);
        if (!u) return null;

        var rectype = u.searchParams.get('rectype')
            || u.searchParams.get('recordtype')
            || u.searchParams.get('type');
        if (rectype) return rectype;

        var pathMatch = u.pathname.match(/\/([a-z]+)\.nl$/i);
        if (pathMatch) return pathMatch[1];

        return null;
    }

    /**
     * Extracts the record internal ID from a NetSuite URL.
     */
    export function getRecordId(url?: string): string | null {
        var u = _safeUrl(url);
        if (!u) return null;

        return u.searchParams.get('id') || null;
    }

    /**
     * Determines the current NetSuite page type based on URL analysis.
     */
    export function getPageType(url?: string): string {
        var u = _safeUrl(url);
        if (!u) return 'other';

        for (var i = 0; i < PAGE_TYPE_RULES.length; i++) {
            var rule = PAGE_TYPE_RULES[i];
            if (rule.test(u)) {
                if (typeof rule.type === 'function') {
                    return rule.type(u);
                }
                return rule.type;
            }
        }

        return 'other';
    }

    /**
     * Checks whether the current environment is a production account.
     */
    export function isProductionAccount(url?: string): boolean {
        var href = url || window.location.href;
        for (var i = 0; i < SANDBOX_PATTERNS.length; i++) {
            if (SANDBOX_PATTERNS[i].test(href)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Returns a human-readable environment label.
     */
    export function getEnvironmentLabel(url?: string): string {
        var href = url || window.location.href;

        if (isProductionAccount(href)) {
            return 'Production';
        }

        var sbMatch = href.match(/[-.]sb(\d+)/i);
        if (sbMatch) {
            var num = parseInt(sbMatch[1], 10);
            if (num === 1) return 'Sandbox';
            return 'Sandbox ' + num;
        }

        return 'Sandbox';
    }

    /**
     * Builds a fully-qualified NetSuite URL from a relative path and parameters.
     */
    export function buildNSUrl(path: string, params?: Record<string, string | number | boolean | undefined | null>): string {
        var base: URL;
        try {
            base = new URL(path, window.location.origin);
        } catch (_) {
            base = new URL(window.location.origin + path);
        }

        if (params && typeof params === 'object') {
            var keys = Object.keys(params);
            for (var i = 0; i < keys.length; i++) {
                var val = params[keys[i]];
                if (val !== undefined && val !== null) {
                    base.searchParams.set(keys[i], String(val));
                }
            }
        }

        return base.toString();
    }

    interface ParsedNSUrl {
        recordType: string | null;
        id: string | null;
        mode: string | null;
        compid: string | null;
        scriptId: string | null;
        deployId: string | null;
        pageType: string;
    }

    /**
     * Parses a NetSuite URL and extracts structured information.
     */
    export function parseNSUrl(url: string): ParsedNSUrl {
        var u = _safeUrl(url);
        if (!u) {
            return {
                recordType: null,
                id: null,
                mode: null,
                compid: null,
                scriptId: null,
                deployId: null,
                pageType: 'other'
            };
        }

        var editParam = u.searchParams.get('e');
        var mode: 'edit' | 'view' | null = null;
        if (u.searchParams.has('id')) {
            mode = editParam === 'T' ? 'edit' : 'view';
        }

        return {
            recordType: getRecordType(url),
            id: u.searchParams.get('id') || null,
            mode: mode,
            compid: u.searchParams.get('compid') || null,
            scriptId: u.searchParams.get('script') || u.searchParams.get('scriptid') || null,
            deployId: u.searchParams.get('deploy') || u.searchParams.get('deploymentid') || null,
            pageType: getPageType(url)
        };
    }
}

// Global exposure for non-module contexts
if (typeof window !== 'undefined') {
    (window as any).TactaNS = TactaNS;
}
