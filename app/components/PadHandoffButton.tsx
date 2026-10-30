import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { createPadDecisionTouch } from '@/lib/padDecisionTouch';

/** Raw native touch ends let Pass/Keep work while another finger holds the PAD.
 * No responder claim, no gameplay events, and no action until this finger lifts.
 */
export function PadHandoffButton({ onPress, label, style, children, nativeTouch = true }: {
  onPress(): void; nativeTouch?: boolean; label: string; children: ReactNode;
  style(state: { pressed: boolean }): StyleProp<ViewStyle>;
}) {
  const view = useRef<View>(null);
  const touch = useRef(createPadDecisionTouch());
  const generation = useRef(0);
  const [pressed, setPressed] = useState(false);
  const measure = useCallback(() => {
    const gen = ++generation.current;
    touch.current.layout(null); setPressed(false);
    view.current?.measureInWindow((x, y, w, h) => {
      if (gen === generation.current && [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0)
        touch.current.layout({ x, y, w, h });
    });
  }, []);
  useLayoutEffect(() => {
    measure();
    return () => { ++generation.current; touch.current.layout(null); };
  }, [measure]);
  const dispatch = (kind: 'start' | 'move' | 'end', e: GestureResponderEvent) => {
    const points = e.nativeEvent.changedTouches.map(p => ({ identifier: Number(p.identifier), x: p.pageX, y: p.pageY }));
    const activate = touch.current[kind](points);
    setPressed(touch.current.pressed());
    if (activate === true) onPress();
  };
  if (Platform.OS === 'web' || !nativeTouch) return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={style}>{children}</Pressable>;
  return <View ref={view} collapsable={false} onLayout={measure} style={style({ pressed })}
    accessible accessibilityRole="button" accessibilityLabel={label}
    onAccessibilityTap={Platform.OS === 'ios' ? onPress : undefined}
    accessibilityActions={[{ name: 'activate' }]}
    onAccessibilityAction={Platform.OS === 'android' ? e => { if (e.nativeEvent.actionName === 'activate') onPress(); } : undefined}
    onTouchStart={e => dispatch('start', e)} onTouchMove={e => dispatch('move', e)} onTouchEnd={e => dispatch('end', e)}
    onTouchCancel={() => { touch.current.cancel(); setPressed(false); }}>{children}</View>;
}
