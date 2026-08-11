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
import { GamepadClient } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { mono, useTheme, useThemedStyles, type Palette } from '@/lib/theme';

export function useDesktopKeyboard(
  client: GamepadClient,
  opts?: { autoOpenSignal?: number },
): { bar: React.ReactNode; open: boolean; toggle: () => void } {
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
    // Synchronous inside the tap handler — deferring loses the touch context
    // and iOS refuses to raise the keyboard. The input is always mounted.
    inputRef.current?.focus();
  }, [setOpenSynced]);

  const dismiss = useCallback(() => {
    Keyboard.dismiss();
    inputRef.current?.blur();
    setOpenSynced(false);
    setValue('');
  }, [setOpenSynced]);

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

  const bar = (
    <>
      {/* zero-size anchor marking the container's bottom in window coords */}
      <View ref={anchorRef} style={styles.kbAnchor} pointerEvents="none" />
      <View
        style={[styles.kbBar, { bottom: kbLift }, !open && styles.kbBarHidden]}
        pointerEvents={open ? 'auto' : 'none'}>
        <TextInput
          ref={inputRef}
          style={styles.kbInput}
          value={value}
          onChangeText={onChangeText}
          onKeyPress={onKeyPress}
          onSubmitEditing={() => client.sendKey('enter')}
          blurOnSubmit={false}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardAppearance="dark"
          placeholder="Type on the box…"
          placeholderTextColor={t.textFaint}
        />
        <Pressable onPress={dismiss} hitSlop={8}
          accessibilityLabel="Hide keyboard"
          style={({ pressed }) => [styles.kbHide, pressed && styles.pressed]}>
          <Ionicons name="chevron-down" size={18} color={t.textDim} />
        </Pressable>
      </View>
    </>
  );

  return { bar, open, toggle };
}

const makeStyles = (t: Palette) => StyleSheet.create({
  pressed: { opacity: 0.7 },
  kbAnchor: { position: 'absolute', bottom: 0, left: 0, width: 0, height: 0 },
  kbBar: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: t.card, borderTopColor: t.cardBorder, borderTopWidth: 1,
  },
  kbBarHidden: { opacity: 0, height: 0, paddingVertical: 0, overflow: 'hidden' },
  kbInput: {
    flex: 1, color: t.text, fontSize: 15, fontFamily: mono,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: t.bg, borderRadius: 8,
    borderColor: t.cardBorder, borderWidth: 1,
  },
  kbHide: { padding: 6 },
});
