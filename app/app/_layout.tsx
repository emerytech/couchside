import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import 'react-native-reanimated';

import { ReviewPrompt } from '@/components/ReviewPrompt';
import { ReviewToast } from '@/components/ReviewToast';
import { AppUpdateReminderToast } from '@/components/AppUpdateReminderToast';
import { TrialEndsToast } from '@/components/TrialEndsToast';
import { AppToast } from '@/components/AppToast';
import { UnlockToast } from '@/components/UnlockToast';
import { TapCapture } from '@/components/TouchIndicatorLayer';
import { DeepLinkHandler } from '@/lib/DeepLink';
import { EntitlementProvider } from '@/lib/EntitlementContext';
import { useImmersive } from '@/lib/immersive';
import { SettingsProvider } from '@/lib/SettingsContext';
import { useResolvedScheme, useTheme } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  const t = useTheme();
  const scheme = useResolvedScheme();
  // Full-screen controller on screen: NO dismissal gesture at all (see the
  // Stack.Screen options below).
  const immersive = useImmersive();
  const navTheme = useMemo(() => {
    const base = scheme === 'light' ? DefaultTheme : DarkTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: t.bg,
        card: t.tabBar,
        border: t.tabBarBorder,
        text: t.text,
        primary: t.blue,
      },
    };
  }, [t, scheme]);

  return (
    <SettingsProvider>
      <EntitlementProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
          <DeepLinkHandler />
          {/* Touch indicators wrap the whole tree because they read the responder
              system in the CAPTURE phase -- an ancestor, not a sibling overlay.
              Rendered unconditionally and gated internally on the pref: if the
              wrapper came and went with the toggle, the navigator would remount
              and drop the screen you were about to record. Observe-only; it must
              never become the responder. */}
          <TapCapture>
          <Stack>
            {/* THE BACK GESTURE IS A DRAG, AND THIS APP IS MADE OF DRAGS.
                iOS ONLY — both options below are no-ops on Android, which is
                exactly how the bug was reported: "only occurs in iOS, Android
                works great."

                `fullScreenGestureEnabled` DEFAULTS TO TRUE ON iOS 26+ (it was
                false, edge-only, on every earlier version). So on a new iPhone
                the swipe-back gesture is live across the ENTIRE screen — and a
                JS PanResponder cannot veto a native UIKit recogniser, so both
                run at once. Measured from a screen recording: dragging the
                landscape pad's left stick tracked the stick (ring and nub
                followed the finger) WHILE the navigator popped the screen out
                from under it. Every drag surface in the app sits on this route
                — both analog sticks, the trackpad, the swipe surface — so this
                was never only a landscape problem. Pin it back to edge-only.

                And while the immersive controller is up, refuse the gesture
                outright: there is no drag on that screen that is not deliberate
                game input, and it has its own ✕ EXIT. Same reasoning as
                `onboarding` below, which has always set gestureEnabled false. */}
            <Stack.Screen
              name="(tabs)"
              options={{
                headerShown: false,
                gestureEnabled: !immersive,
                fullScreenGestureEnabled: false,
              }}
            />
            {/* First run. A sibling of (tabs), never inside it: the tab bar must
                not render behind it and the tab layout's redirects must not race
                it. See docs/memory/project_first-run-mode-chooser.md. */}
            <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
            {/* The full owned-but-uninstalled library (pushed from the Launch tab's
                "Not installed" row). A dedicated FlatList route because the library
                is large — an inline grid can't virtualise it. */}
            <Stack.Screen name="installable" options={{ headerShown: false }} />
          </Stack>
          {/* Global overlay: survives the Paywall unmount on unlock (see UnlockToast). */}
          <UnlockToast />
          {/* Download completions and anything else worth saying from any tab. */}
          <AppToast />
          {/* Last word before the paywall lands: one-shot, on the trial's final day. */}
          <TrialEndsToast />
          {/* Decides whether to ask for a review, and how. Asks once, ever. */}
          <ReviewPrompt />
          {/* The fallback invite ReviewPrompt falls back to when the OS sheet can't run. */}
          <ReviewToast />
          {/* Rare nudge that the MANUAL app-update check exists (Setup > Account);
              off via the pref or its own "Don't show again". */}
          <AppUpdateReminderToast />
        </TapCapture>
        </ThemeProvider>
      </EntitlementProvider>
    </SettingsProvider>
  );
}
