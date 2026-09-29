/**
 * Pure-logic checks for the Android home-screen widget's snapshot builder.
 * The widget shows exactly what this produces, so this IS the widget's logic
 * test (the render is device-only).
 *
 *   node --experimental-strip-types app/__tests__/widget-payload.ts
 *
 * RN-free module; the two data types are type-only, erased at runtime.
 */
import {
  buildWidgetPayload,
  formatCents,
  pickBestDrop,
  pickTonight,
} from '../lib/widget/widgetPayload.ts';

let bad = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  if (!ok) bad++;
}

const reco = (primary: unknown, available = true) =>
  ({ available, generated: 1, primary, alternates: [], counts: {} }) as any;
const alert = (o: Record<string, unknown>) =>
  ({ appid: '1', name: 'X', discount_percent: 0, final: 0, original: 0, currency: 'USD', ...o }) as any;
const alerts = (list: unknown[], o: Record<string, unknown> = {}) =>
  ({ configured: true, connected: true, alerts: list, ...o }) as any;

console.log('pickTonight');
eq('primary present -> title+reason',
  pickTonight(reco({ appid: '10', name: 'Hades', hours: 40, reason: 'A favourite you haven’t touched in a while' })),
  { title: 'Hades', subtitle: 'A favourite you haven’t touched in a while' });
eq('no reason -> hours fallback',
  pickTonight(reco({ appid: '10', name: 'Hades', hours: 12, reason: '' })),
  { title: 'Hades', subtitle: '12h played' });
eq('no reason, no hours -> ready',
  pickTonight(reco({ appid: '10', name: 'Hades', hours: 0, reason: '' })),
  { title: 'Hades', subtitle: 'Ready to play' });
// CONTROLS — both directions: not-available and null-primary must yield null.
eq('not available -> null', pickTonight(reco({ appid: '1', name: 'X', hours: 1 }, false)), null);
eq('null primary -> null', pickTonight(reco(null)), null);
eq('null reco -> null', pickTonight(null), null);
eq('blank name -> null', pickTonight(reco({ appid: '1', name: '   ', hours: 1 })), null);

console.log('formatCents');
eq('USD gets a $', formatCents(1249, 'USD'), '$12.49');
eq('non-USD keeps its code', formatCents(1000, 'EUR'), '10.00 EUR');
eq('zero', formatCents(0, 'USD'), '$0.00');

console.log('pickBestDrop — picks biggest % off, ties by lower price');
eq('biggest percent wins',
  pickBestDrop(alerts([
    alert({ name: 'A', discount_percent: 25, final: 1500 }),
    alert({ name: 'B', discount_percent: 60, final: 800, at_low: true }),
    alert({ name: 'C', discount_percent: 40, final: 500 }),
  ])),
  { title: 'B', priceLine: '$8.00', pct: 60, atLow: true });
eq('tie on percent -> lower final wins',
  pickBestDrop(alerts([
    alert({ name: 'A', discount_percent: 50, final: 2000 }),
    alert({ name: 'B', discount_percent: 50, final: 999 }),
  ])),
  { title: 'B', priceLine: '$9.99', pct: 50, atLow: false });
// CONTROLS — every degrade path is null (never a bogus deal line).
eq('empty list -> null', pickBestDrop(alerts([])), null);
eq('not configured -> null', pickBestDrop(alerts([alert({ discount_percent: 90 })], { configured: false })), null);
eq('not connected -> null', pickBestDrop(alerts([alert({ discount_percent: 90 })], { connected: false })), null);
eq('null -> null', pickBestDrop(null), null);

console.log('buildWidgetPayload');
eq('both present',
  buildWidgetPayload(
    reco({ appid: '10', name: 'Hades', hours: 40, reason: 'Pick up where you left off' }),
    alerts([alert({ name: 'B', discount_percent: 60, final: 800 })]),
    1717000000000),
  { tonight: { title: 'Hades', subtitle: 'Pick up where you left off' },
    deal: { title: 'B', priceLine: '$8.00', pct: 60, atLow: false },
    updatedAt: 1717000000000, empty: false });
eq('nothing -> empty:true',
  buildWidgetPayload(null, null, 42),
  { tonight: null, deal: null, updatedAt: 42, empty: true });
eq('only tonight -> not empty',
  buildWidgetPayload(reco({ appid: '1', name: 'X', hours: 5, reason: '' }), null, 7).empty,
  false);

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
