/**
 * A one-time offer of the new first-run flow, for people who were already using
 * the app before it existed.
 *
 * WHY AN OFFER AND NOT THE FLOW ITSELF. The condition here is the exact mirror
 * of the fleet guard: someone with a box or a TV paired who has never been
 * through onboarding. The guard refuses to FORCE a welcome screen on them —
 * being an existing user is not a problem to be corrected — but there is no
 * reason they should never get to see it either. Same facts, two answers.
 *
 * ASKED AT MOST ONCE. The flag is written when the offer is ANSWERED, and both
 * answers count, so a decline is as final as an accept. It is written BEFORE
 * navigating, so an accept that is interrupted mid-navigation still cannot ask
 * again on the next launch.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import { setPref } from '@/lib/prefs';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function WhatsNewOffer({ onDone }: { onDone: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);

  const answer = async (show: boolean) => {
    hapticLight();
    // Flag first, navigation second. The reverse order can lose the write if the
    // navigation unmounts this before the store commits.
    await setPref('whatsNewOffered', true);
    onDone();
    if (show) router.push('/onboarding');
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Tapping outside DECLINES rather than deferring: a dialog that comes
          back because you missed it is worse than one you answered by accident,
          and the same offer is always available from Prefs. */}
      <Pressable
        style={styles.scrim}
        onPress={() => void answer(false)}
        accessibilityLabel="Dismiss"
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="sparkles-outline" size={16} color={t.green} />
          </View>
          <Text style={styles.title}>New: a setup walkthrough</Text>
          <Text style={styles.body}>
            There is now a short walkthrough covering what Couchside does, and a guided tour
            of the tabs. You have not seen it because you were already set up.
          </Text>
          <Text style={styles.note}>You can always start it again from Setup &rsaquo; Prefs.</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={() => void answer(false)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}>
              <Text style={styles.ghostText}>NO THANKS</Text>
            </Pressable>
            <Pressable
              onPress={() => void answer(true)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>SHOW ME</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000000b0' },
    wrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 22 },
    card: {
      backgroundColor: t.card,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: t.cardBorder,
      padding: 20,
      gap: 10,
    },
    badge: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    title: { color: t.text, fontSize: 18, fontWeight: '800' },
    body: { color: t.textDim, fontSize: 13.5, lineHeight: 20 },
    note: { color: t.textFaint, fontSize: 12, lineHeight: 17 },
    actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
    ghost: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      paddingVertical: 13,
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
    },
    ghostText: { color: t.textDim, fontSize: 12.5, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
    primary: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 12,
      paddingVertical: 13,
      backgroundColor: t.green,
    },
    primaryText: { color: '#04140c', fontSize: 12.5, fontWeight: '900', letterSpacing: 1, fontFamily: mono },
    pressed: { opacity: 0.75 },
  });
