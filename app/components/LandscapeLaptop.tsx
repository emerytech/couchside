/**
 * Landscape "laptop mode" for the Pad tab: rotate the phone sideways and the
 * (non-gamepad) pad surface becomes a trackpad with a mini-QWERTY under it, like
 * a laptop, for driving the box's DESKTOP. Portrait is unchanged, and the
 * gamepad/move modes keep their own landscape spreads — this is only for the
 * pointer/typing surfaces, which otherwise force portrait because a trackpad
 * "gains nothing from landscape" (pad.tsx's own words). It does now: a full-width
 * trackpad plus a real keyboard is exactly the desktop-driving layout that never
 * fit portrait.
 *
 * REUSE, not reinvention. The trackpad is the shared `useTrackpad` gesture engine
 * (the same one the portrait MOUSE surface and the Remote nav circle use); the
 * keyboard is `DesktopKeys` (the translucent landscape grid built for the Desktop
 * Control screen). Both ride the SAME `GamepadClient` the Pad already owns — this
 * component mounts no socket of its own (that lifecycle stays in PadScreen, the
 * KI-053 rule), it just calls methods on the client handed to it.
 *
 * Gated behind the `landscapeLaptop` pref (default on, disable in Preferences).
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DesktopKeys } from '@/components/DesktopKeys';
import { hapticLight } from '@/lib/haptics';
import type { GamepadClient, MouseButton } from '@/lib/gamepad';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';
import { useTrackpad, type TrackpadCallbacks } from '@/hooks/useTrackpad';

export function LandscapeLaptop({
  client,
  tp,
  hasDesktop,
  onExit,
}: {
  /** The Pad's live gamepad-WS client — mouse buttons + keys ride it directly. */
  client: GamepadClient;
  /** The Pad's trackpad handlers (haptics + texture already baked in). */
  tp: TrackpadCallbacks;
  /** Show START/OVERVIEW (desktop nav) — a Game-Mode box has no desktop. */
  hasDesktop: boolean;
  /** ✕ / rotate-back: pops out of laptop mode and re-locks portrait. */
  onExit: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const responder = useTrackpad(tp);
  // The keyboard is collapsible so the whole surface can be one big trackpad.
  const [kbOpen, setKbOpen] = useState(true);

  // A momentary mouse button: down on touch, up on release — so press-and-hold
  // (drag with LEFT held) works, not just a click.
  const holdBtn = (k: MouseButton) => ({
    onPressIn: () => { hapticLight(); client.sendMouseButton(k, 1); },
    onPressOut: () => client.sendMouseButton(k, 0),
  });

  return (
    <View style={[styles.root, { paddingTop: insets.top + 4, paddingLeft: insets.left, paddingRight: insets.right }]}>
      {/* Control strip: exit, the three mouse buttons, ESC, desktop nav, keyboard toggle. */}
      <View style={styles.strip}>
        <StripBtn label={<Ionicons name="close" size={18} color={t.text} />} onPress={onExit} accLabel="Exit laptop mode" />
        <View style={styles.stripGap} />
        <StripBtn label="LEFT" {...holdBtn('l')} accLabel="Left mouse button" />
        <StripBtn label="MID" {...holdBtn('m')} accLabel="Middle mouse button" />
        <StripBtn label="RIGHT" {...holdBtn('r')} accLabel="Right mouse button" />
        <StripBtn label="ESC" onPress={() => client.sendKey('esc')} accLabel="Escape" />
        {hasDesktop && (
          <>
            <StripBtn label="START" onPress={() => client.sendDesktopKey('meta')} accLabel="Desktop menu" />
            <StripBtn label="OVERVIEW" onPress={() => client.sendDesktopKey('overview')} accLabel="Window overview" />
          </>
        )}
        <View style={styles.stripGap} />
        <StripBtn
          label={<Ionicons name={kbOpen ? 'chevron-down' : 'keypad-outline'} size={18} color={t.text} />}
          onPress={() => { hapticLight(); setKbOpen((v) => !v); }}
          accLabel={kbOpen ? 'Hide keyboard' : 'Show keyboard'}
        />
      </View>

      {/* Trackpad — fills the space above the (floating, translucent) keyboard. */}
      <View style={styles.pad} {...responder.panHandlers}>
        <Text style={styles.hint}>trackpad · drag to move · tap = click · two fingers = right-click / scroll</Text>
      </View>

      {/* Mini-QWERTY, floating over the lower trackpad (box-none: taps in the gaps
          still reach the pad). Same grid + uinput path as the Desktop screen. */}
      <DesktopKeys
        visible={kbOpen}
        onChar={(ch) => client.sendText(ch)}
        onSpecial={(k) => client.sendKey(k)}
        onHide={() => setKbOpen(false)}
      />
    </View>
  );
}

function StripBtn({
  label, onPress, onPressIn, onPressOut, accLabel,
}: {
  label: ReactNode;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  accLabel: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel={accLabel}
      hitSlop={4}
      style={({ pressed }) => [styles.stripBtn, pressed && styles.stripBtnPressed]}>
      {typeof label === 'string' ? <Text style={styles.stripBtnText}>{label}</Text> : label}
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    strip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 10, paddingVertical: 6,
    },
    stripGap: { flex: 1 },
    stripBtn: {
      minWidth: 40, height: 34, borderRadius: 8, paddingHorizontal: 10,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1,
    },
    stripBtnPressed: { backgroundColor: t.inset },
    stripBtnText: { color: t.text, fontSize: 12, fontWeight: '700', fontFamily: mono, letterSpacing: 0.5 },
    pad: {
      flex: 1, margin: 10, borderRadius: 14,
      backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center',
    },
    hint: { color: t.textFaint, fontSize: 11, fontFamily: mono, paddingHorizontal: 16, textAlign: 'center' },
  });
