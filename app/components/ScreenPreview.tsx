/**
 * Live screen preview (Console tab). Probe-and-appear: renders nothing until the
 * box reports a capture path (gamescope/desktop), then a sticky card. Preview is
 * OFF by default — captures cost GPU — until the user taps START. While active it
 * pulls one frame ~every second from the resolved host as a base64 data URI (no
 * disk cache: a frame may show a password prompt), and auto-stops when the tab
 * blurs or the app backgrounds. Tap the frame for a fullscreen modal.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { api, hostKey, screenFrameSource, ScreenInfo } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, theme } from '@/lib/theme';

const FRAME_INTERVAL_MS = 1000;
const FULLSCREEN_INTERVAL_MS = 700;

export function ScreenPreview() {
  const { settings, ready } = useSettings();
  const configured = !!settings.host && !!settings.token;

  // Slow probe: just detects whether capture is possible on this box.
  const boxKey = hostKey(settings);
  const probe = usePoll<ScreenInfo | null>(
    () => api.screenInfo(settings),
    30000,
    ready && configured,
    boxKey, // clear the previous box's probe on switch
  );
  // Sticky PER BOX: once this box has ever reported capture support, keep the
  // card so a later 404 (e.g. the greeter after a session restart) is
  // explained, not hidden. Stickiness must not survive a box switch — that
  // once left the card showing "no capturable session" on a headless box that
  // never supported capture at all.
  //
  // The dataKey check is load-bearing, not belt-and-braces: on a box switch,
  // React finishes executing the discarded render pass with the OLD box's
  // probe.data still visible, and a bare `if (probe.data)` there re-poisons
  // this ref right after the reset below. dataKey identifies which box the
  // data belongs to, so the doomed pass can't attribute it to the new box.
  // (See PollState.dataKey in hooks/usePoll.ts.)
  const everSupported = useRef(false);
  const supportKeyRef = useRef(boxKey);
  if (supportKeyRef.current !== boxKey) {
    supportKeyRef.current = boxKey;
    everSupported.current = false;
  }
  if (probe.data && probe.dataKey === boxKey) everSupported.current = true;
  const supported = probe.data != null;

  const [active, setActive] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastGood, setLastGood] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Generation token: each start() owns a unique gen; any stop()/start() bumps
  // it so orphaned in-flight tick chains self-terminate at their next check and
  // can never overlap (a shared boolean can't tell chains apart). timerRef holds
  // the one pending frame timer so stop() can cancel it too.
  const genRef = useRef(0);
  const focusedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    genRef.current++;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(
    (intervalMs: number) => {
      stop(); // cancel any prior chain + pending timer first
      const myGen = ++genRef.current;
      const run = async () => {
        if (genRef.current !== myGen) return;
        const uri = await screenFrameSource(settings);
        if (genRef.current !== myGen) return; // superseded/stopped mid-fetch
        if (uri) {
          setFrame(uri);
          setFailed(false);
          setLastGood(Date.now());
        } else {
          setFailed(true);
        }
        if (genRef.current === myGen) {
          timerRef.current = setTimeout(run, intervalMs);
        }
      };
      void run();
    },
    [settings, stop],
  );

  const intervalFor = useCallback(
    () => (fullscreen ? FULLSCREEN_INTERVAL_MS : FRAME_INTERVAL_MS),
    [fullscreen],
  );

  // Drive the loop from the active toggle + fullscreen cadence.
  useEffect(() => {
    if (active && focusedRef.current) start(intervalFor());
    else stop();
    return stop;
  }, [active, intervalFor, start, stop]);

  // Pause on blur (leaving the tab) and on backgrounding; resume on return.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (active) start(intervalFor());
      const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
        if (s === 'active') {
          focusedRef.current = true;
          if (active) start(intervalFor());
        } else {
          focusedRef.current = false;
          stop();
        }
      });
      return () => {
        focusedRef.current = false;
        stop();
        sub.remove();
      };
    }, [active, intervalFor, start, stop]),
  );

  const toggle = useCallback(() => {
    hapticLight();
    setActive((a) => {
      if (a) {
        setFrame(null);
        setFailed(false);
      }
      return !a;
    });
  }, []);

  if (!supported && !everSupported.current) return null;

  const noSession = !supported && everSupported.current;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>SCREEN</Text>
        {supported && (
          <Pressable
            onPress={toggle}
            style={({ pressed }) => [styles.pill, active && styles.pillOn, pressed && styles.pressed]}>
            <Ionicons
              name={active ? 'stop' : 'play'}
              size={12}
              color={active ? theme.bg : theme.green}
            />
            <Text style={[styles.pillText, active && styles.pillTextOn]}>
              {active ? 'STOP' : 'START PREVIEW'}
            </Text>
          </Pressable>
        )}
      </View>

      {noSession ? (
        <View style={styles.stateBox}>
          <Ionicons name="tv-outline" size={26} color={theme.textFaint} />
          <Text style={styles.stateText}>no capturable session (greeter?)</Text>
        </View>
      ) : !active ? (
        <View style={styles.stateBox}>
          <Ionicons name="eye-outline" size={26} color={theme.textFaint} />
          <Text style={styles.stateText}>Preview is off. Tap START to see the screen.</Text>
        </View>
      ) : (
        <Pressable onPress={() => frame && setFullscreen(true)}>
          <View style={styles.frameWrap}>
            {frame ? (
              <Image source={{ uri: frame }} style={styles.frame} resizeMode="contain" />
            ) : (
              <View style={styles.frameLoading}>
                <Text style={styles.stateText}>capturing…</Text>
              </View>
            )}
            {failed && frame && (
              <View style={styles.failBadge}>
                <Text style={styles.failText}>
                  CAPTURE FAILED{lastGood ? ` · last ${new Date(lastGood).toLocaleTimeString()}` : ''}
                </Text>
              </View>
            )}
          </View>
        </Pressable>
      )}

      <Modal visible={fullscreen} transparent animationType="fade" onRequestClose={() => setFullscreen(false)}>
        <Pressable style={styles.fsRoot} onPress={() => setFullscreen(false)}>
          {frame && <Image source={{ uri: frame }} style={styles.fsImage} resizeMode="contain" />}
          <View style={styles.fsHint} pointerEvents="none">
            <Text style={styles.fsHintText}>tap to close</Text>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: theme.textFaint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, fontFamily: mono },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderColor: theme.green,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  pillOn: { backgroundColor: theme.green },
  pillText: { color: theme.green, fontSize: 11, fontWeight: '700', fontFamily: mono },
  pillTextOn: { color: theme.bg },
  pressed: { opacity: 0.7 },

  stateBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 22, gap: 8 },
  stateText: { color: theme.textDim, fontSize: 13, textAlign: 'center' },

  frameWrap: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000',
    aspectRatio: 16 / 9,
  },
  frame: { width: '100%', height: '100%' },
  frameLoading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  failBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  failText: { color: theme.amber, fontSize: 10, fontWeight: '700', fontFamily: mono },

  fsRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  fsImage: { width: '100%', height: '100%' },
  fsHint: { position: 'absolute', bottom: 30 },
  fsHintText: { color: theme.textDim, fontSize: 12, fontFamily: mono },
});
