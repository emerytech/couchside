/**
 * Saved LED presets — the user's own named colour/effect combos for the LIGHT
 * card (owner ask 2026-08-13: "save presets … save custom LED presets").
 *
 * ON DEVICE ONLY, per phone. A preset is just a label + the same fields the app
 * already POSTs to /api/leds/effect (effect, colour, speed, brightness); the box
 * has no idea the phone keeps a library. Same module-level external-store shape
 * as lib/note.ts (SecureStore on native, localStorage on web, load-once,
 * useSyncExternalStore) so the editor and the preset strip stay in sync.
 *
 * Applying a preset is a normal setLedEffect() call; the AGENT is what persists
 * the *active* choice across a reboot. This library is only the shortcuts.
 *
 * On first run (empty storage) a few starter presets are seeded — including
 * "Night Rider" — so the feature isn't blank. They are ordinary rows the user
 * can delete; deletions stick (we never re-seed once storage is non-empty).
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { LedEffect, Rgb } from './api';

const KEY = 'couchside.ledpresets.v1';
/** Bounded so a runaway library can't blow SecureStore's per-item size limit. */
export const PRESET_MAX = 40;

export type LedPreset = {
  id: string;
  label: string;
  effect: LedEffect;
  /** null for a mono effect (brightness-only) or an effect that ignores colour. */
  color: Rgb | null;
  speed: number;
  brightness: number;
  /** A per-LED painted pattern (effect==='manual' only): one colour per strip
      node, null = off. Applying it repaints every LED. */
  pattern?: (Rgb | null)[];
};

/** Seeded once when the library is empty. "Night Rider" is the owner's example. */
const DEFAULTS: LedPreset[] = [
  { id: 'seed-nightrider', label: 'Night Rider', effect: 'scanner',
    color: { r: 255, g: 0, b: 0 }, speed: 80, brightness: 100 },
  { id: 'seed-breathe-blue', label: 'Breathe Blue', effect: 'breathe',
    color: { r: 0, g: 80, b: 255 }, speed: 35, brightness: 90 },
  { id: 'seed-rainbow', label: 'Rainbow', effect: 'rainbow',
    color: null, speed: 50, brightness: 100 },
  { id: 'seed-warm', label: 'Warm', effect: 'solid',
    color: { r: 255, g: 170, b: 90 }, speed: 50, brightness: 60 },
];

async function storageGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' && window.localStorage
        ? window.localStorage.getItem(key)
        : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, value);
    } catch {
      // storage unavailable (private mode): presets live for this session only
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

let presets: LedPreset[] = [];
let loadStarted = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

const isRgb = (c: unknown): c is Rgb =>
  !!c && typeof c === 'object' &&
  ['r', 'g', 'b'].every((k) => Number.isInteger((c as Record<string, unknown>)[k]));

/** Coerce a parsed value into a clean LedPreset[], dropping anything malformed. */
function normalize(raw: unknown): LedPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: LedPreset[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const p = r as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.label !== 'string' || typeof p.effect !== 'string') continue;
    out.push({
      id: p.id,
      label: p.label.slice(0, 40),
      effect: p.effect as LedEffect,
      color: isRgb(p.color) ? { r: p.color.r, g: p.color.g, b: p.color.b } : null,
      speed: typeof p.speed === 'number' ? p.speed : 50,
      brightness: typeof p.brightness === 'number' ? p.brightness : 100,
      pattern: Array.isArray(p.pattern)
        ? (p.pattern as unknown[]).map((c) => (isRgb(c) ? { r: c.r, g: c.g, b: c.b } : null))
        : undefined,
    });
    if (out.length >= PRESET_MAX) break;
  }
  return out;
}

/** Read the stored presets once; seed DEFAULTS if the library is empty/new. */
export async function loadPresets(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  const raw = await storageGet(KEY);
  if (typeof raw === 'string' && raw.length > 0) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    presets = normalize(parsed);
    if (presets.length > 0) {
      emit();
      return;
    }
    // stored but unusable (corrupt/empty) -> fall through and re-seed
  }
  // First run: seed the starter set and persist it so deletions stick.
  presets = DEFAULTS.slice();
  emit();
  await storageSet(KEY, JSON.stringify(presets));
}
void loadPresets();

export function getPresets(): LedPreset[] {
  return presets;
}

function persist(): Promise<void> {
  return storageSet(KEY, JSON.stringify(presets));
}

function genId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Save a new preset (newest first). Returns it. No-op past PRESET_MAX. */
export async function addPreset(p: Omit<LedPreset, 'id'>): Promise<LedPreset | null> {
  if (presets.length >= PRESET_MAX) return null;
  const preset: LedPreset = { ...p, id: genId(), label: p.label.slice(0, 40) };
  presets = [preset, ...presets];
  emit();
  await persist();
  return preset;
}

/** True for a preinstalled (seeded) preset — those can't be deleted. */
export const isBuiltinPreset = (id: string): boolean => id.startsWith('seed-');

/** Remove a USER-made preset by id (deletions persist). Built-in (seeded) presets
 *  are protected: this is a no-op for them. */
export async function removePreset(id: string): Promise<void> {
  if (isBuiltinPreset(id)) return;
  const next = presets.filter((p) => p.id !== id);
  if (next.length === presets.length) return;
  presets = next;
  emit();
  await persist();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook: live preset list. */
export function useLedPresets(): LedPreset[] {
  return useSyncExternalStore(subscribe, () => presets, () => presets);
}
