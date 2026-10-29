import { dpadZone, navZone, stickValue, type PadLayout } from './padLayout.ts';
import { STARDEW_ACTIONS } from './padPresets.ts';
import type { ButtonKey } from './gamepad';
import type { PadControl } from './padTouches.ts';

/** Adapters only: future presets describe controls without owning touch logic. */
export function padTouchControls(layout: Extract<PadLayout, { ok: true }>, preset: 'current' | 'stardew' | 'move'): PadControl[] {
  const { byId: n, u } = layout;
  const button = (id: string, key: ButtonKey, slideGroup?: string): PadControl => ({ id, hit: n[id as keyof typeof n].hit, kind: 'button', action: { kind: 'button', key }, slideGroup });
  const stick = (id: 'move' | 'lstick' | 'rstick', key: 'l' | 'r', click?: 'l3' | 'r3'): PadControl => ({ id, hit: n[id].hit, kind: 'stick', stick: key, value: (dx, dy) => stickValue(dx, dy, u), click });
  if (preset === 'stardew') return [stick('move', 'l'), ...STARDEW_ACTIONS.map(a => ({ id: a.key, hit: n[a.key].hit, kind: 'button' as const, action: a.kind === 'trigger' ? { kind: 'trigger' as const, key: a.key } : { kind: 'button' as const, key: a.key } }))];
  const zone = (id: 'dpad' | 'nav', nav: boolean): PadControl => ({ id, hit: n[id].hit, kind: 'zone', at(x, y) {
    const r = n[id].rect;
    const key = (nav ? navZone : dpadZone)(x - r.x - r.w / 2, y - r.y - r.h / 2, u);
    return key ? { kind: 'button', key } : null;
  } });
  if (preset === 'move') return [stick('move', 'l'), zone('nav', true), button('a', 'a'), button('b', 'b'), button('start', 'start')];
  return [stick('lstick', 'l', 'l3'), stick('rstick', 'r', 'r3'), zone('dpad', false),
    ...(['a', 'b', 'x', 'y'] as const).map(k => button(k, k, 'face')),
    ...(['lb', 'rb', 'select', 'start'] as const).map(k => button(k, k)), button('steam', 'guide'),
    ...(['lt', 'rt'] as const).map(k => ({ id: k, hit: n[k].hit, kind: 'button' as const, action: { kind: 'trigger' as const, key: k } })),
    { id: 'qam', hit: n.qam.hit, kind: 'command', command: 'qam' }];
}
