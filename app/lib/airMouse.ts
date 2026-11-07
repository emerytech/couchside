/** Pure gyro integrator. Measurements are rad/s; timestamps are seconds. */
export type MotionSample = { x: number; y: number; z: number; timestamp: number };
export type AirMouseGrip = 'remote';
/** Remote pointing should cover a TV with wrist rotation, not an arm sweep. */
export const AIR_MOUSE_REMOTE_GAIN = 4;
/** Remote: screen up, top aimed at TV (Z yaw).
 * Apply the same frame to bias calibration and integration. */
export function airMouseGripSample(sample: MotionSample, grip: AirMouseGrip): MotionSample {
  return { ...sample, y: sample.z };
}
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
    // Continuous deadband avoids a jump when a small correction crosses zero.
    const radialDeadband = (v: number) => v * Math.max(0, 1 - .012 / Math.max(.012, magnitude));
    const rawX = s.x - this.bias.x, rawY = s.y - this.bias.y;
    const magnitude = Math.hypot(rawX, rawY);
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
    const x = radialDeadband(rawX), y = radialDeadband(rawY);
    // Steady fine aiming; open the filter for deliberate wrist sweeps.
    const intent = Math.max(0, Math.min(1, (magnitude - .03) / .27));
    const alpha = 1 - Math.exp(-dt / (.09 - .07 * intent));
    this.filtered.x += alpha * (x - this.filtered.x); this.filtered.y += alpha * (y - this.filtered.y);
    // Lower gain near a target without sacrificing cross-screen coverage.
    const speed = Math.hypot(this.filtered.x, this.filtered.y);
    const fine = Math.max(0, Math.min(1, (speed - .025) / .225));
    const precision = .35 + .65 * fine * fine * (3 - 2 * fine);
    const gain = 1100 * Math.max(.4, Math.min(8, sensitivity)) * precision;
    const moveX = -this.filtered.y * dt * gain, moveY = -this.filtered.x * dt * gain;
    const bound = Math.min(1, 60 / Math.max(60, Math.hypot(moveX, moveY)));
    const xTotal = moveX * bound + this.carry.x;
    const yTotal = moveY * bound + this.carry.y;
    const dx = Math.round(xTotal), dy = Math.round(yTotal);
    this.carry = { x: xTotal - dx, y: yTotal - dy };
    return { dx, dy };
  }
}
