/** Shared native PAD plane. Gameplay drawings are passive; chrome is a sibling.
 * Effects create a fresh router (also safe under StrictMode's setup/cleanup).
 * Callback replacement, resize, blur and unmount revoke all local ownership.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import type { LandscapePadProps } from './LandscapePad';
import { hapticSelection } from '@/lib/haptics';
import { createPadTouches, type PadAction, type PadControl, type PadTouchVisual } from '@/lib/padTouches';
import type { Rect } from '@/lib/padLayout';

type Router = ReturnType<typeof createPadTouches>;
const EMPTY: PadTouchVisual = { held: [], sticks: {} };
const NO_CONTROLS: PadControl[] = [];
const NO_EXCLUSIONS: Rect[] = [];
type ContextValue = { generation: RefObject<number>; geometry: number; remeasure(): void; root: RefObject<View | null>; visual: PadTouchVisual; activate(a: PadAction): void; command(): void; register(id: string, control: PadControl | null): void };
const TouchContext = createContext<ContextValue | null>(null);
export const usePadTouchVisual = () => useContext(TouchContext);
type Props = Pick<LandscapePadProps, 'btn' | 'trig' | 'stickMove' | 'stickRelease'> & {
  controls?: PadControl[]; excluded?: Rect[]; children: ReactNode; style?: StyleProp<ViewStyle>;
};

export function PadTouchSurface({ controls = NO_CONTROLS, excluded = NO_EXCLUSIONS, btn, trig, stickMove, stickRelease, children, style }: Props) {
  const root = useRef<View>(null), origin = useRef<{ x: number; y: number } | null>(null), generation = useRef(0);
  const register = useCallback((id: string, control: PadControl | null) => { setRegistered(old => { const next = { ...old }; if (control) next[id] = control; else delete next[id]; return next; }); }, []);
  const [geometry, setGeometry] = useState(0);
  const [registered, setRegistered] = useState<Record<string, PadControl>>({});
  const all = useMemo(() => [...controls, ...Object.values(registered)], [controls, registered]);
  const router = useRef<Router | null>(null);
  const [visual, setVisual] = useState(EMPTY);
  useLayoutEffect(() => {
    const current = createPadTouches(all, excluded, {
      action(a, down) { const input = a.kind === 'trigger' ? trig(a.key) : btn(a.key); if (down) input.onDown(); else input.onUp(); },
      stick(k, x, y) { if (x === 0 && y === 0) stickRelease(k)(); else stickMove(k)(x, y); },
      feedback: hapticSelection,
      changed() { setVisual(current.visual()); },
    });
    router.current = current; setVisual(EMPTY);
    return () => { router.current = null; current.dispose(); };
  }, [all, excluded, btn, trig, stickMove, stickRelease]);
  const measure = useCallback(() => {
    const gen = ++generation.current; origin.current = null; router.current?.cancel(); setVisual(EMPTY);
    setRegistered({}); setGeometry(n => n + 1);
    root.current?.measureInWindow((x, y) => { if (gen === generation.current && Number.isFinite(x) && Number.isFinite(y)) origin.current = { x, y }; });
  }, []);
  useLayoutEffect(() => { measure(); return () => { ++generation.current; origin.current = null; }; }, [measure]);
  const context = useMemo<ContextValue>(() => ({ root, visual, generation, geometry, remeasure: measure,
    activate(a) { router.current?.activate(a); if (router.current) setVisual(router.current.visual()); },
    command() { router.current?.command(); if (router.current) setVisual(router.current.visual()); },
    register,
  }), [visual, register, geometry, measure]);
  // Both static and measured controls use root-relative coordinates.
  // Subtract the measured root origin at dispatch, never locationX/touches[0].
  const dispatch = (kind: 'start' | 'move' | 'end', e: GestureResponderEvent) => {
    if (!origin.current || !router.current) return;
    router.current[kind](e.nativeEvent.changedTouches.map(p => ({ identifier: Number(p.identifier), x: p.pageX - origin.current!.x, y: p.pageY - origin.current!.y })));
    setVisual(router.current.visual());
  };
  if (Platform.OS === 'web') return <View style={style}>{children}</View>;
  return <TouchContext.Provider value={context}>
    <View ref={root} collapsable={false} style={style ?? StyleSheet.absoluteFill} onLayout={measure}
      onTouchStart={e => dispatch('start', e)} onTouchMove={e => dispatch('move', e)} onTouchEnd={e => dispatch('end', e)}
      onTouchCancel={() => { router.current?.cancel(); setVisual(EMPTY); }}>{children}</View>
  </TouchContext.Provider>;
}

/** Measurement adapter for the existing flex-based portrait PAD only. */
export function useMeasuredPadControl(id: string, make: (hit: Rect) => PadControl | null) {
  const context = useContext(TouchContext);
  const view = useRef<View>(null);
  const makeRef = useRef(make); makeRef.current = make;
  const register = context?.register;
  const generation = useRef(0);
  useLayoutEffect(() => () => { ++generation.current; register?.(id, null); }, [register, id]);
  const onLayout = useCallback(() => {
    const gen = ++generation.current, rootGen = context?.generation.current;
    // Root-relative measurement, never assume the gamepad starts at page (0,0).
    if (!context?.root.current) return;
    view.current?.measureLayout(
      // Resolve relative to this provider, never a global/root singleton.
      context!.root.current!,
      (x, y, w, h) => { if (gen === generation.current && rootGen === context?.generation.current && w > 0 && h > 0) register?.(id, makeRef.current({ x, y, w, h })); },
      () => { if (gen === generation.current && rootGen === context?.generation.current) register?.(id, null); },
    );
  }, [context?.root, register, id]);
  useLayoutEffect(() => { onLayout(); }, [onLayout, context?.geometry]);
  return { context: Platform.OS === 'web' ? null : context, ref: view, onLayout };
}


/** Portrait ancestors can move children without changing their local frame. */
export function PadTouchRow({ onLayout, ...props }: import('react-native').ViewProps) {
  const context = useContext(TouchContext);
  return <View {...props} onLayout={e => { onLayout?.(e); context?.remeasure(); }} />;
}
