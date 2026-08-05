/**
 * LAN sweep for TVs the app can drive DIRECTLY (remote-only mode). ZERO
 * runtime imports beyond sibling tvdirect modules and lanIp — bare-Node
 * testable like the rest of this directory.
 *
 * Same shape as lib/boxDiscovery.ts's httpSweep, for the same reason: iOS
 * blocks app UDP, so SSDP/mDNS — how Roku is "supposed" to be discovered — is
 * not available to this app, while a /24 HTTP sweep works on both platforms.
 * Each candidate gets the same GET /query/device-info the ADD-by-IP flow uses,
 * so a host only ever appears in results by proving it is a Roku.
 *
 * Only Roku today, matching DIRECT_BRANDS: discovery for a brand the app
 * cannot drive would surface TVs whose ADD button leads nowhere. When the
 * TLS-socket work lands for LG/Samsung/Google TV (see
 * docs/memory/project_remote-only-mode.md Phase 2+), their probes join this
 * sweep rather than growing a second one.
 */

import { isValidLanIp } from '../lanIp.ts';
import { rokuIdentify, type RokuInfo } from './roku.ts';
import type { DirectBrand } from './model.ts';

/** A TV that answered the sweep. `host` has already proven itself. */
export type FoundTv = {
  brand: DirectBrand;
  host: string;
  name: string;
  model: string;
};

/** Per-host probe timeout during a sweep. A live Roku answers device-info in
 *  milliseconds; 900ms tolerates a congested Wi-Fi hop without letting 254
 *  dead hosts stretch the sweep past a few seconds at CONC workers. */
const SWEEP_TIMEOUT_MS = 900;
/** Concurrent probes. Matches boxDiscovery's order of magnitude — small enough
 *  not to trip AP client limits, large enough that 254/48 x 0.9s ≈ 5s worst case. */
const SWEEP_CONC = 48;

/**
 * The /24 around the phone's own address, phone excluded, .0/.255 excluded.
 * Empty when the address is missing or not a LAN IP: sweeping a public /24
 * from a phone on cellular would be 254 requests at strangers — the same gate
 * (isValidLanIp, KI-033-hardened) that decides what a TV host may be decides
 * what a sweep may cover.
 */
export function sweepCandidates(myIp: string | undefined): string[] {
  if (!myIp || !isValidLanIp(myIp)) return [];
  const base = myIp.slice(0, myIp.lastIndexOf('.') + 1);
  const ips: string[] = [];
  for (let h = 1; h <= 254; h++) {
    const ip = base + h;
    if (ip !== myIp) ips.push(ip);
  }
  return ips;
}

export type SweepOpts = {
  /** Fires the instant a TV answers, so the UI lists it while the sweep is
   *  still draining — a found TV withheld for seconds reads as a slow app. */
  onFound?: (tv: FoundTv) => void;
  /** Cooperative cancel: workers exit within one per-host timeout. */
  signal?: { aborted: boolean };
  /** Injectable for tests; production uses rokuIdentify at the sweep timeout. */
  identify?: (host: string) => Promise<RokuInfo | null>;
  conc?: number;
};

/**
 * Probe `ips` for Rokus, `conc` at a time. Never throws; a host that fails,
 * times out, or answers as something-else-on-8060 is simply not in the result
 * (rokuIdentify already refuses impostors).
 */
export async function sweepForRokus(ips: string[], opts: SweepOpts = {}): Promise<FoundTv[]> {
  const identify = opts.identify ?? ((h: string) => rokuIdentify(h, SWEEP_TIMEOUT_MS));
  const found: FoundTv[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (i >= ips.length) return;
      const info = await identify(ips[i]);
      if (info && !opts.signal?.aborted) {
        const tv: FoundTv = { brand: 'roku', host: ips[i], name: info.name, model: info.model };
        found.push(tv);
        opts.onFound?.(tv);
      }
    }
  };
  const conc = Math.min(opts.conc ?? SWEEP_CONC, Math.max(ips.length, 1));
  await Promise.all(Array.from({ length: conc }, worker));
  return found;
}
