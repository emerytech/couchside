import { mediaKey, type MediaTitle } from './discovery.ts';

export type LibraryEntry = {
  title: MediaTitle;
  saved: boolean;
  watched: boolean;
  progress?: { position: number; duration: number };
  updatedAt: number;
};
export type LibraryState = { entries: LibraryEntry[]; ready: boolean; error: string | null };
export interface LibraryStorage { read(): Promise<string | null>; write(value: string): Promise<void> }
const MAX = 200;
const text = (v: unknown, max: number): string => typeof v === 'string' ? v.slice(0, max) : '';

export function normalizeLibrary(raw: unknown): LibraryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const doc = raw as { version?: unknown; entries?: unknown };
  if (doc.version !== 1 || !Array.isArray(doc.entries)) return [];
  const seen = new Set<string>();
  return doc.entries.flatMap((item): LibraryEntry[] => {
    if (!item || typeof item !== 'object') return [];
    const { title: t } = item;
    if (!t || !t.ref || !['movie', 'series', 'episode'].includes(t.kind)) return [];
    const provider = text(t.ref.provider, 80), id = text(t.ref.id, 200), name = text(t.name, 200);
    if (!provider || !id || !name) return [];
    const title: MediaTitle = { ref: { provider, id }, kind: t.kind, name,
      description: text(t.description, 1200), attribution: text(t.attribution, 500) };
    if (typeof t.year === 'number' && Number.isInteger(t.year) && t.year > 1800 && t.year < 3000) title.year = t.year;
    if (typeof t.poster === 'string' && /^https:\/\//.test(t.poster) && t.poster.length <= 2000) title.poster = t.poster;
    if (typeof t.license === 'string') title.license = text(t.license, 500);
    if (t.externalIds && typeof t.externalIds === 'object' && !Array.isArray(t.externalIds)) {
      title.externalIds = Object.fromEntries(Object.entries(t.externalIds).slice(0, 10)
        .flatMap(([k, v]) => /^[a-z0-9_-]{1,40}$/i.test(k) && typeof v === 'string' && v.length <= 100 ? [[k, v]] : []));
    }
    const key = mediaKey(title.ref);
    if (seen.has(key)) return [];
    seen.add(key);
    const entry: LibraryEntry = { title, saved: item.saved === true, watched: item.watched === true,
      updatedAt: Number.isFinite(item.updatedAt) && item.updatedAt >= 0 ? item.updatedAt : 0 };
    const p = item.progress;
    if (p && Number.isFinite(p.position) && Number.isFinite(p.duration) && p.position >= 0 && p.duration > 0 && p.duration <= 604800) {
      entry.progress = { position: Math.min(p.position, p.duration), duration: p.duration };
    }
    return [entry];
  }).slice(0, MAX);
}

/** Serialized mutations wait for hydration. A late disk read cannot erase a
 * tap; failed persistence is visible and the next mutation retries it. */
export class PlayerLibrary {
  private state: LibraryState = { entries: [], ready: false, error: null };
  private listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private storage: LibraryStorage;
  constructor(storage: LibraryStorage) { this.storage = storage; }
  snapshot = (): LibraryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); void this.load();
    return () => this.listeners.delete(listener);
  };
  private publish(state: LibraryState) { this.state = state; this.listeners.forEach(l => l()); }
  load(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const raw = await this.storage.read();
        const parsed = raw ? JSON.parse(raw) : { version: 1, entries: [] };
        if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Unknown library format');
        this.publish({ entries: normalizeLibrary(parsed), ready: true, error: null });
      } catch {
        this.publish({ entries: [], ready: true, error: 'Couldn’t read your library. Existing storage has not been changed.' });
      }
    })();
  }
  private mutate(change: (entries: LibraryEntry[]) => LibraryEntry[]): Promise<void> {
    this.writes = this.writes.then(async () => {
      await this.load();
      // Do not overwrite unreadable data with a new empty library.
      if (this.state.error?.startsWith('Couldn’t read')) return;
      const changed = change(this.state.entries);
      if (changed.length > MAX) {
        this.publish({ ...this.state, error: 'Your library has 200 titles. Forget a title before adding another.' });
        return;
      }
      const entries = normalizeLibrary({ version: 1, entries: changed });
      if (JSON.stringify(entries) === JSON.stringify(this.state.entries) && !this.state.error) return;
      this.publish({ entries, ready: true, error: null });
      try { await this.storage.write(JSON.stringify({ version: 1, entries })); }
      catch { this.publish({ ...this.state, error: 'Library changes could not be saved. Keep the app open and try again.' }); }
    });
    return this.writes;
  }
  update(title: MediaTitle, patch: Partial<Pick<LibraryEntry, 'saved' | 'watched'>>): Promise<void> {
    return this.mutate(entries => {
      const old = entries.find(e => mediaKey(e.title.ref) === mediaKey(title.ref));
      const entry = { ...old, title, saved: old?.saved ?? false, watched: old?.watched ?? false, ...patch, updatedAt: Date.now() };
      const rest = entries.filter(e => mediaKey(e.title.ref) !== mediaKey(title.ref));
      return entry.saved || entry.watched || entry.progress ? [entry, ...rest] : rest;
    });
  }
  recordProgress(title: MediaTitle, position: number, duration: number): Promise<void> {
    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0 || position < 0) return Promise.resolve();
    return this.mutate(entries => {
      const old = entries.find(e => mediaKey(e.title.ref) === mediaKey(title.ref));
      // Ignore repeated/stationary polling and insignificant start-up samples.
      if (position < 5 || (old?.progress && Math.abs(old.progress.position - position) < 5 && old.progress.duration === duration)) return entries;
      const watched = !!old?.watched || position / duration >= 0.95;
      const entry: LibraryEntry = { title, saved: old?.saved ?? false, watched,
        progress: { position, duration }, updatedAt: Date.now() };
      return [entry, ...entries.filter(e => mediaKey(e.title.ref) !== mediaKey(title.ref))];
    });
  }
  remove(ref: MediaTitle['ref']): Promise<void> {
    return this.mutate(entries => entries.filter(e => mediaKey(e.title.ref) !== mediaKey(ref)));
  }
}
