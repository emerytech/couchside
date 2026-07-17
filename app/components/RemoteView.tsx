import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useState } from 'react';
import { PanResponder, PanResponderInstance, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePoll } from '@/hooks/usePoll';
import { useTrackpad } from '@/hooks/useTrackpad';
import { api, hostKey, Status, Tv, TvKey, TvOp } from '@/lib/api';
import { GamepadClient } from '@/lib/gamepad';
import { hapticLight } from '@/lib/haptics';
import { usePref } from '@/lib/prefs';
import { Settings } from '@/lib/settings';
import { mono, theme } from '@/lib/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/**
 * Traditional TV-remote layout for the Pad tab: big circular D-pad with OK,
 * corner keys, volume/brightness rockers, Steam + QAM, source row.
 *
 * Two nav targets when the box's display is a Newline panel on RS-232 (the
 * agent reports tv.keys): BOX drives the box over the virtual gamepad
 * (D-pad/A/B), TV emulates the Newline factory remote over serial (arrows/OK/
 * menu/home/back/settings/brightness). Without RS-232 only BOX exists and the
 * TV-specific clusters stay hidden — CEC/soft setups keep a clean remote.
 */
export function RemoteView({
  client,
  settings,
}: {
  client: GamepadClient;
  settings: Settings;
}) {
  // TV caps, self-polled: cheap, and the strip adapts if the backend changes.
  // Deliberately does NOT gate on tvPoll.error: usePoll keeps last-good data
  // through a transient failure, and dropping the caps there would silently
  // flip the nav target from TV to BOX mid-interaction (one lost poll would
  // turn OSD arrow presses into gamepad presses inside a game). A box with no
  // backend never yields data (404), so the TV clusters still stay hidden.
  const tvPoll = usePoll<Tv>(() => api.tv(settings), 15000, true, hostKey(settings));
  const tv = tvPoll.data?.available ? tvPoll.data : null;
  const hasTvKeys = tv?.keys === true;
  const sources = tv?.sources ?? [];
  const canBlank = tv?.screen_toggle === true;

  // Desktop nav, self-polled and session-aware: the SteamOS/Bazzite desktop
  // cluster (Start menu, trackpad, overview) appears only while the box is in
  // the Plasma desktop, and the poll flips it off once it's flung to Game Mode.
  const statusPoll = usePoll<Status>(() => api.status(settings), 8000, true, hostKey(settings));
  const showDesktopNav = usePref('padDesktopNav');
  const hasDesktop = statusPoll.data?.caps?.desktop === true && showDesktopNav;

  const [target, setTarget] = useState<'box' | 'tv'>('box');
  const nav = hasTvKeys ? target : 'box';

  // Nav-circle input surface: the classic D-pad, or a relative-mouse trackpad
  // (desktop only). Force back to the D-pad if the box leaves desktop mode.
  const [surface, setSurface] = useState<'dpad' | 'track'>('dpad');
  const trackpad = hasDesktop && surface === 'track';
  const [joyActive, setJoyActive] = useState(false);
  // The nav circle is ELASTIC: it sizes to whatever vertical space is left
  // after the fixed rows (which vary — TV keys, the desktop cluster). Measured
  // from its own container so the whole remote always fits ONE screen with no
  // scroll, on any phone and with any set of rows present.
  const [circleSize, setCircleSize] = useState(200);
  const onCircleLayout = React.useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = e.nativeEvent.layout;
      const s = Math.max(132, Math.min(240, Math.floor(Math.min(width, height)) - 4));
      setCircleSize((prev) => (Math.abs(prev - s) > 1 ? s : prev));
    },
    [],
  );

  // ---- senders -------------------------------------------------------------

  const tvKey = useCallback(
    (k: TvKey) => {
      hapticLight();
      void api.tvKey(settings, k).catch(() => {});
    },
    [settings],
  );

  const padTap = useCallback(
    (k: 'du' | 'dd' | 'dl' | 'dr' | 'a' | 'b' | 'start' | 'select') => {
      hapticLight();
      client.sendButton(k, 1);
      setTimeout(() => client.sendButton(k, 0), 50);
    },
    [client],
  );

  const steam = useCallback(() => {
    hapticLight();
    client.sendButton('guide', 1);
    setTimeout(() => client.sendButton('guide', 0), 60);
  }, [client]);

  const qam = useCallback(() => {
    hapticLight();
    client.qamChord();
  }, [client]);

  const tvOp = useCallback(
    (op: TvOp) => {
      hapticLight();
      void api.tvSend(settings, op, settings.volumeTarget ?? 'box').catch(() => {});
    },
    [settings],
  );

  const blank = useCallback(() => {
    hapticLight();
    void api.tvScreenToggle(settings).catch(() => {});
  }, [settings]);

  const source = useCallback(
    (id: string) => {
      hapticLight();
      void api.tvSelectSource(settings, id).catch(() => {});
    },
    [settings],
  );

  // ---- desktop nav senders (SteamOS/Bazzite Plasma, via the WS uinput) ------

  const leftClick = useCallback(() => {
    hapticLight();
    client.sendMouseButton('l', 1);
    setTimeout(() => client.sendMouseButton('l', 0), 40);
  }, [client]);

  const rightClick = useCallback(() => {
    hapticLight();
    client.sendMouseButton('r', 1);
    setTimeout(() => client.sendMouseButton('r', 0), 40);
  }, [client]);

  const startMenu = useCallback(() => {
    hapticLight();
    client.sendDesktopKey('meta');
  }, [client]);

  const overview = useCallback(() => {
    hapticLight();
    client.sendDesktopKey('overview');
  }, [client]);

  const escKey = useCallback(() => {
    hapticLight();
    client.sendKey('esc');
  }, [client]);

  // The nav circle's trackpad responder. Created unconditionally (a hook); its
  // panHandlers are only attached to the surface while `trackpad` is on.
  const trackpadResponder = useTrackpad({
    onMove: (dx, dy) => client.sendMouseMove(dx, dy),
    onLeftClick: leftClick,
    onRightClick: rightClick,
    onScroll: (notches) => client.sendWheel(notches),
  });

  // Nav cluster routing: BOX = virtual gamepad, TV = factory-remote serial keys.
  const navUp = () => (nav === 'tv' ? tvKey('up') : padTap('du'));
  const navDown = () => (nav === 'tv' ? tvKey('down') : padTap('dd'));
  const navLeft = () => (nav === 'tv' ? tvKey('left') : padTap('dl'));
  const navRight = () => (nav === 'tv' ? tvKey('right') : padTap('dr'));
  const navOk = () => (nav === 'tv' ? tvKey('ok') : padTap('a'));
  const navBack = () => (nav === 'tv' ? tvKey('back') : padTap('b'));
  const navMenu = () => (nav === 'tv' ? tvKey('menu') : padTap('start'));
  const navHome = () => (nav === 'tv' ? tvKey('home') : steam());
  const navSettings = () => (nav === 'tv' ? tvKey('settings') : padTap('select'));

  return (
    // Fixed, non-scrolling column: the elastic nav circle absorbs any leftover
    // height so nothing ever scrolls or clips (see circleSize).
    <View style={styles.root}>
      {/* Nav target toggle — only meaningful with an RS-232 panel */}
      {hasTvKeys && (
        <View style={styles.targetRow}>
          <View style={styles.targetSeg}>
            {(['box', 'tv'] as const).map((t) => (
              <Pressable
                key={t}
                onPress={() => {
                  hapticLight();
                  setTarget(t);
                }}
                style={[styles.seg, target === t && styles.segActive]}>
                <Text style={[styles.segText, target === t && styles.segTextActive]}>
                  {t === 'box' ? 'BOX' : 'TV'}
                </Text>
              </Pressable>
            ))}
          </View>
          {canBlank && (
            <Pressable onPress={blank} style={({ pressed }) => [styles.pwr, pressed && styles.pressed]}>
              <Ionicons name="power" size={20} color={theme.red} />
            </Pressable>
          )}
        </View>
      )}

      {/* Nav-circle surface toggle: D-pad vs trackpad (desktop boxes only) */}
      {hasDesktop && (
        <View style={styles.surfaceSeg}>
          {(['dpad', 'track'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                hapticLight();
                setSurface(s);
              }}
              style={[styles.seg, surface === s && styles.segActive]}>
              <Ionicons
                name={s === 'dpad' ? 'apps' : 'move'}
                size={14}
                color={surface === s ? theme.blue : theme.textDim}
              />
              <Text style={[styles.segText, surface === s && styles.segTextActive]}>
                {s === 'dpad' ? 'D-PAD' : 'TRACKPAD'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Corner keys + D-pad / trackpad. navBlock flexes to fill leftover
          height; circleArea (flex) centers the elastic circle between the two
          corner rows and is what onCircleLayout measures. */}
      <View style={styles.navBlock}>
        <View style={styles.cornerRow}>
          <CornerBtn icon="menu" label="MENU" onPress={navMenu} />
          <CornerBtn icon="settings-outline" label={nav === 'tv' ? 'SETTINGS' : 'VIEW'} onPress={navSettings} />
        </View>

        <View style={styles.circleArea} onLayout={onCircleLayout}>
          {trackpad ? (
            <NavTrackpad size={circleSize} responder={trackpadResponder} />
          ) : (
            <Dpad
              size={circleSize}
              onUp={navUp}
              onDown={navDown}
              onLeft={navLeft}
              onRight={navRight}
              onOk={navOk}
              // Pointer works in BOTH sessions (Big Picture has a cursor too),
              // so the joystick arms whenever OK drives the box — only the
              // serial-TV target (nav === 'tv') has no pointer to move.
              joyEnabled={nav === 'box'}
              onJoyMove={(dx, dy) => client.sendMouseMove(dx, dy)}
              onJoyActive={setJoyActive}
            />
          )}
        </View>

        <View style={styles.cornerRow}>
          <CornerBtn icon="arrow-undo" label="BACK" onPress={navBack} />
          <CornerBtn
            icon={nav === 'tv' ? 'home-outline' : 'logo-steam'}
            label={nav === 'tv' ? 'HOME' : 'STEAM'}
            onPress={navHome}
          />
        </View>
      </View>

      {/* Desktop cluster: Plasma start menu, overview, esc, explicit clicks */}
      {hasDesktop && (
        <View style={styles.deskCluster}>
          <DeskBtn icon="grid" label="START" onPress={startMenu} />
          <DeskBtn icon="copy-outline" label="OVERVIEW" onPress={overview} />
          <DeskBtn icon="close" label="ESC" onPress={escKey} />
          <DeskBtn icon="ellipse-outline" label="L-CLICK" onPress={leftClick} />
          <DeskBtn icon="ellipse" label="R-CLICK" onPress={rightClick} />
        </View>
      )}

      {/* Rockers + center stack (vol | mute/blank | brightness) */}
      <View style={styles.rockerRow}>
        <Rocker
          label="VOL"
          onPlus={() => tvOp('volume_up')}
          onMinus={() => tvOp('volume_down')}
        />
        <View style={styles.midStack}>
          <MidBtn icon="volume-mute" label="MUTE" color={theme.red} onPress={() => tvOp('mute')} />
          <MidBtn icon="logo-steam" label="STEAM" color={theme.green} onPress={steam} />
          <MidBtn icon="ellipsis-horizontal" label="QAM" color={theme.amber} onPress={qam} />
        </View>
        {hasTvKeys ? (
          <Rocker
            label="BRT"
            onPlus={() => tvKey('bright_up')}
            onMinus={() => tvKey('bright_down')}
          />
        ) : (
          <View style={styles.rockerGhost} />
        )}
      </View>

      {/* Source row (RS-232 panels only) */}
      {sources.length > 0 && (
        <View style={styles.sourceRow}>
          {sources.map((s) => {
            const isBox = s.id === 'ops';
            return (
              <Pressable
                key={s.id}
                onPress={() => source(s.id)}
                style={({ pressed }) => [
                  styles.sourcePill,
                  isBox && styles.sourcePillBox,
                  pressed && styles.pressed,
                ]}>
                <Text style={[styles.sourceText, isBox && { color: theme.green }]}>
                  {isBox ? 'BOX' : s.label.toUpperCase()}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ---- pieces ----------------------------------------------------------------

function CornerBtn({
  icon,
  label,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.corner, pressed && styles.pressed]}>
      <Ionicons name={icon} size={17} color={theme.text} />
      <Text style={styles.cornerText}>{label}</Text>
    </Pressable>
  );
}

// ---- OK-button joystick (hold OK -> velocity-controlled mouse) --------------

/** Hold this long on OK (without dragging) to arm the joystick. */
const JOY_HOLD_MS = 280;
/** Drag distance that arms the joystick immediately (clear pointing intent). */
const JOY_DRAG_ARM_PX = 12;
/** Finger offsets inside this radius move nothing (rest zone). */
const JOY_DEADZONE_PX = 10;
/** Send cadence for velocity frames. */
const JOY_TICK_MS = 33;
/** Pointer speed: px per tick at full deflection (scaled by sensitivity). */
const JOY_MAX_PX_PER_TICK = 34;
/** Offset (past deadzone) that counts as full deflection. */
const JOY_FULL_DEFLECT_PX = 90;
/** Releases quicker than this (that never armed) are an OK tap. */
const JOY_TAP_MS = 350;

/**
 * The circular D-pad: a light ring of four wedge buttons around a bright OK
 * disc, echoing a classic TV remote (light pad on dark chrome).
 *
 * On desktop-capable boxes the OK disc doubles as a JOYSTICK: hold it (or drag
 * off it) and the disc arms — finger offset from where you pressed becomes
 * cursor VELOCITY (deadzone + expo curve, like a laptop pointing stick). A
 * quick tap is still OK. No mode switch needed for casual pointing.
 */
function Dpad({
  size,
  onUp,
  onDown,
  onLeft,
  onRight,
  onOk,
  joyEnabled,
  onJoyMove,
  onJoyActive,
}: {
  onUp: () => void;
  onDown: () => void;
  onLeft: () => void;
  onRight: () => void;
  onOk: () => void;
  /** Diameter of the circle (elastic, measured by the parent). */
  size: number;
  /** Arm the hold-to-point behavior (desktop boxes). */
  joyEnabled: boolean;
  /** Relative cursor move for one tick (already scaled). */
  onJoyMove: (dx: number, dy: number) => void;
  /** Joystick armed/released — the parent locks page scrolling while armed. */
  onJoyActive: (active: boolean) => void;
}) {
  const sens = usePref('trackpadSensitivity');
  const [joy, setJoy] = useState(false);
  const geo = dpadGeometry(size);

  // All gesture state in refs: the responder is created once.
  const st = React.useRef({
    joy: false,
    t0: 0,
    offX: 0,
    offY: 0,
    holdTimer: null as ReturnType<typeof setTimeout> | null,
    tick: null as ReturnType<typeof setInterval> | null,
  });
  const cb = React.useRef({ onOk, onJoyMove, onJoyActive, joyEnabled, sens });
  cb.current = { onOk, onJoyMove, onJoyActive, joyEnabled, sens };

  const arm = React.useCallback(() => {
    const s = st.current;
    if (s.joy) return;
    s.joy = true;
    setJoy(true);
    hapticLight();
    cb.current.onJoyActive(true);
    s.tick = setInterval(() => {
      const m = Math.hypot(s.offX, s.offY);
      if (m <= JOY_DEADZONE_PX) return;
      // Expo response: gentle near center, fast at full deflection.
      const norm = Math.min((m - JOY_DEADZONE_PX) / JOY_FULL_DEFLECT_PX, 1);
      const speed = Math.pow(norm, 1.6) * JOY_MAX_PX_PER_TICK * cb.current.sens;
      cb.current.onJoyMove((s.offX / m) * speed, (s.offY / m) * speed);
    }, JOY_TICK_MS);
  }, []);

  const disarm = React.useCallback(() => {
    const s = st.current;
    if (s.holdTimer) {
      clearTimeout(s.holdTimer);
      s.holdTimer = null;
    }
    if (s.tick) {
      clearInterval(s.tick);
      s.tick = null;
    }
    if (s.joy) {
      s.joy = false;
      setJoy(false);
      cb.current.onJoyActive(false);
    }
  }, []);

  // Never leak the tick loop (unmount mid-hold, box switch, tab change).
  React.useEffect(() => disarm, [disarm]);

  const okResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Inside a ScrollView: once the OK disc owns the touch, keep it — the
      // same gesture theft that broke the trackpad face would break the hold.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        const s = st.current;
        s.t0 = Date.now();
        s.offX = 0;
        s.offY = 0;
        if (cb.current.joyEnabled) {
          s.holdTimer = setTimeout(arm, JOY_HOLD_MS);
        }
      },
      onPanResponderMove: (_e, g) => {
        const s = st.current;
        s.offX = g.dx;
        s.offY = g.dy;
        if (
          !s.joy &&
          cb.current.joyEnabled &&
          Math.hypot(g.dx, g.dy) > JOY_DRAG_ARM_PX
        ) {
          arm();
        }
      },
      onPanResponderRelease: () => {
        const s = st.current;
        const wasJoy = s.joy;
        const quick = Date.now() - s.t0 < JOY_TAP_MS;
        disarm();
        if (!wasJoy && quick) cb.current.onOk();
      },
      onPanResponderTerminate: () => disarm(),
    }),
  ).current;

  const chevron = Math.round(size * 0.13);
  return (
    <View style={[styles.dpad, geo.disc]}>
      <Pressable onPress={onUp} style={({ pressed }) => [styles.wedge, geo.wedge, geo.wedgeUp, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-up" size={chevron} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onDown} style={({ pressed }) => [styles.wedge, geo.wedge, geo.wedgeDown, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-down" size={chevron} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onLeft} style={({ pressed }) => [styles.wedge, geo.wedge, geo.wedgeLeft, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-back" size={chevron} color="#0b1220" />
      </Pressable>
      <Pressable onPress={onRight} style={({ pressed }) => [styles.wedge, geo.wedge, geo.wedgeRight, pressed && styles.wedgePressed]}>
        <Ionicons name="chevron-forward" size={chevron} color="#0b1220" />
      </Pressable>
      <View {...okResponder.panHandlers} style={[styles.ok, geo.ok, joy && styles.okJoy]}>
        {joy ? (
          <Ionicons name="move" size={Math.round(size * 0.15)} color="#f8fafc" />
        ) : (
          <Text style={[styles.okText, { fontSize: Math.round(size * 0.1) }]}>OK</Text>
        )}
      </View>
    </View>
  );
}

/** Circle geometry derived from the elastic diameter: the disc, the four wedge
 *  hit-areas around the rim, and the OK disc in the center. */
function dpadGeometry(size: number) {
  const wedge = Math.round(size * 0.34);
  const ok = Math.round(size * 0.4);
  const mid = (size - wedge) / 2;
  return {
    disc: { width: size, height: size, borderRadius: size / 2 },
    wedge: { width: wedge, height: wedge, borderRadius: wedge / 2 },
    wedgeUp: { top: 4, left: mid },
    wedgeDown: { bottom: 4, left: mid },
    wedgeLeft: { left: 4, top: mid },
    wedgeRight: { right: 4, top: mid },
    ok: {
      width: ok,
      height: ok,
      borderRadius: ok / 2,
      left: (size - ok) / 2,
      top: (size - ok) / 2,
    },
  };
}

/**
 * Trackpad face of the nav circle: same footprint as the D-pad, but the whole
 * disc is a relative-mouse surface (drag=pointer, tap=click, two-finger tap=
 * right-click, two-finger drag=scroll).
 */
function NavTrackpad({ size, responder }: { size: number; responder: PanResponderInstance }) {
  const hints = usePref('padHints');
  return (
    <View
      style={[styles.dpad, styles.navTrack, { width: size, height: size, borderRadius: size / 2 }]}
      {...responder.panHandlers}>
      <Ionicons name="move" size={Math.round(size * 0.14)} color="rgba(11,18,32,0.35)" />
      {hints && size >= 150 && (
        <Text style={styles.navTrackHint}>drag · tap = click{'\n'}2-finger: right / scroll</Text>
      )}
    </View>
  );
}

function DeskBtn({
  icon,
  label,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.desk, pressed && styles.pressed]}>
      <Ionicons name={icon} size={17} color={theme.text} />
      <Text style={styles.deskText}>{label}</Text>
    </Pressable>
  );
}

function Rocker({
  label,
  onPlus,
  onMinus,
}: {
  label: string;
  onPlus: () => void;
  onMinus: () => void;
}) {
  return (
    <View style={styles.rocker}>
      <Pressable onPress={onPlus} style={({ pressed }) => [styles.rockerBtn, pressed && styles.pressed]}>
        <Ionicons name="add" size={26} color={theme.text} />
      </Pressable>
      <Text style={styles.rockerLabel}>{label}</Text>
      <Pressable onPress={onMinus} style={({ pressed }) => [styles.rockerBtn, pressed && styles.pressed]}>
        <Ionicons name="remove" size={26} color={theme.text} />
      </Pressable>
    </View>
  );
}

function MidBtn({
  icon,
  label,
  color,
  onPress,
}: {
  icon: IoniconName;
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.mid, pressed && styles.pressed]}>
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.midText, { color }]}>{label}</Text>
    </Pressable>
  );
}

// ---- styles ----------------------------------------------------------------

const styles = StyleSheet.create({
  // Fixed, non-scrolling column. gap spaces the rows; navBlock (flex:1) eats
  // the leftover so the elastic circle fits without any scroll.
  root: { flex: 1, gap: 10, paddingBottom: 6 },
  pressed: { opacity: 0.6 },

  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  targetSeg: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  surfaceSeg: {
    flexDirection: 'row',
    gap: 2,
    padding: 2,
    borderRadius: 10,
    backgroundColor: theme.inset,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  seg: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: 'center',
  },
  segActive: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.blue },
  segText: { color: theme.textDim, fontSize: 12, fontWeight: '700', fontFamily: mono },
  segTextActive: { color: theme.blue },
  pwr: {
    width: 44,
    height: 40,
    borderRadius: 10,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  navBlock: { flex: 1, gap: 6, minHeight: 190 },
  circleArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cornerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  corner: {
    minWidth: 92,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  cornerText: {
    color: theme.textDim,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
  },

  // Base disc styling; width/height/radius come from dpadGeometry(size).
  dpad: {
    backgroundColor: '#e8edf6',
    alignSelf: 'center',
  },
  wedge: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wedgePressed: { backgroundColor: 'rgba(11,18,32,0.12)' },
  ok: {
    position: 'absolute',
    backgroundColor: '#f8fafc',
    borderWidth: 4,
    borderColor: '#0b1220',
    alignItems: 'center',
    justifyContent: 'center',
  },
  okPressed: { backgroundColor: '#cbd5e1' },
  okText: { color: '#0b1220', fontWeight: '800', fontFamily: mono },
  // OK disc while the hold-to-point joystick is armed.
  okJoy: { backgroundColor: theme.blue, borderColor: theme.blue },

  // Trackpad face of the nav circle (same disc, different surface).
  navTrack: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  navTrackHint: {
    color: 'rgba(11,18,32,0.45)',
    fontSize: 11,
    fontFamily: mono,
    textAlign: 'center',
    lineHeight: 16,
  },

  // Desktop cluster (Plasma desktop boxes only).
  deskCluster: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  desk: {
    minWidth: 64,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  deskText: {
    color: theme.textDim,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    fontFamily: mono,
  },

  rockerRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  rocker: {
    width: 84,
    borderRadius: 42,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
    alignItems: 'center',
    paddingVertical: 6,
  },
  rockerGhost: { width: 84 },
  rockerBtn: {
    width: 72,
    height: 58,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rockerLabel: {
    color: theme.textDim,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    fontFamily: mono,
    paddingVertical: 4,
  },
  midStack: { justifyContent: 'space-between', gap: 8 },
  mid: {
    width: 108,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  midText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, fontFamily: mono },

  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  sourcePill: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.cardBorder,
  },
  sourcePillBox: { borderColor: 'rgba(52,211,153,0.5)' },
  sourceText: {
    color: theme.textDim,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    fontFamily: mono,
  },
});
