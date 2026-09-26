/**
 * "Couchside closed unexpectedly — copy details?" — the one-tap offer on the
 * launch after a crash.
 *
 * Shown when the local error log has a PENDING crash: a JS fatal recorded just
 * before the process died, or an inferred exit (the previous process ended
 * while on screen with no JS error — likely native; see lib/crashLog). Once per
 * crash: Copy details and Dismiss both clear the pending mark, and a new crash
 * sets a new one. The same text is always available later in Setup › Account.
 *
 * Nothing is sent anywhere. Copy puts the report on the user's clipboard.
 *
 * Also the error log's route tracker: it is mounted once at the root for the
 * life of the app, so it reports the current pathname for context (which screen
 * a crash happened on — the field report was "the Pad tab's Remote mode").
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { usePathname } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { crashReport, dismissPendingCrash, noteRoute, usePendingCrash } from '@/lib/crashLog';
import { exitBannerText } from '@/lib/crashLogCore';
import { hapticLight } from '@/lib/haptics';
import { mono, useThemedStyles, type Palette } from '@/lib/theme';

export function CrashBanner() {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const pending = usePendingCrash();
  const pathname = usePathname();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    noteRoute(pathname ?? '');
  }, [pathname]);

  if (!pending) return null;

  const native = pending.kind === 'exit';

  const onCopy = async () => {
    hapticLight();
    let ok = false;
    try {
      ok = await Clipboard.setStringAsync(crashReport());
    } catch {
      ok = false;
    }
    // Only a copy that landed retires the offer; a refused one stays up with a
    // warning so the details are not lost behind a banner that went away.
    if (ok) dismissPendingCrash();
    else setFailed(true);
  };

  return (
    // box-none: only the card takes touches; the screen under it stays usable.
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
      <View style={styles.card} accessibilityRole="alert">
        <View style={styles.head}>
          <Ionicons name="warning-outline" size={15} color={styles.title.color as string} />
          <Text style={styles.title}>Couchside closed unexpectedly</Text>
        </View>
        <Text style={styles.sub}>
          {native
            ? exitBannerText(pending)
            : 'An error was recorded just before it closed. Copy the details to include in a bug report.'}
        </Text>
        {failed && (
          <Text style={styles.failed}>
            Couldn’t copy here — open Setup › Account › App error log to Share it instead.
          </Text>
        )}
        <View style={styles.actions}>
          <Pressable
            onPress={() => {
              hapticLight();
              dismissPendingCrash();
            }}
            hitSlop={6}
            accessibilityRole="button"
            style={styles.action}>
            <Text style={styles.actionMuted}>Dismiss</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void onCopy();
            }}
            hitSlop={6}
            accessibilityRole="button"
            style={styles.action}>
            <Text style={styles.actionBold}>Copy details</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 14 },
    card: {
      maxWidth: 460,
      width: '100%',
      backgroundColor: t.card,
      borderColor: t.amber,
      borderWidth: 1,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 16,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    title: { color: t.amber, fontFamily: mono, fontSize: 13, fontWeight: '800', flex: 1 },
    sub: { color: t.textDim, fontSize: 12, marginTop: 5, lineHeight: 17 },
    failed: { color: t.red, fontSize: 11, marginTop: 6, lineHeight: 15 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 22, marginTop: 10 },
    action: { paddingVertical: 2 },
    actionMuted: { color: t.textDim, fontSize: 13, fontWeight: '600' },
    actionBold: { color: t.blue, fontSize: 13, fontWeight: '800' },
  });
