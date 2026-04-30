/**
 * Tactacam NS Toolkit — Context Menu Manager
 *
 * Registers right-click context menu items that are visible only on
 * *.netsuite.com pages. Each handler communicates with the content script
 * or performs a direct action.
 */

/**
 * Create all context menu items for the toolkit. Safe to call multiple times;
 * chrome.contextMenus.create silently replaces items with the same `id`.
 */
export function setupContextMenus() {
  // Remove any previous items to avoid duplicates after update
  chrome.contextMenus.removeAll(() => {
    // ── Parent menu ───────────────────────────────────────────────────────
    chrome.contextMenus.create({
      id: 'tacta-toolkit-parent',
      title: 'Tactacam NS Toolkit',
      contexts: ['page', 'editable', 'link'],
      documentUrlPatterns: ['https://*.netsuite.com/*']
    });

    // ── Split View ────────────────────────────────────────────────────────
    chrome.contextMenus.create({
      id: 'tacta-split-view',
      parentId: 'tacta-toolkit-parent',
      title: 'Open in Split View',
      contexts: ['page', 'link'],
      documentUrlPatterns: ['https://*.netsuite.com/*']
    });

    // ── Copy Field ID ─────────────────────────────────────────────────────
    chrome.contextMenus.create({
      id: 'tacta-copy-field-id',
      parentId: 'tacta-toolkit-parent',
      title: 'Copy Field ID',
      contexts: ['page', 'editable'],
      documentUrlPatterns: ['https://*.netsuite.com/*']
    });
  });

  // ── Click handlers ────────────────────────────────────────────────────────
  // Remove any previous listener to avoid stacking on update
  if (!setupContextMenus._listenerRegistered) {
    chrome.contextMenus.onClicked.addListener(handleContextMenuClick);
    setupContextMenus._listenerRegistered = true;
  }
}

/**
 * Route context menu clicks to the appropriate content-script action.
 *
 * @param {chrome.contextMenus.OnClickData} info - Click metadata.
 * @param {chrome.tabs.Tab}                 tab  - The tab where the click occurred.
 */
function handleContextMenuClick(info, tab) {
  if (!tab?.id) return;

  switch (info.menuItemId) {
    case 'tacta-split-view':
      handleSplitView(info, tab);
      break;

    case 'tacta-copy-field-id':
      handleCopyFieldId(tab);
      break;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Open the current page (or right-clicked link) in a split-view layout by
 * sending a message to the content script.
 */
function handleSplitView(info, tab) {
  const targetUrl = info.linkUrl || tab.url;
  chrome.tabs.sendMessage(tab.id, {
    action: 'activateFeature',
    featureId: 'split-view',
    data: { url: targetUrl }
  });
}

/**
 * Ask the content script to identify the field nearest to the click target
 * and copy its internal ID to the clipboard.
 */
function handleCopyFieldId(tab) {
  chrome.tabs.sendMessage(tab.id, {
    action: 'activateFeature',
    featureId: 'copy-field-id'
  });
}
