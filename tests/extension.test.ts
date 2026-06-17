import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';

const extensionPath = path.resolve(__dirname, '../dist');

test.describe('TactaSuite NS Toolkit', () => {
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
});
