import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';

const extensionPath = path.resolve(__dirname, '../dist');

test.describe('NetSuite TactaSuite', () => {
    let context: BrowserContext;

    test.beforeEach(async () => {
        context = await chromium.launchPersistentContext('', {
            headless: false, // Extensions only work in headful mode
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
        });
    });

    test.afterEach(async () => {
        if (context) await context.close();
    });

    test('extension popup should load', async () => {
        let [background] = context.serviceWorkers();
        if (!background) background = await context.waitForEvent('serviceworker');

        const extensionId = background.url().split('/')[2];
        const page = await context.newPage();

        await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await expect(page.locator('.tacta-logo-text')).toHaveText('NS Toolkit');
        await expect(page.locator('[data-action="field-explorer"]')).toBeVisible();
    });

    test('every popup-triggered feature has a launch surface', async () => {
        let [background] = context.serviceWorkers();
        if (!background) background = await context.waitForEvent('serviceworker');

        const extensionId = background.url().split('/')[2];
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

        // Quick Actions cover the most-used tools.
        for (const action of [
            'field-explorer', 'record-object', 'script-explorer', 'suiteql-runner',
            'csv-template-generator', 'audit-trail', 'search-url-builder', 'script-content-search',
        ]) {
            await expect(page.locator(`[data-action="${action}"]`)).toBeVisible();
        }

        // Anything else that only runs on request gets an Open button on its row.
        await page.waitForSelector('.tacta-feature-launch');
        const launchIds = await page.$$eval('.tacta-feature-launch[data-launch-id]',
            (els) => els.map((el) => (el as HTMLElement).dataset.launchId));

        expect(launchIds).toContain('console-snippets');
        expect(launchIds).toContain('csv-template-generator');

        // Console Snippets is Developer-only, so it ships disabled.
        await expect(page.locator('[data-launch-id="console-snippets"]')).toBeDisabled();
    });
});
