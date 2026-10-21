# Privacy Policy — NetSuite TactaSuite

**Author:** Blane Maher
**Last updated:** 2026-05-22

## Summary

NetSuite TactaSuite ("the extension") does not collect, transmit, or sell any user data. It does not contact any remote server controlled by the developer or any third party. All settings and state are stored locally on your device.

## What the extension stores

The extension stores the following information **locally** in `chrome.storage.local`. This data never leaves your device.

| Stored item | Purpose |
|---|---|
| Feature toggle states (on/off per feature) | Remember which features you have enabled. |
| User type preset (`user` or `developer`) | Apply the matching default feature set. |
| Meeting Mode flag | Suppress visual modifications during screen shares. |
| Panel position and size for the SuiteQL Runner | Restore window state across page loads. |
| SuiteQL query history (up to 20 entries) | Recall recent queries from the SuiteQL Runner. |
| Quick Search type selections | Remember which search types you have enabled in the Quick Search toolbar. |
| Theme settings (color scheme, accent color) | Apply your chosen visual theme. |
| Account Color settings (production / sandbox colors) | Color-code the NetSuite header per environment. |
| Generic UI state (group collapse, "close on click outside") | Remember UI preferences. |

## What the extension reads from NetSuite

The extension's content scripts run only on `*.netsuite.com` pages, and only to render the features documented in the [README](./README.md). It reads:

- The current page URL (to detect production vs. sandbox and which page type is loaded).
- DOM content of the current NetSuite page (to inspect fields, sublist rows, search results, etc., for the features you have enabled).
- NetSuite's own JavaScript APIs (`require`, `nlapi*`, `currentRecord`) where applicable, for features such as Field Explorer, Record Object Viewer, SuiteQL Runner, and Saved Search Export.

This information is processed entirely inside your browser and never transmitted to any external endpoint.

## What the extension does NOT do

- It does **not** include any AI, ML, or large-language-model integration.
- It does **not** make any network requests to the extension developer.
- It does **not** make any network requests to third-party analytics, telemetry, error-tracking, or advertising services.
- It does **not** collect personally identifiable information.
- It does **not** collect, share, or sell browsing history, NetSuite data, or any other user content.
- It does **not** modify or transmit NetSuite records on its own initiative — every NetSuite write (e.g., saved search creation, field updates from Field Explorer) is initiated by an explicit user action.

## Network access

The extension's `manifest.json` requests host access only for `https://*.netsuite.com/*`. NetSuite uses per-account subdomains (for example `1234567.app.netsuite.com`), so the wildcard is required for the extension to function. The extension does not declare host access for any other origin.

## Permissions

See [README.md](./README.md#permissions) for the full list of Chrome permissions and what each is used for.

## Data export and deletion

All extension data lives in `chrome.storage.local`. You can:

- **Export** your settings via the **Export** button on the options page (downloads a JSON file).
- **Reset to defaults** via the options page (clears feature toggle preferences).
- **Remove everything** by uninstalling the extension from `chrome://extensions`. Chrome clears all associated `chrome.storage.local` data automatically on uninstall.

## Changes

If this policy changes in a future version, the updated text will be published in this file and the **Last updated** date will be revised.

## Contact

For questions or concerns about privacy, open an issue on the project's source repository.
