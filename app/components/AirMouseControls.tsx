import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Dimensions, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { AirMouseIntegrator, AIR_MOUSE_REMOTE_GAIN, airMouseGripSample, type MotionSample } from '@/lib/airMouse';
import { usePref, usePrefsReady } from '@/lib/prefs';
import { useTheme } from '@/lib/theme';

type Props = {
  targetKey: string;
  pauseSignal?: number;
  available?: boolean;
  onMove: (dx: number, dy: number, current: () => boolean) => void | Promise<void>;
  onClick: (current: () => boolean) => void | Promise<void>;
  onStop?: () => void;
  onGuide?: () => Promise<unknown>;
  onCursor?: (enabled: boolean, lease: string) => Promise<unknown>;
  touchpad?: boolean;
  onScroll?: (notches: number, current: () => boolean) => void | Promise<void>;
};
/** Opt-in, portrait hold-to-point. No subscription or permission prompt until a user action. */
export function AirMouseControls(props: Props) {
  const t = useTheme(); const latest = useRef(props); latest.current = props;
  const [message, setMessage] = useState('');
  const enabled = usePref('airMouseEnabled'), largeCursor = usePref('airMouseLargeCursor');
  const gain = usePref('airMouseSpeed'), prefsReady = usePrefsReady();
  const autoStarted = useRef(false); const [focusVersion, setFocusVersion] = useState(0);
  const [holding, setHolding] = useState(false);
  const [toggleOn, setToggleOn] = useState(false);
  const grip = 'remote' as const;
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
    if (mounted.current) { setHolding(false); setToggleOn(false); setMessage(''); }
  }, []);
  useFocusEffect(useCallback(() => { focused.current = true; autoStarted.current = false; setFocusVersion(v => v + 1); return () => { focused.current = false; stop(); }; }, [stop]));
  useLayoutEffect(() => {
    mounted.current = true;
    const app = AppState.addEventListener('change', state => { if (state !== 'active') stop(); });
    const size = Dimensions.addEventListener('change', stop);
    return () => { mounted.current = false; stop(); app.remove(); size.remove(); };
  }, [stop]);
  useLayoutEffect(() => { stop(); }, [props.targetKey, props.available, stop]);
  useLayoutEffect(() => { if (props.pauseSignal) stop(); }, [props.pauseSignal, stop]);
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
      setMessage(calibrate ? 'Keep the phone still for one second…' : '');
      subscription.current = Gyroscope.addListener(rawSample => {
        const sample = airMouseGripSample(rawSample, grip);
        if (!current()) return;
        if (calibrate) { samples.push(sample); return; }
        const delta = engine.current.step(sample, gain * (AIR_MOUSE_REMOTE_GAIN));
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
  useEffect(() => {
    if (!prefsReady || !focused.current || props.available === false || autoStarted.current) return;
    autoStarted.current = true;
    if (enabled) void begin(false, true);
  }, [focusVersion, prefsReady, props.available, enabled]);
  useEffect(() => {
    if (!toggleOn || !largeCursor || !props.onCursor) return;
    const lease = Date.now().toString(36) + Math.random().toString(36).slice(2);
    let retired = false, timer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();
    const renew = () => {
      pending = Promise.resolve().then(() => latest.current.onCursor?.(true, lease)).then(() => {
        if (!retired) timer = setTimeout(renew, 4000);
      }).catch(() => { if (!retired) setMessage('Large pointer unavailable on this box. Air Mouse still works.'); });
    };
    renew();
    return () => { retired = true; if (timer) clearTimeout(timer); void pending.then(() => latest.current.onCursor?.(false, lease)).catch(() => {}); };
  }, [toggleOn, largeCursor, props.targetKey]);
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
  const button = { minHeight: 42, justifyContent: 'center' as const, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: t.cardBorder, backgroundColor: t.card };
  return <View style={{ gap: 4 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Pressable accessibilityRole="switch" accessibilityLabel="Air Mouse" accessibilityState={{ checked: toggleOn }} disabled={props.available === false}
        onPress={() => { if (latched.current) stop(); else void begin(false, true); }} style={button}>
        <Text style={{ color: toggleOn ? t.blue : t.textDim, fontWeight: '700', fontSize: 13 }}>◉ Air {toggleOn ? 'ON' : 'OFF'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Quick calibrate" style={button} onPress={() => { void begin(true); }}><Text style={{ color: t.text, fontSize: 13 }}>Cal</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Recenter Air Mouse" style={button} onPress={() => { stop(); setMessage('Regrip, then turn Air on. Cursor stays in place.'); }}><Text style={{ color: t.text, fontSize: 13 }}>↺</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Click or confirm target" style={button} disabled={props.available === false} onPress={() => { const id=epoch.current; const current=()=>mounted.current&&focused.current&&epoch.current===id&&AppState.currentState==='active'&&latest.current.available!==false; void Promise.resolve().then(()=>{if(current())return latest.current.onClick(current);}).catch(()=>{if(current())setMessage('Click failed. Check connection.');}); }}><Text style={{color:t.text,fontSize:13}}>Click</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Air Mouse preferences" style={button} onPress={() => { stop(); router.push('/air-mouse-settings'); }}><Text style={{ color: t.blue, fontSize: 18 }}>⚙</Text></Pressable>
    </View>
    {!!message && <Text numberOfLines={2} style={{ color: t.textDim, fontSize: 12 }}>{message}</Text>}
    {props.touchpad && <View {...pad.panHandlers} accessibilityLabel="TV touchpad" style={{ minHeight: 110, borderRadius: 12, backgroundColor: t.inset, padding: 14, justifyContent: 'center' }}><Text style={{ color: t.textDim, textAlign: 'center' }}>Touchpad · tap to click · two fingers to scroll</Text></View>}
  </View>;
}
