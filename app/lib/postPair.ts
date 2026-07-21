/**
 * Where the app goes once a box is paired.
 *
 * Pairing is the last step of setup, not a destination — the user paired a box
 * because they want to drive it. So every pairing path lands on the Pad (the
 * swipe Remote), which is already the app's declared default screen
 * (`unstable_settings.initialRouteName = 'pad'` in app/(tabs)/_layout.tsx).
 * First run deliberately detours to Setup so a box exists before the remote
 * opens; this closes that detour instead of stranding the user on Setup.
 *
 * There are three pairing entry points (LAN scan + PIN, the manual host/token
 * form, and the QR deep link) and they must agree, hence one helper rather than
 * three copies of the rule.
 *
 * Server boxes: a headless box reports caps.gamepad === false and the tab layout
 * BOUNCES off /pad to Console. Routing such a box to the Pad would still land
 * correctly, but only after a visible Pad->Console flash, so we skip straight to
 * Console when we already know. Only `=== false` counts: caps are undefined for
 * a box being paired for the first time (they arrive with the first /api/status),
 * and the layout's own rule is "never hide a tab on a guess" — an unknown box
 * gets the Pad.
 */
import { router } from 'expo-router';

import type { Box } from './settings';

export function navigateAfterPair(box: Box | undefined) {
  // replace, not navigate: pairing is a completed step, so leaving it on the
  // back stack would let Back return to a half-filled add form.
  if (box?.caps?.gamepad === false) {
    router.replace('/(tabs)');
    return;
  }
  router.replace('/(tabs)/pad');
}
