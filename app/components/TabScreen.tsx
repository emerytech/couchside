/**
 * Shared per-tab frame: the persistent BoxSwitcher header (device picker) on
 * top, tab content below. The header owns the top safe-area inset, so tab
 * bodies no longer add insets.top themselves. Beta builds also get a small
 * corner BETA badge so testers always know they are on the unlocked beta.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BoxSwitcher } from '@/components/BoxSwitcher';
import { IS_BETA_BUILD } from '@/lib/entitlement';
import { mono, theme } from '@/lib/theme';

export function TabScreen({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.root}>
      <BoxSwitcher />
      <View style={styles.body}>{children}</View>
      {IS_BETA_BUILD && (
        <View pointerEvents="none" style={styles.betaBadge}>
          <Text style={styles.betaText}>BETA</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1 },
  // Pinned above the tab bar, non-interactive so it never eats a touch.
  betaBadge: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: theme.amber,
    opacity: 0.9,
  },
  betaText: {
    color: theme.amber,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: mono,
    letterSpacing: 1.5,
  },
});
