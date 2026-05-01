/**
 * options.js
 * Tactacam NS Toolkit — Options Page Controller
 *
 * Full-page settings management: feature toggles, import/export,
 * reset to defaults.
 *
 * Communicates with the background service-worker via chrome.runtime
 * messages using the established { action, ... } protocol.
 *
 * Vanilla JS, no frameworks.
 */

(() => {
    'use strict';

    /* ── Constants ─────────────────────────────────────────────────── */

    const GROUP_ORDER = ['developer', 'search', 'record', 'layout', 'misc'];

    const GROUP_LABELS = {
        developer: 'Developer',
        search:    'Search',
        record:    'Record',
        layout:    'Layout',
        misc:      'Misc',
    };

    const STORAGE_KEY = 'featureStates';

    /** All available quick search types — must stay in sync with quick-search-creation.js */
    const QSC_SEARCH_TYPES = [
        { id: 'transaction',      label: 'Transaction',      group: 'Transactions', defaultEnabled: true },
        { id: 'salesorder',       label: 'Sales Order',      group: 'Transactions', defaultEnabled: true },
        { id: 'invoice',          label: 'Invoice',          group: 'Transactions', defaultEnabled: true },
        { id: 'itemfulfillment',  label: 'Item Fulfillment', group: 'Transactions', defaultEnabled: true },
        { id: 'purchaseorder',    label: 'Purchase Order',   group: 'Transactions', defaultEnabled: true },
        { id: 'vendorbill',       label: 'Vendor Bill',      group: 'Transactions', defaultEnabled: false },
        { id: 'returnauth',       label: 'Return Auth',      group: 'Transactions', defaultEnabled: false },
        { id: 'creditmemo',       label: 'Credit Memo',      group: 'Transactions', defaultEnabled: false },
        { id: 'transferorder',    label: 'Transfer Order',   group: 'Transactions', defaultEnabled: false },
        { id: 'inboundshipment',  label: 'Inbound Shipment', group: 'Transactions', defaultEnabled: false },
        { id: 'journalentry',     label: 'Journal Entry',    group: 'Transactions', defaultEnabled: false },
        { id: 'customer',         label: 'Customer',         group: 'Entities',     defaultEnabled: true },
        { id: 'contact',          label: 'Contact',          group: 'Entities',     defaultEnabled: true },
        { id: 'vendor',           label: 'Vendor',           group: 'Entities',     defaultEnabled: true },
        { id: 'partner',          label: 'Partner',          group: 'Entities',     defaultEnabled: false },
        { id: 'employee',         label: 'Employee',         group: 'Entities',     defaultEnabled: true },
        { id: 'item',             label: 'Item',             group: 'Items',        defaultEnabled: true },
        { id: 'task',             label: 'Task',             group: 'Activities',   defaultEnabled: false },
        { id: 'case',             label: 'Case',             group: 'Activities',   defaultEnabled: false },
        { id: 'phonecall',        label: 'Phone Call',       group: 'Activities',   defaultEnabled: false },
        { id: 'event',            label: 'Event',            group: 'Activities',   defaultEnabled: false },
        { id: 'customrecord',     label: 'Custom Records',   group: 'Other',        defaultEnabled: false },
        { id: 'savedsearch',      label: 'Saved Searches',   group: 'Other',        defaultEnabled: false },
        { id: 'file',             label: 'File',             group: 'Other',        defaultEnabled: false },
    ];

    const QSC_STORAGE_KEY = 'tacta_qsc_enabled_types';
    const QSC_INACTIVES_KEY = 'tacta_qsc_include_inactives';
    const QSC_GROUPS = ['Transactions', 'Entities', 'Items', 'Activities', 'Other'];

    /* ── DOM References ───────────────────────────────────────────── */

    const $featureList  = document.getElementById('featureList');
    const $featureTotal = document.getElementById('featureTotal');
    const $importBtn    = document.getElementById('importBtn');
    const $exportBtn    = document.getElementById('exportBtn');
    const $resetBtn     = document.getElementById('resetBtn');
    const $importFile   = document.getElementById('importFile');


    /* ── State ────────────────────────────────────────────────────── */

    let features      = [];     // Full feature registry from background
    let featureStates = {};     // { featureId: boolean }


    /* ── Background Messaging ─────────────────────────────────────── */

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
        renderFeatureList();
        $featureTotal.textContent = `${features.length} total`;
        await loadThemeSettings();
        await loadAccountColorSettings();
        await loadGeneralSettings();
        await loadAISettings();
        await loadQscSettings();
        bindEvents();
    }

    async function loadState() {
        // Feature registry from background service worker
        try {
            features = await sendMessage({ action: 'getFeatures' }) || [];
        } catch {
            features = [];
        }

        // Load current states from background
        try {
            featureStates = await sendMessage({ action: 'getFeatureStates' }) || {};
        } catch {
            const data = await chrome.storage.local.get(STORAGE_KEY);
            featureStates = data[STORAGE_KEY] || {};
        }

        // Merge defaults for any features not yet in storage
        for (const f of features) {
            if (!(f.id in featureStates)) {
                featureStates[f.id] = f.defaultEnabled;
            }
        }
    }


    /* ── Render Feature List ──────────────────────────────────────── */

    function renderFeatureList() {
        $featureList.innerHTML = '';

        for (const group of GROUP_ORDER) {
            const groupFeatures = features.filter(f => f.group === group);
            if (groupFeatures.length === 0) continue;

            // Group wrapper
            const groupEl = document.createElement('div');
            groupEl.className = 'tacta-opt-feature-group';

            // Group header
            const header = document.createElement('div');
            header.className = 'tacta-opt-group-header';
            header.innerHTML = `
                <span class="tacta-opt-group-name">${GROUP_LABELS[group] || group}</span>
                <span class="tacta-opt-group-count">${groupFeatures.length} features</span>
                <div class="tacta-opt-group-line"></div>`;
            groupEl.appendChild(header);

            // Feature cards
            const cards = document.createElement('div');
            cards.className = 'tacta-opt-group-cards';

            for (const feat of groupFeatures) {
                const card = document.createElement('div');
                card.className = 'tacta-opt-feature-card';
                card.innerHTML = `
                    <div class="tacta-opt-card-left">
                        <div class="tacta-opt-card-top">
                            <span class="tacta-opt-feature-name">${feat.label}</span>
                            <span class="tacta-opt-badge tacta-opt-badge-group">${GROUP_LABELS[feat.group] || feat.group}</span>
                            ${feat.defaultEnabled
                                ? '<span class="tacta-opt-badge tacta-opt-badge-default">Default</span>'
                                : ''}
                        </div>
                        <span class="tacta-opt-feature-desc">${feat.description}</span>
                    </div>
                    <label class="tacta-opt-toggle">
                        <input type="checkbox" data-feature-id="${feat.id}"
                               ${featureStates[feat.id] ? 'checked' : ''}>
                        <span class="tacta-opt-toggle-track"></span>
                    </label>`;
                cards.appendChild(card);
            }

            groupEl.appendChild(cards);
            $featureList.appendChild(groupEl);
        }
    }


    /* ── Feature Toggle Handler ───────────────────────────────────── */

    function handleFeatureToggle(featureId, enabled) {
        featureStates[featureId] = enabled;

        // Persist via background service-worker
        sendMessage({
            action: 'setFeatureState',
            featureId,
            enabled,
        }).catch((err) => {
            console.error('[Options] Failed to save feature state:', err);
            // Fall back to direct storage write
            chrome.storage.local.get(STORAGE_KEY, (data) => {
                const states = data[STORAGE_KEY] || {};
                states[featureId] = enabled;
                chrome.storage.local.set({ [STORAGE_KEY]: states });
            });
        });
    }


    /* ── Export Settings ──────────────────────────────────────────── */

    async function exportSettings() {
        const themeData = await chrome.storage.local.get('tacta_theme_settings');
        const payload = {
            _meta: {
                extension:  'Tactacam NS Toolkit',
                version:    '1.0.0',
                exportedAt: new Date().toISOString(),
            },
            featureStates,
            themeSettings: themeData.tacta_theme_settings || null,
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');

        a.href     = url;
        a.download = `tacta-ns-toolkit-settings-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Settings exported successfully', 'success');
    }


    /* ── Import Settings ──────────────────────────────────────────── */

    function triggerImport() {
        $importFile.value = '';
        $importFile.click();
    }

    function handleImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const data = JSON.parse(evt.target.result);

                if (!data.featureStates || typeof data.featureStates !== 'object') {
                    showToast('Invalid settings file: missing featureStates object', 'error');
                    return;
                }

                // Validate feature IDs against registry
                const validIds = new Set(features.map(f => f.id));
                let importCount = 0;

                for (const [id, enabled] of Object.entries(data.featureStates)) {
                    if (validIds.has(id) && typeof enabled === 'boolean') {
                        featureStates[id] = enabled;
                        importCount++;
                    }
                }

                // Persist all at once
                const updates = { [STORAGE_KEY]: featureStates };
                if (data.themeSettings && typeof data.themeSettings === 'object') {
                    updates.tacta_theme_settings = data.themeSettings;
                    if (window.TactaThemeManager) {
                        window.TactaThemeManager.apply(data.themeSettings);
                    }
                }
                chrome.storage.local.set(updates);
                renderFeatureList();
                loadThemeSettings();
                showToast(`Imported ${importCount} feature settings`, 'success');

            } catch {
                showToast('Failed to parse settings file', 'error');
            }
        };
        reader.readAsText(file);
    }


    /* ── Reset to Defaults ────────────────────────────────────────── */

    function resetToDefaults() {
        const confirmed = confirm(
            'Reset all features to their default states?\n\n' +
            'This cannot be undone.'
        );
        if (!confirmed) return;

        featureStates = {};
        for (const f of features) {
            featureStates[f.id] = f.defaultEnabled;
        }

        chrome.storage.local.set({ [STORAGE_KEY]: featureStates });
        renderFeatureList();
        showToast('All features reset to defaults', 'success');
    }


    /* ── Toast Notification ───────────────────────────────────────── */

    let toastTimer = null;

    function showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.tacta-opt-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `tacta-opt-toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation on next frame
        requestAnimationFrame(() => {
            toast.classList.add('visible');
        });

        // Auto-hide
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 350);
        }, 3000);
    }


    /* ── Event Binding ────────────────────────────────────────────── */

    function bindEvents() {
        // Feature toggles (delegated)
        $featureList.addEventListener('change', (e) => {
            if (e.target.matches('input[data-feature-id]')) {
                handleFeatureToggle(e.target.dataset.featureId, e.target.checked);
            }
        });

        // Action buttons
        $exportBtn.addEventListener('click', exportSettings);
        $importBtn.addEventListener('click', triggerImport);
        $importFile.addEventListener('change', handleImport);
        $resetBtn.addEventListener('click', resetToDefaults);

        // General settings
        const $saveGeneralBtn = document.getElementById('saveGeneralSettings');
        if ($saveGeneralBtn) {
            $saveGeneralBtn.addEventListener('click', saveGeneralSettings);
        }

        // Theme settings
        const $saveThemeBtn = document.getElementById('saveThemeSettings');
        if ($saveThemeBtn) {
            $saveThemeBtn.addEventListener('click', saveThemeSettings);
        }
        const $themeScheme = document.getElementById('themeScheme');
        const $themeAccent = document.getElementById('themeAccent');
        if ($themeScheme) {
            $themeScheme.addEventListener('change', previewThemeSettings);
        }
        if ($themeAccent) {
            $themeAccent.addEventListener('input', previewThemeSettings);
        }

        // Account Color settings
        const $saveAcBtn = document.getElementById('saveAccountColorSettings');
        if ($saveAcBtn) {
            $saveAcBtn.addEventListener('click', saveAccountColorSettings);
        }

        // AI settings
        const $saveAIBtn = document.getElementById('saveAISettings');
        if ($saveAIBtn) {
            $saveAIBtn.addEventListener('click', saveAISettings);
        }

        const $toggleKey = document.getElementById('toggleApiKeyVisibility');
        if ($toggleKey) {
            $toggleKey.addEventListener('click', toggleApiKeyVisibility);
        }

        const $testAI = document.getElementById('testAIConnection');
        if ($testAI) {
            $testAI.addEventListener('click', testAIConnection);
        }

        // Quick Search settings
        const $saveQscBtn = document.getElementById('saveQscSettings');
        if ($saveQscBtn) {
            $saveQscBtn.addEventListener('click', saveQscSettings);
        }
        const $qscSelectAll = document.getElementById('qscSelectAll');
        if ($qscSelectAll) {
            $qscSelectAll.addEventListener('click', () => toggleAllQsc(true));
        }
        const $qscSelectNone = document.getElementById('qscSelectNone');
        if ($qscSelectNone) {
            $qscSelectNone.addEventListener('click', () => toggleAllQsc(false));
        }
    }

    /* ── Theme Settings ───────────────────────────────────────────── */

    async function loadThemeSettings() {
        if (!window.TactaThemeManager) return;
        const settings = await window.TactaThemeManager.load();
        const $scheme = document.getElementById('themeScheme');
        const $accent = document.getElementById('themeAccent');
        if ($scheme) $scheme.value = settings.scheme;
        if ($accent) $accent.value = settings.accent;
    }

    function getThemeFormSettings() {
        const $scheme = document.getElementById('themeScheme');
        const $accent = document.getElementById('themeAccent');
        return {
            scheme: $scheme ? $scheme.value : 'dark',
            accent: $accent ? $accent.value : '#76c043'
        };
    }

    function previewThemeSettings() {
        if (!window.TactaThemeManager) return;
        window.TactaThemeManager.apply(getThemeFormSettings());
    }

    async function saveThemeSettings() {
        if (!window.TactaThemeManager) return;
        await window.TactaThemeManager.save(getThemeFormSettings());
        const btn = document.getElementById('saveThemeSettings');
        if (btn) {
            const orig = btn.innerHTML;
            btn.textContent = 'Saved!';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
        }
    }

    /* ── General Settings ─────────────────────────────────────────── */

    async function loadGeneralSettings() {
        try {
            const data = await chrome.storage.local.get('tacta_close_on_click_outside');
            const $cb = document.getElementById('closeOnClickOutside');
            if ($cb) $cb.checked = data.tacta_close_on_click_outside === true;
        } catch (_) {}
    }

    async function saveGeneralSettings() {
        const $cb = document.getElementById('closeOnClickOutside');
        await chrome.storage.local.set({
            tacta_close_on_click_outside: $cb ? $cb.checked : false
        });
        const btn = document.getElementById('saveGeneralSettings');
        if (btn) {
            const orig = btn.innerHTML;
            btn.textContent = 'Saved!';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
        }
    }

    /* ── AI Settings ─────────────────────────────────────────── */

    // SECURITY NOTE: The API key is stored in chrome.storage.local for persistence
    // across browser restarts. chrome.storage.local is NOT encrypted — it is readable
    // by any code running in this extension's context. chrome.storage.session would be
    // more secure (cleared on browser close) but requires the user to re-enter the key
    // every session, which is too disruptive. The key is never exposed to content
    // scripts or web pages. The testAIConnection call is routed through the background
    // service worker to avoid exposing the key in options page network requests.
    // NOTE: background/service-worker.js must handle a 'testAIConnection' message
    // for the test button to work (see handler below).

    async function loadAISettings() {
        try {
            const data = await chrome.storage.local.get(['tacta_ai_api_key', 'tacta_ai_model']);
            const $key = document.getElementById('aiApiKey');
            const $model = document.getElementById('aiModel');
            if ($key && data.tacta_ai_api_key) $key.value = data.tacta_ai_api_key;
            if ($model && data.tacta_ai_model) $model.value = data.tacta_ai_model;
        } catch (_) {}
    }

    async function saveAISettings() {
        const $key = document.getElementById('aiApiKey');
        const $model = document.getElementById('aiModel');
        await chrome.storage.local.set({
            tacta_ai_api_key: $key ? $key.value.trim() : '',
            tacta_ai_model: $model ? $model.value : 'claude-sonnet-4-5-20250514'
        });
        // Visual feedback
        const btn = document.getElementById('saveAISettings');
        if (btn) {
            const orig = btn.innerHTML;
            btn.textContent = 'Saved!';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
        }
    }

    function toggleApiKeyVisibility() {
        const $key = document.getElementById('aiApiKey');
        if (!$key) return;
        const isPassword = $key.type === 'password';
        $key.type = isPassword ? 'text' : 'password';
        // Update icon
        const $btn = document.getElementById('toggleApiKeyVisibility');
        if ($btn) {
            $btn.title = isPassword ? 'Hide API key' : 'Show API key';
        }
    }

    async function testAIConnection() {
        const $btn = document.getElementById('testAIConnection');
        if (!$btn) return;

        const origHTML = $btn.innerHTML;
        $btn.disabled = true;
        $btn.innerHTML = '<span class="tacta-opt-spinner"></span> Testing...';

        try {
            const $key = document.getElementById('aiApiKey');
            const apiKey = $key ? $key.value.trim() : '';

            if (!apiKey) {
                showToast('Please enter an API key first', 'error');
                return;
            }

            // Save current key/model first so background has the latest values
            await saveAISettings();

            // Route the API call through the background service worker so the
            // API key is never exposed in options page network requests.
            const result = await sendMessage({ action: 'testAIConnection' });

            if (result && result.success) {
                showToast('Connection successful! Claude API is working.', 'success');
            } else if (result && result.status === 401) {
                showToast('Invalid API key. Please check your key.', 'error');
            } else {
                const detail = (result && result.error) || 'Unknown error';
                showToast(`API error: ${detail}`, 'error');
            }
        } catch (err) {
            showToast('Connection failed: ' + err.message, 'error');
        } finally {
            $btn.innerHTML = origHTML;
            $btn.disabled = false;
        }
    }

    /* ── Quick Search Settings ────────────────────────────────────── */

    async function loadQscSettings() {
        const container = document.getElementById('qscTypeGroups');
        if (!container) return;

        let enabledTypes = {};
        let includeInactives = false;
        try {
            const data = await chrome.storage.local.get([QSC_STORAGE_KEY, QSC_INACTIVES_KEY]);
            enabledTypes = data[QSC_STORAGE_KEY] || {};
            includeInactives = data[QSC_INACTIVES_KEY] === true;
        } catch (_) {}

        const hasSettings = Object.keys(enabledTypes).length > 0;
        container.innerHTML = '';

        for (const group of QSC_GROUPS) {
            const groupTypes = QSC_SEARCH_TYPES.filter(t => t.group === group);
            if (groupTypes.length === 0) continue;

            const groupEl = document.createElement('div');
            groupEl.className = 'tacta-opt-qsc-group';

            const groupLabel = document.createElement('div');
            groupLabel.className = 'tacta-opt-qsc-group-label';
            groupLabel.textContent = group;
            groupEl.appendChild(groupLabel);

            const checkboxes = document.createElement('div');
            checkboxes.className = 'tacta-opt-qsc-checkboxes';

            for (const st of groupTypes) {
                const isChecked = hasSettings ? (enabledTypes[st.id] === true) : st.defaultEnabled;

                const label = document.createElement('label');
                label.className = 'tacta-opt-qsc-item';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = isChecked;
                cb.dataset.qscId = st.id;

                const span = document.createElement('span');
                span.textContent = st.label;

                label.appendChild(cb);
                label.appendChild(span);
                checkboxes.appendChild(label);
            }

            groupEl.appendChild(checkboxes);
            container.appendChild(groupEl);
        }

        // Include Inactives checkbox
        const inactivesEl = document.createElement('div');
        inactivesEl.className = 'tacta-opt-qsc-group';

        const inactivesLabel = document.createElement('div');
        inactivesLabel.className = 'tacta-opt-qsc-group-label';
        inactivesLabel.textContent = 'Options';
        inactivesEl.appendChild(inactivesLabel);

        const inactivesCheckboxes = document.createElement('div');
        inactivesCheckboxes.className = 'tacta-opt-qsc-checkboxes';

        const inactivesItem = document.createElement('label');
        inactivesItem.className = 'tacta-opt-qsc-item';

        const inactivesCb = document.createElement('input');
        inactivesCb.type = 'checkbox';
        inactivesCb.checked = includeInactives;
        inactivesCb.id = 'qscIncludeInactives';

        const inactivesSpan = document.createElement('span');
        inactivesSpan.textContent = 'Include inactive records';

        inactivesItem.appendChild(inactivesCb);
        inactivesItem.appendChild(inactivesSpan);
        inactivesCheckboxes.appendChild(inactivesItem);
        inactivesEl.appendChild(inactivesCheckboxes);
        container.appendChild(inactivesEl);
    }

    async function saveQscSettings() {
        const checkboxes = document.querySelectorAll('#qscTypeGroups input[data-qsc-id]');
        const enabledTypes = {};
        checkboxes.forEach(cb => {
            enabledTypes[cb.dataset.qscId] = cb.checked;
        });

        const inactivesCb = document.getElementById('qscIncludeInactives');
        const includeInactives = inactivesCb ? inactivesCb.checked : false;

        await chrome.storage.local.set({
            [QSC_STORAGE_KEY]: enabledTypes,
            [QSC_INACTIVES_KEY]: includeInactives
        });

        const btn = document.getElementById('saveQscSettings');
        if (btn) {
            const orig = btn.innerHTML;
            btn.textContent = 'Saved!';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
        }
    }

    function toggleAllQsc(checked) {
        const checkboxes = document.querySelectorAll('#qscTypeGroups input[data-qsc-id]');
        checkboxes.forEach(cb => { cb.checked = checked; });
    }

    /* ── Account Color Settings ────────────────────────────────────── */

    async function loadAccountColorSettings() {
        try {
            const data = await chrome.storage.local.get([
                'tacta_ac_color_prod',
                'tacta_ac_color_sandbox',
                'tacta_ac_color_sandbox_n'
            ]);
            const $prod = document.getElementById('acColorProd');
            const $sb = document.getElementById('acColorSandbox');
            const $sbN = document.getElementById('acColorSandboxN');
            if ($prod && data.tacta_ac_color_prod) $prod.value = data.tacta_ac_color_prod;
            if ($sb && data.tacta_ac_color_sandbox) $sb.value = data.tacta_ac_color_sandbox;
            if ($sbN && data.tacta_ac_color_sandbox_n) $sbN.value = data.tacta_ac_color_sandbox_n;
        } catch (_) {}
    }

    async function saveAccountColorSettings() {
        const $prod = document.getElementById('acColorProd');
        const $sb = document.getElementById('acColorSandbox');
        const $sbN = document.getElementById('acColorSandboxN');
        await chrome.storage.local.set({
            tacta_ac_color_prod: $prod ? $prod.value : '#ff4444',
            tacta_ac_color_sandbox: $sb ? $sb.value : '#76c043',
            tacta_ac_color_sandbox_n: $sbN ? $sbN.value : '#4488ff'
        });
        // Visual feedback
        const btn = document.getElementById('saveAccountColorSettings');
        if (btn) {
            const orig = btn.innerHTML;
            btn.textContent = 'Saved!';
            btn.disabled = true;
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
        }
    }


    /* ── Launch ────────────────────────────────────────────────────── */

    document.addEventListener('DOMContentLoaded', init);
})();
