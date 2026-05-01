/**
 * popup.js
 * Tactacam NS Toolkit — Popup Controller
 *
 * Manages the extension popup: environment detection, quick actions,
 * feature toggles, meeting mode, and active-feature display.
 *
 * Communicates with the background service-worker via chrome.runtime
 * messages using the established { action, ... } protocol.
 *
 * Pure vanilla JS — no frameworks.
 */

(() => {
    'use strict';

    /* ── Constants ─────────────────────────────────────────────────── */

    const GROUP_ORDER = ['developer', 'search', 'record', 'layout', 'misc'];

    /** Labels for display (groups are stored lowercase in the registry) */
    const GROUP_LABELS = {
        developer: 'Developer',
        search:    'Search',
        record:    'Record',
        layout:    'Layout',
        misc:      'Misc',
    };

    /** Quick-action button IDs — only include implemented features */
    const QUICK_ACTIONS = ['field-explorer', 'record-object', 'script-explorer', 'suiteql-runner'];

    const STORAGE_KEY_GROUPS = 'tacta_group_collapsed';
    const STORAGE_KEY_USER_TYPE = 'tacta_user_type';

    /**
     * Feature presets by user type.
     * When the user switches type, these defaults are applied to all feature toggles.
     * 'user' = end-user focused (productivity tools, no dev tools)
     * 'developer' = all features on
     */
    const USER_TYPE_PRESETS = {
        user: {
            'field-explorer': false,
            'script-analyzer': false,
            'script-explorer': false,
            'record-object': false,
            'suiteql-runner': false,
            'saved-search-export': true,
            'field-finder': true,
            'quick-search-creation': true,
            'field-help': false,
            'transaction-tree': true,
            'split-view': false,
            'fixed-headers': true,
            'account-color': true,
            'nav-search': true,
            'pdf-tools': false,
            'csv-viewer': false,
            'workflow-colors': false,
            'better-page-titles': true
        },
        developer: {
            'field-explorer': true,
            'script-analyzer': true,
            'script-explorer': true,
            'record-object': true,
            'suiteql-runner': true,
            'saved-search-export': true,
            'field-finder': true,
            'quick-search-creation': true,
            'field-help': true,
            'transaction-tree': true,
            'split-view': false,
            'fixed-headers': true,
            'account-color': true,
            'nav-search': true,
            'pdf-tools': true,
            'csv-viewer': true,
            'workflow-colors': true,
            'better-page-titles': true
        }
    };


    /* ── DOM References ───────────────────────────────────────────── */

    const $envDot         = document.getElementById('envDot');
    const $envLabel       = document.getElementById('envLabel');
    const $meetingToggle  = document.getElementById('meetingToggle');
    const $quickActions   = document.getElementById('quickActions');
    const $activeCount    = document.getElementById('activeCount');
    const $activeFeatures = document.getElementById('activeFeatures');
    const $featureGroups  = document.getElementById('featureGroups');
    const $optionsLink    = document.getElementById('optionsLink');
    const $userTypeSelect = document.getElementById('userTypeSelect');


    /* ── State ────────────────────────────────────────────────────── */

    let features        = [];     // Full feature registry from background
    let featureStates   = {};     // { featureId: boolean }
    let groupCollapsed  = {};     // { groupName: boolean }
    let meetingMode     = false;
    let userType        = 'user'; // 'user' or 'developer'
    let currentTabId    = null;
    let currentTabUrl   = '';


    /* ── Background Messaging ─────────────────────────────────────── */

    /**
     * Send a message to the background service-worker and return the response.
     * @param {Object} payload - Must include `action`.
     * @returns {Promise<*>}
     */
    function sendMessage(payload) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(payload, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else if (response?.error) {
                    reject(new Error(response.error));
                } else {
                    resolve(response);
                }
            });
        });
    }


    /* ── Initialisation ───────────────────────────────────────────── */

    async function init() {
        await loadState();
        detectEnvironment();
        renderFeatureGroups();
        renderActiveFeatures();
        updateQuickActions();
        bindEvents();
        updateMeetingModeUI();
        if ($userTypeSelect) $userTypeSelect.value = userType;
    }

    async function loadState() {
        // Feature states from background (via storage-manager)
        try {
            featureStates = await sendMessage({ action: 'getFeatureStates' }) || {};
        } catch {
            // If background isn't ready, read storage directly
            const data = await chrome.storage.local.get('featureStates');
            featureStates = data.featureStates || {};
        }

        // Meeting mode
        try {
            meetingMode = await sendMessage({ action: 'getMeetingMode' });
        } catch {
            const data = await chrome.storage.local.get('meetingMode');
            meetingMode = data.meetingMode === true;
        }

        // Feature registry from background service worker
        try {
            features = await sendMessage({ action: 'getFeatures' }) || [];
        } catch {
            features = [];
        }

        // Merge defaults for any features not yet in storage
        for (const f of features) {
            if (!(f.id in featureStates)) {
                featureStates[f.id] = f.defaultEnabled;
            }
        }

        // Group collapse state (stored locally, not shared with background)
        const groupData = await chrome.storage.local.get(STORAGE_KEY_GROUPS);
        groupCollapsed = groupData[STORAGE_KEY_GROUPS] || {};

        // User type
        const utData = await chrome.storage.local.get(STORAGE_KEY_USER_TYPE);
        userType = utData[STORAGE_KEY_USER_TYPE] || 'user';
    }

    /* ── Environment Detection ────────────────────────────────────── */

    async function detectEnvironment() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            currentTabId  = tab.id;
            currentTabUrl = tab.url || '';

            const isNetSuite = /netsuite\.com/i.test(currentTabUrl);

            if (!isNetSuite) {
                $envDot.className  = 'tacta-env-dot';
                $envLabel.textContent = 'Not NetSuite';
                return;
            }

            const isSandbox = /sb\d/i.test(currentTabUrl) || /sandbox/i.test(currentTabUrl);

            if (isSandbox) {
                $envDot.className  = 'tacta-env-dot sandbox';
                $envLabel.textContent = 'Sandbox';
            } else {
                $envDot.className  = 'tacta-env-dot production';
                $envLabel.textContent = 'Production';
            }
        } catch {
            $envDot.className  = 'tacta-env-dot';
            $envLabel.textContent = 'Unknown';
        }
    }


    /* ── Quick Actions ────────────────────────────────────────────── */

    function handleQuickAction(actionId) {
        if (meetingMode || !currentTabId || featureStates[actionId] !== true) return;

        sendMessage({
            action:    'executeFeature',
            featureId: actionId,
            tabId:     currentTabId,
        }).then(() => {
            window.close();
        }).catch((err) => {
            console.error('[Popup] Quick action failed:', err);
        });
    }


    /* ── Active Features ──────────────────────────────────────────── */

    function renderActiveFeatures() {
        const enabledFeatures = features.filter(f => featureStates[f.id]);

        $activeCount.textContent = enabledFeatures.length;

        if (enabledFeatures.length === 0) {
            $activeFeatures.innerHTML = '<p class="tacta-empty-state">No features enabled</p>';
            return;
        }

        // Show only auto-triggered features as "active on this page"
        const autoFeatures = enabledFeatures.filter(f => f.trigger === 'auto');

        if (autoFeatures.length === 0) {
            $activeFeatures.innerHTML = '<p class="tacta-empty-state">No auto-features active</p>';
            $activeCount.textContent = '0';
            return;
        }

        $activeCount.textContent = autoFeatures.length;
        $activeFeatures.innerHTML = autoFeatures
            .map(f => `
                <div class="tacta-active-item">
                    <span class="tacta-active-dot"></span>
                    <span>${f.label}</span>
                </div>`)
            .join('');
    }

    function updateQuickActions() {
        if (!$quickActions) return;
        $quickActions.querySelectorAll('.tacta-action-btn[data-action]').forEach((btn) => {
            const enabled = featureStates[btn.dataset.action] === true;
            btn.disabled = meetingMode || !enabled;
            btn.classList.toggle('disabled', meetingMode || !enabled);
        });
    }


    /* ── Feature Groups & Toggles ─────────────────────────────────── */

    function renderFeatureGroups() {
        $featureGroups.innerHTML = '';

        for (const group of GROUP_ORDER) {
            const groupFeatures = features.filter(f => f.group === group);
            if (groupFeatures.length === 0) continue;

            const isCollapsed = groupCollapsed[group] === true;

            const groupEl = document.createElement('div');
            groupEl.className = 'tacta-feature-group';

            // Header
            const header = document.createElement('div');
            header.className = `tacta-group-header${isCollapsed ? '' : ' expanded'}`;
            header.innerHTML = `
                <div class="tacta-group-header-left">
                    <svg class="tacta-group-arrow" viewBox="0 0 16 16" fill="none">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                              stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="tacta-group-name">${GROUP_LABELS[group] || group}</span>
                    <span class="tacta-group-count">(${groupFeatures.length})</span>
                </div>`;

            // Body
            const body = document.createElement('div');
            body.className = `tacta-group-body${isCollapsed ? '' : ' expanded'}`;

            const items = document.createElement('div');
            items.className = 'tacta-group-items';

            for (const feat of groupFeatures) {
                const row = document.createElement('div');
                row.className = 'tacta-feature-row';
                row.innerHTML = `
                    <div class="tacta-feature-info">
                        <span class="tacta-feature-name">${feat.label}</span>
                        <span class="tacta-feature-desc">${feat.description}</span>
                    </div>
                    <label class="tacta-toggle">
                        <input type="checkbox" data-feature-id="${feat.id}"
                               ${featureStates[feat.id] ? 'checked' : ''}>
                        <span class="tacta-toggle-track"></span>
                    </label>`;
                items.appendChild(row);
            }

            body.appendChild(items);
            header.addEventListener('click', () => toggleGroup(group, header, body));
            groupEl.appendChild(header);
            groupEl.appendChild(body);
            $featureGroups.appendChild(groupEl);
        }
    }

    function toggleGroup(group, headerEl, bodyEl) {
        const expanding = !bodyEl.classList.contains('expanded');
        bodyEl.classList.toggle('expanded', expanding);
        headerEl.classList.toggle('expanded', expanding);

        groupCollapsed[group] = !expanding;
        chrome.storage.local.set({ [STORAGE_KEY_GROUPS]: groupCollapsed });
    }


    /* ── Feature Toggle Handler ───────────────────────────────────── */

    function handleFeatureToggle(featureId, enabled) {
        featureStates[featureId] = enabled;

        // Persist via background service-worker
        sendMessage({
            action:    'setFeatureState',
            featureId,
            enabled,
        }).catch((err) => {
            console.error('[Popup] Failed to save feature state:', err);
            // Fall back to direct storage write
            chrome.storage.local.get('featureStates', (data) => {
                const states = data.featureStates || {};
                states[featureId] = enabled;
                chrome.storage.local.set({ featureStates: states });
            });
        });

        renderActiveFeatures();
        updateQuickActions();
    }


    /* ── Meeting Mode ─────────────────────────────────────────────── */

    function toggleMeetingMode() {
        meetingMode = !meetingMode;
        updateMeetingModeUI();

        sendMessage({
            action:  'setMeetingMode',
            enabled: meetingMode,
        }).catch((err) => {
            console.error('[Popup] Failed to set meeting mode:', err);
            chrome.storage.local.set({ meetingMode });
        });
    }

    function updateMeetingModeUI() {
        document.body.classList.toggle('meeting-mode', meetingMode);
        $meetingToggle.classList.toggle('active', meetingMode);
        updateQuickActions();
    }


    /* ── Options Link ─────────────────────────────────────────────── */

    function openOptions(e) {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    }


    /* ── Event Binding ────────────────────────────────────────────── */

    function bindEvents() {
        // Quick action buttons
        $quickActions.addEventListener('click', (e) => {
            const btn = e.target.closest('.tacta-action-btn');
            if (!btn) return;
            handleQuickAction(btn.dataset.action);
        });

        // Feature toggles (delegated)
        $featureGroups.addEventListener('change', (e) => {
            if (e.target.matches('input[data-feature-id]')) {
                handleFeatureToggle(e.target.dataset.featureId, e.target.checked);
            }
        });

        // Meeting mode
        $meetingToggle.addEventListener('click', toggleMeetingMode);

        // User type selector
        if ($userTypeSelect) {
            $userTypeSelect.addEventListener('change', () => {
                applyUserTypePreset($userTypeSelect.value);
            });
        }

        // Options
        $optionsLink.addEventListener('click', openOptions);

        // Listen for tab activation changes to refresh environment display
        chrome.tabs.onActivated.addListener(async (activeInfo) => {
            currentTabId = activeInfo.tabId;
            try {
                const tab = await chrome.tabs.get(activeInfo.tabId);
                currentTabUrl = tab.url || '';
            } catch {
                currentTabUrl = '';
            }
            detectEnvironment();
            renderActiveFeatures();
        });
    }


    /* ── User Type Presets ─────────────────────────────────────────── */

    /**
     * Applies a user type preset — sets all feature toggles to the preset
     * defaults for the selected type, persists the choice, and re-renders.
     * @param {string} type - 'user' or 'developer'
     */
    async function applyUserTypePreset(type) {
        if (!USER_TYPE_PRESETS[type]) return;

        userType = type;
        const preset = USER_TYPE_PRESETS[type];

        // Apply preset to local state
        for (const [featureId, enabled] of Object.entries(preset)) {
            featureStates[featureId] = enabled;
        }

        // Persist all feature state changes in a single batched message
        // instead of sending one message per feature (Fix #9)
        sendMessage({ action: 'setFeatureStates', states: featureStates }).catch((err) => {
            console.error('[Popup] Failed to batch-save feature states:', err);
            // Fall back to direct storage write
            chrome.storage.local.set({ featureStates });
        });

        // Persist user type selection
        chrome.storage.local.set({ [STORAGE_KEY_USER_TYPE]: type });

        // Re-render
        renderFeatureGroups();
        renderActiveFeatures();
        updateQuickActions();
    }


    /* ── Launch ────────────────────────────────────────────────────── */

    document.addEventListener('DOMContentLoaded', init);
})();
