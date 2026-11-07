import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Dimensions, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { AirMouseIntegrator, AIR_MOUSE_REMOTE_GAIN, airMouseGripSample, type AirMouseGrip, type MotionSample } from '@/lib/airMouse';
import { useTheme } from '@/lib/theme';

type Props = {
  targetKey: string;
  available?: boolean;
  onMove: (dx: number, dy: number, current: () => boolean) => void | Promise<void>;
  onClick: (current: () => boolean) => void | Promise<void>;
  onStop?: () => void;
  onGuide?: () => Promise<unknown>;
  touchpad?: boolean;
  onScroll?: (notches: number, current: () => boolean) => void | Promise<void>;
};
/** Opt-in, portrait hold-to-point. No subscription or permission prompt until a user action. */
export function AirMouseControls(props: Props) {
  const t = useTheme(); const latest = useRef(props); latest.current = props;
  const [open, setOpen] = useState(false), [message, setMessage] = useState('Point the top of your phone toward the TV, with its screen facing up.');
  const [holding, setHolding] = useState(false), [gain, setGain] = useState(1);
  const [toggleOn, setToggleOn] = useState(false);
  const [grip, setGrip] = useState<AirMouseGrip>('remote');
  const latched = useRef(false);
  const epoch = useRef(0), mounted = useRef(true), focused = useRef(false), busy = useRef(false);
  const subscription = useRef<{ remove(): void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engine = useRef(new AirMouseIntegrator());
  const stop = useCallback(() => {
    latched.current = false;
    ++epoch.current; subscription.current?.remove(); subscription.current = null;
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    engine.current.reset(); latest.current.onStop?.();
    if (mounted.current) { setHolding(false); setToggleOn(false); setMessage('Air Mouse is off. Choose Remote or Upright grip below.'); }
  }, []);
  useFocusEffect(useCallback(() => { focused.current = true; return () => { focused.current = false; stop(); }; }, [stop]));
  useLayoutEffect(() => {
    mounted.current = true;
    const app = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    const size = Dimensions.addEventListener('change', stop);
    return () => { mounted.current = false; stop(); app.remove(); size.remove(); };
  }, [stop]);
  useLayoutEffect(() => { stop(); }, [props.targetKey, props.available, stop]);
  const begin = async (calibrate = false, latch = false) => {
    stop(); latched.current = latch; const id = epoch.current;
    const current = () => mounted.current && focused.current && epoch.current === id && latest.current.available !== false && AppState.currentState === 'active';
    if (!current()) return;
    if (Dimensions.get('window').width > Dimensions.get('window').height) { setMessage('Keep the screen in portrait layout; point the phone toward the TV like a remote. Use the touchpad in landscape.'); return; }
    try {
      const { Gyroscope } = await import('expo-sensors');
      if (!current()) return;
      if (!await Gyroscope.isAvailableAsync()) throw new Error('Motion sensor unavailable. Use the touchpad.');
      if (!current()) return;
      const permission = await Gyroscope.requestPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) throw new Error('Motion permission is off. Use the touchpad.');
      // Android's native gyro runs at 20ms (SENSOR_DELAY_GAME). Expo's event
      // throttle uses a strict > comparison, so asking for 20ms can skip every
      // other 20ms sample. A 10ms event gate preserves the hardware's 50Hz stream.
      Gyroscope.setUpdateInterval(Platform.OS === 'android' ? 10 : 20);
      const samples: MotionSample[] = [];
      if (!calibrate) { setHolding(true); setToggleOn(latch); }
      setMessage(calibrate ? 'Keep the phone still for one second…' : latch ? 'Air Mouse on. Hold still to pause; move to resume.' : 'Pointing. Release to stop.');
      subscription.current = Gyroscope.addListener(rawSample => {
        const sample = airMouseGripSample(rawSample, grip);
        if (!current()) return;
        if (calibrate) { samples.push(sample); return; }
        const delta = engine.current.step(sample, gain * (grip === 'remote' ? AIR_MOUSE_REMOTE_GAIN : 1));
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
    <View style={{ flexDirection: 'row', gap: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Air Mouse" onPress={() => { stop(); setOpen(!open); }} style={button}>
      <Text style={{ color: t.blue, fontWeight: '700' }}>Air Mouse {open ? '▴' : '▾'}</Text>
    </Pressable>
    <Pressable accessibilityRole="switch" accessibilityLabel="Toggle Air Mouse" accessibilityState={{ checked: toggleOn, disabled: props.available === false }}
      disabled={props.available === false} style={[button, { flex: 1, backgroundColor: toggleOn ? t.blue : t.card }]}
      onPress={() => { if (latched.current) stop(); else { setOpen(true); void begin(false, true); } }}>
      <Text style={{ color: toggleOn ? t.bg : t.text, fontWeight: '700', textAlign: 'center' }}>Air Mouse {toggleOn ? 'ON' : 'OFF'}</Text>
    </Pressable>
    </View>
    {open && <View style={{ gap: 8 }}>
      <Text style={{ color: t.textDim }}>{message}</Text>
      <Text style={{ color: t.textDim }}>{grip === 'remote' ? 'Remote grip: screen facing up, top of phone aimed toward the TV.' : 'Upright grip: screen facing you, top of phone pointing up.'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Hold to point" disabled={props.available === false}
        onPressIn={() => { void begin(); }} onPressOut={() => { if (!latched.current) stop(); }} onTouchCancel={() => { if (!latched.current) stop(); }}
        style={[button, { backgroundColor: holding ? t.blue : t.card }]}>
        <Text style={{ color: holding ? t.bg : t.text, textAlign: 'center', fontWeight: '700' }}>{holding && !toggleOn ? 'Pointing — release to stop' : 'Hold to point'}</Text>
      </Pressable>
      {props.touchpad && <View {...pad.panHandlers} accessibilityLabel="TV touchpad" style={{ minHeight: 110, borderRadius: 12, backgroundColor: t.inset, padding: 14, justifyContent: 'center' }}>
        <Text style={{ color: t.textDim, textAlign: 'center' }}>Touchpad · tap to click · two fingers to scroll</Text>
      </View>}
      {props.onGuide && <Pressable style={button} accessibilityRole="button" disabled={props.available === false} onPress={() => {
        stop(); const id = epoch.current;
        void props.onGuide?.().then(() => { if (mounted.current && epoch.current === id) setMessage('Setup requested on the box. Quick calibrate, turn Air Mouse on, then Confirm target four times. If no screen appears, check the box browser.'); })
          .catch(() => { if (mounted.current && epoch.current === id) setMessage('Guided setup needs an updated agent and an open desktop or Steam session. Quick calibrate is still available.'); });
      }}><Text style={{ color: t.blue }}>Four-target setup on box</Text></Pressable>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pressable style={button} accessibilityRole="button" disabled={props.available === false} onPress={() => { if (!latched.current) stop(); const id = epoch.current; const current = () => mounted.current && focused.current && epoch.current === id && AppState.currentState === 'active' && latest.current.available !== false; void Promise.resolve().then(() => current() && latest.current.onClick(current)).catch(() => { if (current()) setMessage('Click failed. Check the connection.'); }); }}><Text style={{ color: t.text }}>{props.onGuide ? 'Click / Confirm target' : 'Click'}</Text></Pressable>
        <Pressable style={button} accessibilityRole="button" disabled={props.available === false} onPress={() => { void begin(true); }}><Text style={{ color: t.text }}>Quick calibrate</Text></Pressable>
        <Pressable style={button} accessibilityRole="button" onPress={() => { stop(); setMessage('Motion reset. Regrip comfortably, then turn Air Mouse on. The cursor stays in place.'); }}><Text style={{ color: t.text }}>Recenter</Text></Pressable>
        <Pressable style={button} accessibilityRole="button" accessibilityLabel="Air Mouse grip" onPress={() => { stop(); engine.current = new AirMouseIntegrator(); setGrip(grip === 'remote' ? 'upright' : 'remote'); setMessage('Grip changed. Quick calibrate while holding the phone in your preferred position.'); }}><Text style={{ color: t.text }}>Grip {grip === 'remote' ? 'Remote' : 'Upright'}</Text></Pressable>
        <Pressable style={button} accessibilityRole="button" accessibilityLabel="Air Mouse sensitivity" onPress={() => { stop(); setGain(gain === 1 ? 1.5 : gain === 1.5 ? .25 : 1); }}><Text style={{ color: t.text }}>Speed {gain === 1 ? 'Normal' : gain === 1.5 ? 'Fast' : 'Slow'}</Text></Pressable>
      </View>
    </View>}
  </View>;
}
