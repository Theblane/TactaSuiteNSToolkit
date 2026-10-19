/**
 * TactaSuite NS Toolkit — Feature Registry
 *
 * @author Blane Maher
 */

export interface FeatureDefinition {
    id: string;
    label: string;
    group: 'developer' | 'search' | 'record' | 'layout' | 'misc';
    description: string;
    defaultEnabled: boolean;
    pageTypes: string[];
    trigger: 'auto' | 'popup' | 'contextmenu';
    contentScripts: string[];
    contentStyles: string[];
    injectScripts: string[];
}

export const FEATURES: FeatureDefinition[] = [
  // ── Developer ─────────────────────────────────────────────────────────────
  {
    id: 'field-explorer',
    label: 'Field Explorer',
    group: 'developer',
    description: 'Inspect every field on the current record — IDs, types, values, and sublist columns.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/field-explorer/field-explorer.js'],
    contentStyles: ['content/features/field-explorer/field-explorer.css'],
    injectScripts: ['content/features/field-explorer/field-explorer-client.js']
  },
  {
    id: 'script-analyzer',
    label: 'Script Analyzer',
    group: 'developer',
    description: 'Analyze deployed scripts on the current record — entry points, usage, governance.',
    defaultEnabled: true,
    pageTypes: ['script-record', 'record-view', 'record-edit'],
    trigger: 'auto',
    contentScripts: ['content/features/script-analyzer/script-analyzer.js'],
    contentStyles: ['content/features/script-analyzer/script-analyzer.css'],
    injectScripts: []
  },
  {
    id: 'script-explorer',
    label: 'Script Explorer',
    group: 'developer',
    description: 'Browse all scripts and deployments in the account from a slide-out panel.',
    defaultEnabled: false,
    pageTypes: ['script-record', 'suitelet', 'dashboard', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/script-explorer/script-explorer.js'],
    contentStyles: ['content/features/script-explorer/script-explorer.css'],
    injectScripts: []
  },
  {
    id: 'script-content-search',
    label: 'Script Content Search',
    group: 'developer',
    description: 'Search SuiteScript files by source text and inspect module, record, field, and file references.',
    defaultEnabled: false,
    pageTypes: ['script-record', 'file-cabinet', 'suitelet', 'dashboard', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/script-content-search/script-content-search.js'],
    contentStyles: ['content/features/script-content-search/script-content-search.css'],
    injectScripts: []
  },
  {
    id: 'console-tools',
    label: 'Console Tools',
    group: 'developer',
    description: 'Adds window.TactaNSKit console helpers for quick current-record updates and inspection.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-edit', 'script-record', 'suitelet', 'workflow', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/console-tools/console-tools.js'],
    contentStyles: [],
    injectScripts: ['content/features/console-tools/console-tools-client.js']
  },
  {
    id: 'console-snippets',
    label: 'Console Snippets',
    group: 'developer',
    description: 'Known-good console commands for the record you are on, with the internal ID pre-filled. Copy, paste into DevTools.',
    defaultEnabled: false,
    pageTypes: ['record-view', 'record-edit', 'list', 'script-record', 'suitelet',
                'file-cabinet', 'dashboard', 'setup', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/console-snippets/console-snippets-data.js',
                     'content/features/console-snippets/console-snippets.js'],
    contentStyles: ['content/features/console-snippets/console-snippets.css'],
    injectScripts: ['content/features/console-snippets/console-snippets-client.js']
  },
  {
    id: 'record-object',
    label: 'Record Object Viewer',
    group: 'developer',
    description: 'View the raw nlapiGetFieldValue / currentRecord object as JSON.',
    defaultEnabled: false,
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/record-object/record-object.js'],
    contentStyles: ['content/features/record-object/record-object.css'],
    injectScripts: []
  },
  {
    id: 'suiteql-runner',
    label: 'SuiteQL Runner',
    group: 'developer',
    description: 'Run SuiteQL queries against NetSuite — query editor, history, sortable results, CSV export.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'popup',
    contentScripts: ['content/features/suiteql-runner/suiteql-runner.js'],
    contentStyles: ['content/features/suiteql-runner/suiteql-runner.css'],
    injectScripts: ['content/features/suiteql-runner/suiteql-runner-client.js']
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    id: 'suitescript-exporter',
    label: 'SuiteScript Exporter',
    group: 'search',
    description: 'Export saved search, dataset, and workbook pages to SuiteScript 2.x TypeScript scaffolds.',
    defaultEnabled: true,
    pageTypes: ['search-edit', 'dataset', 'workbook'],
    trigger: 'auto',
    contentScripts: ['content/features/suitescript-exporter/suitescript-exporter.js'],
    contentStyles: ['content/features/suitescript-exporter/suitescript-exporter.css'],
    injectScripts: []
  },
  {
    id: 'saved-search-export',
    label: 'Saved Search Export',
    group: 'search',
    description: 'One-click CSV/JSON export from saved search results pages.',
    defaultEnabled: true,
    pageTypes: ['search-results', 'search-list'],
    trigger: 'auto',
    contentScripts: ['content/features/saved-search-export/saved-search-export.js'],
    contentStyles: ['content/features/saved-search-export/saved-search-export.css'],
    injectScripts: ['content/features/saved-search-export/saved-search-export-client.js']
  },
  {
    id: 'field-finder',
    label: 'Field Finder',
    group: 'search',
    description: 'Quick-filter search columns and criteria fields by ID or label.',
    defaultEnabled: true,
    pageTypes: ['search-edit', 'workflow'],
    trigger: 'auto',
    contentScripts: ['content/features/field-finder/field-finder.js'],
    contentStyles: ['content/features/field-finder/field-finder.css'],
    injectScripts: ['content/features/field-finder/field-finder-client.js']
  },
  {
    id: 'quick-search-creation',
    label: 'Quick Search Creation',
    group: 'search',
    description: 'Shortcut buttons to create common saved searches from templates.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/quick-search-creation/quick-search-creation.js'],
    contentStyles: ['content/features/quick-search-creation/quick-search-creation.css'],
    injectScripts: []
  },

  // ── Record ────────────────────────────────────────────────────────────────
  {
    id: 'field-help',
    label: 'Field Help Tooltips',
    group: 'record',
    description: 'Enhanced field help popups — shows field ID, value, select options, and set-value on any page.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-edit', 'search-results', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/field-help/field-help.js'],
    contentStyles: ['content/features/field-help/field-help.css'],
    injectScripts: ['content/features/field-help/field-help-client.js']
  },
  {
    id: 'transaction-tree',
    label: 'Transaction Tree',
    group: 'record',
    description: 'Visualize the full transaction chain (SO > IF > INV) as an interactive tree.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'auto',
    contentScripts: ['content/features/transaction-tree/transaction-tree.js'],
    contentStyles: ['content/features/transaction-tree/transaction-tree.css'],
    injectScripts: []
  },

  // ── Layout ────────────────────────────────────────────────────────────────
  {
    id: 'split-view',
    label: 'Split View',
    group: 'layout',
    description: 'Open the current page in a side-by-side split pane.',
    defaultEnabled: false,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'list', 'other'],
    trigger: 'contextmenu',
    contentScripts: ['content/features/split-view/split-view.js'],
    contentStyles: ['content/features/split-view/split-view.css'],
    injectScripts: []
  },
  {
    id: 'fixed-headers',
    label: 'Fixed Headers',
    group: 'layout',
    description: 'Pin sublist headers so they stay visible when scrolling long line lists.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'list'],
    trigger: 'auto',
    contentScripts: ['content/features/fixed-headers/fixed-headers.js'],
    contentStyles: ['content/features/fixed-headers/fixed-headers.css'],
    injectScripts: []
  },

  // ── Misc ──────────────────────────────────────────────────────────────────
  {
    id: 'account-color',
    label: 'Account Color',
    group: 'misc',
    description: 'Color-code the NetSuite header bar per account (production vs. sandbox).',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/ns-utils/account-color/account-color.js'],
    contentStyles: ['content/features/ns-utils/account-color/account-color.css'],
    injectScripts: []
  },
  {
    id: 'nav-search',
    label: 'Navigation Search',
    group: 'misc',
    description: 'Keyboard-driven fuzzy search across NetSuite menu items (Ctrl+Shift+K).',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: [
      'content/features/ns-utils/nav-search/nav-search-pages.js',
      'content/features/ns-utils/nav-search/nav-search.js'
    ],
    contentStyles: ['content/features/ns-utils/nav-search/nav-search.css'],
    injectScripts: []
  },
  {
    id: 'pdf-tools',
    label: 'PDF Template Tools',
    group: 'misc',
    description: 'Live preview and syntax helpers for Advanced PDF/HTML templates.',
    defaultEnabled: false,
    pageTypes: ['pdf-template'],
    trigger: 'auto',
    contentScripts: ['content/features/pdf-tools/pdf-tools.js'],
    contentStyles: ['content/features/pdf-tools/pdf-tools.css'],
    injectScripts: []
  },
  {
    id: 'csv-viewer',
    label: 'CSV Import Viewer',
    group: 'misc',
    description: 'Preview CSV import files in a formatted table before submitting.',
    defaultEnabled: false,
    pageTypes: ['csv-import'],
    trigger: 'auto',
    contentScripts: ['content/features/csv-viewer/csv-viewer.js'],
    contentStyles: ['content/features/csv-viewer/csv-viewer.css'],
    injectScripts: []
  },
  {
    id: 'workflow-colors',
    label: 'Workflow Colors',
    group: 'misc',
    description: 'Color-code workflow states and transitions for easier visual parsing.',
    defaultEnabled: true,
    pageTypes: ['workflow'],
    trigger: 'auto',
    contentScripts: ['content/features/workflow-colors/workflow-colors.js'],
    contentStyles: ['content/features/workflow-colors/workflow-colors.css'],
    injectScripts: []
  },
  {
    id: 'better-page-titles',
    label: 'Better Page Titles',
    group: 'misc',
    description: 'Rewrite browser tab titles to include record type and name for easier tab-switching.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit', 'search-results', 'search-edit', 'search-list',
                'script-record', 'suitelet', 'dashboard', 'list', 'setup', 'other'],
    trigger: 'auto',
    contentScripts: ['content/features/better-page-titles/better-page-titles.js'],
    contentStyles: [],
    injectScripts: []
  },
  {
    id: 'csv-template-generator',
    label: 'CSV Template Generator',
    group: 'misc',
    description: 'Generate a CSV import/export template from the current NetSuite record — all fields, mandatory only, with values, or a manual selection.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/csv-template-generator/csv-template-generator.js'],
    contentStyles: ['content/features/csv-template-generator/csv-template-generator.css'],
    injectScripts: ['content/features/csv-template-generator/csv-template-generator-client.js']
  },

  // ── Record ────────────────────────────────────────────────────────────────
  {
    id: 'audit-trail',
    label: 'Audit Trail',
    group: 'record',
    description: 'View the full system notes / change history for the current record — sortable, filterable, and exportable.',
    defaultEnabled: true,
    pageTypes: ['record-view', 'record-edit'],
    trigger: 'popup',
    contentScripts: ['content/features/audit-trail/audit-trail.js'],
    contentStyles: ['content/features/audit-trail/audit-trail.css'],
    injectScripts: []
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    id: 'search-url-builder',
    label: 'Search URL Builder',
    group: 'search',
    description: 'Generate shareable results URLs, edit links, and SuiteScript 2.1 snippets for the current saved search.',
    defaultEnabled: true,
    pageTypes: ['search-results', 'search-edit', 'search-list'],
    trigger: 'popup',
    contentScripts: ['content/features/search-url-builder/search-url-builder.js'],
    contentStyles: ['content/features/search-url-builder/search-url-builder.css'],
    injectScripts: []
  }
];
