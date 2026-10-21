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

await check('options', base + 'options/options.html#ai', () => ({
  title: document.title,
  featureCards: document.querySelectorAll('.tacta-opt-feature-card').length,
  groups: Array.from(document.querySelectorAll('.tacta-opt-group-name')).map((e) => e.textContent),
  aiMounted: !!document.querySelector('#aiSettingsMount .tacta-ai-set-root, #aiSettingsMount [class*="tacta-ai-set"]'),
  aiMountText: document.getElementById('aiSettingsMount')?.textContent.trim().slice(0, 80),
  userType: document.getElementById('userTypeSelect')?.value,
  scheme: document.documentElement.dataset.tactaTheme
}));

await check('popup', base + 'popup/popup.html', () => ({
  title: document.title,
  quickActions: document.querySelectorAll('.tacta-action-btn').length,
  groups: Array.from(document.querySelectorAll('.tacta-group-name')).map((e) => e.textContent),
  toggles: document.querySelectorAll('input[data-feature-id]').length,
  gear: !!document.getElementById('settingsToggle'),
  panelHidden: document.getElementById('settingsPanel')?.hasAttribute('hidden'),
  version: document.querySelector('.tacta-version')?.textContent,
  scheme: document.documentElement.dataset.tactaTheme
}));

await context.close();
console.log('\nscreenshots in', OUT);
