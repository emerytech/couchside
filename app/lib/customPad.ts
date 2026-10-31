import type { ButtonKey, TriggerKey } from './gamepad';

export const CUSTOM_OUTPUTS = ['a','b','x','y','lb','rb','lt','rt','select','start','l3','r3'] as const;
export type CustomOutput = typeof CUSTOM_OUTPUTS[number];
export type CustomBinding = { output: CustomOutput; label: string };
export type CustomPad = { version: 1; id: string; name: string; bindings: Partial<Record<CustomOutput, CustomBinding>> };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function normalizeCustomPad(raw: unknown): CustomPad | undefined {
  if (!record(raw) || raw.version !== 1 || typeof raw.id !== 'string' || !/^custom-[a-z0-9-]{1,64}$/.test(raw.id)
    || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 40 || !record(raw.bindings)) return;
  const bindings: CustomPad['bindings'] = {};
  for (const key of CUSTOM_OUTPUTS) {
    const b = raw.bindings[key];
    if (record(b) && CUSTOM_OUTPUTS.includes(b.output as CustomOutput) && typeof b.label === 'string' && b.label.length <= 28)
      bindings[key] = { output: b.output as CustomOutput, label: b.label };
  }
  return { version: 1, id: raw.id, name: raw.name.trim(), bindings };
}

type Momentary = { onDown(): void; onUp(): void };
/** Own each source hold, reference-count destinations, and reject late events after disposal. */
export function createCustomPadInputs(custom: CustomPad, sink: { btn(k: ButtonKey): Momentary; trig(k: TriggerKey): Momentary }) {
  const held = new Map<string, string>(), counts = new Map<string, number>();
  let disposed = false;
  const output = (key: string) => key === 'lt' || key === 'rt' ? sink.trig(key) : sink.btn(key as ButtonKey);
  const input = (source: string): Momentary => ({
    onDown() {
      if (disposed || held.has(source)) return;
      const key = custom.bindings[source as CustomOutput]?.output ?? source;
      held.set(source, key);
      const n = counts.get(key) ?? 0; counts.set(key, n + 1);
      if (!n) output(key).onDown();
    },
    onUp() {
      const key = held.get(source); if (disposed || !key) return;
      held.delete(source);
      const n = (counts.get(key) ?? 1) - 1;
      if (n) counts.set(key, n); else { counts.delete(key); output(key).onUp(); }
    },
  });
  return { activate() { disposed = false; }, btn: (k: ButtonKey) => input(k), trig: (k: TriggerKey) => input(k), dispose() {
    if (disposed) return; disposed = true;
    const keys = [...counts.keys()]; held.clear(); counts.clear();
    for (const k of keys) output(k).onUp();
  } };
}
