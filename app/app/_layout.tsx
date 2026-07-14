import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { ReviewPrompt } from '@/components/ReviewPrompt';
import { ReviewToast } from '@/components/ReviewToast';
import { TrialEndsToast } from '@/components/TrialEndsToast';
import { UnlockToast } from '@/components/UnlockToast';
import { DeepLinkHandler } from '@/lib/DeepLink';
import { EntitlementProvider } from '@/lib/EntitlementContext';
import { SettingsProvider } from '@/lib/SettingsContext';
import { theme } from '@/lib/theme';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

const opsTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.tabBar,
    border: theme.tabBarBorder,
    text: theme.text,
    primary: theme.blue,
  },
};

export default function RootLayout() {
  return (
    <SettingsProvider>
      <EntitlementProvider>
        <ThemeProvider value={opsTheme}>
          <StatusBar style="light" />
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
