/** In-memory Play data only; no persistence, one request per resource at a time. */
export class PlayResource<T> {
  snapshot: { data: T | null; error: Error | null; pending: boolean; updated: number } = { data: null, error: null, pending: false, updated: 0 };
  private flight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<typeof this.snapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.listeners.forEach(fn => fn()); }
  fetch(fn: () => Promise<T>, maxAge: number, force = false): Promise<void> {
    if (this.flight) return this.flight;
    if (!force && !this.snapshot.error && this.snapshot.updated && Date.now() - this.snapshot.updated < maxAge) return Promise.resolve();
    this.publish({ pending: true });
    this.flight = Promise.resolve().then(fn).then(data => {
      this.publish({ data, error: null, updated: Date.now() });
    }, error => { this.publish({ error: error instanceof Error ? error : new Error(String(error)) }); })
      .finally(() => { this.flight = null; this.publish({ pending: false }); });
    return this.flight;
  }
}
