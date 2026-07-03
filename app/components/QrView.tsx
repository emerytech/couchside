import QRCode from 'qrcode';
import React, { useMemo } from 'react';
import { View } from 'react-native';

/**
 * Pure-View QR renderer.
 *
 * qrcode's toDataURL/toString renderers need a browser canvas or Node zlib —
 * neither exists in React Native, which is why the pairing modal rendered
 * blank on-device ("Could not render QR"). QRCode.create() is pure JS: it
 * returns the module bit-matrix, which we draw as rows of Views. Consecutive
 * dark modules in a row are merged into single segments, so a v5-ish pairing
 * QR is ~600 Views — fine for a static modal.
 *
 * Rendered black-on-white inside its own white quiet zone (QRs need both to
 * scan reliably).
 */
export function QrView({ value, size }: { value: string; size: number }) {
  const matrix = useMemo(() => {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const rows: { start: number; len: number }[][] = [];
      for (let r = 0; r < n; r++) {
        const runs: { start: number; len: number }[] = [];
        let c = 0;
        while (c < n) {
          if (qr.modules.get(r, c)) {
            const start = c;
            while (c < n && qr.modules.get(r, c)) c++;
            runs.push({ start, len: c - start });
          } else {
            c++;
          }
        }
        rows.push(runs);
      }
      return { n, rows };
    } catch {
      return null;
    }
  }, [value]);

  if (!matrix) return null;

  // Integer cell size avoids hairline gaps from sub-pixel rounding; the quiet
  // zone absorbs the remainder.
  const QUIET = 3; // modules of white border
  const cell = Math.max(1, Math.floor(size / (matrix.n + QUIET * 2)));
  const body = cell * matrix.n;
  const pad = Math.floor((size - body) / 2);

  return (
    <View
      style={{
        width: size,
        height: size,
        backgroundColor: '#ffffff',
        paddingTop: pad,
        paddingLeft: pad,
      }}>
      {matrix.rows.map((runs, r) => (
        <View key={r} style={{ flexDirection: 'row', height: cell, width: body }}>
          {runs.map((run, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                left: run.start * cell,
                width: run.len * cell,
                height: cell,
                backgroundColor: '#000000',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
