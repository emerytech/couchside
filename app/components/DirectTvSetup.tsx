/**
 * Setup card for REMOTE-ONLY MODE: the toggle, the list of TVs this phone drives
 * directly (no box), and the shared pairing form.
 *
 * The form itself is components/TvPairForm — the SAME one the box path
 * (SmartTvSetup) uses. The only difference is the injected driver: here it is
 * directDriver (lib/tvdirect/directDriver), which pairs straight from the phone
 * and persists to the on-phone TV store, and which exposes only the brands the
 * app can reach without a box (Roku, Google TV today). This card keeps just the
 * remote-only chrome around that form: the mode toggle and the TV list.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { TvPairForm } from '@/components/TvPairForm';
import { hapticSelection } from '@/lib/haptics';
import { setPref, usePref } from '@/lib/prefs';
import { useBoxes } from '@/lib/SettingsContext';
import { directDriver } from '@/lib/tvdirect/directDriver';
import { removeTv, selectTv, useTvs } from '@/lib/tvdirect/store';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function DirectTvSetup() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const remoteOnly = usePref('remoteOnlyMode');
  const { tvs, activeTvId } = useTvs();
  const { boxes } = useBoxes();

  // One stateful driver for the card's lifetime: an Android TV pairing holds its
  // open session between the two steps inside this object.
  const driver = useMemo(() => directDriver(), []);

  // After a successful pair, someone with no box has told us which app they
  // want, so flip remote-only ON — but only when the fleet is EMPTY, since
  // flipping a box owner would hide the tabs they came for.
  const onPaired = useCallback(() => {
    if (boxes.length === 0 && !remoteOnly) void setPref('remoteOnlyMode', true);
  }, [boxes.length, remoteOnly]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="tv-outline" size={16} color={t.blue} />
        <Text style={styles.headerText}>TV REMOTE (NO BOX)</Text>
      </View>

      <View style={styles.toggleRow}>
        <View style={styles.toggleBody}>
          <Text style={styles.toggleLabel}>Remote-only mode</Text>
          <Text style={styles.toggleSub}>
            Turns Couchside into just a TV remote: the box tabs are hidden and the phone talks
            to your TV directly. Turn it off any time to get them back.
          </Text>
        </View>
        <Switch
          value={remoteOnly}
          onValueChange={(v) => {
            hapticSelection();
            void setPref('remoteOnlyMode', v);
          }}
          trackColor={{ true: t.blue, false: t.inset }}
        />
      </View>

      {tvs.length > 0 && (
        <View style={styles.list}>
          {tvs.map((tv) => (
            <View key={tv.id} style={styles.tvRow}>
              <Pressable
                onPress={() => {
                  hapticSelection();
                  void selectTv(tv.id);
                }}
                style={styles.tvMain}>
                <Ionicons
                  name={tv.id === activeTvId ? 'radio-button-on' : 'radio-button-off'}
                  size={16}
                  color={tv.id === activeTvId ? t.blue : t.textFaint}
                />
                <View style={styles.tvBody}>
                  <Text style={styles.tvName} numberOfLines={1}>
                    {tv.name}
                  </Text>
                  <Text style={styles.tvHost} numberOfLines={1}>
                    {tv.brand} · {tv.host}
                  </Text>
                </View>
              </Pressable>
              <Pressable onPress={() => void removeTv(tv.id)} hitSlop={8} style={styles.removeBtn}>
                <Text style={[styles.removeText, { color: t.red }]}>REMOVE</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* The shared pairing form, box-less. Roku and Google TV both live in one
          brand picker here — no separate cards. */}
      <TvPairForm driver={driver} onPaired={onPaired} />

      {/* Honest ceiling: LG/Samsung/Hisense still need the box path, which does
          support them today. */}
      <Text style={styles.note}>
        LG, Samsung and Hisense still need a Couchside box — the app can’t yet make the kind of
        encrypted connection those TVs require on its own. With a box they all work: open the
        box above and use its Smart TV section.
      </Text>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    gap: 10,
    marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerText: {
    color: t.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: mono,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleBody: { flex: 1, gap: 3 },
  toggleLabel: { color: t.text, fontSize: 14, fontWeight: '700' },
  toggleSub: { color: t.textDim, fontSize: 12, lineHeight: 17 },
  list: { gap: 6 },
  tvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: t.inset,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tvMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  tvBody: { flex: 1 },
  tvName: { color: t.text, fontSize: 13, fontWeight: '700' },
  tvHost: { color: t.textDim, fontSize: 11, fontFamily: mono },
  removeBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  removeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, fontFamily: mono },
  note: {
    color: t.textFaint,
    fontSize: 11,
    lineHeight: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.cardBorder,
    paddingTop: 10,
  },
});
