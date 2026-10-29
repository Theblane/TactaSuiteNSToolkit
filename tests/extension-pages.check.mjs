/**
 * NetSuite TactaSuite - extension page smoke check (not a Playwright test file)
 *
 * @author Blane Maher
 *
 * Launches Chromium with the unpacked extension, opens the onboarding, options
 * and popup pages, and reports console errors, key DOM state and screenshots.
 * Run: node tests/extension-pages.check.mjs   (from the project root)
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'test-results', 'pages');
fs.mkdirSync(OUT, { recursive: true });
const userData = path.join(OUT, 'profile-' + Date.now());

const context = await chromium.launchPersistentContext(userData, {
  channel: 'chromium',
  headless: true,
  args: ['--disable-extensions-except=' + ROOT, '--load-extension=' + ROOT],
  viewport: { width: 1100, height: 900 }
});

let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('extension id:', extId, 'sw:', sw.url());

// First install opens the onboarding tab automatically; give it a moment.
await new Promise((r) => setTimeout(r, 1500));
const autoOpened = context.pages().filter((p) => p.url().includes('onboarding'));
console.log('onboarding auto-opened on install:', autoOpened.length > 0);

async function check(name, url, probe) {
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const state = await page.evaluate(probe);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
  console.log('\n=== ' + name + ' (' + url.replace(extId, 'EXT') + ')');
  console.log('state:', JSON.stringify(state, null, 1));
  console.log('console errors/warnings:', errors.length ? errors : 'none');
  return { page, state, errors };
}

const base = 'chrome-extension://' + extId + '/';

const ob = await check('onboarding', base + 'onboarding/onboarding.html', () => ({
  title: document.title,
  counter: document.getElementById('obProgressCounter')?.textContent,
  stepChildren: document.getElementById('obStep')?.children.length,
  stepHeading: document.querySelector('#obStep h1')?.textContent,
  milestones: Array.from(document.querySelectorAll('#obMilestones li')).map((li) => li.textContent),
  scheme: document.documentElement.dataset.tactaTheme,
  bg: getComputedStyle(document.body).backgroundColor
}));

// Walk: Next -> choose Developer -> Next -> first feature page
await ob.page.click('#obNextBtn');
await ob.page.waitForTimeout(300);
const roleCards = await ob.page.$$('[data-user-type], .tacta-ob-role, button');
const devBtn = await ob.page.$('[data-user-type="developer"], [data-role="developer"]');
if (devBtn) { await devBtn.click(); await ob.page.waitForTimeout(400); }
const afterRole = await ob.page.evaluate(() => ({
  counter: document.getElementById('obProgressCounter')?.textContent,
  nextDisabled: document.getElementById('obNextBtn')?.disabled,
  heading: document.querySelector('#obStep h1')?.textContent
}));
console.log('after role step:', JSON.stringify(afterRole), 'role buttons found:', roleCards.length, 'devBtn:', !!devBtn);
if (!afterRole.nextDisabled) {
  await ob.page.click('#obNextBtn');
  await ob.page.waitForTimeout(400);
  const feat = await ob.page.evaluate(() => ({
    counter: document.getElementById('obProgressCounter')?.textContent,
    heading: document.querySelector('#obStep h1')?.textContent,
    toggles: document.querySelectorAll('#obStep input[type="checkbox"]').length,
    checked: document.querySelectorAll('#obStep input[type="checkbox"]:checked').length
  }));
  console.log('first feature page:', JSON.stringify(feat));
  await ob.page.screenshot({ path: path.join(OUT, 'onboarding-features.png'), fullPage: true });
}
const stored = await sw.evaluate(() => chrome.storage.local.get(['tacta_user_type', 'featureStates', 'tacta_onboarding_progress', 'tacta_theme_settings']));
console.log('storage after walk:', JSON.stringify({ userType: stored.tacta_user_type, progress: stored.tacta_onboarding_progress, enabledCount: Object.values(stored.featureStates || {}).filter(Boolean).length, theme: stored.tacta_theme_settings }));

const opt = await check('options', base + 'options/options.html', () => ({
  title: document.title,
  featureCards: document.querySelectorAll('.tacta-opt-feature-card').length,
  groups: Array.from(document.querySelectorAll('.tacta-opt-group-name')).map((e) => e.textContent),
  userType: document.getElementById('userTypeSelect')?.value,
  scheme: document.documentElement.dataset.tactaTheme,
  // Claude Desktop Bridge card (shared/bridge-settings-ui.js)
  bridgeBadge: document.querySelector('#bridge .tacta-opt-badge')?.textContent,
  bridgeEnable: !!document.getElementById('brEnabled'),
  bridgeSetupFirst: (() => {
    const card = document.getElementById('bridgeCard');
    const first = card && card.firstElementChild;
    return !!(first && first.matches('details.tacta-br-setup') && first.hasAttribute('open'));
  })(),
  bridgeSnippets: document.querySelectorAll('#bridgeCard .tacta-br-snippet').length,
  bridgeSnippetHasExtId: (document.getElementById('brSnippetFull')?.textContent || '').includes(chrome.runtime.id),
  bridgeSandboxOnly: !!document.getElementById('brSandboxOnly'),
  bridgeWriteWarning: !!document.querySelector('#bridgeCard .tacta-br-warn strong'),
  bridgeFaq: document.querySelectorAll('#bridgeCard .tacta-br-faq dt').length,
  feedbackButtons: document.querySelectorAll('[data-tacta-feedback]').length
}));
const optState = opt.state;
const optProblems = [];
if (!/beta/i.test(optState.bridgeBadge || '')) optProblems.push('bridge badge should say Beta: ' + optState.bridgeBadge);
if (!optState.bridgeEnable) optProblems.push('bridge enable switch missing');
if (!optState.bridgeSetupFirst) optProblems.push('bridge setup steps should be the first, open block in the card');
if (optState.bridgeSnippets < 3) optProblems.push('expected 3 config snippets (cases A, B, C), got ' + optState.bridgeSnippets);
if (!optState.bridgeSnippetHasExtId) optProblems.push('config snippet lacks the real extension id');
if (!optState.bridgeSandboxOnly) optProblems.push('Sandbox only toggle missing');
if (!optState.bridgeWriteWarning) optProblems.push('write-actions warning missing');
if (optState.bridgeFaq < 5) optProblems.push('FAQ too short: ' + optState.bridgeFaq);
if (optState.feedbackButtons < 2) optProblems.push('feedback buttons missing in About');
console.log('options assertions:', optProblems.length ? optProblems : 'all ok');
if (optProblems.length) process.exitCode = 1;

// Feedback form opens and composes a mailto: with the message.
const fb = await opt.page.evaluate(() => {
  document.querySelector('[data-tacta-feedback="bug"]').click();
  const dlg = document.querySelector('.tacta-fb');
  if (!dlg) return { opened: false };
  document.getElementById('tactaFbTitleIn').value = 'Smoke test';
  document.getElementById('tactaFbDetails').value = 'Details here';
  const msg = window.TactaFeedback.buildMessage({ type: 'bug', title: 'Smoke test', details: 'Details here', includeTech: true, features: ['a'], userType: 'developer' });
  const target = window.TactaFeedback.targetUrl(msg);
  window.TactaFeedback.close();
  return { opened: true, kind: target.kind, urlStart: target.url.slice(0, 40), subjectOk: msg.subject.includes('Smoke test'), bodyHasVersion: /Extension: .* v\d/.test(msg.body) };
});
console.log('feedback form:', JSON.stringify(fb));
if (!fb.opened || !fb.subjectOk || !fb.bodyHasVersion) { console.log('feedback form assertions FAILED'); process.exitCode = 1; }

const pop = await check('popup', base + 'popup/popup.html', () => ({
  title: document.title,
  quickActions: document.querySelectorAll('.tacta-action-btn').length,
  groups: Array.from(document.querySelectorAll('.tacta-group-name')).map((e) => e.textContent),
  toggles: document.querySelectorAll('input[data-feature-id]').length,
  gear: !!document.getElementById('settingsToggle'),
  panelHidden: document.getElementById('settingsPanel')?.hasAttribute('hidden'),
  feedbackBtn: !!document.getElementById('feedbackBtn'),
  version: document.querySelector('.tacta-version')?.textContent,
  scheme: document.documentElement.dataset.tactaTheme
}));
if (!pop.state.feedbackBtn) { console.log('popup: Send feedback button missing'); process.exitCode = 1; }
// Open the gear panel and the feedback form so both get a screenshot at popup width.
await pop.page.setViewportSize({ width: 400, height: 600 });
await pop.page.click('#settingsToggle');
await pop.page.screenshot({ path: path.join(OUT, 'popup-gear.png'), fullPage: true });
await pop.page.click('#feedbackBtn');
await pop.page.waitForSelector('.tacta-fb', { timeout: 3000 });
await pop.page.screenshot({ path: path.join(OUT, 'popup-feedback.png'), fullPage: true });
console.log('popup gear + feedback screenshots taken');

await context.close();
console.log('\nscreenshots in', OUT);
