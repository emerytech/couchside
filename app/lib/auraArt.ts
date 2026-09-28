/**
 * Game Aura — fetch a game's cover, decode it, and sample it to a strip palette.
 *
 * This is the IMPURE glue that lib/auraPalette (pure) deliberately stays out of:
 * it fetches the cover BYTES from the box (never a CDN — see api.steamCoverBytes),
 * decodes them to RGBA, and hands the pixels to samplePalette(). Because it
 * touches the DOM/RN it is NOT in the install-free test glob; the sampling maths
 * it depends on is unit-tested in lib/__tests__/auraPalette.test.ts.
 *
 * DECODE: on web (and the web harness) an offscreen <canvas> decodes any format
 * the browser reads. On native there is no built-in pixel decoder, so this
 * resolves null and the caller degrades to "couldn't sample" — the button simply
 * reports it rather than doing anything unsafe. (A native decoder is a follow-up;
 * the endpoint + sampler are the load-bearing pieces and are exercised here.)
 *
 * SAFETY: the only thing that ever leaves this module is an N-length array of
 * `{r,g,b}` — colour DATA — posted to /api/leds/aura, where the agent re-validates
 * every channel and looks the strip up in its live set (CLAUDE.md §3). Nothing
 * derived from the image can become a path, an attribute, or a command.
 */
import { Platform } from 'react-native';

import { steamCoverBytes, type ConnSettings, type Rgb } from './api';
import { samplePalette, type SampleOpts } from './auraPalette';

/** Load image bytes into an <img> via a temporary object URL (web only). */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

/**
 * Decode image bytes to a flat RGBA buffer + dimensions, or null when this
 * platform can't decode (native) or the decode fails. Web/harness only.
 */
async function decodeToRgba(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number } | null> {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || typeof URL === 'undefined') {
    return null;
  }
  let url: string | null = null;
  try {
    // A fresh ArrayBuffer copy so the Blob owns bytes independent of the caller.
    const buf = bytes.slice().buffer;
    const blob = new Blob([buf], { type: contentType || 'image/jpeg' });
    url = URL.createObjectURL(blob);
    const img = await loadImage(url);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    return { rgba: data, width, height };
  } catch {
    return null;
  } finally {
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Default sampling for a game cover: the centre band, with a light saturation
 *  lift so a muted cover still reads as colour on the strip. */
const AURA_DEFAULTS: SampleOpts = { band: 0.6, satLift: 0.25 };

/**
 * Sample the running game's cover into exactly `ledCount` colours, ready to POST
 * to /api/leds/aura. Resolves null when the cover can't be fetched or decoded on
 * this platform (the caller degrades gracefully). `ledCount` MUST be the strip's
 * real member count — the agent rejects a frame of any other length.
 */
export async function sampleGameAura(
  settings: ConnSettings,
  appid: number,
  ledCount: number,
  opts: SampleOpts = {},
): Promise<Rgb[] | null> {
  if (!Number.isFinite(appid) || !(ledCount > 0)) return null;
  const cover = await steamCoverBytes(settings, appid);
  if (!cover) return null;
  const dec = await decodeToRgba(cover.bytes, cover.contentType);
  if (!dec) return null;
  const palette = samplePalette(dec.rgba, dec.width, dec.height, ledCount, {
    ...AURA_DEFAULTS,
    ...opts,
  });
  // The sampler returns exactly ledCount for a valid image; guard anyway so a
  // wrong-length frame is never posted (the agent would 400 it regardless).
  return palette.length === Math.floor(ledCount) ? palette : null;
}
