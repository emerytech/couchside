/**
 * Install-free host-selection policy for box requests (used by api.ts, which
 * cannot load in CI's strip-types glob because it imports react-native).
 *
 * raceIpFirst: the IP-first race behind every idempotent GET when a cached LAN
 * IP is known. ttlMemo: the throttle on attempt()'s secure-link diagnostics.
 *
 * WHY THE RACE CHANGED (2026-09-26, Razr / Android 16, Steam Machine): the LAN
 * gained an IPv6 ULA prefix and the box's mDNS name began resolving ONLY to IPv6
 * on the phone, while the agent listens on 0.0.0.0. The hostname path could
 * therefore never connect, yet the race started it on EVERY GET whose IP path had
 * not finished in 250 ms, including GETs whose IP probe had already proven the box
 * and were merely queued behind other requests on the one pinned socket. Each of
 * those hostname attempts was a refused connect plus diagnostics. Now, once the
 * IP has proven itself, the hostname joins only if the IP request itself fails.
 */

/**
 * Race a cached IP against the configured hostname, IP first.
 *
 *  - The IP path runs `probeIp` (an identity check that carries no token) and,
 *    only if it passes, `viaIp`.
 *  - The hostname path (`viaHost`) starts at `staggerMs` if the IP has NOT proven
 *    itself by then (probe failed or still pending). That is the old behaviour.
 *  - If the probe passed, the hostname path starts only if the IP path then
 *    fails. It also starts at once whenever the IP path fails before the stagger.
 *
 * Resolves with the first success. If both paths fail, rejects with the hostname
 * path's error (it matches what a single hostname attempt would have reported).
 * Safe only for idempotent requests: both paths may deliver.
 */
export function raceIpFirst<T>(o: {
  probeIp: () => Promise<boolean>;
  viaIp: () => Promise<T>;
  viaHost: () => Promise<T>;
  staggerMs: number;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let ipProven = false;
    let ipFailed = false;
    let hostStarted = false;
    let hostFailed = false;
    let hostErr: unknown = null;

    const win = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(stagger);
      resolve(v);
    };
    const maybeFail = () => {
      if (done || !ipFailed || !hostFailed) return;
      done = true;
      clearTimeout(stagger);
      reject(hostErr);
    };
    const startHost = () => {
      if (hostStarted || done) return;
      hostStarted = true;
      let p: Promise<T>;
      try {
        p = o.viaHost();
      } catch (e) {
        p = Promise.reject(e);
      }
      p.then(win, (e: unknown) => {
        hostFailed = true;
        hostErr = e;
        maybeFail();
      });
    };

    const stagger = setTimeout(() => {
      if (!ipProven) startHost();
    }, o.staggerMs);

    (async () => {
      let ok = false;
      try {
        ok = await o.probeIp();
      } catch {
        ok = false;
      }
      if (!ok) throw new Error('cached IP did not answer as this box');
      ipProven = true;
      return o.viaIp();
    })().then(win, () => {
      ipFailed = true;
      startHost();
      maybeFail();
    });
  });
}

/**
 * Memoize an async lookup per key for `ttlMs` after it settles, sharing the
 * in-flight promise meanwhile. A rejection is not cached. Used to cap attempt()'s
 * secure-link diagnostics at one per host per window, so a burst of failing
 * requests cannot become a burst of pings.
 */
export function ttlMemo<T>(
  ttlMs: number,
  now: () => number = () => Date.now(),
): (key: string, fn: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, { p: Promise<T>; exp: number }>();
  return (key, fn) => {
    const hit = cache.get(key);
    if (hit && now() < hit.exp) return hit.p;
    let p: Promise<T>;
    try {
      p = fn();
    } catch (e) {
      p = Promise.reject(e);
    }
    const entry = { p, exp: Number.POSITIVE_INFINITY }; // in flight: always shared
    cache.set(key, entry);
    p.then(
      () => {
        entry.exp = now() + ttlMs;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    return p;
  };
}
