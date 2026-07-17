import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import 'react-native-reanimated';

import { ReviewPrompt } from '@/components/ReviewPrompt';
import { ReviewToast } from '@/components/ReviewToast';
import { TrialEndsToast } from '@/components/TrialEndsToast';
import { UnlockToast } from '@/components/UnlockToast';
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
        </ThemeProvider>
      </EntitlementProvider>
    </SettingsProvider>
  );
}
