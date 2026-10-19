# TactaSuite NS Toolkit

A unified NetSuite developer and administrator productivity toolkit, delivered as a Chrome extension (Manifest V3).

**Author:** Blane Maher
**License:** MIT
**Target:** NetSuite (`*.netsuite.com`)
**Manifest:** V3

## What it does

TactaSuite NS Toolkit adds a single popup to NetSuite tabs that exposes a curated set of developer and admin features. Each feature can be toggled on or off independently, and a "Meeting Mode" toggle suppresses every visual modification at once so the UI looks stock during screen shares.

## Features

### Developer
- **Field Explorer** — inspect every field on the current record: IDs, types, values, sublist columns.
- **Script Analyzer** — analyze deployed scripts on the current record (entry points, usage, governance).
- **Script Explorer** — browse all scripts and deployments in the account.
- **Script Content Search** — search SuiteScript files by source text; inspect module, record, field, file references.
- **Console Tools** — `window.TactaNSKit` console helpers for quick current-record updates and inspection.
- **Console Snippets** — record-aware library of known-good console commands with the internal ID pre-filled; copy and paste into DevTools. Developer mode only.
- **Record Object Viewer** — view the raw `nlapiGetFieldValue` / `currentRecord` object as JSON.
- **SuiteQL Runner** — run SuiteQL queries against NetSuite: editor, history, sortable results, CSV export.

### Search
- **SuiteScript Exporter** — export saved search, dataset, and workbook pages to SuiteScript 2.x TypeScript scaffolds.
- **Saved Search Export** — one-click CSV/JSON export from saved search results pages.
- **Field Finder** — quick-filter search columns and criteria fields by ID or label.
- **Quick Search Creation** — shortcut buttons to create common saved searches from templates.
- **Search URL Builder** — shareable results URLs, edit links, and SuiteScript 2.1 snippets for the current saved search.

### Record
- **Field Help Tooltips** — enhanced field help popups (field ID, value, select options, set-value).
- **Transaction Tree** — visualize the full transaction chain (SO → IF → INV) as an interactive tree.
- **Audit Trail** — full system notes / change history for the current record: sortable, filterable, exportable.

### Layout
- **Split View** — open the current page in a side-by-side split pane.
- **Fixed Headers** — pin sublist headers so they stay visible when scrolling.

### Misc
- **Account Color** — color-code the NetSuite header per environment (production vs. sandbox).
- **Navigation Search** — keyboard-driven fuzzy search across NetSuite menu items (Ctrl+Shift+K).
- **PDF Template Tools** — live preview and syntax helpers for Advanced PDF/HTML templates.
- **CSV Import Viewer** — preview CSV import files in a formatted table before submitting.
- **Workflow Colors** — color-code workflow states and transitions for easier visual parsing.
- **Better Page Titles** — rewrite browser tab titles to include record type and name.
- **CSV Template Generator** — build a CSV import/export template from the current record: all fields, mandatory only, with values, or a manual selection.

## Installation

### From the Chrome Web Store

*(Once published — link will be added here.)*

### Manual / Unpacked (development)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the `TactaSuiteNSToolkit` folder.
5. Pin the extension and navigate to any `*.netsuite.com` page.

## Usage

- Click the extension icon on any NetSuite page to open the popup.
- Toggle features on or off; settings persist across browser restarts.
- Quick Action buttons in the popup open the most common tools (Fields, Record, Scripts, SuiteQL).
- Right-click on a NetSuite page for context menu actions (e.g., Split View).
- For full feature management, theme settings, account color settings, and Quick Search type selection, open **Options** from the popup footer.

### User Type Presets

The popup has a **User / Developer** selector that applies a sensible defaults preset:
- **User** — productivity tools only (Field Finder, Quick Search, Transaction Tree, etc.).
- **Developer** — every feature enabled.

## Permissions

The extension requests only what it needs to operate inside NetSuite:

| Permission | Reason |
|---|---|
| `storage` | Persist feature toggles, theme, and per-feature settings in `chrome.storage.local`. |
| `activeTab` | Read the current tab URL to detect environment (production vs. sandbox). |
| `scripting` | Inject content scripts on demand for popup-triggered features (e.g., Field Explorer). |
| `declarativeContent` | Show the extension action icon only on `*.netsuite.com` pages. |
| `contextMenus` | Right-click menu entries (e.g., Split View). |
| Host: `https://*.netsuite.com/*` | NetSuite uses per-account subdomains (`<accountid>.app.netsuite.com`), so wildcard host access is required. The extension communicates with no other origin. |

## Privacy

This extension does not collect, transmit, or store any user data on remote servers. All settings are stored locally in `chrome.storage.local`. See [PRIVACY.md](./PRIVACY.md).

## Architecture

```
TactaSuiteNSToolkit/
├── manifest.json
├── background/
│   ├── service-worker.js          MV3 service worker, message router
│   └── modules/
│       ├── feature-registry.js    All features described here
│       ├── storage-manager.js     chrome.storage wrapper
│       └── context-menu-manager.js
├── content/
│   ├── ns-page-detector.js        Identifies NetSuite page type
│   ├── router.js                  Routes auto-triggered features
│   ├── feature-loader.js          URL-pattern feature loader
│   └── features/                  One folder per feature
├── popup/                         Extension action popup
├── options/                       Full-page settings
├── shared/                        Cross-feature utilities and theme
└── icons/
```

- Pure vanilla JS, no build step.
- All UI is scoped under the `.tacta-*` class prefix to avoid colliding with NetSuite styles.
- Theming via CSS custom properties in `shared/theme-vars.css`.
- Features that run in NetSuite's page world (`MAIN`) are loaded via `chrome.scripting.executeScript` with `world: 'MAIN'` and communicate via a message bridge (`shared/ns-bridge.js`).

## Development

No build tooling. To make a change:

1. Edit the relevant file under `content/features/<feature>/`.
2. Reload the extension in `chrome://extensions`.
3. Refresh the NetSuite tab.

To add a new feature, register it in `background/modules/feature-registry.js` and drop content/style files in a matching `content/features/<feature>/` folder.

## License

MIT — see [LICENSE](./LICENSE).
