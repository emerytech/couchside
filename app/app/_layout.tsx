import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { ReviewPrompt } from '@/components/ReviewPrompt';
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
          {/* One-shot store-review ask a few seconds after the unlock toast. */}
          <ReviewPrompt />
        </ThemeProvider>
      </EntitlementProvider>
    </SettingsProvider>
  );
}
