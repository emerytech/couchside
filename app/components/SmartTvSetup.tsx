import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TvPairForm } from '@/components/TvPairForm';
import { usePoll } from '@/hooks/usePoll';
import { api, ApiError, ConnSettings, hostKey, Tv } from '@/lib/api';
import { boxDriver } from '@/lib/tvPairDriver';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** identify's brand names devices we cannot pair; the card also shows non-pairable
 *  backends (RS-232 panel, HDMI-CEC) as choosable TVs, so the label map spans more
 *  than the pairable roster. An id a future agent adds falls through to the raw id. */
const BACKEND_LABELS: Record<string, string> = {
  webos: 'LG',
  samsung: 'Samsung',
  roku: 'Roku',
  androidtv: 'Google TV',
  vidaa: 'Hisense',
  panel: 'RS-232 panel',
  cec: 'CEC',
};
const backendLabel = (id: string): string => BACKEND_LABELS[id] ?? id;

const NETWORK_BACKENDS = ['webos', 'samsung', 'roku', 'androidtv', 'vidaa', 'lgcom'];

function pairErr(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.kind === 'http') return `${fallback} — box says: ${e.message}`;
    return `${fallback} (${e.kind})`;
  }
  return fallback;
}

/**
 * Pair a networked smart TV to the BOX so the Pad tab's D-pad drives it.
 *
 * The pairing form itself is the shared components/TvPairForm; this component is
 * only the box-specific chrome around it: the "Connected: <adapter>" row and the
 * multi-TV backend picker, both fed by the box's /api/tv poll. The box driver
 * (lib/tvPairDriver) forwards every pairing action to the agent, so behaviour is
 * unchanged from before the form was extracted. The box's agent owns the
 * connection — the phone only kicks off pairing over the LAN.
 */
export function SmartTvSetup({ settings }: { settings: ConnSettings }) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [switching, setSwitching] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const tvPoll = usePoll<Tv>(() => api.tv(settings), 15000, true, hostKey(settings));
  const active =
    tvPoll.data?.available && NETWORK_BACKENDS.includes(tvPoll.data.backend) ? tvPoll.data : null;
  const backends = tvPoll.data?.backends ?? [];

  // Point the remote at one of several paired TVs. Before this the box resolved a
  // TV by a fixed priority chain, so a second pairing succeeded and then drove
  // nothing — this switch is what makes the extra TV reachable.
  const chooseBackend = useCallback(
    async (id: string) => {
      if (switching) return;
      setSwitching(true);
      setMsg({ ok: true, text: `Switching to ${backendLabel(id)}…` });
      try {
        const r = await api.tvSetActive(settings, id);
        // The reply's backend is what RESOLVED, not what was asked for.
        const now = r.backend ?? id;
        setMsg(
          now === id
            ? { ok: true, text: `Remote now drives ${backendLabel(id)}.` }
            : { ok: false, text: `${backendLabel(id)} is not available — still driving ${backendLabel(now)}.` },
        );
      } catch (e: unknown) {
        setMsg({ ok: false, text: pairErr(e, `Could not switch to ${backendLabel(id)}.`) });
      } finally {
        setSwitching(false);
        tvPoll.refresh();
      }
    },
    [settings, switching, tvPoll],
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Smart TV remote</Text>
      <Text style={styles.sub}>
        Control a networked TV — LG webOS, Samsung, Roku, Google TV, or Hisense — from the Pad
        tab. The D-pad, SOURCE key, volume, power, and on-screen keyboard all light up once it’s
        connected, and your phone’s volume buttons drive the TV too.
      </Text>

      {active ? (
        <View style={styles.activeRow}>
          <Ionicons name="tv" size={16} color={t.green} />
          <Text style={styles.activeText}>Connected: {active.adapter}</Text>
        </View>
      ) : null}

      {/* Only worth a row when there is an actual choice. Selection tracks the
          RESOLVED backend, so a fallback shows as itself. */}
      {backends.length > 1 ? (
        <View style={styles.pickerBlock}>
          <Text style={styles.pickerLabel}>Remote drives</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segment}>
            {backends.map((b) => (
              <Pressable
                key={b}
                onPress={() => chooseBackend(b)}
                disabled={switching}
                style={[styles.seg, tvPoll.data?.backend === b && styles.segOn, switching && styles.busy]}>
                <Text style={[styles.segText, tvPoll.data?.backend === b && styles.segTextOn]}>{backendLabel(b)}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {msg ? (
            <Text style={[styles.switchMsg, { color: msg.ok ? t.green : t.red }]}>{msg.text}</Text>
          ) : null}
        </View>
      ) : null}

      <TvPairForm driver={boxDriver(settings)} onPaired={() => tvPoll.refresh()} />
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  card: {
    backgroundColor: t.card,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  title: { color: t.text, fontSize: 16, fontWeight: '700' },
  sub: { color: t.textDim, fontSize: 13, lineHeight: 18 },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: t.inset,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  activeText: { color: t.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  pickerBlock: { gap: 6 },
  pickerLabel: { color: t.textDim, fontSize: 12, fontWeight: '700' },
  segment: { flexDirection: 'row', backgroundColor: t.inset, borderRadius: 10, padding: 3, gap: 3 },
  seg: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: t.blue },
  segText: { color: t.textDim, fontSize: 13, fontWeight: '600' },
  segTextOn: { color: t.bg },
  busy: { opacity: 0.7 },
  switchMsg: { fontSize: 12, fontWeight: '600', marginTop: 2 },
});
