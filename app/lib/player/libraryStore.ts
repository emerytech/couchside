import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { useSyncExternalStore } from 'react';
import { PlayerLibrary } from './library';

const KEY = 'couchside.player.library.v1';
// Regular sandboxed app storage: this bounded collection is too large for
// SecureStore. No account, analytics upload, or metadata API key is stored here.
export const playerLibrary = new PlayerLibrary({
  async read() {
    if (Platform.OS === 'web') return localStorage.getItem(KEY);
    const file = new File(Paths.document, `${KEY}.json`);
    const backup = new File(Paths.document, `${KEY}.backup.json`);
    if (!file.exists && !backup.exists) return null;
    let primary: string;
    try {
      primary = await file.text();
      JSON.parse(primary);
    } catch {
      if (!backup.exists) throw new Error('Library unreadable');
      const value = await backup.text();
      const parsed = JSON.parse(value);
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Library unreadable');
      // Preserve recovered data before the next write as well.
      file.write(value);
      return value;
    }
    // An app downgrade must not replace a future schema with an old backup.
    return primary;
  },
  async write(value) {
    if (Platform.OS === 'web') { localStorage.setItem(KEY, value); return; }
    const file = new File(Paths.document, `${KEY}.json`);
    // Write a recovery copy first. Both copies get the new contents, so a
    // forgotten title cannot reappear from a stale backup on a later read.
    new File(Paths.document, `${KEY}.backup.json`).write(value);
    file.write(value);
  },
});
export function usePlayerLibrary() {
  return useSyncExternalStore(playerLibrary.subscribe, playerLibrary.snapshot, playerLibrary.snapshot);
}
