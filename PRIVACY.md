# Privacy Policy - NetSuite TactaSuite

**Author:** Blane Maher
**Last updated:** 2026-10-21

## Summary

NetSuite TactaSuite ("the extension") does not collect, transmit, or sell any user data, and never contacts any server controlled by the developer. All settings and state are stored locally on your device. The one exception to "no network calls" is the optional AI assistant: if you configure a provider yourself (Claude on Amazon Bedrock with your own API key, or NetSuite's own AI through a RESTlet you deploy into your account), your messages and the query results needed to answer them are sent to that provider when you press Send. See "AI assistant" below.

## What the extension stores

The extension stores the following information **locally** in `chrome.storage.local`. This data never leaves your device.

| Stored item | Purpose |
|---|---|
| Feature toggle states (on/off per feature) | Remember which features you have enabled. |
| User type preset (`user`, `admin` or `developer`) | Apply the matching default feature set. |
| Onboarding progress and completion flag | Resume or re-run the setup walkthrough. |
| AI assistant settings (provider choice, region, model, your API key or RESTlet ids, masking preference) | Configure the optional assistant. The key never leaves your device except as the authorization header to the provider you chose. |
| Meeting Mode flag | Suppress visual modifications during screen shares. |
| Panel position and size for the SuiteQL Runner | Restore window state across page loads. |
| SuiteQL query history and saved queries | Recall recent and named queries in the SuiteQL Runner. |
| Portlet auto-refresh interval, environment badge preferences | Remember small per-feature preferences. |
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

## AI assistant

The assistant is off until you configure it. It is grounded in the NetSuite account you are signed in to and can only read: it runs SuiteQL SELECT statements, looks up the Records Catalog, and reads the record on screen. It cannot create, update or delete anything.

- **What is sent:** your message, the schema metadata and query results the assistant needs, and (if you tick "Include this record") the field values of the record on screen. Emails, phone numbers, tax ids and card numbers are masked before sending unless you turn masking off.
- **Where it goes:** only to the provider you selected. With Claude on Amazon Bedrock, to `bedrock-runtime.<region>.amazonaws.com` using your API key. With NetSuite AI, to a RESTlet inside your own NetSuite account, so the data never leaves NetSuite.
- **When:** only when you press Send. Nothing runs in the background.
- **Developer access:** none. The developer never sees prompts, results or keys.

## What the extension does NOT do

- It does **not** contact any AI provider you have not configured yourself, and has no AI capability until you do.
- It does **not** make any network requests to the extension developer.
- It does **not** make any network requests to third-party analytics, telemetry, error-tracking, or advertising services.
- It does **not** collect personally identifiable information.
- It does **not** collect, share, or sell browsing history, NetSuite data, or any other user content.
- It does **not** modify or transmit NetSuite records on its own initiative - every NetSuite write (e.g., saved search creation, field updates from Field Explorer) is initiated by an explicit user action.

## Network access

The extension's `manifest.json` requests host access for `https://*.netsuite.com/*` and `https://*.oracle.com/*`. NetSuite uses per-account subdomains (for example `1234567.app.netsuite.com`), so the wildcard is required for the extension to function. One optional host permission, `https://*.amazonaws.com/*`, is requested at runtime only if you choose Claude on Amazon Bedrock as the assistant provider; you can revoke it at any time from the extension's details page in Chrome.

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
