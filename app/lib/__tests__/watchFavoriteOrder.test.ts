import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFavorites, orderFavoriteServices } from '../watchFavoriteOrder.ts';

test('favorites are bounded unique service identifiers', () => {
  assert.deepEqual(normalizeFavorites(['youtube', 'youtube', null, {}, 'https://bad', '../bad', 'netflix']), ['youtube', 'netflix']);
  assert.deepEqual(normalizeFavorites({}), []);
  assert.equal(normalizeFavorites(Array.from({length: 100}, (_, i) => `app${i}`)).length, 32);
});
test('favorite-first order is stable and cannot expose unavailable services', () => {
  assert.deepEqual(orderFavoriteServices(['netflix', 'youtube', 'hulu', 'plex'], ['plex', 'youtube', 'unknown']), ['youtube', 'plex', 'netflix', 'hulu']);
  assert.deepEqual(orderFavoriteServices([], ['netflix']), []);
});
