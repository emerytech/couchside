/**
 * Shared per-tab frame: the persistent BoxSwitcher header (device picker) on
 * top, tab content below. The header owns the top safe-area inset, so tab
 * bodies no longer add insets.top themselves.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { BoxSwitcher } from '@/components/BoxSwitcher';
import { theme } from '@/lib/theme';

export function TabScreen({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.root}>
      <BoxSwitcher />
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1 },
});
