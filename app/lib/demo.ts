/**
 * DESIGN-REVIEW DEMO SEED. Web only, inert unless the bundle was started with
 * EXPO_PUBLIC_DEMO=1 (Expo inlines that at bundle time; store builds never set
 * it, so this whole body is dead code there).
 *
 * Seeds a fresh web session so the Console renders fully populated against the
 * local fixture box (scripts/demo-box/fixture_server.py on 127.0.0.1:8787):
 * pairs the box, marks onboarding done, and turns the one-time feature tour off.
 * Each write is guarded so it never clobbers a real value.
 */
import { Platform } from 'react-native';

if (process.env.EXPO_PUBLIC_DEMO === '1' && Platform.OS === 'web' && typeof window !== 'undefined') {
  const ls = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  if (ls) {
    try {
      const BOXES = 'couchpilot.boxes.v1';
      if (!ls.getItem(BOXES)) {
        ls.setItem(
          BOXES,
          JSON.stringify({
            boxes: [
              { id: 'box-0', name: 'couchside-box', host: '127.0.0.1', port: 8787, token: 'demo', padMode: 'swipe' },
            ],
            activeBoxId: 'box-0',
          }),
        );
      }
      // Skip onboarding + the feature-tour spotlight so a screenshot lands on the
      // dashboard, not the intro. Merge, so a real prefs blob keeps its values.
      const PREFS = 'couchside.prefs.v1';
      const prefs = JSON.parse(ls.getItem(PREFS) ?? '{}');
      let touched = false;
      if (prefs.onboardingDone !== true) {
        prefs.onboardingDone = true;
        touched = true;
      }
      if (prefs.featureTour !== false) {
        prefs.featureTour = false;
        touched = true;
      }
      if (touched) ls.setItem(PREFS, JSON.stringify(prefs));
      // Never fire the store-review ask during a screenshot session.
      if (ls.getItem('couchside.reviewAsked.v1') !== '1') ls.setItem('couchside.reviewAsked.v1', '1');
      // eslint-disable-next-line no-console
      console.log('[demo] seeded fixture box + skipped onboarding/tour');
    } catch {
      // storage write failed (private mode): the Setup tab still works
    }
  }
}

export {};
