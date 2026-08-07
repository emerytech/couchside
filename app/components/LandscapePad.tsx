/**
 * The landscape gamepad — a real controller, full screen, no app chrome.
 *
 * Every control is ABSOLUTELY positioned from `lib/padLayout.ts`. There is no
 * flex here on purpose: the layout this replaces was a flex column of
 * fixed-pixel children that demanded ~575dp inside a 393dp short axis, and flex
 * neither clips nor warns, so it silently painted the left stick off the screen
 * edge, RB into the gap between X and B, and the d-pad's DOWN arrow behind the
 * tab bar. Positions come from one table that a test can check; see
 * `lib/__tests__/padLayout.test.ts`.
 *
 * Nothing in this file may size a control off the window width, read insets, or
 * use a percentage string. It gets a computed layout and draws it.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';

// Same routing as the portrait pad: every Pad haptic goes through the app-wide
// gated emitter so the Settings toggle governs them.
import { hapticLight, hapticSelection as haptic } from '@/lib/haptics';
import {
  DPAD,
  FACE,
  NAV,
  STICK,
  dpadZone,
  navZone,
  stickNubOffset,
  stickValue,
  type PadLayout,
  type PadNode,
  type Rect,
} from '@/lib/padLayout';
import type { ButtonKey, StickKey, TriggerKey } from '@/lib/gamepad';
import { useTheme, mono, type Palette } from '@/lib/theme';

/** Movement under this is still a tap (matches the swipe surface's rule). */
const TAP_SLOP = 12;
/** Touches longer than this aren't taps. */
const TAP_MS = 450;

type Down = { onDown: () => void; onUp: () => void };

/** The four face buttons, as ids that are BOTH layout nodes and protocol keys. */
const FACE_IDS = ['a', 'b', 'x', 'y'] as const;
type FaceId = (typeof FACE_IDS)[number];

export type LandscapePadProps = {
  layout: Extract<PadLayout, { ok: true }>;
  /**
   * Momentary buttons. Typed to the protocol's frozen key union rather than
   * `string`: these ids are looked up, never interpolated, and widening the
   * parameter here would be the one place a typo could reach the wire.
   */
  btn: (k: ButtonKey) => Down;
  /** Analog triggers. */
  trig: (k: TriggerKey) => Down;
  stickMove: (k: StickKey) => (x: number, y: number) => void;
  stickRelease: (k: StickKey) => () => void;
  /** Guide + A chord — the ⋯ Quick Access Menu. */
  qam: () => void;
  locked: boolean;
  onToggleLock: () => void;
  onExit: () => void;
  /** The PAD -> MOVE toggle in the chrome row. */
  onVariant: () => void;
};

const abs = (r: Rect) => ({
  position: 'absolute' as const,
  left: r.x,
  top: r.y,
  width: r.w,
  height: r.h,
});

/** Where a node's DRAWN box sits inside its (anisotropically grown) hit box. */
const inner = (n: PadNode) => ({
  position: 'absolute' as const,
  left: n.rect.x - n.hit.x,
  top: n.rect.y - n.hit.y,
  width: n.rect.w,
  height: n.rect.h,
});

// ---------- A plain momentary button ----------

function PadKey({
  node, label, color, fontSize, onDown, onUp, u,
}: {
  node: PadNode; label: string; color?: string; fontSize?: number;
  onDown: () => void; onUp: () => void; u: number;
}) {
  const t = useTheme();
  const [held, setHeld] = useState(false);
  return (
    <Pressable
      style={abs(node.hit)}
      onPressIn={() => {
        setHeld(true);
        // Eyes-off, haptics ARE the pressed state — nobody is looking at the
        // phone to see a colour change.
        haptic();
        onDown();
      }}
      onPressOut={() => {
        setHeld(false);
        onUp();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}>
      <View
        style={[
          inner(node),
          {
            borderRadius: node.shape === 'circle' ? node.rect.w / 2 : 2.5 * u,
            borderWidth: 1,
            borderColor: held ? (color ?? t.blue) : t.cardBorder,
            backgroundColor: held ? t.cardBorder : t.card,
            alignItems: 'center',
            justifyContent: 'center',
          },
        ]}>
        <Text
          style={{
            color: color ?? t.text,
            fontFamily: mono,
            fontWeight: '700',
            fontSize: fontSize ?? 3.4 * u,
          }}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

// ---------- Analog stick: fixed container, floating origin ----------

function FloatingStick({
  node, u, onMove, onRelease, onClick, label, zoneOutline,
}: {
  node: PadNode; u: number;
  onMove: (x: number, y: number) => void;
  onRelease: () => void;
  /** L3 / R3 — the stick CLICK, which is now a tap rather than its own button. */
  onClick: () => void;
  label: string;
  /** Movement mode: the container is a large RECT zone, not a stick-sized
      circle. Draw its outline faintly (so the zone is discoverable) plus a
      standard-size resting ring at the node centre, instead of rounding the
      whole node into a giant ellipse. */
  zoneOutline?: boolean;
}) {
  const t = useTheme();
  // Where in the container the finger landed. The ring is drawn there, not at
  // the container's centre: the thumb lands where it lands and there is nothing
  // to look at to aim with.
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const nub = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const cb = useRef({ onMove, onRelease, onClick });
  cb.current = { onMove, onRelease, onClick };
  const geom = useRef({ u });
  geom.current = { u };
  const t0 = useRef(0);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // HOLD THE TOUCH. A competing responder that steals the gesture
        // mid-drag strands the axis at its last value and the agent latches it
        // — the pad keeps walking in a direction nobody is pushing. The
        // trackpad and swipe surfaces both refuse for the same reason; the old
        // Stick did not, and was the one that could be stolen.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e: GestureResponderEvent) => {
          setOrigin({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
          t0.current = Date.now();
          haptic();
        },
        onPanResponderMove: (_e, g: PanResponderGestureState) => {
          // g.dx/g.dy are already relative to touch-down, which IS the floating
          // origin — no bookkeeping needed.
          const v = stickValue(g.dx, g.dy, geom.current.u);
          const n = stickNubOffset(g.dx, g.dy, geom.current.u);
          nub.setValue(n);
          // +y down in screen coords matches the protocol directly.
          cb.current.onMove(v.x, v.y);
        },
        onPanResponderRelease: (_e, g) => {
          const tap =
            Math.hypot(g.dx, g.dy) < TAP_SLOP && Date.now() - t0.current < TAP_MS;
          setOrigin(null);
          nub.setValue({ x: 0, y: 0 });
          cb.current.onRelease();
          if (tap) cb.current.onClick();
        },
        onPanResponderTerminate: () => {
          setOrigin(null);
          nub.setValue({ x: 0, y: 0 });
          cb.current.onRelease();
        },
      }),
    [nub],
  );

  const ringR = STICK.ringR * u;
  const nubR = STICK.nubR * u;

  return (
    <View style={abs(node.hit)} {...responder.panHandlers} accessibilityLabel={label}>
      {/* Resting state: a faint ring where the stick nominally lives, so it can
          be found by eye the first time. Nothing else is drawn until touch. */}
      {origin === null ? (
        zoneOutline ? (
          <>
            {/* The whole zone, barely visible — any touch inside starts a drag. */}
            <View
              pointerEvents="none"
              style={[
                inner(node),
                { borderRadius: 4 * u, borderWidth: 1, borderColor: t.cardBorder, opacity: 0.35 },
              ]}
            />
            {/* And a stick-sized ring at its centre as the visual anchor. */}
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: node.rect.x - node.hit.x + node.rect.w / 2 - ringR,
                top: node.rect.y - node.hit.y + node.rect.h / 2 - ringR,
                width: ringR * 2,
                height: ringR * 2,
                borderRadius: ringR,
                borderWidth: 1,
                borderColor: t.cardBorder,
                opacity: 0.5,
              }}
            />
          </>
        ) : (
        <View
          pointerEvents="none"
          style={[
            inner(node),
            {
              borderRadius: node.rect.w / 2,
              borderWidth: 1,
              borderColor: t.cardBorder,
              opacity: 0.5,
            },
          ]}
        />
        )
      ) : (
        <>
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: origin.x - ringR,
              top: origin.y - ringR,
              width: ringR * 2,
              height: ringR * 2,
              borderRadius: ringR,
              borderWidth: 1,
              borderColor: t.blue,
              backgroundColor: t.card,
            }}
          />
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: origin.x - nubR,
              top: origin.y - nubR,
              width: nubR * 2,
              height: nubR * 2,
              borderRadius: nubR,
              backgroundColor: t.cardBorder,
              borderWidth: 1,
              borderColor: t.blue,
              transform: nub.getTranslateTransform(),
            }}
          />
        </>
      )}
    </View>
  );
}

// ---------- D-pad: angular, no diagonals ----------

function Dpad({
  node, u, btn,
}: {
  node: PadNode; u: number; btn: (k: ButtonKey) => Down;
}) {
  const t = useTheme();
  // dpadZone returns 'du' | 'dd' | 'dl' | 'dr' | 'a' — every one of them a
  // ButtonKey, so nothing needs widening on the way to the wire.
  const [zone, setZone] = useState<ButtonKey | null>(null);
  const held = useRef<ButtonKey | null>(null);
  const bt = useRef(btn);
  bt.current = btn;
  const geom = useRef({ u, node });
  geom.current = { u, node };

  const to = useCallback((next: ButtonKey | null) => {
    if (held.current === next) return;
    if (held.current) bt.current(held.current).onUp();
    held.current = next;
    setZone(next);
    if (next) {
      bt.current(next).onDown();
      // One tick per SECTOR CHANGE, so a held direction that slides into
      // another is felt. Not one per frame — that floods the generator.
      hapticLight();
    }
  }, []);

  const at = useCallback((e: GestureResponderEvent) => {
    const { node: n, u: uu } = geom.current;
    // Centre of the DRAWN box, in container coordinates.
    const cx = n.rect.x - n.hit.x + n.rect.w / 2;
    const cy = n.rect.y - n.hit.y + n.rect.h / 2;
    return dpadZone(e.nativeEvent.locationX - cx, e.nativeEvent.locationY - cy, uu);
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => to(at(e)),
        onPanResponderMove: (e) => to(at(e)),
        onPanResponderRelease: () => to(null),
        onPanResponderTerminate: () => to(null),
      }),
    [at, to],
  );

  const r = node.rect.w / 2;
  const outer = DPAD.outerRU * u;
  const innerR = DPAD.innerRU * u;
  const arm = (k: string, label: string, dx: number, dy: number) => (
    <View
      key={k}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: r + dx * (outer * 0.62) - 3 * u,
        top: r + dy * (outer * 0.62) - 3 * u,
        width: 6 * u,
        height: 6 * u,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={{ color: zone === k ? t.blue : t.textFaint, fontSize: 4 * u }}>{label}</Text>
    </View>
  );

  return (
    <View style={abs(node.hit)} {...responder.panHandlers} accessibilityLabel="D-pad">
      <View pointerEvents="none" style={inner(node)}>
        {/* Ring: every pixel inside it does something — four 90° sectors with
            no dead corners, because eyes-off there is nothing to aim at. */}
        <View
          style={{
            position: 'absolute',
            left: r - outer, top: r - outer, width: outer * 2, height: outer * 2,
            borderRadius: outer, borderWidth: 1, borderColor: t.cardBorder,
            backgroundColor: t.card,
          }}
        />
        {arm('du', '▲', 0, -1)}
        {arm('dd', '▼', 0, 1)}
        {arm('dl', '◀', -1, 0)}
        {arm('dr', '▶', 1, 0)}
        {/* Centre disc = A/OK, keeping the existing centre-OK behaviour. */}
        <View
          style={{
            position: 'absolute',
            left: r - innerR, top: r - innerR, width: innerR * 2, height: innerR * 2,
            borderRadius: innerR, borderWidth: 1,
            borderColor: zone === 'a' ? t.green : t.cardBorder,
            backgroundColor: zone === 'a' ? t.cardBorder : t.card,
            alignItems: 'center', justifyContent: 'center',
          }}>
          <Text style={{ color: t.green, fontFamily: mono, fontWeight: '700', fontSize: 3.4 * u }}>
            OK
          </Text>
        </View>
      </View>
    </View>
  );
}

// ---------- Movement mode's 4-way NAV: angular, no centre action ----------

function NavPad({
  node, u, btn,
}: {
  node: PadNode; u: number; btn: (k: ButtonKey) => Down;
}) {
  const t = useTheme();
  const [zone, setZone] = useState<ButtonKey | null>(null);
  const held = useRef<ButtonKey | null>(null);
  const bt = useRef(btn);
  bt.current = btn;
  const geom = useRef({ u, node });
  geom.current = { u, node };

  const to = useCallback((next: ButtonKey | null) => {
    if (held.current === next) return;
    if (held.current) bt.current(held.current).onUp();
    held.current = next;
    setZone(next);
    if (next) {
      bt.current(next).onDown();
      hapticLight();
    }
  }, []);

  const at = useCallback((e: GestureResponderEvent) => {
    const { node: n, u: uu } = geom.current;
    const cx = n.rect.x - n.hit.x + n.rect.w / 2;
    const cy = n.rect.y - n.hit.y + n.rect.h / 2;
    return navZone(e.nativeEvent.locationX - cx, e.nativeEvent.locationY - cy, uu);
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => to(at(e)),
        onPanResponderMove: (e) => to(at(e)),
        onPanResponderRelease: () => to(null),
        onPanResponderTerminate: () => to(null),
      }),
    [at, to],
  );

  const r = node.rect.w / 2;
  const outer = NAV.outerRU * u;
  const arm = (k: ButtonKey, label: string, dx: number, dy: number) => (
    <View
      key={k}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: r + dx * (outer * 0.55) - 3 * u,
        top: r + dy * (outer * 0.55) - 3 * u,
        width: 6 * u,
        height: 6 * u,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={{ color: zone === k ? t.blue : t.textFaint, fontSize: 4 * u }}>{label}</Text>
    </View>
  );

  return (
    <View style={abs(node.hit)} {...responder.panHandlers} accessibilityLabel="Menu navigation">
      <View pointerEvents="none" style={inner(node)}>
        <View
          style={{
            position: 'absolute',
            left: r - outer, top: r - outer, width: outer * 2, height: outer * 2,
            borderRadius: outer, borderWidth: 1, borderColor: t.cardBorder,
            backgroundColor: t.card,
          }}
        />
        {arm('du', '▲', 0, -1)}
        {arm('dd', '▼', 0, 1)}
        {arm('dl', '◀', -1, 0)}
        {arm('dr', '▶', 1, 0)}
      </View>
    </View>
  );
}

// ---------- Face diamond: one responder, so a thumb can roll A -> B ----------

function FaceCluster({
  nodes, u, btn, colors,
}: {
  nodes: PadNode[]; u: number; btn: (k: ButtonKey) => Down; colors: Record<FaceId, string>;
}) {
  const t = useTheme();
  const [zone, setZone] = useState<FaceId | null>(null);
  const held = useRef<FaceId | null>(null);
  const bt = useRef(btn);
  bt.current = btn;

  // Bounding box of the four hit rects. Slide-between is allowed WITHIN this
  // cluster (they are one layer) and impossible outside it, because no other
  // node's hit rect reaches in — which the layout test asserts.
  const box = useMemo(() => {
    const x = Math.min(...nodes.map((n) => n.hit.x));
    const y = Math.min(...nodes.map((n) => n.hit.y));
    return {
      x, y,
      w: Math.max(...nodes.map((n) => n.hit.x + n.hit.w)) - x,
      h: Math.max(...nodes.map((n) => n.hit.y + n.hit.h)) - y,
    };
  }, [nodes]);

  const geom = useRef({ nodes, box });
  geom.current = { nodes, box };

  const to = useCallback((next: FaceId | null) => {
    if (held.current === next) return;
    if (held.current) bt.current(held.current).onUp();
    held.current = next;
    setZone(next);
    if (next) {
      bt.current(next).onDown();
      haptic();
    }
  }, []);

  const at = useCallback((e: GestureResponderEvent): FaceId | null => {
    const { nodes: ns, box: b } = geom.current;
    // locationX/Y are relative to this responder View, which is positioned at
    // the cluster's bounding box — so adding the box origin puts the touch back
    // into the same coordinate space the node hit rects are in.
    const px = e.nativeEvent.locationX + b.x;
    const py = e.nativeEvent.locationY + b.y;
    for (const n of ns) {
      if (px >= n.hit.x && px <= n.hit.x + n.hit.w && py >= n.hit.y && py <= n.hit.y + n.hit.h) {
        return n.id as FaceId;
      }
    }
    return null;
  }, []);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => to(at(e)),
        onPanResponderMove: (e) => to(at(e)),
        onPanResponderRelease: () => to(null),
        onPanResponderTerminate: () => to(null),
      }),
    [at, to],
  );

  return (
    <View style={abs(box)} {...responder.panHandlers} accessibilityLabel="Face buttons">
      {nodes.map((n) => {
        const d = FACE.diaU * u;
        const id = n.id as FaceId;
        const on = zone === id;
        return (
          <View
            key={id}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: n.rect.x - box.x,
              top: n.rect.y - box.y,
              width: d,
              height: d,
              borderRadius: d / 2,
              borderWidth: 1,
              borderColor: on ? colors[id] : t.cardBorder,
              backgroundColor: on ? t.cardBorder : t.card,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Text
              style={{
                color: colors[id],
                fontFamily: mono,
                fontWeight: '700',
                fontSize: 4.4 * u,
              }}>
              {id.toUpperCase()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------- The pad ----------

/** One chrome-row button (LOCK / EXIT / the PAD⇄MOVE toggle). Layer 9: hit
    rect = drawn rect, and a touch must start AND end inside. */
function ChromeButton({
  node, u, text, color, onPress, accessibilityLabel, checked,
}: {
  node: PadNode; u: number; text: string; color?: string;
  onPress: () => void; accessibilityLabel: string; checked?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      style={abs(node.hit)}
      onPress={() => {
        haptic();
        onPress();
      }}
      accessibilityRole={checked === undefined ? 'button' : 'switch'}
      accessibilityState={checked === undefined ? undefined : { checked }}
      accessibilityLabel={accessibilityLabel}>
      <View
        style={[
          inner(node),
          {
            borderRadius: 2.5 * u, borderWidth: 1,
            borderColor: color ?? t.cardBorder,
            backgroundColor: t.card,
            alignItems: 'center', justifyContent: 'center',
          },
        ]}>
        <Text style={{ color: color ?? t.textFaint, fontFamily: mono, fontSize: 2.6 * u }}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}

export function LandscapePad({
  layout, btn, trig, stickMove, stickRelease, qam, locked, onToggleLock, onExit, onVariant,
}: LandscapePadProps) {
  const t = useTheme();
  const { byId, u } = layout;
  const faceColors: Record<FaceId, string> = {
    a: t.green, b: t.red, x: t.blue, y: t.amber,
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Row 1 — shoulders. */}
      <PadKey node={byId.lt} label="LT" u={u} {...trig('lt')} />
      <PadKey node={byId.lb} label="LB" u={u} {...btn('lb')} />
      <PadKey node={byId.rb} label="RB" u={u} {...btn('rb')} />
      <PadKey node={byId.rt} label="RT" u={u} {...trig('rt')} />

      {/* Row 2 — menu cluster. */}
      <PadKey node={byId.select} label="SELECT" u={u} fontSize={2.8 * u} {...btn('select')} />
      <PadKey node={byId.steam} label="STEAM" u={u} color={t.blue} fontSize={2.8 * u} {...btn('guide')} />
      <PadKey node={byId.qam} label="⋯" u={u} color={t.blue} fontSize={5 * u} onDown={qam} onUp={NOOP} />
      <PadKey node={byId.start} label="START" u={u} fontSize={2.8 * u} {...btn('start')} />

      {/* Thumb clusters. */}
      <Dpad node={byId.dpad} u={u} btn={btn} />
      <FloatingStick
        node={byId.lstick} u={u} label="Left stick"
        onMove={stickMove('l')} onRelease={stickRelease('l')}
        onClick={() => {
          // L3 is the stick TAP now. That removed a whole row of thumb buttons
          // and bought back the short axis the layout needed.
          btn('l3').onDown();
          setTimeout(() => btn('l3').onUp(), 60);
        }}
      />
      <FloatingStick
        node={byId.rstick} u={u} label="Right stick"
        onMove={stickMove('r')} onRelease={stickRelease('r')}
        onClick={() => {
          btn('r3').onDown();
          setTimeout(() => btn('r3').onUp(), 60);
        }}
      />
      <FaceCluster nodes={FACE_IDS.map((id) => byId[id])} u={u} btn={btn} colors={faceColors} />

      {/* Chrome. Deliberately NOT auto-hiding on a timer: the three buttons
          cost nothing (they sit in a band that is otherwise empty) and fading
          the only exit on a screen nobody is looking at is a bad trade at any
          timeout. Steam Link fades its controls after 10s; not copied. */}
      <ChromeButton
        node={byId.variant} u={u} text="⊕ MOVE"
        onPress={onVariant}
        accessibilityLabel="Switch to the movement layout"
      />
      <ChromeButton
        node={byId.lock} u={u}
        text={locked ? '🔒 LOCKED' : '🔓 AUTO'}
        color={locked ? t.amber : undefined}
        onPress={onToggleLock} checked={locked}
        accessibilityLabel={locked ? 'Orientation locked' : 'Orientation follows the phone'}
      />
      <ChromeButton
        node={byId.exit} u={u} text="✕ EXIT"
        onPress={onExit}
        accessibilityLabel="Exit full-screen controller"
      />
    </View>
  );
}

// ---------- Movement mode ----------

export type MovePadProps = {
  layout: Extract<PadLayout, { ok: true }>;
  btn: (k: ButtonKey) => Down;
  stickMove: (k: StickKey) => (x: number, y: number) => void;
  stickRelease: (k: StickKey) => () => void;
  locked: boolean;
  onToggleLock: () => void;
  onExit: () => void;
  onVariant: () => void;
};

/**
 * The movement layout: one enormous left-thumb zone driving the LEFT STICK,
 * and a small right-hand cluster (A, B, 4-way NAV, START). For games that are
 * almost entirely continuous movement — Vampire Survivors and its family.
 * See moveLayout() in lib/padLayout.ts for why this is a separate mode and
 * not a change to the controller.
 *
 * Same protocol keys as the gamepad — the zone emits {t:'s',k:'l'} frames and
 * the buttons emit their normal ids — so the agent cannot tell the layouts
 * apart and needs no change.
 */
export function MovePad({
  layout, btn, stickMove, stickRelease, locked, onToggleLock, onExit, onVariant,
}: MovePadProps) {
  const t = useTheme();
  const { byId, u } = layout;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* The movement zone. A tap (no drag) is deliberately NOTHING here — in
          the games this mode serves, a stray A press picks whatever upgrade is
          highlighted. Confirm lives under the right thumb only. */}
      <FloatingStick
        node={byId.move} u={u} label="Move" zoneOutline
        onMove={stickMove('l')} onRelease={stickRelease('l')}
        onClick={NOOP}
      />

      {/* Right thumb: A at rest, B up-left, 4-way NAV above for menus. */}
      <NavPad node={byId.nav} u={u} btn={btn} />
      <PadKey node={byId.b} label="B" u={u} color={t.red} fontSize={4.4 * u} {...btn('b')} />
      <PadKey node={byId.a} label="A" u={u} color={t.green} fontSize={4.4 * u} {...btn('a')} />

      {/* Chrome: same row, same positions as the gamepad layout, so the toggle
          never jumps under the thumb that pressed it. */}
      <ChromeButton
        node={byId.variant} u={u} text="🎮 PAD"
        onPress={onVariant}
        accessibilityLabel="Switch to the full controller"
      />
      <ChromeButton
        node={byId.lock} u={u}
        text={locked ? '🔒 LOCKED' : '🔓 AUTO'}
        color={locked ? t.amber : undefined}
        onPress={onToggleLock} checked={locked}
        accessibilityLabel={locked ? 'Orientation locked' : 'Orientation follows the phone'}
      />
      <ChromeButton
        node={byId.exit} u={u} text="✕ EXIT"
        onPress={onExit}
        accessibilityLabel="Exit full-screen controller"
      />
      <PadKey node={byId.start} label="START" u={u} fontSize={2.8 * u} {...btn('start')} />
    </View>
  );
}

const NOOP = () => {};

/**
 * Shown instead of the controller when the screen is too small to draw one that
 * meets the 44dp touch floor. Refusing is the honest answer — a cramped
 * controller that half-works is worse than being told to turn the phone back.
 */
export function LandscapePadTooSmall({ reason, onExit }: { reason: string; onExit: () => void }) {
  const t = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
      <Text style={{ color: t.text, fontFamily: mono, fontSize: 15, textAlign: 'center' }}>
        {reason === 'too-narrow'
          ? 'This window is too narrow for the controller.'
          : 'This screen is too short for the controller.'}
      </Text>
      <Text style={{ color: t.textFaint, fontSize: 13, textAlign: 'center', marginTop: 8 }}>
        Turn the phone back to portrait to keep playing.
      </Text>
      <Pressable onPress={onExit} style={{ marginTop: 16, padding: 12 }}>
        <Text style={{ color: t.blue, fontFamily: mono, fontSize: 13 }}>✕ BACK TO PORTRAIT</Text>
      </Pressable>
    </View>
  );
}

export type { Palette };
