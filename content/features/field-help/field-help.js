/**
 * field-help.js
 * Tactacam NS Toolkit — Field Help (Content Script)
 *
 * Minimal content script that injects the page-world client script
 * (field-help-client.js) into the NetSuite page. The client script
 * hooks into NetSuite's native nlFieldHelp() function and enhances
 * the native field help popup with additional metadata — same approach
 * as the NetSuite Advanced Field Help reference extension.
 *
 * This content script does NOT intercept clicks or show its own tooltip.
 * The native NS help popup opens normally and the client script appends
 * enhanced data (field value, copy button, options table, etc.) into it.
 *
 * Auto-activates on all page types.
 *
 * @fileoverview Content script for the Field Help feature.
 */
(function () {
    'use strict';

    // Guard against double-init.
    if (window.__tactaFieldHelpLoaded) return;
    window.__tactaFieldHelpLoaded = true;

    /**
     * Injects the field-help-client.js script into the page world
     * so it can access NetSuite's native JS APIs and hook nlFieldHelp.
     */
    function injectClientScript() {
        var scriptUrl = chrome.runtime.getURL('content/features/field-help/field-help-client.js');
        if (document.querySelector('script[src="' + scriptUrl + '"]')) return;

        var script = document.createElement('script');
        script.src = scriptUrl;
        (document.head || document.documentElement).appendChild(script);
    }

    /**
     * Sets up the Field Help feature: injects the page-world client script.
     */
    function init() {
        // Inject the page-world script for NS API access and nlFieldHelp hook.
        injectClientScript();

        // Also ensure the shared bridge is injected (for other features that may need it).
        var bridgeUrl = chrome.runtime.getURL('shared/ns-bridge.js');
        if (!document.querySelector('script[src="' + bridgeUrl + '"]')) {
            var bridgeScript = document.createElement('script');
            bridgeScript.src = bridgeUrl;
            (document.head || document.documentElement).appendChild(bridgeScript);
        }
    }

    // Run when DOM is ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
