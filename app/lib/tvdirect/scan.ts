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
 * EVERY DIRECT BRAND, one sweep. Roku answers an HTTP probe that proves what it
 * is; Google TV and LG do not, so they are proven by their control ports being
 * OPEN (Android TV Remote 6466, webOS SSAP 3001) — a TCP probe injected by the
 * caller, because opening a socket needs native code this bare-Node-testable
 * module must not import.
 *
 * Discovery stays limited to brands the app can actually DRIVE. Surfacing a
 * Samsung the user cannot then add would be a list of dead ends; those stay
 * box-only until their transport lands, at which point they join this table.
 *
 * The probe table is FROZEN and looked up, never built from anything a client
 * or a TV said — same rule as every other id table in this project.
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

/** Open a TCP connection; true if it connects before the timeout. Injected —
 *  see the header note about native imports. */
export type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/**
 * How each brand proves itself. `port` is what a TCP probe knocks on; `http`
 * brands prove themselves by answering a request only that brand answers.
 */
export type BrandProbe = {
  brand: DirectBrand;
  /** Human label used when the device exposes no name of its own. */
  fallbackName: string;
  /** TCP port that proves the brand's control channel is live (tcp probes). */
  port?: number;
  /** Full identify (roku): self-proving, returns the real name. */
  identify?: (host: string, timeoutMs: number) => Promise<{ name: string; model: string } | null>;
  /** Optional friendly-name lookup once `port` proved the brand. */
  nameLookup?: (host: string, timeoutMs: number) => Promise<string | null>;
};

/**
 * The Google TV / Chromecast name endpoint. MEASURED against a real device
 * (returned "Bedroom TV"): plain HTTP, answers even when the TV is in standby.
 * Name only — it does NOT prove the remote service is up, which is why the
 * androidtv probe still requires port 6466. Never throws.
 */
export async function castName(host: string, timeoutMs: number): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://${host}:8008/setup/eureka_info?options=detail`, {
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = (await res.json()) as { name?: unknown };
    return typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  } catch {
    return null;
  }
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
  /** Brands to look for. Defaults to DEFAULT_PROBES. */
  probes?: BrandProbe[];
  /** Required for the TCP-proven brands; without it only HTTP brands are found. */
  tcpProbe?: TcpProbe;
};

/** Android TV Remote v2 control port — open means the remote service is live. */
export const ATV_REMOTE_PORT = 6466;
/** LG webOS SSAP port (wss). Open means the TV will accept a pairing request. */
export const WEBOS_SSAP_PORT = 3001;

export const DEFAULT_PROBES: BrandProbe[] = [
  { brand: 'roku', fallbackName: 'Roku' },
  { brand: 'androidtv', fallbackName: 'Google TV', port: ATV_REMOTE_PORT, nameLookup: castName },
  { brand: 'webos', fallbackName: 'LG webOS', port: WEBOS_SSAP_PORT },
];

/**
 * Probe `ips` for Rokus, `conc` at a time. Never throws; a host that fails,
 * times out, or answers as something-else-on-8060 is simply not in the result
 * (rokuIdentify already refuses impostors).
 */
export async function sweepForRokus(ips: string[], opts: SweepOpts = {}): Promise<FoundTv[]> {
  return sweepForTvs(ips, { ...opts, probes: [{ brand: 'roku', fallbackName: 'Roku' }] });
}

/**
 * Probe `ips` for every brand in `probes`, `conc` hosts at a time. Never throws;
 * a host that fails, times out, or answers as something else is simply absent
 * from the result.
 *
 * One host can only be ONE TV — the first brand to prove itself wins and the
 * remaining probes for that host are skipped. That keeps a single television
 * from appearing three times, and keeps the sweep cheap: a proven host costs one
 * probe, not len(probes).
 */
export async function sweepForTvs(ips: string[], opts: SweepOpts = {}): Promise<FoundTv[]> {
  const probes = opts.probes ?? DEFAULT_PROBES;
  const rokuFn = opts.identify ?? ((h: string) => rokuIdentify(h, SWEEP_TIMEOUT_MS));
  const found: FoundTv[] = [];
  let next = 0;

  const probeHost = async (host: string): Promise<FoundTv | null> => {
    for (const p of probes) {
      if (opts.signal?.aborted) return null;
      // Roku (and any future self-proving brand) identifies itself outright.
      const identify = p.brand === 'roku' ? rokuFn : p.identify;
      if (identify) {
        const info = await identify(host, SWEEP_TIMEOUT_MS);
        if (info) return { brand: p.brand, host, name: info.name, model: info.model };
        continue;
      }
      // Otherwise the brand is proven by its control port being open.
      if (p.port == null || !opts.tcpProbe) continue;
      const open = await opts.tcpProbe(host, p.port, SWEEP_TIMEOUT_MS);
      if (!open) continue;
      const name = p.nameLookup ? await p.nameLookup(host, SWEEP_TIMEOUT_MS) : null;
      return { brand: p.brand, host, name: name ?? `${p.fallbackName} (${host})`, model: p.fallbackName };
    }
    return null;
  };

  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = next++;
      if (i >= ips.length) return;
      const tv = await probeHost(ips[i]);
      if (tv && !opts.signal?.aborted) {
        found.push(tv);
        opts.onFound?.(tv);
      }
    }
  };
  const conc = Math.min(opts.conc ?? SWEEP_CONC, Math.max(ips.length, 1));
  await Promise.all(Array.from({ length: conc }, worker));
  return found;
}
