import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useCapsSync } from '@/hooks/useCapsSync';
import { hapticSelection } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { useBoxes } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';

// NOT the landing screen. This governs back-behaviour within the tab group; on a
// cold start the index route (Console) is what renders. The comment that used to
// sit here claimed "Default screen = the swipe Remote (Pad)", which was never
// true — measured in the harness, loading "/" leaves Console active. What the app
// opens on is the `landingTab` preference, applied by the redirect below.
export const unstable_settings = {
  initialRouteName: 'pad',
};

export default function TabLayout() {
  const t = useTheme();
  const { boxes, activeBox, ready } = useBoxes();
  const landingTab = usePref('landingTab');
  const segments = useSegments();
  // Always-mounted caps safety net: heals a stale persisted caps snapshot
  // (e.g. couchmode:false cached before the box became capable) no matter
  // which tab the user lives on. See hooks/useCapsSync.ts for the field bug.
  useCapsSync();

  // A "server box" (headless: no virtual gamepad, no Steam) reports these false
  // in /api/status caps, so its gaming tabs are hidden. Undefined caps (unknown,
  // or agent < 2.8.2) leaves both visible — never hide a tab on a guess.
  const caps = activeBox?.caps;
  const hidePad = caps?.gamepad === false;
  const hideLaunch = caps?.steam === false;

  // On true first run (persisted fleet loaded, but empty) send the user to
  // Setup to pair. Otherwise honour the landing-tab preference.
  //
  // The redirect is how the landing tab is chosen at all: `unstable_settings.
  // initialRouteName` below does NOT decide what opens on a cold start — the
  // index route (Console) wins, which is why the app has always opened on
  // Console despite that setting naming 'pad'. Measured in the harness: loading
  // "/" leaves Console as the active tab.
  //
  // Pairing beats the preference. Someone with no box who set the landing tab to
  // Pad still needs Setup first, or they land on a remote wired to nothing.
  const redirected = useRef(false);
  useEffect(() => {
    if (!ready || redirected.current) return;
    redirected.current = true;
    if (boxes.length === 0) {
      router.replace('/(tabs)/setup');
      return;
    }
    // 'index' is already what renders, so redirecting to it would be a wasted
    // navigation on every cold start.
    if (landingTab !== 'index') {
      router.replace(`/(tabs)/${landingTab}`);
    }
  }, [ready, boxes.length, landingTab]);

  // Bounce off a tab hidden for the active box — landing on the Pad initial
  // route for a server box, or switching from an HTPC to a server box while the
  // Pad/Launch tab is focused. Sends the user to Console (the tabs index).
  useEffect(() => {
    if (!ready) return;
    const leaf = segments[segments.length - 1];
    if ((hidePad && leaf === 'pad') || (hideLaunch && leaf === 'launch')) {
      router.replace('/(tabs)');
    }
  }, [ready, hidePad, hideLaunch, segments]);

  return (
    <Tabs
      screenListeners={{ tabPress: () => hapticSelection() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.blue,
        tabBarInactiveTintColor: t.textFaint,
        tabBarStyle: {
          backgroundColor: t.tabBar,
          borderTopColor: t.tabBarBorder,
        },
        sceneStyle: { backgroundColor: t.bg },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Console',
          tabBarIcon: ({ color }) => <Ionicons name="pulse" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="fleet"
        options={{
          title: 'Fleet',
          tabBarIcon: ({ color }) => <Ionicons name="server" size={24} color={color} />,
          // Only useful with several boxes; single-box users keep a clean bar.
          href: boxes.length >= 2 ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="actions"
        options={{
          title: 'Actions',
          tabBarIcon: ({ color }) => <Ionicons name="flash" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="pad"
        options={{
          title: 'Pad',
          tabBarIcon: ({ color }) => <Ionicons name="game-controller" size={24} color={color} />,
          // Hidden on a server box (no virtual gamepad). null = no tab bar entry.
          href: hidePad ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="launch"
        options={{
          title: 'Launch',
          tabBarIcon: ({ color }) => <Ionicons name="rocket" size={24} color={color} />,
          // Hidden on a server box (no Steam install). null = no tab bar entry.
          href: hideLaunch ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="setup"
        options={{
          title: 'Setup',
          tabBarIcon: ({ color }) => <Ionicons name="settings-sharp" size={24} color={color} />,
        }}
      />
    </Tabs>
  );
}
