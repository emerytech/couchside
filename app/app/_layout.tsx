import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import 'react-native-reanimated';

import { ReviewPrompt } from '@/components/ReviewPrompt';
import { ReviewToast } from '@/components/ReviewToast';
import { AppUpdateReminderToast } from '@/components/AppUpdateReminderToast';
import { TrialEndsToast } from '@/components/TrialEndsToast';
import { UnlockToast } from '@/components/UnlockToast';
import { TapCapture } from '@/components/TouchIndicatorLayer';
import { DeepLinkHandler } from '@/lib/DeepLink';
import { EntitlementProvider } from '@/lib/EntitlementContext';
import { SettingsProvider } from '@/lib/SettingsContext';
import { useResolvedScheme, useTheme } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  const t = useTheme();
  const scheme = useResolvedScheme();
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
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          </Stack>
          {/* Global overlay: survives the Paywall unmount on unlock (see UnlockToast). */}
          <UnlockToast />
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
