/**
 * In-controller theme switcher: a chrome button in the immersive MOVE view that
 * opens a dropdown of every theme, so the controller can be re-skinned on the
 * fly without leaving play.
 *
 * The TRIGGER is a layout node ('theme', layer 9) placed by lib/padLayout.ts —
 * so it is collision- and moat-checked like LOCK/EXIT. The DROPDOWN is an
 * overlay: it captures touches (a scrim behind it closes on outside-tap) and
 * lists lib/gameTheme's THEME_PICKER, writing the `controllerTheme` pref on
 * select. Because the pref drives useControllerTheme, the whole controller
 * re-skins the instant a row is tapped — including this component's own colours.
 *
 * NOTHING here is on the gamepad input path. The trigger and the dropdown are
 * ordinary Pressables; while the dropdown is open its scrim sits above the game
 * controls, so a stray drag closes the menu instead of moving the character —
 * which is the safe failure, not a latched axis.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { hapticSelection as haptic } from '@/lib/haptics';
import { THEME_PICKER, type ControllerThemePref } from '@/lib/gameTheme';
import { setPref, usePref } from '@/lib/prefs';
import type { PadNode, Rect } from '@/lib/padLayout';
import type { ThemedPalette } from '@/lib/gameTheme';

const abs = (r: Rect) => ({
  position: 'absolute' as const,
  left: r.x,
  top: r.y,
  width: r.w,
  height: r.h,
});
const inner = (n: PadNode) => ({
  position: 'absolute' as const,
  left: n.rect.x - n.hit.x,
  top: n.rect.y - n.hit.y,
  width: n.rect.w,
  height: n.rect.h,
});

export function ThemeSwitcher({
  node, play, u, t,
}: {
  /** The 'theme' chrome node from the layout. */
  node: PadNode;
  /** The play rect, for sizing/placing the dropdown. */
  play: Rect;
  u: number;
  /** The live controller palette (so the switcher re-skins with everything). */
  t: ThemedPalette;
}) {
  const [open, setOpen] = useState(false);
  const current = usePref('controllerTheme');

  const pick = (value: ControllerThemePref) => {
    haptic();
    void setPref('controllerTheme', value);
    setOpen(false);
  };

  // Dropdown geometry: a panel just below the trigger, left-aligned to it,
  // clamped inside the play rect. Sized in U so it matches the controls.
  const rowH = 13 * u;
  const panelW = Math.min(40 * u, play.w - 8 * u);
  const panelX = Math.min(node.rect.x, play.x + play.w - panelW - 4 * u);
  const panelY = node.rect.y + node.rect.h + 3 * u;
  const panelH = Math.min(THEME_PICKER.length * rowH + 4 * u, play.h - panelY - 4 * u);

  return (
    <>
      {/* Trigger */}
      <Pressable
        style={abs(node.hit)}
        onPress={() => {
          haptic();
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel="Switch controller theme"
        accessibilityState={{ expanded: open }}>
        <View
          style={[
            inner(node),
            {
              borderRadius: 2.5 * u,
              borderWidth: 1,
              borderColor: open ? t.blue : t.cardBorder,
              backgroundColor: t.card,
              alignItems: 'center',
              justifyContent: 'center',
            },
          ]}>
          <Text style={{ color: open ? t.blue : t.textFaint, fontSize: 4 * u }}>🎨</Text>
        </View>
      </Pressable>

      {/* Dropdown overlay */}
      {open ? (
        <>
          {/* Full-screen scrim: outside-tap closes. Sits above the controls so a
              stray touch dismisses the menu rather than driving the game. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close theme menu"
          />
          <View
            style={{
              position: 'absolute',
              left: panelX,
              top: panelY,
              width: panelW,
              maxHeight: panelH,
              backgroundColor: t.card,
              borderColor: t.cardBorder,
              borderWidth: 1,
              borderRadius: 3 * u,
              overflow: 'hidden',
            }}>
            <ScrollView>
              {THEME_PICKER.map((opt) => {
                const active = opt.value === current;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => pick(opt.value)}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={opt.label}
                    style={({ pressed }) => [
                      {
                        height: rowH,
                        paddingHorizontal: 4 * u,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        backgroundColor: pressed || active ? t.cardBorder : 'transparent',
                      },
                    ]}>
                    <Text
                      style={{
                        color: active ? t.blue : t.text,
                        fontSize: 3.6 * u,
                        fontWeight: active ? '700' : '400',
                      }}
                      numberOfLines={1}>
                      {opt.label}
                    </Text>
                    {active ? (
                      <Text style={{ color: t.blue, fontSize: 3.6 * u }}>●</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </>
      ) : null}
    </>
  );
}
