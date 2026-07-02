import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';

import { theme } from '@/lib/theme';

export default function TabLayout() {
  return (
    <Tabs
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
        name="logs"
        options={{
          title: 'Logs',
          tabBarIcon: ({ color }) => <Ionicons name="reader" size={24} color={color} />,
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
