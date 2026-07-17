import Ionicons from '@expo/vector-icons/Ionicons';
import { usePathname, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isGenuinelyPurchased } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/EntitlementContext';
import { hapticLight } from '@/lib/haptics';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import {
  dismissNudge,
  isNudgeDismissed,
  nudgeCopy,
  subscribeNudgeDismissed,
  thresholdFor,
  type NudgeThreshold,
} from '@/lib/trialNudge';

/**
 * Slim, dismissible banner shown near the end of the trial so the paywall on
 * day 7 is never a surprise. Lives inside TabScreen, so it rides above every
 * tab's content — except Setup, where the permanent "Unlock Couchside" row
 * already says the same thing and a banner would just be noise.
 *
 * Tapping it goes straight to the purchase (Setup > Account). Dismissing it is
 * permanent for that threshold: see lib/trialNudge.ts for the once-only rules.
 */
export function TrialNudge() {
  const { entitlement, ready } = useEntitlement();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);

  const [threshold, setThreshold] = useState<NudgeThreshold | null>(null);

  const onSetup = pathname?.startsWith('/setup') ?? false;
  // Not `state === 'trial'`: the store-unreachable fail-open reports
  // 'purchased' while the trial clock keeps running underneath (see
  // entitlement.ts). Such a user WILL be gated once the store recovers, so
  // they still deserve the warning. `trialDaysLeft > 0` also keeps the banner
  // away from an already-expired user, who is looking at the paywall anyway.
  const inTrial =
    ready && !isGenuinelyPurchased(entitlement) && entitlement.trialDaysLeft > 0;
  const candidate = inTrial ? thresholdFor(entitlement.trialDaysLeft) : null;

  useEffect(() => {
    let cancelled = false;
    if (candidate == null) {
      setThreshold(null);
      return;
    }
    void (async () => {
      const dismissed = await isNudgeDismissed(candidate);
      if (!cancelled) setThreshold(dismissed ? null : candidate);
    })();
    return () => {
      cancelled = true;
    };
  }, [candidate]);

  // Every mounted tab has its own TrialNudge; a dismissal on one must clear
  // them all, or an already-mounted sibling keeps showing the banner.
  useEffect(() => subscribeNudgeDismissed(() => setThreshold(null)), []);

  const onDismiss = useCallback(() => {
    if (threshold == null) return;
    hapticLight();
    void dismissNudge(threshold);
    setThreshold(null);
  }, [threshold]);

  const onPress = useCallback(() => {
    hapticLight();
    router.push('/setup?tab=account');
  }, [router]);

  if (threshold == null || onSetup) return null;

  const { title, sub } = nudgeCopy(entitlement.trialDaysLeft);
  const urgent = entitlement.trialDaysLeft <= 1;
  const accent = urgent ? t.amber : t.blue;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderColor: accent }, pressed && styles.pressed]}>
      <Ionicons name="lock-open-outline" size={16} color={accent} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: accent }]}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>
      </View>
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <Ionicons name="close" size={16} color={t.textDim} />
      </Pressable>
    </Pressable>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: t.card,
    borderWidth: 1,
    borderRadius: 10,
  },
  body: { flex: 1 },
  title: { fontSize: 13, fontWeight: '800' },
  sub: { color: t.textDim, fontSize: 11, marginTop: 1 },
  close: { padding: 2 },
  pressed: { opacity: 0.7 },
});
