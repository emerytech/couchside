import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Dimensions, PanResponder, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AirMouseIntegrator, type MotionSample } from '@/lib/airMouse';
import { useTheme } from '@/lib/theme';

type Props = {
  targetKey: string;
  available?: boolean;
  onMove: (dx: number, dy: number, current: () => boolean) => void | Promise<void>;
  onClick: (current: () => boolean) => void | Promise<void>;
  onStop?: () => void;
  touchpad?: boolean;
  onScroll?: (notches: number, current: () => boolean) => void | Promise<void>;
};
/** Opt-in, portrait hold-to-point. No subscription or permission prompt until a user action. */
export function AirMouseControls(props: Props) {
  const t = useTheme(); const latest = useRef(props); latest.current = props;
  const [open, setOpen] = useState(false), [message, setMessage] = useState('Hold your phone upright. Touchpad stays available.');
  const [holding, setHolding] = useState(false), [gain, setGain] = useState(1);
  const epoch = useRef(0), mounted = useRef(true), focused = useRef(false), busy = useRef(false);
  const subscription = useRef<{ remove(): void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engine = useRef(new AirMouseIntegrator());
  const stop = useCallback(() => {
    ++epoch.current; subscription.current?.remove(); subscription.current = null;
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    engine.current.reset(); latest.current.onStop?.();
    if (mounted.current) setHolding(false);
  }, []);
  useFocusEffect(useCallback(() => { focused.current = true; return () => { focused.current = false; stop(); }; }, [stop]));
  useLayoutEffect(() => {
    mounted.current = true;
    const app = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    const size = Dimensions.addEventListener('change', stop);
    return () => { mounted.current = false; stop(); app.remove(); size.remove(); };
  }, [stop]);
  useLayoutEffect(() => { stop(); }, [props.targetKey, props.available, stop]);
  const begin = async (calibrate = false) => {
    stop(); const id = epoch.current;
    const current = () => mounted.current && focused.current && epoch.current === id && latest.current.available !== false && AppState.currentState === 'active';
    if (!current()) return;
    if (Dimensions.get('window').width > Dimensions.get('window').height) { setMessage('Hold the phone upright for Air Mouse; use the touchpad sideways.'); return; }
    try {
      const { Gyroscope } = await import('expo-sensors');
      if (!current()) return;
      if (!await Gyroscope.isAvailableAsync()) throw new Error('Motion sensor unavailable. Use the touchpad.');
      if (!current()) return;
      const permission = await Gyroscope.requestPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) throw new Error('Motion permission is off. Use the touchpad.');
      Gyroscope.setUpdateInterval(20);
      const samples: MotionSample[] = [];
      if (!calibrate) setHolding(true);
      setMessage(calibrate ? 'Keep the phone still for one second…' : 'Pointing. Release to stop.');
      subscription.current = Gyroscope.addListener(sample => {
        if (!current()) return;
        if (calibrate) { samples.push(sample); return; }
        const delta = engine.current.step(sample, gain);
        if (!delta || busy.current || Math.abs(delta.dx) + Math.abs(delta.dy) < .05) return;
        busy.current = true;
        Promise.resolve().then(() => { if (current()) return latest.current.onMove(delta.dx, delta.dy, current); })
          .catch(() => { if (current()) { stop(); setMessage('Connection interrupted. Hold again to retry, or use the touchpad.'); } })
          .finally(() => { busy.current = false; });
      });
      if (calibrate) timer.current = setTimeout(() => {
        if (!current()) return;
        const ok = engine.current.calibrate(samples); stop();
        setMessage(ok ? 'Calibrated. Hold to point.' : 'Keep the phone still and try calibrating again.');
      }, 1000);
    } catch (e) { if (current()) { stop(); setMessage(e instanceof Error && /^(Motion sensor unavailable|Motion permission is off)/.test(e.message) ? e.message : 'Air Mouse unavailable on this device. Use the touchpad.'); } }
  };
  const touch = useRef({ x: 0, y: 0, started: 0, scrolled: false, epoch: 0 });
  const [pad] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { stop(); touch.current = { x: 0, y: 0, started: Date.now(), scrolled: false, epoch: epoch.current }; },
    onPanResponderMove: (_event, gesture) => {
      const state = touch.current, dx = gesture.dx - state.x, dy = gesture.dy - state.y;
      state.x = gesture.dx; state.y = gesture.dy;
      const current = () => mounted.current && focused.current && epoch.current === state.epoch && latest.current.available !== false && AppState.currentState === 'active';
      if (!current() || busy.current) return;
      const scrolling = gesture.numberActiveTouches >= 2;
      if (scrolling) state.scrolled = true;
      busy.current = true;
      Promise.resolve().then(() => {
        if (!current()) return;
        if (scrolling) return latest.current.onScroll?.(Math.max(-5, Math.min(5, Math.round(-dy / 8))), current);
        return latest.current.onMove(Math.max(-120, Math.min(120, dx)), Math.max(-120, Math.min(120, dy)), current);
      }).catch(() => { if (current()) { stop(); setMessage('Pointer disconnected. Try again.'); } }).finally(() => { busy.current = false; });
    },
    onPanResponderRelease: (_event, gesture) => {
      const tap = !touch.current.scrolled && Math.hypot(gesture.dx, gesture.dy) < 6 && Date.now() - touch.current.started < 300;
      stop(); const id = epoch.current;
      const current = () => mounted.current && focused.current && epoch.current === id && latest.current.available !== false && AppState.currentState === 'active';
      if (tap) void Promise.resolve().then(() => { if (current()) return latest.current.onClick(current); }).catch(() => { if (current()) setMessage('Click failed. Check the connection.'); });
    },
    onPanResponderTerminate: stop,
    onPanResponderTerminationRequest: () => true,
  }));
  const button = { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.card };
  return <View style={{ gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Air Mouse" onPress={() => { stop(); setOpen(!open); }} style={button}>
      <Text style={{ color: t.blue, fontWeight: '700' }}>Air Mouse {open ? '▴' : '▾'}</Text>
    </Pressable>
    {open && <View style={{ gap: 8 }}>
      <Text style={{ color: t.textDim }}>{message}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Hold to point" disabled={props.available === false}
        onPressIn={() => { void begin(); }} onPressOut={stop} onTouchCancel={stop}
        style={[button, { backgroundColor: holding ? t.blue : t.card }]}>
        <Text style={{ color: holding ? t.bg : t.text, textAlign: 'center', fontWeight: '700' }}>{holding ? 'Pointing — release to stop' : 'Hold to point'}</Text>
      </Pressable>
      {props.touchpad && <View {...pad.panHandlers} accessibilityLabel="TV touchpad" style={{ minHeight: 110, borderRadius: 12, backgroundColor: t.inset, padding: 14, justifyContent: 'center' }}>
        <Text style={{ color: t.textDim, textAlign: 'center' }}>Touchpad · tap to click · two fingers to scroll</Text>
      </View>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pressable style={button} accessibilityRole="button" disabled={props.available === false} onPress={() => { stop(); const id = epoch.current; const current = () => mounted.current && focused.current && epoch.current === id && AppState.currentState === 'active' && latest.current.available !== false; void Promise.resolve().then(() => current() && latest.current.onClick(current)).catch(() => { if (current()) setMessage('Click failed. Check the connection.'); }); }}><Text style={{ color: t.text }}>Click</Text></Pressable>
        <Pressable style={button} accessibilityRole="button" disabled={props.available === false} onPress={() => { void begin(true); }}><Text style={{ color: t.text }}>Calibrate</Text></Pressable>
        <Pressable style={button} accessibilityRole="button" accessibilityLabel="Air Mouse sensitivity" onPress={() => { stop(); setGain(gain === 1 ? 1.5 : gain === 1.5 ? .6 : 1); }}><Text style={{ color: t.text }}>Speed {gain === 1 ? 'Normal' : gain === 1.5 ? 'Fast' : 'Slow'}</Text></Pressable>
      </View>
    </View>}
  </View>;
}
