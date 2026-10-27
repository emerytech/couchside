import assert from 'node:assert/strict';
import { canApplySteamTheme, steamThemeBox, type SteamThemesState } from '../lib/steamThemes.ts';
import { connFromBox } from '../lib/boxConn.ts';
const state: SteamThemesState = { settings: { version: 1, installed: true, enabled: true, theme: 'orbit', accent: 'blue', motion: false }, companion_ready: true, requires: 'companion', themes: [
  {id: 'orbit', name: 'Orbit', layout: 'carousel', description: 'Large covers'},
  {id: 'shelf', name: 'Shelf', layout: 'grid', description: 'Compact library'},
] };
assert.equal(canApplySteamTheme(state, 'orbit', '', false), true);
assert.equal(canApplySteamTheme(state, 'orbit', '  ORBIT ', false), true);
assert.equal(canApplySteamTheme(state, 'orbit', 'grid', false), false);
assert.equal(canApplySteamTheme(state, 'orbit', 'no results', false), false);
assert.equal(canApplySteamTheme(state, 'shelf', 'grid', false), true);
assert.equal(canApplySteamTheme({...state, companion_ready: false}, 'orbit', '', false), false);
assert.equal(canApplySteamTheme(state, 'orbit', '', true), false);
const first = {id:'active', host:'one.local', port:8787, token:'one'};
const second = {id:'other', host:'two.local', port:8787, token:'two', secure:true, tlsPort:8788, pinModulus:'test-pin'};
const boxes = [first, second];
assert.equal(steamThemeBox(boxes, first, 'other'), second);
assert.equal(steamThemeBox(boxes, first), first);
assert.equal(steamThemeBox(boxes, first, 'removed'), null);
assert.equal(steamThemeBox(boxes, first, ''), null);
assert.equal(connFromBox(steamThemeBox(boxes, first, 'other')!).pinModulus, 'test-pin');
assert.equal(connFromBox(second).tlsPort, 8788);
console.log('PASS: visible selection, search, busy/companion gates, explicit box targeting and TLS preservation');
