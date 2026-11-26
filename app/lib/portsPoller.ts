/** Ports-only polling: one request chain, invalidated on refresh, blur or box
 * switch. No React/native imports so races can be tested with deferred replies. */
import type { PortsState } from './api';

export type PortsPollState = {
  data: PortsState | null;
  error: Error | null;
  loading: boolean;
};
export const PORTS_IDLE_MS = 30_000;
export const PORTS_BUSY_MS = 2_000;

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(timer: unknown): void;
};
const timers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class PortsPoller {
  private generation = 0;
  private timer: unknown;
  private active = false;
  private key: string | undefined;
  private load: (() => Promise<PortsState | null>) | undefined;
  private changed: ((state: PortsPollState) => void) | undefined;
  private state: PortsPollState = { data: null, error: null, loading: true };

  private clock: Timers;
  constructor(clock: Timers = timers) { this.clock = clock; }

  start(key: string, load: () => Promise<PortsState | null>, changed: (state: PortsPollState) => void) {
    this.stop();
    if (key !== this.key) this.state = { data: null, error: null, loading: true };
    this.key = key;
    this.load = load;
    this.changed = changed;
    this.active = true;
    changed(this.state);
    void this.tick(this.generation);
  }

  stop() {
    this.active = false;
    this.generation++;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
  }

  refresh() {
    if (this.active && this.key !== undefined && this.load && this.changed) {
      this.start(this.key, this.load, this.changed);
    }
  }

  private async tick(generation: number) {
    if (!this.active || generation !== this.generation) return;
    try {
      const data = await this.load!();
      if (!this.active || generation !== this.generation) return;
      this.state = { data, error: null, loading: false };
    } catch (error) {
      if (!this.active || generation !== this.generation) return;
      this.state = { ...this.state, error: error instanceof Error ? error : new Error(String(error)), loading: false };
    }
    this.changed!(this.state);
    if (!this.active || generation !== this.generation) return;
    const delay = this.state.error || this.state.data?.install?.running || this.state.data?.addon?.remote_paused ? PORTS_BUSY_MS : PORTS_IDLE_MS;
    this.timer = this.clock.set(() => { this.timer = undefined; void this.tick(generation); }, delay);
  }
}
