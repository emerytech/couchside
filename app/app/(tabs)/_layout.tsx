import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { hapticSelection } from '@/lib/haptics';
import { useBoxes } from '@/lib/SettingsContext';
import { useTheme } from '@/lib/theme';

// Default screen = the swipe Remote (Pad). First-run (empty fleet) is redirected
// to Setup below so the user pairs a box before landing on the remote.
export const unstable_settings = {
  initialRouteName: 'pad',
};

export default function TabLayout() {
  const t = useTheme();
  const { boxes, activeBox, ready } = useBoxes();
  const segments = useSegments();

  // A "server box" (headless: no virtual gamepad, no Steam) reports these false
  // in /api/status caps, so its gaming tabs are hidden. Undefined caps (unknown,
  // or agent < 2.8.2) leaves both visible — never hide a tab on a guess.
  const caps = activeBox?.caps;
  const hidePad = caps?.gamepad === false;
  const hideLaunch = caps?.steam === false;

  // On true first run (persisted fleet loaded, but empty) send the user to
  // Setup to pair. Runs once. After that, the Pad initial route stands.
  const redirected = useRef(false);
  useEffect(() => {
    if (!ready || redirected.current) return;
    redirected.current = true;
    if (boxes.length === 0) {
      router.replace('/(tabs)/setup');
    }
  }, [ready, boxes.length]);

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
