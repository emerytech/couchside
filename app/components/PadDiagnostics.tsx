/**
 * On-Pad WebSocket diagnostics — the readout for "green pill, dead mouse".
 *
 * WHY IT LIVES ON THE PAD TAB, and not in Setup > Logs where diagnostics would
 * normally go: leaving the Pad tab BLURS it, and blur calls client.close(),
 * which tears the socket down and destroys the exact zombie state we opened the
 * panel to inspect. A reader that has to navigate away can only ever show you a
 * healthy connection. So this is a modal over the Pad, reached by long-pressing
 * the status pill, and it never unmounts the pad screen.
 *
 * Reading it during an episode (the trackpad is dead, the pill is green):
 *
 *   inputSends climbing while you swipe   -> frames ARE leaving the phone; the
 *                                            fault is downstream (mute socket
 *                                            or the box), not the touch path.
 *   inputSends flat while you swipe       -> sendRaw is never reached: the JS
 *                                            touch path is frozen, not the WS.
 *   recoveries climbing, still dead       -> the input-driven recovery fires and
 *                                            the REBUILT socket is mute too.
 *   recoveries 0 while stale=yes          -> the recovery condition never became
 *                                            true; its predicate is wrong.
 *   timerFires flat                       -> iOS froze the keepalive interval
 *                                            (the original 2.9.53 case).
 *
 * `stale` is the literal predicate the recovery gates on, so the panel answers
 * "could it even have fired?" rather than leaving that to inference.
 */
import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getWsTrace, type GamepadClient } from '@/lib/gamepad';
import { tpTrace } from '@/hooks/useTrackpad';
import { hapticLight } from '@/lib/haptics';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  client: GamepadClient;
};

/** ms -> a compact age that reads well at a glance ("4.2s", "1m12s", "—"). */
function age(ms: number): string {
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.floor((ms % 60_000) / 1000)}s`;
}

export function PadDiagnostics({ visible, onClose, client }: Props) {
  const styles = useThemedStyles(makeStyles);
  const [, setTick] = useState(0);

  // Poll while open so the counters move as the user swipes — the whole point
  // is watching whether inputSends climbs during a dead-cursor episode.
  useEffect(() => {
    if (!visible) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [visible]);

  const copy = useCallback(() => {
    hapticLight();
  }, []);

  if (!visible) return null;

  const d = client.getDiagnostics();
  const t = getWsTrace();

  const rows: [string, string, boolean?][] = [
    ['status', d.status, d.status !== 'connected'],
    ['socket', d.socket, d.socket !== 'open'],
    ['active', d.active ? 'yes' : 'no', !d.active],
    ['last inbound', age(d.inboundAgeMs), d.inboundAgeMs > 12_500],
    ['last input sent', age(d.inputAgeMs)],
    ['stale (recovery armed)', d.staleByWatchdog ? 'YES' : 'no', d.staleByWatchdog],
    ['ping timer', d.pingTimerArmed ? 'armed' : 'DEAD', !d.pingTimerArmed],
    ['reconnect pending', d.reconnectPending ? 'yes' : 'no'],
  ];

  const counters: [string, number, boolean?][] = [
    ['inputSends', t.inputSends],
    ['inputDropped', t.inputDropped, t.inputDropped > 0],
    ['recoveries', t.recoveries],
    ['opens', t.opens],
    ['timerFires', t.timerFires],
    ['pingsSent', t.pingsSent],
    ['pingsDroppedNotOpen', t.pingsDroppedNotOpen, t.pingsDroppedNotOpen > 0],
    ['pingsThrew', t.pingsThrew, t.pingsThrew > 0],
    ['watchdogTeardowns', t.watchdogTeardowns],
  ];

  // GESTURE LAYER — above the socket. The 2026-07-31 episode had a perfectly
  // healthy WS (pings 115/115, inbound 3s fresh) while inputSends sat frozen
  // during active swiping, which means the frames never reached the client at
  // all. These say where they stopped. Read them together:
  //   grants flat while swiping        -> the surface is orphaned, no new gesture
  //   moves flat, grants climbing      -> Grant fires, Move does not
  //   scrollBranch climbing on 1 finger-> maxTouches latched >= 2, every move
  //                                       returns early and never calls onMove
  //   onMoveCalls climbing             -> the gesture layer is fine
  const g = tpTrace;
  const gestures: [string, number | string, boolean?][] = [
    ['grants', g.grants],
    ['moves', g.moves],
    ['onMoveCalls', g.onMoveCalls],
    // A one-finger drag must never take the scroll branch; if this climbs while
    // onMoveCalls does not, maxTouches is stuck.
    ['scrollBranch', g.scrollBranch, g.moves > 0 && g.onMoveCalls === 0],
    ['lastMaxTouches', g.lastMaxTouches, g.lastMaxTouches >= 2],
    ['releases', g.releases],
    ['terminates', g.terminates],
    // Gestures that began and never ended: the orphaned-surface signature.
    ['unclosed (grants-rel-term)', g.grants - g.releases - g.terminates,
      g.grants - g.releases - g.terminates > 1],
    ['last move', g.lastMoveAt ? age(Date.now() - g.lastMoveAt) : '—'],
  ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Inner press swallows taps so touching the sheet doesn't dismiss it. */}
        <Pressable style={styles.sheet} onPress={copy}>
          <Text style={styles.title}>Connection diagnostics</Text>
          <Text style={styles.hint}>
            Swipe the trackpad while this is open. If{' '}
            <Text style={styles.code}>inputSends</Text> climbs but the cursor is dead, the
            frames are leaving the phone.
          </Text>

          <ScrollView style={styles.scroll}>
            <Text style={styles.section}>LIVE</Text>
            {rows.map(([k, v, warn]) => (
              <View key={k} style={styles.row}>
                <Text style={styles.k}>{k}</Text>
                <Text style={[styles.v, warn ? styles.warn : null]}>{v}</Text>
              </View>
            ))}

            <Text style={styles.section}>COUNTERS</Text>
            {counters.map(([k, v, warn]) => (
              <View key={k} style={styles.row}>
                <Text style={styles.k}>{k}</Text>
                <Text style={[styles.v, warn ? styles.warn : null]}>{String(v)}</Text>
              </View>
            ))}

            <Text style={styles.section}>GESTURE (touch surface)</Text>
            {gestures.map(([k, v, warn]) => (
              <View key={k} style={styles.row}>
                <Text style={styles.k}>{k}</Text>
                <Text style={[styles.v, warn ? styles.warn : null]}>{String(v)}</Text>
              </View>
            ))}

            {!!t.lastError && (
              <>
                <Text style={styles.section}>LAST ERROR</Text>
                <Text style={styles.err}>{t.lastError}</Text>
              </>
            )}
          </ScrollView>

          <Pressable style={styles.btn} onPress={onClose}>
            <Text style={styles.btnText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.65)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    },
    sheet: {
      width: '100%',
      maxWidth: 420,
      maxHeight: '80%',
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 14,
      padding: 16,
      gap: 8,
    },
    title: { color: t.text, fontSize: 15, fontWeight: '700' },
    hint: { color: t.textDim, fontSize: 11, lineHeight: 16 },
    code: { fontFamily: mono, color: t.blue },
    scroll: { marginTop: 4 },
    section: {
      color: t.textFaint,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 1,
      marginTop: 10,
      marginBottom: 4,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
    k: { color: t.textDim, fontSize: 12, fontFamily: mono },
    v: { color: t.text, fontSize: 12, fontFamily: mono, fontWeight: '700' },
    warn: { color: t.amber },
    err: { color: t.red, fontSize: 11, fontFamily: mono, lineHeight: 15 },
    btn: {
      backgroundColor: t.blue,
      borderRadius: 9,
      paddingVertical: 9,
      alignItems: 'center',
      marginTop: 6,
    },
    btnText: { color: '#0b1220', fontSize: 13, fontWeight: '700' },
  });
