/**
 * Couch Mode sheet (opened from the top-bar Couch button). Flings a desktop
 * (Plasma) box into Game Mode on the TV: pick the TV output, optionally HDR,
 * one tap. When the box is already in Game Mode, the sheet flips to a single
 * "Back to Desktop" exit — the return path Steam itself doesn't give you.
 *
 * State comes from the box (api.displays -> session), so the enter/exit view
 * reflects reality: dropping back to desktop from the box shows up on the next
 * poll.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { api, ConnSettings, Displays } from '@/lib/api';
import { hapticError, hapticLight, hapticSuccess } from '@/lib/haptics';
import { mono, theme } from '@/lib/theme';

export function CouchModeSheet({
  visible,
  settings,
  displays,
  onChanged,
  onClose,
}: {
  visible: boolean;
  settings: ConnSettings;
  displays: Displays | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const inGameMode = displays?.session === 'gamescope';
  const outputs = displays?.game_outputs ?? [];
  const [output, setOutput] = useState<string>(outputs[0] ?? '');
  const [hdr, setHdr] = useState(false);
  const [busy, setBusy] = useState(false);

  // Seed the picker from the box's current outputs when the sheet OPENS — not
  // on every background poll (which would fight a mid-selection change).
  const wasVisible = React.useRef(false);
  useEffect(() => {
    const opening = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!opening) return;
    setOutput((cur) => (outputs.includes(cur) ? cur : outputs[0] ?? ''));
  }, [visible, outputs]);

  const fling = useCallback(async () => {
    if (busy || !output) return;
    setBusy(true);
    hapticLight();
    try {
      await api.couchModeStart(settings, output, hdr);
      hapticSuccess();
      onChanged();
      onClose();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [busy, output, hdr, settings, onChanged, onClose]);

  const toDesktop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    hapticLight();
    try {
      await api.desktopMode(settings);
      hapticSuccess();
      onChanged();
      onClose();
    } catch {
      hapticError();
    } finally {
      setBusy(false);
    }
  }, [busy, settings, onChanged, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>COUCH MODE</Text>

          {inGameMode ? (
            <>
              <View style={styles.armedRow}>
                <Ionicons name="game-controller" size={18} color={theme.green} />
                <Text style={styles.armedText}>Gaming on the TV</Text>
              </View>
              <Pressable
                disabled={busy}
                onPress={toDesktop}
                style={({ pressed }) => [styles.startBtn, styles.exitBtn, pressed && styles.pressed]}>
                <Ionicons name="desktop-outline" size={18} color="#fff" />
                <Text style={styles.startText}>{busy ? 'Switching…' : 'Back to Desktop'}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.blurb}>
                Move this desktop to the TV in Game Mode — display, audio, and input all
                hand over. Tap Back to Desktop to return.
              </Text>

              {outputs.length > 1 && (
                <>
                  <Text style={styles.sub}>GAME DISPLAY</Text>
                  <View style={styles.pills}>
                    {outputs.map((name) => {
                      const on = name === output;
                      return (
                        <Pressable
                          key={name}
                          onPress={() => {
                            hapticLight();
                            setOutput(name);
                          }}
                          style={[styles.pill, on && styles.pillOn]}>
                          <Text style={[styles.pillText, on && styles.pillTextOn]}>{name}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              <View style={styles.hdrRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.hdrLabel}>HDR</Text>
                  <Text style={styles.hdrSub}>Enable HDR on the TV (if supported).</Text>
                </View>
                <Switch
                  value={hdr}
                  onValueChange={(v) => {
                    hapticLight();
                    setHdr(v);
                  }}
                  trackColor={{ false: theme.inset, true: theme.blue }}
                />
              </View>

              <Pressable
                disabled={busy || !output}
                onPress={fling}
                style={({ pressed }) => [
                  styles.startBtn,
                  (pressed || busy || !output) && styles.pressed,
                ]}>
                <Ionicons name="tv-outline" size={18} color="#fff" />
                <Text style={styles.startText}>{busy ? 'Switching…' : 'Fling to TV'}</Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    padding: 20,
    paddingBottom: 32,
    gap: 10,
  },
  title: { color: theme.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, fontFamily: mono },
  sub: { color: theme.textFaint, fontSize: 10, fontWeight: '700', letterSpacing: 1, fontFamily: mono, marginTop: 6 },
  blurb: { color: theme.textDim, fontSize: 13, lineHeight: 19 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  pill: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: theme.inset,
    borderColor: theme.cardBorder,
    borderWidth: 1,
  },
  pillOn: { borderColor: theme.blue, backgroundColor: 'rgba(80,150,255,0.12)' },
  pillText: { color: theme.textDim, fontSize: 14, fontWeight: '600', fontFamily: mono },
  pillTextOn: { color: theme.blue },
  pressed: { opacity: 0.7 },

  hdrRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 12 },
  hdrLabel: { color: theme.text, fontSize: 15, fontWeight: '600' },
  hdrSub: { color: theme.textDim, fontSize: 11, marginTop: 2 },

  startBtn: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.blue,
  },
  exitBtn: { backgroundColor: theme.green },
  startText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  armedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.inset,
    borderRadius: 10,
    padding: 12,
  },
  armedText: { color: theme.text, fontSize: 15 },
});
