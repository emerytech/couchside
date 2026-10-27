import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { PlayResource } from '@/lib/playResource';
import { useSettings } from '@/lib/SettingsContext';
import samples from '@/lib/playDemo.json';

const Context = createContext<{ demo: boolean; setDemo: (v: boolean) => void; resources: Map<string, PlayResource<any>>; refreshers: Map<symbol, () => Promise<void>> } | null>(null);
export function PlayDataProvider({ children }: { children: React.ReactNode }) {
  const [demo, setDemo] = useState(false);
  const resources = useMemo(() => new Map<string, PlayResource<any>>(), []);
  const refreshers = useMemo(() => new Map<symbol, () => Promise<void>>(), []);
  const value = useMemo(() => ({ demo, setDemo, resources, refreshers }), [demo, resources, refreshers]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useHasPlayData() { return useContext(Context) !== null; }
export function usePlaySession() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error('Play data provider missing');
  return { demo: ctx.demo, setDemo: ctx.setDemo, refreshAll: () => Promise.all([...ctx.refreshers.values()].map(fn => fn())) };
}
export function usePlayPoll<T>(name: string, fn: () => Promise<T>, interval: number, enabled: boolean, target: string) {
  const ctx = useContext(Context);
  const { settings } = useSettings();
  if (!ctx) throw new Error('Play data provider missing');
  // Credentials and trust configuration isolate snapshots across re-pairing, not just host switches.
  const key = JSON.stringify([ctx.demo, name, target, settings.token, settings.secure, settings.pinModulus]);
  let entry = ctx.resources.get(key) as PlayResource<T> | undefined;
  if (!entry) { entry = new PlayResource<T>(); ctx.resources.set(key, entry); }
  const resource = entry;
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  const ref = useRef(fn); ref.current = fn;
  const active = enabled || ctx.demo;
  const fetch = useCallback((force = false) => resource.fetch(() => ctx.demo
    ? Promise.resolve((samples as Record<string, unknown>)[name.split(':')[0]] as T)
    : ref.current(), interval, force), [resource, interval, ctx.demo, name]);
  useFocusEffect(useCallback(() => {
    if (!active) return;
    let alive = true;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const run = ++sequence;
      await fetch();
      if (!alive || run !== sequence) return;
      const delay = resource.snapshot.error ? Math.min(interval, 10000) : Math.max(1000, interval - (Date.now() - resource.snapshot.updated));
      timer = setTimeout(tick, delay);
    };
    void tick();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') { clearTimeout(timer); void tick(); } });
    return () => { alive = false; clearTimeout(timer); sub.remove(); };
  }, [active, fetch, interval, resource]));
  useEffect(() => {
    if (!active) return;
    const id = Symbol(name);
    ctx.refreshers.set(id, () => fetch(true));
    return () => { ctx.refreshers.delete(id); };
  }, [active, fetch, ctx.refreshers, name]);
  return { data: state.data, error: state.error, loading: !state.updated && !state.error, refreshing: state.pending, refresh: () => fetch(true) };
}
