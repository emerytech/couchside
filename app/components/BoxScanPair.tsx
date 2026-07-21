/**
 * Scan the LAN for Couchside boxes and pair one with a PIN — no IP typing, no
 * token. Mirrors how a TV pairs: tap a discovered box, the box shows a PIN on
 * ITS OWN screen, you type that PIN here, and the box hands back its token.
 *
 * The PIN (shown only on the box's screen) is the physical-presence proof; the
 * token never appears until the right PIN is entered. Needs agent >= 2.9.12 and
 * a native build with react-native-udp (scanAvailable).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { pairFinish, pairStart } from '@/lib/api';
import { FoundBox, scanAvailable, scanForBoxes, selfIp } from '@/lib/boxDiscovery';
import { hapticSelection } from '@/lib/haptics';
import { navigateAfterPair } from '@/lib/postPair';
import { useBoxes } from '@/lib/SettingsContext';
import { useTheme, useThemedStyles, type Palette } from '@/lib/theme';

type Phase =
  | { k: 'idle' }
  | { k: 'scanning' }
  | { k: 'list'; boxes: FoundBox[] }
  | { k: 'pin'; box: FoundBox } // box is showing a PIN; awaiting entry
  | { k: 'pairing'; box: FoundBox };

export function BoxScanPair() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { addBox } = useBoxes();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const scan = useCallback(async () => {
    setMsg(null);
    setPhase({ k: 'scanning' });
    try {
      const boxes = await scanForBoxes({ timeoutMs: 3000 });
      setPhase({ k: 'list', boxes });
      if (boxes.length === 0) {
        // Show which subnet was swept — if this isn't the boxes' subnet (e.g. a
        // VPN skewed the phone's IP), that's why nothing was found.
        const ip = await selfIp();
        setMsg({
          ok: false,
          text: ip
            ? `No boxes found (scanned ${ip}/24). Check the same Wi-Fi, turn off any VPN, or add one by IP below.`
            : 'No boxes found — check the same Wi-Fi, or add one by IP below.',
        });
      }
    } catch {
      setPhase({ k: 'idle' });
      setMsg({ ok: false, text: 'Scan needs a newer build of the app.' });
    }
  }, []);

  // Tap a discovered box: ask it to show a PIN on its own screen, then prompt.
  const startPair = useCallback(async (box: FoundBox) => {
    hapticSelection();
    setMsg(null);
    setPin('');
    setPhase({ k: 'pairing', box });
    try {
      const r = await pairStart(box.ip, box.port);
      if (r.ok) {
        setPhase({ k: 'pin', box });
        setMsg({ ok: true, text: `Enter the PIN now showing on ${box.name}.` });
      } else {
        setPhase({ k: 'list', boxes: [box] });
        setMsg({ ok: false, text: r.error ?? 'Could not start pairing on that box.' });
      }
    } catch {
      setPhase({ k: 'list', boxes: [box] });
      setMsg({ ok: false, text: 'Could not reach that box.' });
    }
  }, []);

  const submitPin = useCallback(async () => {
    if (phase.k !== 'pin') return;
    const box = phase.box;
    const code = pin.trim();
    if (code.length !== 6) {
      setMsg({ ok: false, text: 'Enter the 6-digit PIN from the box.' });
      return;
    }
    setPhase({ k: 'pairing', box });
    try {
      const r = await pairFinish(box.ip, box.port, code);
      if (r.ok && r.token) {
        const added = await addBox({
          host: box.host,
          port: r.port ?? box.port,
          token: r.token,
          lastIp: box.ip,
        });
        setPhase({ k: 'idle' });
        setPin('');
        setMsg({ ok: true, text: `Paired ${box.name}.` });
        // Straight to the remote — see lib/postPair.ts.
        navigateAfterPair(added);
      } else {
        setPhase({ k: 'pin', box });
        setMsg({ ok: false, text: r.error ?? 'Pairing failed — check the PIN and retry.' });
      }
    } catch {
      setPhase({ k: 'pin', box });
      setMsg({ ok: false, text: 'Could not reach that box.' });
    }
  }, [phase, pin, addBox]);

  const cancel = useCallback(() => {
    setPhase({ k: 'idle' });
    setPin('');
    setMsg(null);
  }, []);

  if (!scanAvailable) return null; // old build without the UDP module

  return (
    <View style={styles.wrap}>
      {phase.k === 'pin' ? (
        <>
          <Text style={styles.hint}>A 6-digit PIN is showing on {phase.box.name}. Enter it:</Text>
          <TextInput
            value={pin}
            onChangeText={(v) => setPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="6-digit PIN"
            placeholderTextColor={t.textFaint}
            keyboardType="number-pad"
            autoFocus
            style={styles.input}
          />
          <View style={styles.row}>
            <Pressable onPress={cancel} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostText}>CANCEL</Text>
            </Pressable>
            <Pressable onPress={submitPin} style={[styles.btn, styles.btnPrimary]}>
              <Text style={styles.btnPrimaryText}>PAIR</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Pressable
            onPress={scan}
            disabled={phase.k === 'scanning' || phase.k === 'pairing'}
            style={[styles.scanBtn, (phase.k === 'scanning' || phase.k === 'pairing') && styles.busy]}>
            {phase.k === 'scanning' || phase.k === 'pairing' ? (
              <ActivityIndicator color={t.blue} />
            ) : (
              <>
                <Ionicons name="wifi" size={16} color={t.blue} />
                <Text style={styles.scanText}>Scan for boxes</Text>
              </>
            )}
          </Pressable>
          {phase.k === 'list' && phase.boxes.length > 0 ? (
            <View style={styles.list}>
              {phase.boxes.map((b) => (
                <Pressable key={b.ip} onPress={() => startPair(b)} style={styles.boxRow}>
                  <Ionicons name="hardware-chip-outline" size={18} color={t.text} />
                  <View style={styles.boxText}>
                    <Text style={styles.boxName} numberOfLines={1}>{b.name}</Text>
                    <Text style={styles.boxMeta}>{b.ip} · v{b.version || '?'}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={t.textDim} />
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      )}
      {msg ? (
        <Text style={[styles.msg, { color: msg.ok ? t.green : t.red }]}>{msg.text}</Text>
      ) : null}
    </View>
  );
}

const makeStyles = (t: Palette) => StyleSheet.create({
  wrap: { gap: 10 },
  hint: { color: t.textDim, fontSize: 13, lineHeight: 18 },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 11,
    minHeight: 44,
    backgroundColor: t.inset,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  busy: { opacity: 0.7 },
  scanText: { color: t.blue, fontSize: 14, fontWeight: '700' },
  list: { gap: 6 },
  boxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: t.card,
    borderWidth: 1,
    borderColor: t.cardBorder,
  },
  boxText: { flex: 1 },
  boxName: { color: t.text, fontSize: 14, fontWeight: '700' },
  boxMeta: { color: t.textDim, fontSize: 12, marginTop: 1 },
  input: {
    backgroundColor: t.inset,
    borderColor: t.cardBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: t.text,
    fontSize: 18,
    letterSpacing: 4,
  },
  row: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  btnGhost: { backgroundColor: t.inset },
  btnGhostText: { color: t.textDim, fontWeight: '700', fontSize: 13 },
  btnPrimary: { backgroundColor: t.blue },
  btnPrimaryText: { color: t.bg, fontWeight: '800', fontSize: 13 },
  msg: { fontSize: 13, lineHeight: 18 },
});
