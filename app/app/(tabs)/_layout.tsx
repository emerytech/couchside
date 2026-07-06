import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Tabs } from 'expo-router';
import { useEffect, useRef } from 'react';

import { hapticSelection } from '@/lib/haptics';
import { useBoxes } from '@/lib/SettingsContext';
import { theme } from '@/lib/theme';

// Default screen = the swipe Remote (Pad). First-run (empty fleet) is redirected
// to Setup below so the user pairs a box before landing on the remote.
export const unstable_settings = {
  initialRouteName: 'pad',
};

export default function TabLayout() {
  const { boxes, ready } = useBoxes();

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

  return (
    <Tabs
      screenListeners={{ tabPress: () => hapticSelection() }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.blue,
        tabBarInactiveTintColor: theme.textFaint,
        tabBarStyle: {
          backgroundColor: theme.tabBar,
          borderTopColor: theme.tabBarBorder,
        },
        sceneStyle: { backgroundColor: theme.bg },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Console',
          tabBarIcon: ({ color }) => <Ionicons name="pulse" size={24} color={color} />,
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
        }}
      />
      <Tabs.Screen
        name="launch"
        options={{
          title: 'Launch',
          tabBarIcon: ({ color }) => <Ionicons name="rocket" size={24} color={color} />,
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
