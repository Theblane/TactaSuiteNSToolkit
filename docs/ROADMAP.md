# NetSuite TactaSuite - Roadmap

Source: `docs/competitive-review-2026-10-21.md`, `background/modules/feature-registry.js`, `manifest.json`, `STORE_LISTING.md`.

A feature counts as landed only when it has a registry entry, a test, and a line in STORE_LISTING.md. User types: **T** Traditional User, **A** Administrator, **D** Developer. "On for" means default-enabled for that type (the registry `audience` array); everyone can toggle anything.

## 1. Principles

1. **Single purpose holds.** Every item must fit "NetSuite admin and developer productivity tools." Nothing runs outside `*.netsuite.com` / `*.oracle.com` except the user-configured AI provider call.
2. **No remote code, ever.** No `eval`, `new Function`, remote scripts, or File Cabinet-loaded JS. Third-party libs are vendored. AI calls are data APIs, not code; the CWS Remote Code answer stays **No**.
3. **Permissions are a budget.** New permissions go in `optional_permissions` / `optional_host_permissions` and are requested when the user enables the feature. Each one gets a justification paragraph in STORE_LISTING.md before the version ships. `<all_urls>`, `webRequest`, `cookies`, `history` are never added.
4. **Writes confirm; destructive is gated.** Any mutation (`submitFields`, delete, execute script, deployment edits) shows a confirmation naming environment, record count, and action. Destructive bulk actions sit behind a Developer-only toggle, off by default, and refuse to run on PROD unless the user types the account id.
5. **AI is grounded and read-only.** Two providers only (Claude on Amazon Bedrock via the Converse API with a user API key, NetSuite N/llm via a user-deployed RESTlet). Tools: read-only SuiteQL (SELECT/WITH only, parsed before send), Records Catalog, current record snapshot. No `update_record`, no `run_suitescript`. Prompts leave the machine only to the provider the user configured. Keys live in `chrome.storage.local`, never `sync`.
6. **Light mode default**, Tactacam dark theme optional. Left-aligned panels, no centering. Meeting Mode suppresses everything.
7. **Brittle endpoints are quarantined.** Only `rcendpoint.nl` and `scriptedrecord.nl` are accepted undocumented endpoints. Each lives in one adapter so a release change breaks one feature, not the extension.
8. **Caches are per-account.** Schema and catalog caches key on account id with a TTL and size cap.
9. **Listing truth.** STORE_LISTING.md's "No remote API calls. No AI integration." must be rewritten and PRIVACY.md updated before the Phase 1 build is submitted.

## 2. Phases

### Phase 1 - In progress (v1.2)

| Item | Source | Technique | Eff | Perms | Risk | On for |
|---|---|---|---|---|---|---|
| Onboarding walkthrough + user types | own | `onboarding/` page opened on install; registry `audience` seeds toggles per type | M | none | - | all |
| Popup gear settings | own | inline panel: user type, theme, click-outside, links to walkthrough / AI settings / options | S | none | - | all |
| Light-mode default | own | `theme-manager.js` default flip, `:root` defaults in CSS | S | none | Existing users who never saved a theme switch to light | all |
| AI Assistant (Bedrock + N/llm) | Full Tools (pattern), own tools | Bedrock Converse via fetch with bearer key; N/llm via RESTlet the user deploys from shipped source; tools: SuiteQL SELECT-only, rcendpoint, current record | L | optional host `https://*.amazonaws.com/*` | Listing rewrite required; key handling; cost | A, D |
| Environment badge | TDT, SuiteAdvanced | hostname regex, pill + `[SBn]` title prefix | S | none | - | all |
| Transaction Trail chips | TDT | SuiteQL on nexttransactionlinelink, breadcrumb at page top | S | none | - | all |
| Dataset to SuiteQL | SuiteAdvanced | page-world `N/query.load(id).toSuiteQL()` | S | none | Needs `require` on dataset page | A, D |
| Portlet refresher | Portlet Refresher | timer click on `.ns-portlet-icon-refresh[data-action="refresh"]` on `/app/center/card*` | S | none | - | all (off) |
| Instant UI | Full Tools | CSS class forcing 1 ms animations/transitions | S | none | Scope selectors away from toolkit UI | all (off) |
| Screenshot Studio + privacy masks | TDT | `tabs.captureVisibleTab`, scroll-stitch, text-node masks | M | none (activeTab) | Fixed headers in stitch | all |
| SuiteQL saved queries + JSON export | all five | `tacta_sql_saved`; JSON blob download | S | none | - | A, D |
| nav-search script-id lookup | SuiteAdvanced | `customscript_*` / `customrecord_*` / `custbody_*` prefix to SuiteQL to record URL | S | none | - | all |
| Field history in Field Explorer and Field Help | Full Tools | `SELECT ... FROM systemnote WHERE record = ? AND field = ?` | S | none | Permission-dependent for T | A, D |

### Phase 2 - Developer core (v1.3)

| Item | Source | Technique | Eff | Perms | Risk | On for |
|---|---|---|---|---|---|---|
| SuiteQL autocomplete + schema browser | Query Tool, Consultants | `rcendpoint.nl?action=getRecordTypes` and `getRecordTypeDetail&detailType=SS_ANAL`; cached per account; side tree of fields and joins | M | none | Undocumented endpoint | D |
| SuiteQL runner extras | SuiteAdvanced, TDT, Full Tools | `${var}` params, `_color/_bg/_html` columns, clickable `type:id`, AbortController, XLSX + Copy-as-SuiteScript, REST `/services/rest/query/v1/suiteql` with `Prefer: transient` falling back to page-world `N/query` | M | none | Transport choice | D |
| Record Scripts panel | TDT, Consultants, SuiteAdvanced | fetch `scriptedrecord.nl?id=<TYPE>`, parse `tr.uir-machine-headerrow`; per-deployment status incl. Maxed; fold into `script-analyzer` | M | none | HTML parse brittleness | A, D |
| Record Logs Viewer | Full Tools | SuiteQL `scriptNote` join `ScriptDeployment` filtered to scripts on this record; side panel | M | none | - | D |
| Execute Scheduled / Map-Reduce with progress | Full Tools, SuiteAdvanced | hidden iframe `NLMultiButton_doAction("submitexecute")`, poll `scheduledscriptinstance` | M | none | Write action: confirm with env | D |
| Customization Finder | Full Tools, Consultants | one SuiteQL fan-out over `script`, `workflow`, `customfield`, `savedsearch`, `file`, `customrecordtype` | M | none | Query cost on large accounts; paginate | A, D |
| Go to Record + prefixes | Full Tools, SuiteAdvanced | `tranid` lookup, `search:`, `bundle:`, `path:` in nav-search | S | none | - | all |
| Search Fields Finder | Full Tools | overlay filter on large field `<select>` pickers; extend `field-finder` | S | none | - | A, D |
| Batch search filters | Full Tools | MAIN-world wrap of `doServerSort` / `appendFormDataToURL` to defer reload | S | none | Wraps NS globals | A, D |
| Bulk Summary Type | SuiteAdvanced, Full Tools | set all summary selects on search results edit | S | none | - | A, D |
| Formula `{field}` autocomplete | SuiteAdvanced, Full Tools | vendored autocomplete popup fed by rcendpoint joins | M | none | - | A, D |
| Field popup: Open Setup link, sublist column ids | TDT, SuiteAdvanced | prefix to `/app/common/custom/{body,column,entity,item}custfield.nl`; `window.machines[x].dataManager.fields` | S | none | - | A, D |

### Phase 3 - Admin operations (v1.4)

| Item | Source | Technique | Eff | Perms | Risk | On for |
|---|---|---|---|---|---|---|
| Script Manager with rollback | Consultants | snapshot `isdeployed/status/loglevel`; `record.submitFields` on `scriptdeployment`; restore from snapshot | M | none | Write; mandatory dry-run preview | D |
| Server log search | Consultants | N/search `scriptexecutionlog` with `contains`, date window | S-M | none | Slow on big accounts | D |
| Runtime heatmap | SuiteAdvanced | 4 weeks of `scheduledscriptinstance` / execution data, canvas grid | M | none | - | D |
| 2028.2 SS1 readiness | Consultants | SuiteQL `script` + `file`, header scan for `@NApiVersion`, bundle attribution by folder; CSV report | M | none | File reads count toward governance | A, D |
| Role bulk edit / export / compare | SuiteAdvanced | SuiteQL `role` + permission tables for export/compare; edits via role record `submitFields` | L | none | Write; confirm per role | A |
| Enable Features / Preferences / Company Info export | SuiteAdvanced | scrape setup pages to CSV | S | none | Setup page DOM changes | A |
| Live View auto-refresh | SuiteAdvanced | fetch `?ifrmcntnr=T`, swap `table#div__body` | S | none | View-only pages | A, D |
| Tab grouping + session return | Full Tools | `tabGroups` by account id, env color; store last URL on login redirect and return | S-M | `tabs`, `tabGroups` | Two new permissions, user-opt-in | all |
| Sandbox refresh date, env favicon, Release Preview banner | SuiteAdvanced | `loginaudit` SuiteQL, favicon swap | S | none | - | all |
| Command palette | TDT, Full Tools | extend nav-search with recents, pins, feature launchers | S | none | - | all |

### Phase 4 - Power features (v1.5)

| Item | Source | Technique | Eff | Perms | Risk | On for |
|---|---|---|---|---|---|---|
| File Cabinet drag-drop, zip, quick actions | SuiteAdvanced, Full Tools | drop to `N/file.create` page-world; zip via `CompressionStream`; row actions | L | none | Write; large uploads | D |
| Form Customization reorder / bulk | Consultants | `window[list+"_machine"].moveline` | M-L | none | Undocumented machine API | A |
| PDF template preview / FreeMarker autocomplete | Full Tools | extend `pdf-tools`; render via `N/render` page-world | M | none | - | A, D |
| Dynamic PDF print Suitelet installer | Consultants | ship source the user deploys (same pattern as N/llm RESTlet) | M | none | - | A |
| Compare Records | Consultants | two `record.load` snapshots, diff table | M | none | - | A, D |
| Copy from another record | Consultants | load source, `setValue` loop on current, skip readonly | M | none | Write to unsaved form only | A, D |
| Protect Data blur | Consultants | CSS blur on configurable selectors, hover reveal | S | none | - | all |
| JSON viewer | Consultants, Full Tools | pretty-print for RESTlet/Suitelet JSON responses | S | none | Needs `/app/site/hosting/*` match | D |
| Tab recording | TDT | `tabCapture` + `offscreen` MediaRecorder to webm | M | `tabCapture`, `offscreen` (optional) | Heaviest permission ask | D |
| NetSuite dark theme | SuiteAdvanced, Full Tools | CSS variable override sheet | L | none | High maintenance | opt-in only |

### Phase 5 - Destructive (v1.6, Developer toggle, off by default)

| Item | Source | Technique | Eff | Perms | Risk | On for |
|---|---|---|---|---|---|---|
| Batch Delete | Consultants | `record.delete.promise` in reloadable iframe, resumable queue, CSV log | L | none | Irreversible; PROD lock; typed account id | none |
| Mass deployment changes | Consultants | Script Manager multi-select apply with snapshot | M | none | Rollback required before enable | none |
| Right-click Field Actions (mandatory / editable) | Consultants | `field.isMandatory` / `isDisplay` on currentRecord, session-only | M | none | Masks validation; banner while active | none |

## 3. Explicitly excluded

| Item | Why |
|---|---|
| File Cabinet or S3 script auto-loading (SuiteAdvanced) | Remote code; CWS hard rule and supply-chain exposure |
| Console REPL with `new Function` (Full Tools) | Remote code posture; deferred, not scheduled |
| Executing NS inline `onclick` strings via `new Function` (TDT) | Same |
| LLM tools that mutate (`update_record`, `run_suitescript`) | Violates read-only AI principle |
| Upsell banner, PayPal pixel, email posting to Apps Script | Privacy promises |
| `nlapijsonhandler.nl`, `PlatformClientScriptHandler.nl`, `NLNavMenuData.nl` | Too brittle; only `rcendpoint.nl` and `scriptedrecord.nl` accepted |
| Hard-coded customer field ids (TDT `custbody5`) | Not generic |

## 4. Permission budget

| Permission | Now | Phase | Type | Justification summary |
|---|---|---|---|---|
| `storage`, `activeTab`, `scripting`, `declarativeContent`, `contextMenus` | yes | - | required | unchanged |
| host `*.netsuite.com`, `*.oracle.com` | yes | - | required | unchanged |
| host `https://*.amazonaws.com/*` | optional | 1 | optional host | Claude on Bedrock, user key, requested on save |
| `unlimitedStorage` | no | 2 (if needed) | optional | schema cache; decide after measuring |
| `tabs`, `tabGroups` | no | 3 | optional | account tab grouping, session return |
| `tabCapture`, `offscreen` | no | 4 | optional | tab recording |
| `<all_urls>`, `webRequest`, `cookies`, `history`, `nativeMessaging` | no | never | - | - |

Manifest also needs a new `content_scripts` match for `/app/site/hosting/*` in Phase 4. Dashboard pages (`/app/center/card.nl`) are already covered by the `/app/*` match.

## 5. Testing per phase

Harness today: `tests/field-explorer-pageworld.test.ts` extracts page-world functions from `background/service-worker.js` by name and runs them headless against fixture HTML; `tests/extension.test.ts` loads the extension headful. Playwright cannot log in to NetSuite (MFA), so live verification is chrome-devtools-mcp `reload_extension` against a sandbox with a short checklist per feature.

- **Phase 1.** Pure-function fixtures: hostname regex table (PROD, sb1, sandbox2, system), trail chips from a recorded tree payload, systemnote query builder, mask geometry. AI: snapshot test of the tool list (fails if any tool outside the allowlist), SELECT-only parser rejects `UPDATE`/`DELETE`/`;`. Popup test extended for gear and user-type defaults. Live: reload, open a record in a sandbox, run through badge, trail, screenshot, assistant with N/llm.
- **Phase 2.** Record scrubbed `rcendpoint.nl` and `scriptedrecord.nl` responses as fixtures; parser tests fail loudly on shape change. Execute-script poller tested with fake iframe and fake `scheduledscriptinstance` rows. Transport fallback test (REST 403 to N/query).
- **Phase 3.** Script Manager snapshot, apply, rollback round trip against mocked `submitFields`; dry-run must produce zero calls. `tabGroups` behavior in headful test with two fake account URLs.
- **Phase 4.** Zip output unzipped and compared in test; drag-drop fixture; recording smoke test headful; Compare Records diff on two fixture records.
- **Phase 5.** Gate tests: no delete call without Developer toggle, confirmation, and env acknowledgement; PROD lock test; queue resume after simulated reload.

## 6. Open decisions

1. **SuiteQL transport (Phase 2).** REST with `Prefer: transient` (fast, needs REST permission on role) versus page-world `N/query` (works everywhere `require` exists) versus hidden `userprefs.nl` iframe for pages without `require`. Recommend REST first, N/query fallback, iframe only if the fallback misses common pages.
2. **Tab recording (Phase 4).** `tabCapture` + `offscreen` versus `desktopCapture` picker. Decide at Phase 4 start.
3. **Installers.** Ship script source the user deploys (chosen for the N/llm RESTlet) versus creating script records from the extension. Keep shipping source; it keeps the extension out of the write path.
4. **`unlimitedStorage`.** Only if the measured schema cache for typical accounts exceeds roughly 5 MB.
