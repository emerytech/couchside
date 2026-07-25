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
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '@/lib/api';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { useSettings } from '@/lib/SettingsContext';
import { mono, useThemedStyles } from '@/lib/theme';
import type { Palette } from '@/lib/theme';

type Phase = 'idle' | 'uploading' | 'done' | 'error';

/** How long the "✓ Sent …" confirmation stays before the card resets itself.
 *  Long enough to read it and still tap "Show on box"; short enough that the
 *  card isn't still naming a file you sent ten minutes ago. */
const DONE_LINGER_MS = 12_000;

export function FileDropCard() {
  const { settings } = useSettings();
  const styles = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<Phase>('idle');
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState(0);
  const [detail, setDetail] = useState('');
  const [bytes, setBytes] = useState(0);
  const [revealMsg, setRevealMsg] = useState('');

  // The ✓ line used to sit there with the filename until the next upload, so the
  // card kept advertising a file you sent minutes ago. Clear back to the neutral
  // prompt after a beat — long enough to read the confirmation and still tap
  // "Show on box", short enough that the card doesn't become a stale receipt.
  // Only the SUCCESS state auto-clears: an error has to stay until it's read.
  useEffect(() => {
    if (phase !== 'done') return undefined;
    const id = setTimeout(() => {
      setPhase('idle');
      setFileName('');
      setBytes(0);
      setDetail('');
      setRevealMsg('');
      setProgress(0);
    }, DONE_LINGER_MS);
    return () => clearTimeout(id);
  }, [phase]);

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
      setBytes(result.bytes || asset.size || 0);
      setPhase('done');
      // A LAN drop of a document is often over before the progress bar paints a
      // single frame, so "it worked" has to be felt as well as seen: a success
      // haptic fires here and the ✓ row below stays put until the next action.
      // Deliberately NOT slowing the upload down to show a bar — a fake delay
      // would make the feature worse to use in exchange for a nicer animation.
      hapticSuccess();
    } catch (e) {
      setDetail(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    }
  }, [settings]);

  // "Show on box": raise the drop folder in the box's file manager. Desktop-only
  // on the agent side; in Game Mode it answers opened:false + a reason, which we
  // surface verbatim rather than silently doing nothing.
  const reveal = useCallback(async () => {
    hapticLight();
    setRevealMsg('');
    try {
      const r = await api.revealDrop(settings);
      if (!r.opened) setRevealMsg(r.reason || 'Could not open the folder on the box.');
    } catch {
      setRevealMsg('Could not open the folder on the box.');
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
        // Size included on purpose: a LAN drop is usually instant, so "✓ Sent"
        // alone can read as "did anything happen?". The byte count is the
        // box's OWN reported number, i.e. proof of what actually landed.
        <Text style={styles.ok}>
          ✓ Sent {fileName}
          {bytes > 0 ? ` · ${formatBytes(bytes)}` : ''}
        </Text>
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
      {!!revealMsg && <Text style={styles.revealMsg}>{revealMsg}</Text>}

      <Pressable
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, uploading && styles.btnDisabled]}
        disabled={uploading}
        onPress={send}>
        <Text style={styles.btnText}>
          {uploading ? `Sending ${fileName}…` : phase === 'done' ? 'Send another file' : 'Choose a file…'}
        </Text>
      </Pressable>

      {/* "Show on box" — only after a successful drop, and only when the box is
          on the DESKTOP (caps.desktop flips per session switch). Game Mode has
          no file manager to raise, so offering it there would be a dead button. */}
      {phase === 'done' && settings.caps?.desktop === true && (
        <Pressable
          style={({ pressed }) => [styles.btnGhost, pressed && styles.btnPressed]}
          onPress={reveal}>
          <Text style={styles.btnGhostText}>Show on box</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Human-readable size for the ✓ line (1 decimal past KB, matching the Console). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
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
    // Secondary action: outlined, so it reads as "optional extra" next to the
    // filled primary button rather than competing with it.
    btnGhost: {
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 9,
      paddingVertical: 8,
      alignItems: 'center',
    },
    btnGhostText: { color: t.text, fontSize: 12, fontWeight: '600' },
    revealMsg: { color: t.amber, fontSize: 11, lineHeight: 15 },
  });
