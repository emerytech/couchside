/**
 * PAIRING-time TLS pin derivation (TLS P5) — forge + fetch, NO native import, so
 * the pairing flow (lib/SettingsContext) can use it without pulling in
 * react-native-tcp-socket. The live-connect transport (boxTls / boxWs) is the
 * native side; this is the one-time derive that runs when a box is paired.
 *
 * Trust model (spec §2): the `fp` (DER-cert SHA-256) is delivered in the pairing
 * QR — the physical-presence anchor read off the box's own screen. We fetch the
 * cert over PLAINTEXT (convenient), prove its integrity by re-hashing to `fp`,
 * then derive the RSA modulus that the pinned transport compares against at every
 * connect. A pin is ENABLED only on a verified match; anything else -> plaintext.
 */
import forge from 'node-forge';

import { normalizeModulus } from './boxTlsCodec';

/** RSA modulus (normalized hex) of a PEM certificate, via node-forge. */
export function modulusFromPem(pem: string): string | null {
  try {
    const cert = forge.pki.certificateFromPem(pem);
    const key = cert.publicKey as forge.pki.rsa.PublicKey;
    if (!key?.n) return null;
    return normalizeModulus(key.n.toString(16));
  } catch {
    return null;
  }
}

/**
 * SHA-256 of a PEM certificate's DER encoding, lowercase hex — the SAME value the
 * agent advertises as `fp` (hashlib.sha256(DER).hexdigest()).
 */
export function certFpFromPem(pem: string): string | null {
  try {
    const cert = forge.pki.certificateFromPem(pem);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const md = forge.md.sha256.create();
    md.update(der);
    return md.digest().toHex();
  } catch {
    return null;
  }
}

export type TlsPin = { secure: true; tlsPort: number; fp: string; pinModulus: string };

/**
 * Given the box's advertised `tlsPort` + the `fp` from the QR, fetch the cert over
 * plaintext, verify SHA-256(DER)==fp, and derive the modulus to pin. Returns null
 * on ANY failure — unreachable/missing cert, or an fp MISMATCH (tamper/MITM) — so
 * the caller stores the box WITHOUT `secure` and stays on plaintext (no regression
 * from today). The pin is only ever enabled on a verified fp match.
 */
export async function resolveTlsPin(
  host: string,
  port: number,
  tlsPort: number,
  fp: string,
  timeoutMs = 8000,
): Promise<TlsPin | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`http://${host}:${port}/api/tls/cert`, { signal: ctrl.signal, cache: 'no-store' });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const j = (await res.json()) as { cert?: unknown };
    const pem = typeof j?.cert === 'string' ? j.cert : '';
    if (!pem) return null;
    const gotFp = certFpFromPem(pem);
    const want = fp.trim().toLowerCase();
    if (!gotFp || gotFp !== want) return null; // integrity fail -> do NOT pin
    const pinModulus = modulusFromPem(pem);
    if (!pinModulus) return null;
    return { secure: true, tlsPort, fp: want, pinModulus };
  } catch {
    return null;
  }
}
