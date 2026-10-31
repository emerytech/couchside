import { GAME_PADS, GAME_PAD_IDS, isGamePadId } from './gamePadCatalog.ts';
import { normalizePadPreset, STARDEW_BACKDROP, VAMPIRE_BACKDROP, type PadPreset } from './padPresets.ts';
import { gamePresetLayout, padLayout, stardewLayout, vampireLayout, type PadLayout, type Rect } from './padLayout.ts';

export const PRESET_IDS: PadPreset['id'][] = ['current', 'stardew', 'vampire', ...GAME_PAD_IDS];
export function presetInfo(id: PadPreset['id']) {
  if (isGamePadId(id)) {
    const p = GAME_PADS[id];
    return { title: p.title, kind: p.layout === 'one' ? 'One-handed' : p.layout === 'twin' ? 'Dual-stick' : 'Combat',
      backdrop: `${id}-pad`, art: p.art, beta: true, hint: p.hint, handed: p.layout === 'one' };
  }
  if (id === 'stardew') return { title: 'Stardew Valley', kind: 'Farming', backdrop: STARDEW_BACKDROP.key,
    art: 'Stardew farm', beta: false, handed: false,
    hint: 'Move through the farm and menus. Hold X to charge tools; A interacts, B opens inventory, Y opens crafting, and LT/RT select items. Uses default Xbox bindings.' };
  if (id === 'vampire') return { title: 'Vampire Survivors', kind: 'One-handed', backdrop: VAMPIRE_BACKDROP.key,
    art: 'Moonlit ruins', beta: false, handed: true,
    hint: 'Move with one thumb, then lift to choose upgrades. Attacks are automatic. A selects, B goes back, and Start pauses.' };
  return { title: 'Current controls', kind: 'Standard · Dual-stick', backdrop: null, art: 'My usual background',
    beta: false, handed: false, hint: 'Your familiar controller, using your saved colors and background. Includes two sticks, D-pad, face buttons, shoulders and triggers.' };
}
export function presetDraft(id: PadPreset['id']): PadPreset {
  return { ...normalizePadPreset({ version: 1, id, size: id === 'current' ? 'standard' : 'larger', hand: 'right' }) };
}
export function adjacentPreset(id: PadPreset['id'], direction: -1 | 1): PadPreset['id'] {
  return PRESET_IDS[(PRESET_IDS.indexOf(id) + direction + PRESET_IDS.length) % PRESET_IDS.length];
}

/** Preview-only geometry: scale drawing AND hit targets, not the native view.
 * A transformed native view reports page coordinates at a different scale.
 * This keeps local touch feedback aligned without changing live PAD geometry.
 */
export function previewLayout(preset: PadPreset, width: number): PadLayout {
  const win = { width: 844, height: 390 }, safe = { left: 0, right: 0, top: 0, bottom: 0 };
  const base = isGamePadId(preset.id) ? gamePresetLayout(win, safe, preset.id, preset.hand)
    : preset.id === 'vampire' ? vampireLayout(win, safe, preset.hand)
    : preset.id === 'stardew' ? stardewLayout(win, safe, preset.size) : padLayout(win, safe);
  if (!base.ok || !Number.isFinite(width) || width <= 0) return { ok: false, reason: 'too-narrow' };
  const scale = width / win.width;
  const rect = (r: Rect): Rect => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale });
  const nodes = base.nodes.map(n => ({ ...n, rect: rect(n.rect), hit: rect(n.hit) }));
  return { ok: true, u: base.u * scale, play: rect(base.play), nodes,
    byId: Object.fromEntries(nodes.map(n => [n.id, n])) as Extract<PadLayout, { ok: true }>['byId'] };
}
