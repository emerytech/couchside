import type { ButtonKey, StickKey, TriggerKey } from './gamepad';
import type { Rect } from './padLayout.ts';

export type PadTouch = { identifier: number; x: number; y: number };
export type PadAction = { kind: 'button'; key: ButtonKey } | { kind: 'trigger'; key: TriggerKey };
export type PadControl = { id: string; hit: Rect } & (
  | { kind: 'button'; action: PadAction; slideGroup?: string }
  | { kind: 'zone'; at(x: number, y: number): PadAction | null }
  | { kind: 'stick'; stick: StickKey; value(dx: number, dy: number): { x: number; y: number }; click?: ButtonKey }
  | { kind: 'command'; command: 'qam' }
);
export type PadTouchVisual = { held: string[]; sticks: Record<string, { x: number; y: number; dx: number; dy: number }> };
type Owner = { control: PadControl; x: number; y: number; dx: number; dy: number; distance: number; time: number; action: PadAction | null };
const inside = (p: PadTouch, r: Rect) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
const actionId = (a: PadAction) => `${a.kind}:${a.key}`;

/** PAD-only ownership. No responder centroid, transport, preset IDs or theme state.
 * Layouts supply geometry and frozen protocol actions; fingers never cross groups.
 * Shared actions are reference-counted (e.g. D-pad OK + face A).
 */
export function createPadTouches(controls: readonly PadControl[], excluded: readonly Rect[], output: {
  action(a: PadAction, down: boolean): void;
  stick(k: StickKey, x: number, y: number): void;
  feedback?(): void;
  changed?(): void;
}, clock = { now: () => Date.now(), later: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) }) {
  const owners = new Map<number, Owner | null>();
  const counts = new Map<string, { action: PadAction; count: number }>();
  const sent = new Map<string, PadAction>();
  const directions = ['du', 'dd', 'dl', 'dr'] as const;
  const flush = () => {
    const desired = new Map([...counts].filter(([, { action }]) => {
      if (action.kind !== 'button') return true;
      const index = directions.findIndex(k => k === action.key);
      return index < 0 || !counts.has(`button:${directions[index ^ 1]}`);
    }).map(([id, n]) => [id, n.action]));
    // Reconcile once per changed-touch batch. Two opposing fingers ending in
    // one event must not briefly restore an axis between their releases.
    for (const [id, action] of sent) if (!desired.has(id)) output.action(action, false);
    for (const [id, action] of desired) if (!sent.has(id)) output.action(action, true);
    sent.clear(); for (const [id, action] of desired) sent.set(id, action);
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  const hold = (action: PadAction, down: boolean) => {
    const id = actionId(action), old = counts.get(id)?.count ?? 0;
    const count = old + (down ? 1 : -1);
    if (count > 0) counts.set(id, { action, count }); else counts.delete(id);
    if (down && old === 0) output.feedback?.();
  };
  const schedule = (fn: () => void, ms: number) => {
    const timer = clock.later(() => { timers.delete(timer); if (!disposed) { fn(); flush(); output.changed?.(); } }, ms); timers.add(timer);
  };
  const chord = () => {
    const guide: PadAction = { kind: 'button', key: 'guide' }, a: PadAction = { kind: 'button', key: 'a' };
    hold(guide, true);
    schedule(() => { hold(a, true); schedule(() => { hold(a, false); hold(guide, false); }, 120); }, 60);
  };
  const pulse = (actions: PadAction[]) => {
    for (const action of actions) hold(action, true);
    schedule(() => { for (const action of actions) hold(action, false); }, 60);
  };
  const change = (o: Owner, next: PadAction | null) => {
    if (o.action && next && actionId(o.action) === actionId(next)) return;
    if (o.action) hold(o.action, false);
    o.action = next;
    if (next) hold(next, true);
  };
  function end(id: number, tap = false, final?: PadTouch) {
    const o = owners.get(id); owners.delete(id);
    if (!o) return;
    if (final && Number.isFinite(final.x) && Number.isFinite(final.y)) o.distance = Math.max(o.distance, Math.hypot(final.x - o.x, final.y - o.y));
    change(o, null);
    if (o.control.kind === 'stick') {
      output.stick(o.control.stick, 0, 0);
      if (tap && o.control.click && o.distance < 12 && clock.now() - o.time < 450) pulse([{ kind: 'button', key: o.control.click }]);
    }
  }
  function cancel() {
    for (const timer of timers) clock.clear(timer);
    timers.clear();
    // Atomic cleanup: opposite-direction owners must never briefly restore a
    // direction while the surface is being revoked.
    const sticks = new Set<StickKey>();
    for (const o of owners.values()) if (o?.control.kind === 'stick') sticks.add(o.control.stick);
    const release = [...sent.values()];
    owners.clear(); counts.clear(); sent.clear();
    for (const key of sticks) output.stick(key, 0, 0);
    for (const action of release) output.action(action, false);
  }
  return {
    start(touches: readonly PadTouch[]) {
      if (disposed) return;
      for (const p of touches) {
        if (owners.has(p.identifier) || !Number.isFinite(p.identifier) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const c = excluded.some(r => inside(p, r)) ? undefined : controls.find(c => inside(p, c.hit));
        if (!c || (c.kind === 'stick' && [...owners.values()].some(o => o?.control.kind === 'stick' && o.control.stick === c.stick))) { owners.set(p.identifier, null); continue; }
        const o: Owner = { control: c, x: p.x, y: p.y, dx: 0, dy: 0, distance: 0, time: clock.now(), action: null };
        owners.set(p.identifier, o);
        if (c.kind === 'button') change(o, c.action);
        if (c.kind === 'zone') change(o, c.at(p.x, p.y));
        if (c.kind === 'stick') output.feedback?.();
        if (c.kind === 'command') chord();
      }
      flush();
    },
    move(touches: readonly PadTouch[]) {
      if (disposed) return;
      for (const p of touches) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const o = owners.get(p.identifier); if (!o) continue;
        o.dx = p.x - o.x; o.dy = p.y - o.y; o.distance = Math.max(o.distance, Math.hypot(o.dx, o.dy));
        const c = o.control;
        if (c.kind === 'stick') { const v = c.value(o.dx, o.dy); output.stick(c.stick, v.x, v.y); }
        else if (c.kind === 'zone') change(o, c.at(p.x, p.y));
        else if (c.kind === 'button') {
          if (c.slideGroup) {
            const target = excluded.some(r => inside(p, r)) ? undefined : controls.find(n => n.kind === 'button' && n.slideGroup === c.slideGroup && inside(p, n.hit));
            change(o, target?.kind === 'button' ? target.action : null);
            // Ownership remains in this group even through its gaps.
          } else if (!inside(p, c.hit)) { end(p.identifier); owners.set(p.identifier, null); }
        }
      }
      flush();
    },
    end(touches: readonly PadTouch[]) { if (!disposed) { for (const p of touches) end(p.identifier, true, p); flush(); } },
    cancel,
    dispose() { disposed = true; cancel(); },
    command() { if (!disposed) { chord(); flush(); } },
    activate(action: PadAction) { if (!disposed) { pulse([action]); flush(); } },
    visual(): PadTouchVisual {
      const sticks: PadTouchVisual['sticks'] = {};
      for (const o of owners.values()) if (o?.control.kind === 'stick') sticks[o.control.id] = { x: o.x, y: o.y, dx: o.dx, dy: o.dy };
      return { held: [...sent.keys()], sticks };
    },
  };
}
