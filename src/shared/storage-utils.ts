/**
 * storage-utils.ts
 * TactaSuite NS Toolkit - Chrome Storage Wrapper
 *
 * @author Blane Maher
 *
 * Provides a Promise-based abstraction over chrome.storage.local for
 * managing feature states, user settings, and meeting mode. All keys
 * are namespaced with 'tacta_' to prevent collisions.
 */

export namespace TactaStorage {
    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    const FEATURE_STATES_KEY = 'featureStates';
    const SETTING_PREFIX = 'tacta_setting_';
    const MEETING_MODE_KEY = 'meetingMode';

    // ────────────────────────────────────────────────────────────────
    // Internal helpers
    // ────────────────────────────────────────────────────────────────

    function _storage(): chrome.storage.LocalStorageArea {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return chrome.storage.local;
        }
        throw new Error('TactaStorage: chrome.storage.local is not available.');
    }

    function _get(keys: string | string[] | Record<string, any> | null): Promise<Record<string, any>> {
        return new Promise((resolve, reject) => {
            _storage().get(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(result);
                }
            });
        });
    }

    function _set(items: Record<string, any>): Promise<void> {
        return new Promise((resolve, reject) => {
            _storage().set(items, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve();
                }
            });
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Public API
    // ────────────────────────────────────────────────────────────────

    /**
     * Retrieves the enabled/disabled state of a feature.
     */
    export function getFeatureState(featureId: string): Promise<boolean> {
        return _get(FEATURE_STATES_KEY).then((result) => {
            const states = result[FEATURE_STATES_KEY] || {};
            return !!states[featureId];
        });
    }

    /**
     * Sets the enabled/disabled state of a feature.
     */
    export function setFeatureState(featureId: string, enabled: boolean): Promise<void> {
        return _get(FEATURE_STATES_KEY).then((result) => {
            const states = result[FEATURE_STATES_KEY] || {};
            states[featureId] = !!enabled;
            return _set({ [FEATURE_STATES_KEY]: states });
        });
    }

    /**
     * Returns the enabled/disabled state of all features as a plain object.
     */
    export function getAllFeatureStates(): Promise<Record<string, boolean>> {
        return _get(FEATURE_STATES_KEY).then((result) => {
            return result[FEATURE_STATES_KEY] || {};
        });
    }

    /**
     * Retrieves a user setting value.
     */
    export function getSetting<T = any>(key: string, defaultValue: T | null = null): Promise<T> {
        const storageKey = SETTING_PREFIX + key;
        return _get({ [storageKey]: defaultValue }).then((result) => {
            return result[storageKey];
        });
    }

    /**
     * Stores a user setting value.
     */
    export function setSetting(key: string, value: any): Promise<void> {
        return _set({ [SETTING_PREFIX + key]: value });
    }

    /**
     * Checks whether "meeting mode" is active.
     */
    export function isMeetingMode(): Promise<boolean> {
        return _get({ [MEETING_MODE_KEY]: false }).then((result) => {
            return !!result[MEETING_MODE_KEY];
        });
    }

    /**
     * Enables or disables meeting mode.
     */
    export function setMeetingMode(enabled: boolean): Promise<void> {
        return _set({ [MEETING_MODE_KEY]: !!enabled });
    }
}

// Global exposure for non-module contexts
if (typeof window !== 'undefined') {
    (window as any).TactaStorage = TactaStorage;
}
