/** Pure presentation logic shared by the existing OpenPuck card and tests. */
export type PuckInfo = {
  serial: string; build: string; protocol: number; dirty: boolean;
  connected: boolean; new_reports: number;
  slots: { slot: number; connected: boolean; battery: number | null; rssi: number | null }[];
};
export type PuckPairPlan = {
  confirmation: string; puck_serial: string; controller_serial: string;
  puck_slot: number; controller_slot: number; expires_in: number;
};
export type PuckResult = Partial<PuckInfo & PuckPairPlan> & {
  ok: boolean; error?: string; message?: string;
  responses?: number; active_samples?: number; usb_ok?: boolean; wireless_ok?: boolean;
};
export function comparePuckFirmware(installed: string, latest: string, dirty = false) {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const a = parse(installed), b = parse(latest);
  if (dirty || !a || !b) return 'unknown';
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return 'older';
    if (a[i] > b[i]) return 'newer';
  }
  return 'current';
}
export function puckCheckMessage(r: PuckResult) {
  if (!r.ok) return r.error || 'Check interrupted. No pass recorded.';
  return `${r.usb_ok ? 'USB replies passed' : 'USB check incomplete'} (${r.responses ?? 0}). ${r.wireless_ok ? 'Wireless input stream confirmed.' : 'Wireless input not confirmed. Turn on a paired controller and retry.'} This does not verify every button, axis, or game.`;
}
