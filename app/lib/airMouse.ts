/** Pure gyro integrator. Measurements are rad/s; timestamps are seconds. */
export type MotionSample = { x: number; y: number; z: number; timestamp: number };
export class AirMouseIntegrator {
  private carry = { x: 0, y: 0 };
  private quietSince: number | null = null;
  private stationary = false;
  private previous: number | null = null;
  private bias = { x: 0, y: 0 };
  private filtered = { x: 0, y: 0 };
  reset() { this.quietSince = null; this.stationary = false; this.previous = null; this.carry = { x: 0, y: 0 }; this.filtered = { x: 0, y: 0 }; }
  calibrate(samples: MotionSample[]) {
    if (samples.length < 10 || samples.some(s => ![s.x, s.y].every(Number.isFinite) || Math.hypot(s.x, s.y) > .15)) return false;
    this.bias = { x: samples.reduce((a, s) => a + s.x, 0) / samples.length,
      y: samples.reduce((a, s) => a + s.y, 0) / samples.length };
    this.reset(); return true;
  }
  step(s: MotionSample, sensitivity = 1): { dx: number; dy: number } | null {
    if (![s.x, s.y, s.timestamp, sensitivity].every(Number.isFinite)) { this.reset(); return null; }
    const last = this.previous; this.previous = s.timestamp;
    if (last == null) return null;
    const dt = s.timestamp - last;
    if (dt <= 0 || dt > .08) { this.reset(); this.previous = s.timestamp; return null; }
    const dead = (v: number) => Math.abs(v) < .018 ? 0 : v;
    const rawX = s.x - this.bias.x, rawY = s.y - this.bias.y;
    const magnitude = Math.max(Math.abs(rawX), Math.abs(rawY));
    if (magnitude < .012) {
      this.quietSince ??= s.timestamp;
      if (s.timestamp - this.quietSince >= .1) this.stationary = true;
    } else this.quietSince = null;
    // Hysteresis prevents a resting phone from slowly walking the cursor.
    if (this.stationary && magnitude < .023) {
      this.filtered = { x: 0, y: 0 }; this.carry = { x: 0, y: 0 };
      return { dx: 0, dy: 0 };
    }
    this.stationary = false;
    const x = dead(rawX), y = dead(rawY);
    const alpha = 1 - Math.exp(-dt / .025);
    this.filtered.x += alpha * (x - this.filtered.x); this.filtered.y += alpha * (y - this.filtered.y);
    const gain = 1100 * Math.max(.4, Math.min(2, sensitivity));
    const bound = (v: number) => Math.max(-60, Math.min(60, v));
    const xTotal = bound(-this.filtered.y * dt * gain) + this.carry.x;
    const yTotal = bound(-this.filtered.x * dt * gain) + this.carry.y;
    const dx = Math.round(xTotal), dy = Math.round(yTotal);
    this.carry = { x: xTotal - dx, y: yTotal - dy };
    return { dx, dy };
  }
}
