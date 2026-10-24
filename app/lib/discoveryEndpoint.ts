import { isValidLanIp } from './lanIp.ts';
import type { FoundBox } from './boxDiscovery.ts';

/** UDP reply addresses can belong to a router/relay. The advertised address is
 * only a hint: validate a private literal and confirm agent identity over HTTP
 * before returning an endpoint. No credentials are sent by this probe. */
export async function verifyDiscoveryEndpoint(
  advert: Record<string, unknown>, source: string, defaultPort: number,
  probe: (ip: string, port: number) => Promise<FoundBox | null>,
): Promise<FoundBox | null> {
  if (advert.couchside !== true) return null;
  const port = advert.port === undefined ? defaultPort : advert.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const name = typeof advert.name === 'string' ? advert.name.toLowerCase() : '';
  if (!name) return null;
  const candidates = [advert.ip, source].filter((ip): ip is string =>
    typeof ip === 'string' && isValidLanIp(ip));
  for (const ip of new Set(candidates)) {
    let box: FoundBox | null;
    try { box = await probe(ip, port); } catch { continue; }
    if (!box || box.name.toLowerCase() !== name) continue;
    if (typeof advert.version === 'string' && advert.version !== box.version) continue;
    if (advert.tls_fp !== undefined && (typeof advert.tls_fp !== 'string' ||
        advert.tls_fp.toLowerCase() !== box.fp)) continue;
    return box;
  }
  return null;
}
