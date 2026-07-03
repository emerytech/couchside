import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { DEFAULT_PORT } from './settings';
import { useBoxes } from './SettingsContext';

/**
 * Parse a URL's query string, decoding each value EXACTLY ONCE.
 *
 * Deliberately not expo-linking's Linking.parse: in expo-linking 57 that runs
 * decodeURIComponent on values URLSearchParams has already decoded — a double
 * decode that mangles (or, on an invalid %-escape, throws away) any param
 * value containing '%'. A hand-entered token with a '%' would silently fail to
 * pair. This single-decodes, tolerates a missing '=', strips a fragment, and
 * never throws (a bad escape falls back to the raw substring).
 */
function parseQuery(url: string): Record<string, string> {
  const qStart = url.indexOf('?');
  if (qStart < 0) return {};
  let qs = url.slice(qStart + 1);
  const hash = qs.indexOf('#');
  if (hash >= 0) qs = qs.slice(0, hash);
  const out: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawVal = eq < 0 ? '' : pair.slice(eq + 1);
    let key = rawKey;
    let val = rawVal;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      /* keep raw key */
    }
    try {
      val = decodeURIComponent(rawVal);
    } catch {
      /* keep raw value */
    }
    out[key] = val;
  }
  return out;
}

/**
 * Root-level pairing deep-link handler.
 *
 *   couchside://setup?host=<h>&port=<p>&token=<t>[&ip=<lan ip>]
 *
 * Rendered ABOVE the tabs so a pairing link is applied no matter which tab is
 * focused and whether the app cold-starts or is already running. Handling this
 * on the Setup screen was unreliable: a warm link that arrives while another
 * tab is focused never mounts Setup's effect, and `couchside://setup` parses
 * `setup` as the URL host (not a route), so the params don't always reach the
 * screen. Here we read `queryParams` straight off the URL, add/update the box
 * (addBox dedupes by host+port), and jump to Setup with `?paired=1` so it can
 * flash its confirmation banner.
 *
 * Uses Linking.addEventListener (fires on EVERY inbound URL, even an identical
 * re-scan) plus getInitialURL for the cold-start launch URL. A link that lands
 * before the persisted fleet finishes loading is stashed and flushed once
 * `ready` flips true.
 */
export function DeepLinkHandler() {
  const { addBox, ready } = useBoxes();
  const router = useRouter();

  const readyRef = useRef(ready);
  readyRef.current = ready;
  const pendingUrl = useRef<string | null>(null);

  const apply = useCallback(
    (url: string | null | undefined) => {
      if (!url) return;
      const q = parseQuery(url);
      const host = (q.host ?? '').trim();
      const token = q.token ?? '';
      // Only a link that carries BOTH host and token is a pairing link.
      if (!host || !token) return;

      // Arrived before the fleet loaded — apply it once ready (see effect below).
      if (!readyRef.current) {
        pendingUrl.current = url;
        return;
      }

      const portRaw = q.port ? parseInt(q.port, 10) : NaN;
      const port =
        Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : DEFAULT_PORT;
      const ip = q.ip || undefined;

      void addBox({ host, port, token, lastIp: ip });
      router.navigate('/setup');
    },
    [addBox, router],
  );

  useEffect(() => {
    let mounted = true;
    void Linking.getInitialURL().then((url) => {
      if (mounted) apply(url);
    });
    const sub = Linking.addEventListener('url', (e) => apply(e.url));
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [apply]);

  // Flush a link that arrived before the persisted fleet had loaded.
  useEffect(() => {
    if (ready && pendingUrl.current) {
      const url = pendingUrl.current;
      pendingUrl.current = null;
      apply(url);
    }
  }, [ready, apply]);

  return null;
}
