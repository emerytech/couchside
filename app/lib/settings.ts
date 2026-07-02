import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export type Settings = {
  host: string;
  port: number;
  token: string;
};

export const DEFAULT_SETTINGS: Settings = {
  host: 'bazzite.local',
  port: 8787,
  token: '',
};

const KEY = 'rescue-remote.settings.v1';

/**
 * Persistence wrapper: expo-secure-store on native, localStorage on web.
 */
async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // storage unavailable (private mode); settings live in memory only
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await storageGet(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      host: typeof parsed.host === 'string' && parsed.host ? parsed.host : DEFAULT_SETTINGS.host,
      port:
        typeof parsed.port === 'number' && Number.isFinite(parsed.port)
          ? parsed.port
          : DEFAULT_SETTINGS.port,
      token: typeof parsed.token === 'string' ? parsed.token : DEFAULT_SETTINGS.token,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await storageSet(KEY, JSON.stringify(settings));
}
