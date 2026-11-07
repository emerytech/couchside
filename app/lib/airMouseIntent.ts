/** Session-only intent survives screen remounts; it never owns sensors or sends input. */
export class AirMouseIntentStore {
  private values = new Map<string, boolean>();
  resolve(target: string, defaultOn: boolean): boolean {
    if (!this.values.has(target)) this.values.set(target, defaultOn);
    return this.values.get(target)!;
  }
  set(target: string, on: boolean) { this.values.set(target, on); }
}
export const airMouseIntent = new AirMouseIntentStore();
