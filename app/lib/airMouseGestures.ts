import type { MotionSample } from './airMouse';
/** Keep gyro armed while touchpad owns movement; retire pre-touch frames. */
export class AirMouseTouchHandoff {
  generation = 0;
  private touching = false;
  private until = 0;
  setTouch(active: boolean, now: number) {
    if (active === this.touching) return false;
    this.touching = active; this.until = active ? now : now + 120; this.generation++;
    return true;
  }
  allows(now: number) { return !this.touching && now >= this.until; }
  invalidate() { this.generation++; }
}
/** A deliberate rapid three-reversal shake, not ordinary aim/figure eights. */
export class AirMouseShakeDetector {
  private axis: 'x'|'z' = 'z';
  private start = -Infinity;
  private sign = 0;
  private flips = 0;
  private cooldown = -Infinity;
  private suppressUntil = -Infinity;
  reset() { this.start=-Infinity;this.sign=0;this.flips=0;this.suppressUntil=-Infinity; }
  step(s: MotionSample) {
    if (![s.x,s.z,s.timestamp].every(Number.isFinite)) { this.reset(); return {triggered:false,suppress:false}; }
    const t=s.timestamp, high=Math.max(Math.abs(s.x),Math.abs(s.z))>2.5;
    let triggered=false;
    if (high && t>=this.cooldown) {
      if (t-this.start>.5 || t<this.start) {this.start=t;this.axis=Math.abs(s.x)>Math.abs(s.z)?'x':'z';this.sign=0;this.flips=0;}
      const v=s[this.axis];
      if(Math.abs(v)>2.5) { const sign=Math.sign(v);if(this.sign && sign!==this.sign)this.flips++;this.sign=sign;
        if(this.flips>=3){triggered=true;this.suppressUntil=t+.25;this.cooldown=t+2;this.start=-Infinity;this.flips=0;}
      }
    }
    return {triggered,suppress:t<this.suppressUntil};
  }
}
