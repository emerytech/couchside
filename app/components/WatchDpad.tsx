/**
 * WatchDpad — an on-screen d-pad for driving the page open in the Couchside
 * Player (Netflix/YouTube tile grids, and any web page's focus ring).
 *
 * WHY THIS EXISTS: streaming UIs are spatial grids you navigate with a remote's
 * arrows, not by scrolling. Before this, the Watch panel could only launch a
 * service and then abandon it — you could not move between tiles from the couch.
 *
 * HOW IT WORKS: the agent exposes a token-authed, hold-gated uinput keyboard on
 * /ws/gamepad, so this reuses GamepadClient.sendKey() exactly like the desktop
 * keyboard does. uinput delivers a REAL, trusted key event to whatever the
 * compositor has focused — the Player tile's fullscreen Chrome — so the page's
 * own key handler responds. (A synthetic CDP KeyboardEvent would be
 * isTrusted:false and Netflix ignores it; that is why this path, not CDP.)
 *
 * WHICH KEYS — MEASURED, NOT ASSUMED (2026-08-17, reference box, real sites,
 * each run carrying a control key whose answer was already known):
 *
 *   netflix.com   right/down -> focus UNCHANGED     tab -> Mima to pokemonRhyott
 *   youtube.com   right/down -> focus UNCHANGED     tab -> "Skip navigation" to
 *                                                          "Search with voice"
 *
 * Arrow-key grid navigation is a TV-APP behaviour; the WEB versions of these
 * services ignore arrows entirely and move their focus ring on Tab. So:
 *
 *   left / right -> Shift+Tab / Tab   walk the focus ring ALONG a row
 *   up / down    -> navup / navdown   a SPATIAL focus step between rows
 *   OK           -> enter             activates whatever now has focus
 *   Back         -> esc
 *
 * Up/down cannot be keys. Tab is linear, so from the middle of a row it would
 * have to walk every remaining tile to reach the row below, and arrow keys only
 * scroll the viewport on these sites — the focus ring stays put. The agent's
 * navup/navdown ops instead pick the nearest focusable element above/below
 * geometrically (agent >= 2.9.95). Verified on the real Netflix browse grid:
 * down walked More Info -> Netflix Minigolf -> The Last House -> Walter Boys and
 * up retraced it; OK then opened that title's detail modal, proving the focus
 * those ops set is REAL focus a genuine key activates.
 *
 * Shift+Tab needs agent >= 2.9.95 (the `shifttab` chord). An older agent does
 * not merely ignore an unknown key name — it errors and CLOSES the session — so
 * the back-direction button feature-detects via client.supportsKey() and falls
 * back to a plain arrow rather than risking the socket.
 *
 * We connect with noPad:true so the agent never materialises a virtual Xbox pad
 * for this session (which would make Steam announce a controller). Keys only
 * flow while this session HOLDS control; if another device holds, the panel
 * offers Take control, mirroring the Pad tab's handoff.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from 'expo-router';

import { api } from '@/lib/api';
import { GamepadClient, GamepadStatus, SpecialKey } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { useThemedStyles, type Palette } from '@/lib/theme';
import type { Settings } from '@/lib/settings';

/** Names this device to the current holder's Pass/Keep prompt. Matches pad.tsx. */
const DEVICE_LABEL =
  Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android phone' : 'A device';

/** How long to wait on a silent holder before offering a forced takeover. */
const FORCE_AFTER_MS = 20_000;

export function WatchDpad({
  settings,
  ready,
  navOps,
}: {
  settings: Settings;
  ready: boolean;
  /** PlayerState.nav_ops — which spatial steps this box accepts. */
  navOps?: string[];
}) {
  const styles = useThemedStyles(makeStyles);
  const navigation = useNavigation();

  // Same handoff preference the Pad uses: ask-to-pass vs grab. Read through a
  // ref so flipping it never re-runs the connection effect (which keys on the
  // connection identity only).
  const askToSwitch = usePref('askToSwitchControl');
  const askRef = useRef(askToSwitch);
  askRef.current = askToSwitch;

  const [status, setStatus] = useState<GamepadStatus>('closed');
  const [holder, setHolder] = useState<string | null>(null);
  const [canForce, setCanForce] = useState(false);

  const clientRef = useRef<GamepadClient | null>(null);
  if (clientRef.current == null) clientRef.current = new GamepadClient();
  const client = clientRef.current;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Connection lifecycle, mirrored from pad.tsx: connect on mount and on tab
  // focus, disconnect on blur/unmount and when backgrounded, so a key can never
  // leak to the box while the user is on another tab. connect() is idempotent;
  // an idle socket sends nothing, so holding it open while a page is up is free.
  useEffect(() => {
    if (!ready) return undefined;

    client.onStatus((s, d) => {
      setStatus(s);
      setHolder(d);
      if (s !== 'waiting') setCanForce(false);
    });

    const connect = () =>
      client.connect(settingsRef.current, {
        handoffAsk: askRef.current,
        deviceName: DEVICE_LABEL,
        noPad: true, // never create a virtual gamepad — we only send key frames
      });
    const disconnect = () => client.close();

    const offFocus = navigation.addListener('focus', connect);
    const offBlur = navigation.addListener('blur', disconnect);
    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        connect();
        client.ensureLive();
      } else disconnect();
    });

    connect();

    return () => {
      offFocus();
      offBlur();
      appSub.remove();
      disconnect();
      client.onStatus(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connection identity
    // only; settingsRef/askRef carry the rest without re-running.
  }, [client, ready, settings.host, settings.port, settings.token, navigation]);

  // A holder who never answers (walked away / app backgrounded) shouldn't block
  // forever: after a grace period, offer to force the takeover.
  useEffect(() => {
    if (status !== 'waiting') return undefined;
    const t = setTimeout(() => setCanForce(true), FORCE_AFTER_MS);
    return () => clearTimeout(t);
  }, [status]);

  const holding = status === 'connected';

  const press = (key: SpecialKey) => {
    if (!holding) return;
    hapticLight();
    client.sendKey(key);
  };

  /**
   * Walk the page's focus ring. Forward is Tab everywhere; backward needs the
   * Shift+Tab chord (agent >= 2.9.95). Against an older agent that name would
   * close the session, so fall back to a plain Left arrow — which does nothing
   * on Netflix/YouTube but is harmless, and still scrolls pages that respond to
   * arrows. Checked at press time, not mount: the socket may reconnect to a
   * different box while the panel is open.
   */
  const focusStep = (forward: boolean) => {
    if (forward) return press('tab');
    return press(client.supportsKey('shifttab') ? 'shifttab' : 'left');
  };

  /**
   * Vertical step. Rides the agent's spatial nav op when the box offers it,
   * else falls back to an arrow key — which on these sites only scrolls, but is
   * the most a pre-2.9.95 box can do and is never harmful.
   *
   * Fire-and-forget: a failed step is not worth an error banner (the common
   * "failure" is simply having reached the last row), and the d-pad must stay
   * responsive to rapid presses rather than serialising on a round trip.
   */
  const canNav = (op: 'navup' | 'navdown') => navOps?.includes(op) === true;
  const vertical = (down: boolean) => {
    const op = down ? 'navdown' : 'navup';
    if (!canNav(op)) return press(down ? 'down' : 'up');
    hapticLight();
    api.playerOp(settings, op).catch(() => {});
  };

  const takeControl = () => {
    hapticLight();
    const s = client.getStatus();
    if (s === 'waiting') {
      if (canForce) client.forceControl();
      else client.requestControl();
    } else if (s === 'released') {
      client.requestControl();
    } else {
      // replaced / closed / error / connecting: re-dial and grab (this tap is an
      // explicit "I want to drive now", so don't ask).
      client.connect(settingsRef.current, {
        handoffAsk: false,
        deviceName: DEVICE_LABEL,
        noPad: true,
      });
    }
  };

  // Not holding control: show who does and a way to take it, instead of a live
  // d-pad whose presses the box would silently drop.
  if (!holding) {
    const waiting = status === 'connecting' || status === 'closed';
    return (
      <View style={styles.wrap} testID="watch-dpad">
        <Text style={styles.title}>NAVIGATE</Text>
        <View style={styles.handoff}>
          <Text style={styles.handoffText} numberOfLines={2}>
            {waiting
              ? 'Connecting to the box…'
              : holder
                ? `${holder} has the controller.`
                : 'Another device has the controller.'}
          </Text>
          {!waiting && (
            <Pressable
              onPress={takeControl}
              testID="watch-dpad-take"
              style={({ pressed }) => [styles.takeBtn, pressed && styles.pressed]}
            >
              <Text style={styles.takeText}>
                {status === 'waiting' && canForce ? 'Take control now' : 'Take control'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID="watch-dpad">
      <Text style={styles.title}>NAVIGATE</Text>

      {/* Cross: up/down SCROLL the page, left/right walk the focus ring. */}
      <View style={styles.row}>
        <View style={styles.cell} />
        <DKey
          label="▲"
          testID="watch-dpad-up"
          onPress={() => vertical(false)}
          styles={styles}
        />
        <View style={styles.cell} />
      </View>
      <View style={styles.row}>
        <DKey
          label="◀"
          testID="watch-dpad-left"
          onPress={() => focusStep(false)}
          styles={styles}
        />
        <DKey
          label="OK"
          testID="watch-dpad-ok"
          onPress={() => press('enter')}
          styles={styles}
          main
        />
        <DKey
          label="▶"
          testID="watch-dpad-right"
          onPress={() => focusStep(true)}
          styles={styles}
        />
      </View>
      <View style={styles.row}>
        <View style={styles.cell} />
        <DKey
          label="▼"
          testID="watch-dpad-down"
          onPress={() => vertical(true)}
          styles={styles}
        />
        <View style={styles.cell} />
      </View>

      <Pressable
        onPress={() => press('esc')}
        testID="watch-dpad-back"
        style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
      >
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <Text style={styles.hint}>
        ◀ ▶ along a row · ▲ ▼ between rows · OK selects · Back exits
      </Text>
    </View>
  );
}

/** One d-pad key. Split out so every cell is the same square, keeping the cross
 *  aligned regardless of glyph width. */
function DKey({
  label,
  testID,
  onPress,
  styles,
  main,
}: {
  label: string;
  testID: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  main?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.key, main && styles.keyMain, pressed && styles.pressed]}
    >
      <Text style={[styles.keyText, main && styles.keyMainText]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    wrap: {
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.cardBorder,
      paddingTop: 12,
      alignItems: 'center',
    },
    title: {
      color: t.textFaint,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.2,
      alignSelf: 'stretch',
    },
    row: { flexDirection: 'row', gap: 8 },
    cell: { width: 64, height: 52 },
    key: {
      width: 64,
      height: 52,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    keyMain: { backgroundColor: t.accent, borderColor: t.accent },
    keyText: { color: t.text, fontSize: 18, fontWeight: '700' },
    keyMainText: { color: '#0b1220', fontSize: 15 },
    backBtn: {
      marginTop: 2,
      paddingHorizontal: 22,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.inset,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.cardBorder,
    },
    backText: { color: t.text, fontSize: 13, fontWeight: '600' },
    hint: { color: t.textFaint, fontSize: 11, textAlign: 'center' },
    pressed: { opacity: 0.6 },
    handoff: {
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 4,
    },
    handoffText: { color: t.textDim, fontSize: 13, flex: 1 },
    takeBtn: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: t.accent,
    },
    takeText: { color: '#0b1220', fontSize: 13, fontWeight: '700' },
  });
