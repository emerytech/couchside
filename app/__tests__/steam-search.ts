/**
 * Parser checks for the keyless Steam store search (Discover). Shape is verified
 * against a VERBATIM captured response (fixtures/storesearch-halflife.json), so
 * the real API is exercised, not a stub (the ITAD lesson, CLAUDE.md §11.4). The
 * discount-derivation branch — which the captured response didn't contain — is
 * covered by a controlled input whose answer is known (§11.3).
 *
 *   node --experimental-strip-types app/__tests__/steam-search.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseStoreSearch, searchPriceLabel } from '../lib/steamSearchParse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(join(here, 'fixtures/storesearch-halflife.json'), 'utf8'));

let bad = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  if (!ok) bad++;
}

console.log('parseStoreSearch — against the VERBATIM captured response');
const items = parseStoreSearch(real);
eq('parses all 10 app rows', items.length, 10);
eq('first row: appid is a string, name intact',
  { appid: items[0].appid, name: items[0].name }, { appid: '220', name: 'Half-Life 2' });
eq('priced row -> cents', items[0].priceFinal, 999);
// A real row with no price block (Half-Life 2: Update, appid 290930) -> null, not 0.
const update = items.find((i) => i.appid === '290930');
eq('no-price row -> priceFinal null', update ? update.priceFinal : 'missing', null);
eq('no-price row -> discountPct 0', update ? update.discountPct : 'missing', 0);
eq('a real appid is numeric-string', /^[0-9]+$/.test(items[0].appid), true);

console.log('parseStoreSearch — controls');
// type filter: a non-app entry is dropped.
eq('drops non-app types',
  parseStoreSearch({ items: [{ type: 'bundle', name: 'B', id: 5 }, { type: 'app', name: 'A', id: 6 }] }).map((i) => i.appid),
  ['6']);
// discount derived from initial/final when discount_percent is absent.
eq('derives discount from initial/final',
  parseStoreSearch({ items: [{ type: 'app', name: 'S', id: 9, price: { currency: 'USD', initial: 2000, final: 1000 } }] })[0],
  { appid: '9', name: 'S', priceFinal: 1000, priceInitial: 2000, discountPct: 50, tinyImage: null });
// explicit discount_percent wins.
eq('uses explicit discount_percent',
  parseStoreSearch({ items: [{ type: 'app', name: 'S', id: 9, price: { initial: 2000, final: 1500, discount_percent: 25 } }] })[0].discountPct,
  25);
// degrade: garbage / missing -> [].
eq('null -> []', parseStoreSearch(null), []);
eq('no items -> []', parseStoreSearch({}), []);
eq('drops nameless / non-numeric id',
  parseStoreSearch({ items: [{ type: 'app', name: '', id: 1 }, { type: 'app', name: 'X', id: 'nope' }] }), []);

console.log('searchPriceLabel');
eq('cents -> $', searchPriceLabel({ appid: '1', name: 'x', priceFinal: 1999, priceInitial: 1999, discountPct: 0, tinyImage: null }), '$19.99');
eq('zero -> Free', searchPriceLabel({ appid: '1', name: 'x', priceFinal: 0, priceInitial: 0, discountPct: 0, tinyImage: null }), 'Free');
eq('null -> empty', searchPriceLabel({ appid: '1', name: 'x', priceFinal: null, priceInitial: null, discountPct: 0, tinyImage: null }), '');

console.log(bad ? `\n${bad} FAILED` : '\nall good');
process.exit(bad ? 1 : 0);
