/**
 * NetSuite TactaSuite — Storage Manager
 *
 * @author Blane Maher
 */

const STORAGE_KEYS = {
  FEATURE_STATES: 'featureStates',
  MEETING_MODE: 'meetingMode'
} as const;

export interface Feature {
    id: string;
    defaultEnabled: boolean;
    [key: string]: any;
}

/**
 * Populate default feature states on first install.
 */
export async function initDefaults(features: Feature[]): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.FEATURE_STATES);
  const existing = stored[STORAGE_KEYS.FEATURE_STATES] || {};

  const merged = { ...existing };
  let changed = false;

  for (const feature of features) {
    if (!(feature.id in merged)) {
      merged[feature.id] = feature.defaultEnabled;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [STORAGE_KEYS.FEATURE_STATES]: merged });
  }

  const meetingData = await chrome.storage.local.get(STORAGE_KEYS.MEETING_MODE);
  if (meetingData[STORAGE_KEYS.MEETING_MODE] === undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.MEETING_MODE]: false });
  }
}

/**
 * Retrieve the current enabled/disabled state for every feature.
 */
export async function getFeatureStates(): Promise<Record<string, boolean>> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.FEATURE_STATES);
  return data[STORAGE_KEYS.FEATURE_STATES] || {};
}

/**
 * Toggle a single feature on or off.
 */
export async function setFeatureState(featureId: string, enabled: boolean): Promise<void> {
  const states = await getFeatureStates();
  states[featureId] = enabled;
  await chrome.storage.local.set({ [STORAGE_KEYS.FEATURE_STATES]: states });
}

/**
 * Batch-update multiple feature states at once.
 */
export async function setFeatureStates(newStates: Record<string, boolean>): Promise<void> {
  const current = await getFeatureStates();
  const merged = { ...current, ...newStates };
  await chrome.storage.local.set({ [STORAGE_KEYS.FEATURE_STATES]: merged });
}

/**
 * Check whether meeting mode is currently active.
 */
export async function getMeetingMode(): Promise<boolean> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.MEETING_MODE);
  return data[STORAGE_KEYS.MEETING_MODE] === true;
}

/**
 * Enable or disable meeting mode.
 */
export async function setMeetingMode(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.MEETING_MODE]: !!enabled });
}
