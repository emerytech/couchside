/**
 * DESIGN-REVIEW DEMO SEED. Web only, and inert unless the build was started with
 * EXPO_PUBLIC_DEMO=1 (Expo inlines that at bundle time; production builds never
 * set it, so this whole body is dead code there).
 *
 * Points a fresh web session at the fixture "box" — a stdlib Python server on
 * 127.0.0.1:8787 that answers /api/status, /api/media, /api/gaming, /api/stream-
 * host, /api/units with a populated, slowly moving dataset — so the Console can
 * be rendered fully lit for before/after skin comparisons without a real agent.
 * Only seeds when no box is configured, so it never overwrites a real pairing.
 */
import { Platform } from 'react-native';

if (process.env.EXPO_PUBLIC_DEMO === '1' && Platform.OS === 'web' && typeof window !== 'undefined') {
  try {
    const KEY = 'couchpilot.boxes.v1';
    if (!window.localStorage.getItem(KEY)) {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({
          boxes: [
            { id: 'box-0', name: 'couchside-box', host: '127.0.0.1', port: 8787, token: 'demo', padMode: 'swipe' },
          ],
          activeBoxId: 'box-0',
        }),
      );
    }
  } catch {
    // storage unavailable: the Setup tab still works, just not pre-paired
  }
}

export {};
