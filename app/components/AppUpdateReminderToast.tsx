/**
 * The occasional "check for an app update" nudge.
 *
 * NOT an update check and NOT automatic checking — just a gentle, rare reminder
 * that the manual check exists in Setup > Account, so a user who never looks
 * still learns new features ship. Interactive (unlike the trial toast): it
 * carries a "Don't show again" that flips the `appUpdateReminder` pref off.
 *
 * Two gates, both must pass: the pref is on, AND at least REMIND_DAYS have
 * passed since the last nudge. Mounted once at the root layout so it is not tied
 * to a tab.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { markReminderShown, reminderDue } from '@/lib/appUpdateReminder';
import { hapticLight } from '@/lib/haptics';
import { setPref, usePref } from '@/lib/prefs';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

export function AppUpdateReminderToast() {
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(makeStyles);
  const enabled = usePref('appUpdateReminder');
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // No store version on web (dev harness); and nothing to nudge if the user
    // turned it off.
    if (Platform.OS === 'web' || !enabled) return;
    let cancelled = false;
    void (async () => {
      const now = Date.now();
      if (!(await reminderDue(now))) return;
      await markReminderShown(now); // stamp BEFORE showing, so a crash mid-toast doesn't re-nag
      if (!cancelled) setShown(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!shown) return null;

  const dismiss = () => {
    hapticLight();
    setShown(false);
  };
  const neverAgain = () => {
    hapticLight();
    void setPref('appUpdateReminder', false);
    setShown(false);
  };

  return (
    // box-none: the backdrop lets touches through; only the toast itself
    // captures them (it has buttons, unlike the trial toast).
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 76 }]}>
      <View style={styles.toast}>
        <View style={styles.head}>
          <Ionicons name="sparkles-outline" size={15} color={styles.title.color as string} />
          <Text style={styles.title}>New features ship often</Text>
        </View>
        <Text style={styles.sub}>
          Check for an app update now and then in Setup › Account so you don’t miss them.
        </Text>
        <View style={styles.actions}>
          <Pressable onPress={neverAgain} hitSlop={6} style={styles.action}>
            <Text style={styles.actionMuted}>Don’t show again</Text>
          </Pressable>
          <Pressable onPress={dismiss} hitSlop={6} style={styles.action}>
            <Text style={styles.actionBold}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    maxWidth: '92%',
    backgroundColor: t.card,
    borderColor: t.blue,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 16,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center' },
  title: { color: t.blue, fontFamily: mono, fontSize: 13, fontWeight: '800', textAlign: 'center' },
  sub: { color: t.textDim, fontSize: 11, marginTop: 4, textAlign: 'center', lineHeight: 16 },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 22, marginTop: 10 },
  action: { paddingVertical: 2 },
  actionMuted: { color: t.textDim, fontSize: 12, fontWeight: '600' },
  actionBold: { color: t.blue, fontSize: 12, fontWeight: '800' },
});
