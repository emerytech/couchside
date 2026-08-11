/**
 * Phone-keyboard input for the desktop Control screens (portrait + landscape).
 *
 * A hook rather than a component so the TOGGLE BUTTON (inline in a toolbar)
 * and the COMPOSE BAR (absolute at the screen root) can live in different
 * spots of the tree while sharing one closure — the button's onPress must
 * focus the TextInput SYNCHRONOUSLY inside the touch handler or iOS refuses
 * to raise the keyboard (proven on the Pad's KeyboardBar, whose mechanics
 * this reuses: textDelta diff so paste works, empty-field Backspace
 * forwarding, keyboard-height lift, dismiss-on-OS-hide).
 *
 * Typing rides the EXISTING {t:'kt'} / {t:'k'} uinput keyboard path on
 * /ws/gamepad — proven on the KDE desktop on hardware (typed into a konsole,
 * opened Kickoff) — NOT the portal (whose keysym path delivered nothing).
 *
 * `autoOpenSignal`: increment to raise the keyboard from outside a touch
 * handler (the box's {t:'osk'} event — Steam text fields). iOS may refuse a
 * non-touch focus; that degrades to "stays closed", same as the Pad.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard, Platform, Pressable, StyleSheet, TextInput, View,
} from 'react-native';

import { textDelta } from '@/app/(tabs)/pad';
import { DesktopKeys } from '@/components/DesktopKeys';
import { GamepadClient } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function useDesktopKeyboard(
  client: GamepadClient,
  opts?: { autoOpenSignal?: number; landscape?: boolean },
): { bar: React.ReactNode; open: boolean; toggle: () => void } {
  const landscape = opts?.landscape ?? false;
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [value, setValue] = useState('');
  const valueRef = useRef(value);
  valueRef.current = value;

  const setOpenSynced = useCallback((v: boolean) => {
    openRef.current = v;
    setOpen(v);
  }, []);

  const focus = useCallback(() => {
    setOpenSynced(true);
    // Landscape uses our own drawn keys — no system-keyboard focus. Portrait
    // focuses SYNCHRONOUSLY inside the tap handler (deferring loses the touch
    // context and iOS refuses to raise the keyboard). The input is always mounted.
    if (!landscape) inputRef.current?.focus();
  }, [setOpenSynced, landscape]);

  const dismiss = useCallback(() => {
    if (!landscape) {
      Keyboard.dismiss();
      inputRef.current?.blur();
    }
    setOpenSynced(false);
    setValue('');
  }, [setOpenSynced, landscape]);

  const toggle = useCallback(() => {
    hapticLight();
    if (openRef.current) dismiss();
    else focus();
  }, [dismiss, focus]);

  // Box raised its keyboard (Steam text field) -> raise ours. Skips mount.
  const autoOpenSignal = opts?.autoOpenSignal ?? 0;
  const lastAutoOpen = useRef(autoOpenSignal);
  useEffect(() => {
    if (autoOpenSignal === lastAutoOpen.current) return;
    lastAutoOpen.current = autoOpenSignal;
    if (autoOpenSignal > 0 && !openRef.current) focus();
  }, [autoOpenSignal, focus]);

  // Diff-based send (the field keeps its text): backspaces + insert. Paste is
  // just a large insert. Same contract as the Pad's KeyboardBar.
  const onChangeText = useCallback((next: string) => {
    const { backspaces, insert } = textDelta(valueRef.current, next);
    for (let i = 0; i < backspaces; i += 1) client.sendKey('backspace');
    if (insert.length > 0) client.sendText(insert);
    setValue(next);
  }, [client]);

  const onKeyPress = useCallback((e: { nativeEvent: { key: string } }) => {
    const key = e.nativeEvent.key;
    // Backspace on an EMPTY field can't show as a diff but must still delete
    // on the box; a non-empty field is left to onChangeText (else doubled).
    if (key === 'Backspace') {
      if (valueRef.current.length === 0) client.sendKey('backspace');
    } else if (key === 'Enter') {
      client.sendKey('enter');
    }
  }, [client]);

  // Lift the bar above the OS keyboard: window-coord math (edge-to-edge
  // Android doesn't resize the window; iOS KAV misses late mounts).
  const [kbLift, setKbLift] = useState(0);
  const anchorRef = useRef<View>(null);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const show = Keyboard.addListener(showEvent, (e) => {
      const kbTop = e.endCoordinates?.screenY;
      if (kbTop == null) return;
      anchorRef.current?.measureInWindow((_x, y) => {
        if (typeof y === 'number') setKbLift(Math.max(0, y - kbTop));
      });
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbLift(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Any OS dismissal (Done, swipe, backgrounding) closes the bar for real.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      openRef.current = false;
      setOpen(false);
      setValue('');
    });
    return () => sub.remove();
  }, []);

  // LANDSCAPE: our own translucent floating keys over the desktop — no opaque
  // system keyboard walling off the screen. Same uinput send path.
  if (landscape) {
    return {
      open,
      toggle,
      bar: (
        <DesktopKeys
          visible={open}
          onChar={(ch) => client.sendText(ch)}
          onSpecial={(k) => client.sendKey(k)}
          onHide={dismiss}
        />
      ),
    };
  }

  const bar = (
    <>
      {/* Zero-size anchor at the container's bottom edge — window-coord measure
          feeds the keyboard lift. collapsable=false so Android keeps it. */}
      <View ref={anchorRef} collapsable={false} style={styles.kbAnchor} pointerEvents="none" />
      {/* ONE input, restyled — NOT hidden in a 0-height box. Closed it is a 1x1
          opacity-0.02 focusable sliver: iOS refuses first-responder on a
          zero-size/transparent/overflow-hidden view, so hiding the container
          made focus() bounce ("flash and close"). Open it becomes the compose
          field above the keyboard. (Proven pattern from the Pad's KeyboardBar.) */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onKeyPress={onKeyPress}
        onSubmitEditing={() => client.sendKey('enter')}
        onBlur={() => { setOpenSynced(false); setValue(''); }}
        style={open
          ? [styles.kbInput, landscape && styles.kbInputLandscape, { bottom: 10 + kbLift }]
          : styles.hiddenInput}
        placeholder={open ? 'Type on the box…' : undefined}
        placeholderTextColor={t.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        blurOnSubmit={false}
        caretHidden={!open}
        keyboardAppearance="dark"
      />
      {open && (
        <Pressable onPress={dismiss} hitSlop={12}
          accessibilityLabel="Hide keyboard"
          style={({ pressed }) => [styles.kbHide, { bottom: 10 + kbLift + 52 }, pressed && styles.pressed]}>
          <Ionicons name="chevron-down" size={16} color={t.textDim} />
        </Pressable>
      )}
    </>
  );

  return { bar, open, toggle };
}

const makeStyles = (t: Palette) => StyleSheet.create({
  pressed: { opacity: 0.7 },
  kbAnchor: { position: 'absolute', bottom: 0, left: 0, width: 0, height: 0 },
  // CLOSED: invisible but FOCUSABLE 1x1 sliver (iOS won't focus a 0-size or
  // fully transparent view). Transparent text keeps keystrokes unseen.
  hiddenInput: {
    position: 'absolute', bottom: 0, left: 0, width: 1, height: 1,
    opacity: 0.02, color: 'transparent',
  },
  // OPEN: the compose field pinned above the keyboard (lift added inline).
  kbInput: {
    position: 'absolute', left: 10, right: 10, zIndex: 60,
    color: t.text, fontSize: 15, fontFamily: mono,
    paddingVertical: 10, paddingHorizontal: 12, paddingRight: 40,
    backgroundColor: t.card, borderRadius: 10,
    borderColor: t.cardBorder, borderWidth: 1,
  },
  // LANDSCAPE: the remote screen fills the phone, so the field must not wall it
  // off — translucent (see the desktop through it) + narrower (leave the right
  // side clear). Portrait keeps the solid full-width field (plenty of room).
  kbInputLandscape: {
    right: '42%', paddingVertical: 7,
    backgroundColor: 'rgba(12,14,20,0.62)',
    borderColor: 'rgba(255,255,255,0.18)',
  },
  kbHide: {
    position: 'absolute', right: 16, zIndex: 61,
    backgroundColor: t.card, borderColor: t.cardBorder, borderWidth: 1,
    borderRadius: 999, padding: 8,
  },
});
