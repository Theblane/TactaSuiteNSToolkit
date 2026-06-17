/**
 * theme-manager.ts
 * TactaSuite NS Toolkit - Theme Manager
 *
 * @author Blane Maher
 *
 * Applies user-selected toolkit theme variables in extension pages and
 * injected NetSuite UI.
 */

import { TactaStorage } from './storage-utils';

export namespace TactaThemeManager {
    /** Theme storage key */
    const THEME_KEY = 'theme';

    /** Default theme */
    const DEFAULT_THEME = 'dark';

    /**
     * Initializes the theme manager. Reads the stored theme and applies
     * it to the current document.
     */
    export async function init(): Promise<void> {
        const theme = await TactaStorage.getSetting(THEME_KEY, DEFAULT_THEME);
        applyTheme(theme);

        // Listen for storage changes to update theme in real-time
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes['tacta_setting_' + THEME_KEY]) {
                    applyTheme(changes['tacta_setting_' + THEME_KEY].newValue);
                }
            });
        }
    }

    /**
     * Applies the specified theme to the document.
     */
    export function applyTheme(theme: string): void {
        const root = document.documentElement;
        root.setAttribute('data-tacta-theme', theme || DEFAULT_THEME);
    }

    /**
     * Toggles between light and dark themes.
     */
    export async function toggleTheme(): Promise<string> {
        const current = await TactaStorage.getSetting(THEME_KEY, DEFAULT_THEME);
        const next = current === 'dark' ? 'light' : 'dark';
        await TactaStorage.setSetting(THEME_KEY, next);
        return next;
    }
}

// Global exposure
if (typeof window !== 'undefined') {
    (window as any).TactaThemeManager = TactaThemeManager;
}

// Auto-init
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TactaThemeManager.init(), { once: true });
    } else {
        TactaThemeManager.init();
    }
}
