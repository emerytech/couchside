/**
 * Diagnostic: the last d-pad/button frames the app TRIED to send, and whether
 * each one actually left the socket.
 *
 * Why this is user-facing UI and not a console log: the "swipe sticks and keeps
 * going that direction" bug is INTERMITTENT, so it cannot be reproduced on
 * demand, and a phone has nowhere to read a console. The agent's d-pad is a
 * latched absolute axis — one lost `v:0` pins it until something zeroes it —
 * and GamepadClient.sendRaw() has two paths that drop a frame with no error at
 * all. Without a record, a stuck episode leaves no evidence whatsoever.
 *
 * After an episode: open this and screenshot it. See lib/gamepad.ts's
 * InputTraceEntry docs for how to read it — in short, a trailing `v:1` means the
 * release was never attempted (a stalled JS thread), while a trailing
 * `v:0 sent` means it went out and died downstream.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { clearInputTrace, getInputTrace, type InputTraceEntry } from '@/lib/gamepad';
import { hapticSelection } from '@/lib/haptics';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

const DPAD = new Set(['du', 'dd', 'dl', 'dr']);

function line(e: InputTraceEntry, prev: InputTraceEntry | null): string {
  const d = new Date(e.at);
  const t =
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0') +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0');
  // The GAP is the diagnostic signal: a multi-second hole before a missing
  // release is what a stalled JS thread looks like.
  const gap = prev ? `+${String(e.at - prev.at).padStart(5)}ms` : '      —';
  return `${t} ${gap}  ${e.k.padEnd(3)} ${e.v === 1 ? 'DOWN' : e.v === 0 ? 'up  ' : '?   '} ${e.how}`;
}

export function InputTracePanel() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [rows, setRows] = useState<InputTraceEntry[] | null>(null);

  const refresh = useCallback(() => {
    hapticSelection();
    setRows(getInputTrace());
  }, []);
  const clear = useCallback(() => {
    hapticSelection();
    clearInputTrace();
    setRows([]);
  }, []);

  // A d-pad key still DOWN at the end of the trace is the smoking gun.
  const held = new Set<string>();
  for (const e of rows ?? []) {
    if (!DPAD.has(e.k)) continue;
    if (e.v === 1) held.add(e.k);
    else held.delete(e.k);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>PAD INPUT TRACE (DIAGNOSTIC)</Text>
      <Text style={styles.hint}>
        If a swipe sticks, come here and tap Capture, then screenshot this. It records the last
        button frames the app tried to send and whether each one left the socket.
      </Text>
      <View style={styles.row}>
        <Pressable onPress={refresh} style={[styles.btn, styles.btnPrimary]}>
          <Text style={styles.btnPrimaryText}>CAPTURE</Text>
        </Pressable>
        <Pressable onPress={clear} style={[styles.btn, styles.btnGhost]}>
          <Text style={styles.btnGhostText}>CLEAR</Text>
        </Pressable>
      </View>

      {rows == null ? null : rows.length === 0 ? (
        <Text style={styles.empty}>No frames recorded yet.</Text>
      ) : (
        <>
          {held.size > 0 && (
            <Text style={[styles.verdict, { color: t.red }]}>
              STILL HELD: {Array.from(held).join(', ')} — a direction was never released. This is
              the stuck state.
            </Text>
          )}
          {held.size === 0 && (
            <Text style={[styles.verdict, { color: t.green }]}>
              Every direction was released. Nothing latched in this window.
            </Text>
          )}
          <View style={styles.log}>
            {rows.map((e, i) => (
              <Text key={`${e.at}-${i}`} style={styles.logLine} numberOfLines={1}>
                {line(e, i > 0 ? rows[i - 1] : null)}
              </Text>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { gap: 8, marginTop: 22 },
    title: { color: t.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
    hint: { color: t.textFaint, fontSize: 12, lineHeight: 17 },
    row: { flexDirection: 'row', gap: 8 },
    btn: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      paddingVertical: 11,
      minHeight: 44,
    },
    btnPrimary: { backgroundColor: t.blue },
    btnPrimaryText: { color: t.bg, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
    btnGhost: { backgroundColor: t.inset, borderWidth: 1, borderColor: t.cardBorder },
    btnGhostText: { color: t.textDim, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
    empty: { color: t.textFaint, fontSize: 12, fontStyle: 'italic' },
    verdict: { fontSize: 12, fontWeight: '700', lineHeight: 17 },
    log: {
      backgroundColor: t.inset,
      borderWidth: 1,
      borderColor: t.cardBorder,
      borderRadius: 10,
      padding: 10,
      gap: 1,
    },
    logLine: { color: t.text, fontSize: 10, fontFamily: 'Menlo' },
  });
