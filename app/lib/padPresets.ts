import type { ButtonKey, TriggerKey } from './gamepad';

/** Xbox defaults verified against https://stardewvalleywiki.com/Controls.
 * LT/RT select items (and menu tabs); LB/RB shift entire toolbar rows.
 * B opens inventory in the world and backs out of menus. Y is CRAFTING.
 * These are ordinary controller inputs, never macros or keyboard remaps.
 */
export const STARDEW_ACTIONS = [
  { key: 'lt', kind: 'trigger', glyph: 'LT', label: 'Previous item' },
  { key: 'b', kind: 'button', glyph: 'B', label: 'Inventory / Back' },
  { key: 'rt', kind: 'trigger', glyph: 'RT', label: 'Next item' },
  { key: 'x', kind: 'button', glyph: 'X', label: 'Use tool' },
  { key: 'a', kind: 'button', glyph: 'A', label: 'Interact / Select' },
  { key: 'y', kind: 'button', glyph: 'Y', label: 'Crafting' },
  { key: 'start', kind: 'button', glyph: 'Start', label: 'Menu / Pause' },
] as const;

export const STARDEW_BACKDROP = { key: 'stardew-farm', glow: '#8ca96b' };

type Momentary = { onDown: () => void; onUp: () => void };
export function stardewActionInput(action: typeof STARDEW_ACTIONS[number], controls: {
  btn: (key: ButtonKey) => Momentary;
  trig: (key: TriggerKey) => Momentary;
}): Momentary {
  return action.kind === 'trigger' ? controls.trig(action.key) : controls.btn(action.key);
}

/** Local, per-box layout choice. Never copy a preset into the user's prefs. */
export type PadPreset = {
  version: 1;
  id: 'current' | 'stardew';
  size: 'standard' | 'larger';
  /** Omitted means the preset's farm art; never mutates the saved app theme. */
  background?: 'farm' | 'current';
};

export const CURRENT_CONTROLS: PadPreset = { version: 1, id: 'current', size: 'standard' };

/** Unknown versions/IDs and partial data must retain the familiar controller. */
export function normalizePadPreset(raw: unknown): PadPreset {
  if (!raw || typeof raw !== 'object') return CURRENT_CONTROLS;
  const p = raw as Record<string, unknown>;
  if (p.version !== 1 || p.id !== 'stardew' || (p.size !== 'standard' && p.size !== 'larger')) {
    return CURRENT_CONTROLS;
  }
  return { version: 1, id: 'stardew', size: p.size,
    ...(p.background === 'current' || p.background === 'farm' ? { background: p.background } : {}) };
}

export function padPresetLabel(raw: unknown): string {
  const p = normalizePadPreset(raw);
  return p.id === 'current' ? 'Current controls' : `Stardew Valley · ${p.size === 'larger' ? 'Larger' : 'Standard'}`;
}

export const ROTATION_TIP_TITLE = 'Want a full-screen controller?';
export const ROTATION_TIP_BODY = 'While using PAD, turn your phone sideways to expand the gamepad. In the mobile app, you can also tap Rotate when there is room beside the shoulder buttons. Full-screen Prefs opens your presets and themes.';

export type RotationTipState = {
  ready: boolean;
  learned: boolean;
  focused: boolean;
  mode: string;
  landscape: boolean;
  available: boolean;
  connected: boolean;
  blocked: boolean;
  tourVisible: boolean;
  selectorVisible: boolean;
};

export function shouldShowRotationTip(s: RotationTipState): boolean {
  return s.ready && !s.learned && s.focused && s.mode === 'gamepad'
    && !s.landscape && s.available && s.connected && !s.blocked
    && !s.tourVisible && s.selectorVisible;
}

/** The unchanged portrait D-pad needs 3 * 58 + 2 * 4 dp. A hint may use
 * spare space, never compress this cluster into the shoulders or sticks.
 * Short windows defer the hint (without marking it learned); Help still works.
 */
export function rotationTipFits(clusterRoom: number, tipHeight: number): boolean {
  return tipHeight > 0 && clusterRoom >= 182 + tipHeight + 4;
}
