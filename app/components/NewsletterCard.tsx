import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useBoxes } from '@/lib/SettingsContext';
import { useTvs } from '@/lib/tvdirect/store';
import { setPref, usePref } from '@/lib/prefs';
import { NEWSLETTER_URL, showNewsletterInvite } from '@/lib/newsletterInvite';
import { useTheme } from '@/lib/theme';

/** No modal, no network on render, and no subscription implied by opening a link. */
export function NewsletterCard({ permanent = false }: { permanent?: boolean }) {
  const t = useTheme();
  const { boxes, ready } = useBoxes();
  const tvs = useTvs();
  const dismissed = usePref('newsletterInviteDismissed');
  const onboardingDone = usePref('onboardingDone');
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  const configured = boxes.some(box => !!box.token) || tvs.tvs.length > 0;
  if (!permanent && !showNewsletterInvite(ready && tvs.ready && onboardingDone, configured, dismissed)) return null;

  async function open() {
    if (opening) return;
    setOpening(true);
    setError(false);
    try {
      await Linking.openURL(NEWSLETTER_URL);
      await setPref('newsletterInviteDismissed', true).catch(() => {});
    } catch { setError(true); }
    finally { setOpening(false); }
  }
  if (permanent) return (
    <View style={{ marginBottom: 14 }}>
      <Pressable accessibilityRole="link" accessibilityLabel="Couchside news and updates"
        accessibilityHint="Opens the optional newsletter website; subscription status is not shared with the app"
        disabled={opening} onPress={() => void open()}
        style={[styles.compact, { backgroundColor: t.card, borderColor: t.cardBorder }]}>
        <Ionicons name="mail-outline" size={20} color={t.green} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[styles.compactTitle, { color: t.text }]}>Couchside news & updates</Text>
          <Text style={[styles.compactHint, { color: t.textDim }]}>{opening ? 'Opening…' : 'Optional email news · opens website'}</Text>
        </View>
        <Ionicons name="open-outline" size={16} color={t.textDim} />
      </Pressable>
      {error && <Text accessibilityRole="alert" style={[styles.body, { color: t.red }]}>
        Couldn’t open your browser. Visit couchside.tv/news.
      </Text>}
    </View>
  );
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.cardBorder }]}>
      <View style={styles.heading}>
        <Ionicons name="mail-outline" size={22} color={t.green} />
        <Text style={[styles.title, { color: t.text }]}>
          Get the Couchside scoop
        </Text>
      </View>
      <Text style={[styles.body, { color: t.textDim }]}>
        Occasional emails from the maker about new features, progress, and setup tips.
        {' '}Completely optional. Confirm by email; unsubscribe anytime.
      </Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="link" accessibilityLabel="Sign up for Couchside email updates"
          accessibilityHint="Opens the signup page in your browser" disabled={opening}
          onPress={() => void open()} style={styles.action}>
          <Text style={[styles.actionText, { color: t.green }]}>{opening ? 'Opening…' : 'Sign up ↗'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss newsletter invitation"
          onPress={() => void setPref('newsletterInviteDismissed', true).catch(() => {})} style={styles.action}>
          <Text style={[styles.actionText, { color: t.textDim }]}>No thanks</Text>
        </Pressable>
      </View>
      {error && <Text accessibilityRole="alert" style={[styles.body, { color: t.red }]}>
        Couldn’t open your browser. Try again, or visit couchside.tv/news.
      </Text>}
    </View>
  );
}
const styles = StyleSheet.create({
  compact: { minHeight: 64, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 14 },
  compactTitle: { fontSize: 15, fontWeight: '600' },
  compactHint: { fontSize: 12, lineHeight: 17 },
  card: { padding: 18, borderWidth: 1, borderRadius: 18, marginBottom: 14, gap: 10 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 18, fontWeight: '700', flex: 1 },
  body: { fontSize: 14, lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  actionText: { fontSize: 15, fontWeight: '600' },
});
