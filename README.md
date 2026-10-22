# NetSuite TactaSuite

A unified NetSuite developer and administrator productivity toolkit, delivered as a Chrome extension (Manifest V3).

**Author:** Blane Maher
**License:** MIT
**Target:** NetSuite (`*.netsuite.com`)
**Manifest:** V3

## What it does

NetSuite TactaSuite adds a single popup to NetSuite tabs that exposes a curated set of user, admin and developer features. Each feature can be toggled on or off independently, and a "Meeting Mode" toggle suppresses every visual modification at once so the UI looks stock during screen shares.

On first install a setup walkthrough opens. It asks whether you are a Traditional User, an Administrator or a Developer, seeds the feature toggles for that role, then walks you through the features a few at a time so you can switch any of them on or off. Progress is saved on every step. Re-run it any time from the gear icon in the popup or from Settings.

## Features

### Developer
- **Field Explorer** - inspect every field on the current record: IDs, types, values, sublist columns.
- **Script Analyzer** - analyze deployed scripts on the current record (entry points, usage, governance).
- **Script Explorer** - browse all scripts and deployments in the account.
- **Script Content Search** - search SuiteScript files by source text; inspect module, record, field, file references.
- **Console Tools** - `window.TactaNSKit` console helpers for quick current-record updates and inspection.
- **Console Snippets** - record-aware library of known-good console commands with the internal ID pre-filled; copy and paste into DevTools. Developer mode only.
- **Record Object Viewer** - view the raw `nlapiGetFieldValue` / `currentRecord` object as JSON.
- **SuiteQL Runner** - run SuiteQL queries against NetSuite: editor, history, named saved queries, sortable results, CSV and JSON export. Other features can hand it a query to open.

### Search
- **SuiteScript Exporter** - export saved search, dataset, and workbook pages to SuiteScript 2.x TypeScript scaffolds.
- **Saved Search Export** - one-click CSV/JSON export from saved search results pages.
- **Field Finder** - quick-filter search columns and criteria fields by ID or label.
- **Quick Search Creation** - shortcut buttons to create common saved searches from templates.
- **Search URL Builder** - shareable results URLs, edit links, and SuiteScript 2.1 snippets for the current saved search.
- **Dataset to SuiteQL** - a Get SuiteQL button on dataset and workbook pages that returns the equivalent SuiteQL, with copy and open-in-runner.

### Record
- **Field Help Tooltips** - enhanced field help popups (field ID, value, select options, set-value, per-field change history).
- **Transaction Tree** - visualize the full transaction chain (SO → IF → INV) as an interactive tree.
- **Transaction Trail** - breadcrumb chips under the page title showing the document chain through the current transaction; click to jump.
- **Audit Trail** - full system notes / change history for the current record: sortable, filterable, exportable.

### Layout
- **Split View** - open the current page in a side-by-side split pane.
- **Fixed Headers** - pin sublist headers so they stay visible when scrolling.
- **Instant UI** - collapse NetSuite animations and transitions so the interface responds immediately.

### Misc
- **Account Color** - color-code the NetSuite header per environment (production vs. sandbox).
- **Environment Badge** - a PROD / SB1 / SB2 pill with the account id beside the logo, plus a [SB1] prefix on the tab title.
- **Screenshot Studio** - visible, full-page or record-area PNG captures with privacy masks (emails, phones, tax ids, card numbers, amounts, custom text) and a clean mode that hides the NetSuite header.
- **Portlet Refresher** - auto-refresh dashboard portlets on a 1 to 15 minute schedule while the tab is visible.
- **Navigation Search** - keyboard-driven fuzzy search across NetSuite menu items (Ctrl+Shift+K); paste a script, field, record or search id (or script:/search:/bundle:N) to open it.
- **PDF Template Tools** - live preview and syntax helpers for Advanced PDF/HTML templates.
- **CSV Import Viewer** - preview CSV import files in a formatted table before submitting.
- **Workflow Colors** - color-code workflow states and transitions for easier visual parsing.
- **Better Page Titles** - rewrite browser tab titles to include record type and name.
- **CSV Template Generator** - build a CSV import/export template from the current record: all fields, mandatory only, with values, or a manual selection.

## Installation

### From the Chrome Web Store

*(Once published - link will be added here.)*

Source: [github.com/Theblane/TactaSuiteNSToolkit](https://github.com/Theblane/TactaSuiteNSToolkit)

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

### User Types

The gear icon in the popup (and the setup walkthrough) lets you pick who you are. Each feature in the registry declares an `audience`, and the preset is derived from it so the popup, the settings page and the walkthrough always agree:
- **Traditional User** - productivity tools only (Field Finder, Quick Search, Transaction Tree, Audit Trail, Environment Badge, Screenshot Studio, etc.).
- **Administrator** - user tools plus Field Explorer, SuiteQL Runner, Field Help, PDF and CSV tools, Workflow Colors.
- **Developer** - everything except the opt-in extras (Split View, Portlet Refresher, Instant UI).

The gear panel also holds the theme (Light is the default) and accent color.

## Permissions

The extension requests only what it needs to operate inside NetSuite:

| Permission | Reason |
|---|---|
| `storage` | Persist feature toggles, theme, and per-feature settings in `chrome.storage.local`. |
| `activeTab` | Read the current tab URL to detect environment (production vs. sandbox). |
| `scripting` | Inject content scripts on demand for popup-triggered features (e.g., Field Explorer). |
| `declarativeContent` | Show the extension action icon only on `*.netsuite.com` pages. |
| `contextMenus` | Right-click menu entries (e.g., Split View). |
| `alarms` | Periodic reconnect heartbeat for the optional Claude Desktop bridge (does nothing if the bridge is off). |
| Host: `https://*.netsuite.com/*`, `https://*.oracle.com/*` | NetSuite uses per-account subdomains (`<accountid>.app.netsuite.com`), so wildcard host access is required. |
| Optional host: `http://127.0.0.1/*` | Not granted at install. Requested only if you enable the Claude Desktop bridge; used solely to reach the local companion over loopback. |

## Optional: Claude Desktop bridge

The extension can act as a bridge so a desktop MCP client you run (such as Claude Desktop) can query your **live** NetSuite session through your signed-in browser tab - no NetSuite setup, no OAuth, no role switch. It is **off by default**. When enabled, the extension connects out to a small, zero-dependency companion on your own machine over `127.0.0.1`; read-only (SuiteQL `SELECT`/`WITH`) by default. See [`companion/README.md`](./companion/README.md) for setup and [PRIVACY.md](./PRIVACY.md) for what it does and does not send.

## Privacy

This extension does not collect, transmit, or store any user data on remote servers, and never contacts the developer. By default it makes no outbound network calls; the only connection it can make is the optional Claude Desktop bridge to `127.0.0.1` on your own machine, and only if you enable it. All settings and state are stored locally in `chrome.storage.local`. See [PRIVACY.md](./PRIVACY.md).

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
├── popup/                         Extension action popup (gear panel for settings)
├── options/                       Full-page settings
├── onboarding/                    Setup walkthrough shown on first install
├── shared/                        Cross-feature utilities, theme
├── docs/                          Competitive review, roadmap
├── tests/                         Playwright page-world tests
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

To add a new feature, register it in `background/modules/feature-registry.js` (including `audience` and `onboarding` copy) and drop content/style files in a matching `content/features/<feature>/` folder. CSS that styles the NetSuite page itself must be listed in the `globalStyles` arrays of `content/router.js` and `content/feature-loader.js`; everything else is injected into the toolkit's shadow root.

Tests: `npx playwright test tests/field-explorer-pageworld.test.ts` (Node 20 or newer on PATH).

## License

MIT - see [LICENSE](./LICENSE).
