/**
 * The Remote tab — REMOTE-ONLY MODE.
 *
 * Visible only while the remoteOnlyMode pref is on (app/(tabs)/_layout.tsx),
 * which is the mode for someone who has a smart TV and no Couchside box. It
 * deliberately does NOT use TabScreen: that frame carries the BoxSwitcher and
 * RemotePowerBar, which are box furniture ("No box, tap to add", box suspend,
 * box volume) and would be noise-at-best on a screen where no box exists. This
 * screen's header is the TV picker instead.
 *
 * Gated like every other feature tab: remote-only mode is an architecture
 * change, not a pricing change. Whether this tier ever becomes free is a
 * separate, later decision (docs/memory/project_remote-only-mode.md §3).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DirectRemoteView } from '@/components/DirectRemoteView';
import { Gated } from '@/components/Gated';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { hapticSelection } from '@/lib/haptics';
import { DirectTv } from '@/lib/tvdirect/model';
import { selectTv, useTvs } from '@/lib/tvdirect/store';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export default function RemoteTab() {
  useLockOrientation('portrait');
  return (
    <Gated>
      <RemoteScreen />
    </Gated>
  );
}

function RemoteScreen() {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { tvs, active, ready } = useTvs();

  return (
    <View style={[styles.root, { paddingTop: insets.top + 6 }]}>
      <TvPicker tvs={tvs} active={active} />
      <View style={styles.body}>
        {/* `ready` distinguishes "no TVs" from "the store has not loaded yet".
            Without it the empty state flashes on every cold start and reads as
            "your TV is gone". */}
        {!ready ? null : active ? <DirectRemoteView tv={active} /> : <NoTv />}
      </View>
    </View>
  );
}

/** Header pill: which TV this remote is pointed at, and a sheet to change it. */
function TvPicker({ tvs, active }: { tvs: DirectTv[]; active: DirectTv | null }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => {
          hapticSelection();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}>
        <Ionicons name="tv-outline" size={16} color={t.blue} />
        <Text style={styles.pillText} numberOfLines={1}>
          {active?.name ?? 'No TV, tap to add'}
        </Text>
        <Ionicons name="chevron-down" size={14} color={t.textDim} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>YOUR TVs</Text>
            {tvs.length === 0 ? (
              <Text style={styles.sheetEmpty}>No TVs yet.</Text>
            ) : (
              tvs.map((tv) => (
                <Pressable
                  key={tv.id}
                  onPress={() => {
                    hapticSelection();
                    void selectTv(tv.id);
                    setOpen(false);
                  }}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                  <Ionicons
                    name={tv.id === active?.id ? 'radio-button-on' : 'radio-button-off'}
                    size={16}
                    color={tv.id === active?.id ? t.blue : t.textFaint}
                  />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {tv.name}
                    </Text>
                    <Text style={styles.rowHost} numberOfLines={1}>
                      {tv.brand} · {tv.host}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
            <Pressable
              onPress={() => {
                setOpen(false);
                // navigate, not push — a push stacks a duplicate (tabs) entry
                // that the iOS back-swipe can pop to. See _layout.tsx.
                router.navigate('/(tabs)/setup');
              }}
              style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}>
              <Ionicons name="add" size={16} color={t.blue} />
              <Text style={[styles.rowName, { color: t.blue }]}>Add a TV</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function NoTv() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.empty}>
      <Ionicons name="tv-outline" size={40} color={t.textFaint} />
      <Text style={styles.emptyTitle}>No TV set up yet</Text>
      <Text style={styles.emptyBody}>
        Add your TV in Setup and this becomes its remote. The phone talks to the TV directly
        over your Wi-Fi — nothing else has to be running.
      </Text>
      <Pressable
        onPress={() => router.navigate('/(tabs)/setup')}
        style={({ pressed }) => [styles.emptyBtn, pressed && styles.pressed]}>
        <Text style={styles.emptyBtnText}>OPEN SETUP</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 14 },
  body: { flex: 1, paddingTop: 10 },
  pressed: { opacity: 0.6 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  pillText: { color: t.text, fontSize: 13, fontWeight: '700', maxWidth: 200 },
  backdrop: { flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: 24 },
  sheet: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  sheetTitle: {
    color: t.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontFamily: mono,
  },
  sheetEmpty: { color: t.textDim, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  rowBody: { flex: 1 },
  rowName: { color: t.text, fontSize: 14, fontWeight: '700' },
  rowHost: { color: t.textDim, fontSize: 11, fontFamily: mono },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.cardBorder,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 20 },
  emptyTitle: { color: t.text, fontSize: 17, fontWeight: '700' },
  emptyBody: { color: t.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  emptyBtn: {
    marginTop: 6,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: t.blue,
  },
  emptyBtnText: { color: t.bg, fontSize: 12, fontWeight: '800', letterSpacing: 1, fontFamily: mono },
});
