/**
 * Setup › Account › APP ERROR LOG — the phone app's own recent errors, with Copy
 * and Share, plus how to get a NATIVE crash out of the phone.
 *
 * Not the box journal (that is Setup › Logs, the box's systemd units). This is
 * the app: the last few JS errors, screen errors and "closed unexpectedly"
 * exits recorded by lib/crashLog. Deliberately NOT behind <Gated> like the
 * journal: a user whose trial ended must still be able to report a crash.
 *
 * Nothing is sent anywhere. Copy puts the text on the clipboard; Share opens
 * the OS share sheet (React Native `Share`) so the user picks where it goes.
 *
 * The native-crash help exists because the likeliest crashes (a native module
 * throwing: the pinned-TLS socket, the volume-button listener, a Fabric mount
 * race) run no JS and cannot be logged here. On Android the system keeps them
 * in the `crash` log buffer; the help names the exact package id so the user
 * can find Couchside's block (store and direct editions differ).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { ANDROID_PACKAGES, APP_ID } from '@/lib/appVersion';
import { clearCrashLog, crashReport, useCrashLog, type CrashEntry } from '@/lib/crashLog';
import { kindLabel } from '@/lib/crashLogCore';
import { hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

/** Entries shown before "Show all". The full log is always in Copy/Share. */
const PREVIEW = 3;

function when(ts: number): string {
  try {
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return String(ts);
  }
}

export function CrashLogCard() {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const log = useCrashLog();
  const [showAll, setShowAll] = useState(false);
  const [status, setStatus] = useState<{ msg: string; bad: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  const say = (msg: string, bad = false) => {
    setStatus({ msg, bad });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 2500);
  };

  const onCopy = async () => {
    hapticLight();
    let ok = false;
    try {
      ok = await Clipboard.setStringAsync(crashReport());
    } catch {
      ok = false;
    }
    say(ok ? 'Copied ✓' : 'Couldn’t copy — try Share', !ok);
  };

  const onShare = async () => {
    hapticLight();
    try {
      await Share.share({ message: crashReport(), title: 'Couchside error log' });
    } catch {
      say('Sharing isn’t available here — use Copy', true);
    }
  };

  const onClear = () => {
    hapticLight();
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearCrashLog();
    setConfirmClear(false);
    say('Cleared');
  };

  const newestFirst = [...log.entries].reverse();
  const shown = showAll ? newestFirst : newestFirst.slice(0, PREVIEW);
  const pkg = APP_ID || ANDROID_PACKAGES.join(' / ');

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="bug-outline" size={14} color={t.textDim} />
        <Text style={styles.headerText}>APP ERROR LOG</Text>
        <Text style={styles.count}>
          {log.entries.length === 0 ? 'empty' : `${log.entries.length} recent`}
        </Text>
      </View>
      <Text style={styles.sub}>
        This phone app’s own recent errors (not your box’s — that’s the Logs tab). Kept on this
        phone only; Couchside never sends them. Copy or Share to include them in a bug report.
      </Text>

      {newestFirst.length === 0 ? (
        <Text style={styles.empty}>No errors recorded.</Text>
      ) : (
        <View style={styles.list}>
          {shown.map((e) => (
            <EntryRow key={e.id} e={e} styles={styles} />
          ))}
          {newestFirst.length > PREVIEW && (
            <Pressable onPress={() => setShowAll((v) => !v)} hitSlop={6} accessibilityRole="button">
              <Text style={styles.link}>
                {showAll ? 'Show fewer' : `Show all ${newestFirst.length}`}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.btnRow}>
        <Pressable
          onPress={() => void onCopy()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
          <Ionicons name="copy-outline" size={14} color={t.text} />
          <Text style={styles.btnText}>Copy</Text>
        </Pressable>
        <Pressable
          onPress={() => void onShare()}
          accessibilityRole="button"
          style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
          <Ionicons name="share-outline" size={14} color={t.text} />
          <Text style={styles.btnText}>Share</Text>
        </Pressable>
        {log.entries.length > 0 && (
          <Pressable
            onPress={onClear}
            accessibilityRole="button"
            style={({ pressed }) => [styles.btn, confirmClear && styles.btnDanger, pressed && styles.pressed]}>
            <Text style={[styles.btnText, confirmClear && styles.btnDangerText]}>
              {confirmClear ? 'Tap to confirm' : 'Clear'}
            </Text>
          </Pressable>
        )}
      </View>
      {!!status && <Text style={[styles.status, status.bad && styles.statusBad]}>{status.msg}</Text>}

      <Pressable
        onPress={() => setShowHelp((v) => !v)}
        hitSlop={6}
        accessibilityRole="button"
        style={styles.helpToggle}>
        <Ionicons name={showHelp ? 'chevron-down' : 'chevron-forward'} size={13} color={t.blue} />
        <Text style={styles.link}>If the app closes with nothing logged here</Text>
      </Pressable>
      {showHelp &&
        (Platform.OS === 'ios' ? (
          <Text style={styles.help}>
            A crash inside iOS or a native library runs no app code, so it can’t be logged here.
            iOS keeps its own report: Settings › Privacy &amp; Security › Analytics &amp;
            Improvements › Analytics Data — look for entries that start with “Couchside”, open
            the newest, and share it.
          </Text>
        ) : (
          <View style={styles.helpBox}>
            <Text style={styles.help}>
              A crash inside Android or a native library runs no app code, so it can’t be logged
              here. Android keeps it in the system crash log. With USB debugging on and the
              phone connected to a computer with adb, run:
            </Text>
            <Text style={styles.code} selectable>
              adb logcat -b crash -d &gt; crash.txt
            </Text>
            <Text style={styles.help}>
              Then send crash.txt, or the block in it that names{' '}
              <Text style={styles.codeInline}>{pkg}</Text>. Run it soon after the crash — the
              buffer is small and older crashes roll off.
            </Text>
          </View>
        ))}
    </View>
  );
}

function EntryRow({ e, styles }: { e: CrashEntry; styles: ReturnType<typeof makeStyles> }) {
  const tone = e.kind === 'fatal' || e.kind === 'exit' ? styles.kindBad : styles.kindWarn;
  return (
    <View style={styles.entry}>
      <View style={styles.entryHead}>
        <Text style={[styles.kind, tone]}>{kindLabel(e.kind)}</Text>
        <Text style={styles.entryWhen}>
          {when(e.ts)}
          {e.count > 1 ? ` · ×${e.count}` : ''}
        </Text>
      </View>
      <Text style={styles.entryMsg} numberOfLines={3}>
        {e.kind === 'exit' ? 'No app error captured — likely a native crash.' : `${e.name}: ${e.message}`}
      </Text>
      {(!!e.route || !!e.app) && (
        <Text style={styles.entryMeta} numberOfLines={1}>
          {[e.route && `screen ${e.route}`, e.app && `app ${e.app}`].filter(Boolean).join(' · ')}
        </Text>
      )}
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
      padding: 14,
      marginTop: 12,
      marginBottom: 12,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
    headerText: {
      color: t.textDim,
      fontSize: 11,
      fontWeight: '800',
      letterSpacing: 1.2,
      fontFamily: mono,
      flex: 1,
    },
    count: { color: t.textFaint, fontSize: 11, fontFamily: mono },
    sub: { color: t.textDim, fontSize: 12, lineHeight: 17 },
    empty: { color: t.textFaint, fontSize: 12, fontFamily: mono, marginTop: 10 },
    list: { marginTop: 10, gap: 8 },
    entry: {
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 8,
      padding: 9,
    },
    entryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    kind: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, fontFamily: mono, color: t.amber },
    kindBad: { color: t.red },
    kindWarn: { color: t.amber },
    entryWhen: { color: t.textFaint, fontSize: 11, fontFamily: mono, flex: 1, textAlign: 'right' },
    entryMsg: { color: t.text, fontSize: 12, fontFamily: mono, lineHeight: 16, marginTop: 4 },
    entryMeta: { color: t.textFaint, fontSize: 10, fontFamily: mono, marginTop: 3 },
    link: { color: t.blue, fontSize: 12, fontWeight: '700' },
    btnRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
    btn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 8,
      paddingVertical: 9,
      paddingHorizontal: 14,
    },
    btnText: { color: t.text, fontSize: 13, fontWeight: '700' },
    btnDanger: { borderColor: t.red },
    btnDangerText: { color: t.red },
    pressed: { opacity: 0.7 },
    status: { color: t.green, fontSize: 12, fontFamily: mono, marginTop: 8 },
    statusBad: { color: t.amber },
    helpToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 14 },
    helpBox: { gap: 6 },
    help: { color: t.textDim, fontSize: 12, lineHeight: 17, marginTop: 6 },
    code: {
      color: t.text,
      fontFamily: mono,
      fontSize: 12,
      backgroundColor: t.inset,
      borderColor: t.cardBorder,
      borderWidth: 1,
      borderRadius: 6,
      paddingVertical: 7,
      paddingHorizontal: 9,
      marginTop: 4,
    },
    codeInline: { color: t.text, fontFamily: mono, fontSize: 12 },
  });
