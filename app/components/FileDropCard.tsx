/**
 * "Send a file to your box" — a phone->box file drop on the Console tab.
 *
 * Pick any file on the phone and stream it to the box's drop dir
 * (~/Downloads/Couchside) via POST /api/upload. The bytes go straight from disk
 * to the wire (expo-file-system upload task), so a multi-GB game/video is fine,
 * and progress is shown live.
 *
 * Probe-and-appear: the card exists ONLY when the box explicitly reports the
 * file_upload capability (agent >= 2.9.54). An older agent has no /api/upload
 * route, so the cap is undefined and the card stays hidden — a dead button costs
 * more trust than a missing one.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '@/lib/api';
import { hapticLight } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

type Phase = 'idle' | 'uploading' | 'done' | 'error';

export function FileDropCard() {
  const { settings } = useSettings();
  const styles = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState(0);
  const [detail, setDetail] = useState('');

  const send = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      // The agent rejects any non-basename; strip a path defensively regardless.
      const name = (asset.name || 'file').split(/[\\/]/).pop() || 'file';
      setPhase('uploading');
      setFileName(name);
      setProgress(0);
      setDetail('');
      hapticLight();
      const result = await api.uploadFile(settings, asset.uri, name, setProgress);
      setDetail(result.path || '');
      setPhase('done');
    } catch (e) {
      setDetail(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    }
  }, [settings]);

  // Probe-and-appear: only when the box says it can receive (no dead button).
  if (settings.caps?.file_upload !== true) return null;

  const uploading = phase === 'uploading';
  const pct = Math.round(progress * 100);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="cloud-upload-outline" size={16} color={styles.iconColor.color} />
        <Text style={styles.title}>Send a file to your box</Text>
      </View>

      {phase === 'done' ? (
        <Text style={styles.ok}>✓ Sent {fileName}</Text>
      ) : phase === 'error' ? (
        <Text style={styles.err}>{detail}</Text>
      ) : (
        <Text style={styles.hint}>
          Pick any file — it lands in <Text style={styles.code}>~/Downloads/Couchside</Text> on your box.
        </Text>
      )}

      {uploading && (
        <View style={styles.progressRow}>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${pct}%` }]} />
          </View>
          <Text style={styles.pct}>{pct}%</Text>
        </View>
      )}
      {phase === 'done' && !!detail && <Text style={styles.pathHint}>{detail}</Text>}

      <Pressable
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, uploading && styles.btnDisabled]}
        disabled={uploading}
        onPress={send}>
        <Text style={styles.btnText}>
          {uploading ? `Sending ${fileName}…` : phase === 'done' ? 'Send another file' : 'Choose a file…'}
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.card,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginBottom: 14,
      gap: 7,
    },
    iconColor: { color: t.blue },
    header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    title: { color: t.text, fontSize: 13, fontWeight: '700', flex: 1 },
    hint: { color: t.textDim, fontSize: 12, lineHeight: 17 },
    code: { fontFamily: mono, color: t.textDim },
    ok: { color: t.green, fontSize: 12, fontWeight: '700' },
    err: { color: t.red, fontSize: 12, lineHeight: 17 },
    pathHint: { color: t.textFaint, fontSize: 11, fontFamily: mono },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: t.inset, overflow: 'hidden' },
    fill: { height: 6, borderRadius: 3, backgroundColor: t.blue },
    pct: { color: t.textDim, fontSize: 11, fontFamily: mono, width: 38, textAlign: 'right' },
    btn: {
      backgroundColor: t.blue,
      borderRadius: 9,
      paddingVertical: 9,
      alignItems: 'center',
      marginTop: 1,
    },
    btnPressed: { opacity: 0.85 },
    btnDisabled: { opacity: 0.6 },
    btnText: { color: '#0b1220', fontSize: 13, fontWeight: '700' },
  });
