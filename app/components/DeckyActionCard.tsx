/**
 * Actions tab — a compact, tappable "Decky Loader" card that OPENS the manager
 * (app/decky.tsx). It is an entry point, not a control surface: the full
 * install / repair / store / plugin management lives on the /decky screen and
 * in the Setup › Account card. Placed in Actions because that is where the
 * owner reaches for "do something to my box" (owner's call, 2026-09-06).
 *
 * Probe-and-appear, exactly like components/DeckyCard.tsx so the two never
 * disagree: derives SOLELY from GET /api/decky/loader — a 404 (old agent,
 * non-Steam box) hides it, and it also hides when the box has nothing to say
 * (no loader, no opt-in, no installer). NOT pref-gated: the box-side opt-in
 * (`couchside allow-decky on`) is the consent, same as the Setup card.
 *
 * The "N plugin updates" pill is a SEPARATE probe of GET /api/decky/plugins,
 * shown only when it answers (a Phase A agent 404s that route and the card is
 * unaffected). The poll is slow (30 s) and tightens to 2 s only while a loader
 * op is in flight, so a state change (Installing… → Running) paints without a
 * manual refresh even though this card starts nothing itself.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { usePoll } from '@/hooks/usePoll';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api, hostKey, type DeckyLoader, type DeckyPluginsList } from '@/lib/api';
import { describeLoaderState, isLoaderOpActive } from '@/lib/deckyPlugins';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function DeckyActionCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { settings } = useSettings();
  const configured = settings.host.trim().length > 0;
  const key = hostKey(settings);

  const loader = usePoll<DeckyLoader | null>(
    () => api.deckyLoader(settings), 30 * 1000, configured, key);
  const l = loader.data;
  const opActive = isLoaderOpActive(l?.op);

  // Tighten the poll only while an op runs, so "Installing…"/"Removing…" resolves
  // to Running on its own (this card triggers nothing; the /decky screen does).
  const fastLoader = usePoll<DeckyLoader | null>(
    () => api.deckyLoader(settings), 2000, configured && opActive, key);
  const live = fastLoader.data ?? l;

  // Update count: a separate probe, null on a Phase A agent (route 404s) — never
  // blocks the card, mirrors DeckyCard's "N plugin updates" line.
  const plugins = usePoll<DeckyPluginsList | null>(
    () => api.deckyPlugins(settings), 5 * 60 * 1000,
    configured && !!live?.installed, key);
  const updates = plugins.data?.updates ?? null;

  if (!configured || !live) return null;
  // Nothing to say: no loader, no opt-in, no installer on the box (same rule as
  // the Setup card, so the two surfaces appear and disappear together).
  if (!live.installed && !live.allowed && !live.installer_ready) return null;

  const d = describeLoaderState(live);
  const toneColor = d.tone === 'good' ? t.green : d.tone === 'warn' ? (t.amber ?? t.red)
    : d.tone === 'action' ? t.blue : t.textFaint;

  return (
    <Pressable
      onPress={() => { hapticLight(); router.push('/decky'); }}
      testID="decky-action-card"
      accessibilityRole="button"
      accessibilityLabel={`Manage Decky Loader, ${d.chip}${updates ? `, ${updates} plugin update${updates === 1 ? '' : 's'}` : ''}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.iconWrap}>
        <Ionicons name="extension-puzzle-outline" size={22} color={t.blue} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>Decky Loader</Text>
          <View style={[styles.chip, { borderColor: toneColor }]}>
            <Text style={[styles.chipText, { color: toneColor }]} numberOfLines={1}>{d.chip}</Text>
          </View>
          {updates && updates > 0 ? (
            <View style={[styles.chip, styles.updChip, { borderColor: t.blue, backgroundColor: t.blue + '22' }]}>
              <Text style={[styles.chipText, { color: t.blue }]}>{updates} update{updates === 1 ? '' : 's'}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.sub} numberOfLines={2}>{d.line}</Text>
        <Text style={styles.manage}>Manage plugins &amp; store &rsaquo;</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.textFaint} />
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginVertical: 8,
      borderRadius: 14,
      backgroundColor: t.card,
      borderWidth: 1,
      borderColor: t.blue + '55', // a blue-tinted edge, matching InstallableSection
    },
    pressed: { opacity: 0.7 },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.blue + '22',
    },
    body: { flex: 1 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { color: t.text, fontWeight: '700', fontSize: 15, flexShrink: 1 },
    chip: {
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 1,
    },
    updChip: {},
    chipText: { fontSize: 11, fontWeight: '700' },
    sub: { color: t.textDim, fontSize: 12, marginTop: 3 },
    manage: { color: t.blue, fontSize: 12, fontWeight: '600', marginTop: 5 },
  });
