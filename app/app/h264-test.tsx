/**
 * TEMP diagnostic (P4b H.264 WebCodecs tier, Stage C) — device-tests the real
 * decoder end to end: opens ws://<box>/ws/h264 inside a react-native-webview,
 * WebCodecs-decodes the Annex-B stream, paints it to a canvas, and overlays live
 * stats (decode fps, paint fps, first-frame latency, kB received, decoder queue).
 *
 * This proves the phone half against the box half already verified on hardware
 * (agent /ws/h264 -> ~32fps @ 720p30 Annex-B). Iterated over Metro — no rebuild
 * (build 172 already bundles react-native-webview).
 *
 * REMOVE this route + the Setup entry when the tier is wired into desktop.tsx
 * (Stage D); the reusable decoder lives in components/H264DecoderView.tsx.
 */
import { Stack, router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { H264DecoderView, type H264Msg, type H264Profile } from '@/components/H264DecoderView';
import { useLockOrientation } from '@/hooks/useLockOrientation';
import { resolveEffectiveHost } from '@/lib/api';
import { useSettings } from '@/lib/SettingsContext';

const PROFILES: H264Profile[] = ['720p30', '720p60', '1080p30', '1080p60'];

export default function H264Test() {
  useLockOrientation('portrait');
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const [profile, setProfile] = useState<H264Profile>('720p30');
  const [env, setEnv] = useState<string>('(waiting for WebView…)');
  const [stats, setStats] = useState<string>('');
  const [status, setStatus] = useState<string>('connecting');
  const [firstFrameMs, setFirstFrameMs] = useState<number | null>(null);
  // Remount the WebView to reconnect / change profile (fresh page + socket).
  const [gen, setGen] = useState(0);
  const seenFirst = useRef(false);

  const host = resolveEffectiveHost(settings);
  const { port, token } = settings;
  const configured = host.trim().length > 0 && !!token;

  const onMsg = (m: H264Msg) => {
    switch (m.t) {
      case 'env':
        setEnv(
          `secureCtx=${m.isSecureContext} hasVideoDecoder=${m.hasVideoDecoder} origin=${m.origin}`,
        );
        if (!m.hasVideoDecoder) setStatus('NO VideoDecoder (secure-context?)');
        break;
      case 'wsopen':
        setStatus('ws open — awaiting consent + frames');
        break;
      case 'wsclose':
        setStatus(`ws closed (code ${m.code}) — no module / denied / over cap`);
        break;
      case 'wserror':
        setStatus('ws error');
        break;
      case 'configured':
        setStatus(`decoding ${m.codec}`);
        break;
      case 'cfgerror':
        setStatus(`configure FAILED (${m.codec}): ${m.msg}`);
        break;
      case 'firstframe':
        if (!seenFirst.current) {
          seenFirst.current = true;
          setFirstFrameMs(m.ms);
        }
        break;
      case 'decerror':
      case 'chunkerror':
        setStats((s) => `⚠ ${m.msg}\n${s}`);
        break;
      case 'stats':
        setStats(
          `dec ${m.decFps}fps  paint ${m.paintFps}fps  q=${m.queue}\n` +
            `frames dec=${m.framesDecoded} paint=${m.framesPainted}  ${m.kbRx}kB  errs=${m.decErrs}\n` +
            `codec=${m.codec ?? '—'}`,
        );
        break;
    }
  };

  const reconnect = () => {
    seenFirst.current = false;
    setFirstFrameMs(null);
    setStatus('connecting');
    setStats('');
    setGen((g) => g + 1);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ title: 'H.264 decoder test' }} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.status} numberOfLines={1}>
          {status}
        </Text>
      </View>

      <View style={styles.profiles}>
        {PROFILES.map((p) => (
          <Pressable
            key={p}
            onPress={() => {
              setProfile(p);
              reconnect();
            }}
            style={[styles.pill, p === profile && styles.pillOn]}
          >
            <Text style={[styles.pillText, p === profile && styles.pillTextOn]}>{p}</Text>
          </Pressable>
        ))}
        <Pressable onPress={reconnect} style={[styles.pill, styles.reconnect]}>
          <Text style={styles.pillText}>↻</Text>
        </Pressable>
      </View>

      <View style={styles.stage}>
        {configured ? (
          <H264DecoderView
            key={`${gen}-${profile}`}
            host={host}
            port={port}
            token={token}
            profile={profile}
            onMessage={onMsg}
            style={styles.web}
          />
        ) : (
          <Text style={styles.warn}>No box configured — pair a box first.</Text>
        )}
      </View>

      <View style={styles.footer}>
        <Text style={styles.mono}>
          {host}:{port} · /ws/h264?profile={profile}
        </Text>
        {firstFrameMs != null && (
          <Text style={styles.good}>first frame: {firstFrameMs} ms</Text>
        )}
        <Text style={styles.mono}>{env}</Text>
        <Text style={styles.mono}>{stats}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0d12' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  back: { paddingVertical: 4, paddingRight: 12 },
  backText: { color: '#7aa2ff', fontSize: 15 },
  status: { color: '#e8e8ea', fontSize: 13, flexShrink: 1, textAlign: 'right' },
  profiles: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 8, flexWrap: 'wrap' },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: '#1a1f2e' },
  pillOn: { backgroundColor: '#2f6bff' },
  reconnect: { backgroundColor: '#28304a' },
  pillText: { color: '#aeb6c8', fontSize: 13, fontWeight: '600' },
  pillTextOn: { color: '#fff' },
  stage: { flex: 1, backgroundColor: '#000', margin: 8, borderRadius: 8, overflow: 'hidden' },
  web: { flex: 1, backgroundColor: '#000' },
  warn: { color: '#f5a', textAlign: 'center', marginTop: 40, paddingHorizontal: 20 },
  footer: { paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#05060a', gap: 3 },
  good: { color: '#4ade80', fontSize: 12, fontWeight: '700' },
  mono: { color: '#cdd3e0', fontSize: 11, fontFamily: 'Menlo' },
});
