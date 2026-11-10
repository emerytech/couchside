import test from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_TYPES, SETUP_FEATURES, setupShareText, showcaseDraftUrl, FRIEND_MESSAGE } from '../setupSharing.ts';

test('setup messages include selected public choices, never fields from a saved box', () => {
  const features = [SETUP_FEATURES[1], SETUP_FEATURES[0], SETUP_FEATURES[1]];
  const text = setupShareText(SETUP_TYPES[0], features);
  assert.match(text, /Steam Machine \/ SteamOS/);
  assert.equal(text.match(/Air Mouse/g)?.length, 1);
  assert.ok(!text.includes('TV remote & inputs'));
  assert.ok(text.endsWith('https://couchside.tv/'));
  assert.throws(() => setupShareText('secret-host.local', features));
  assert.throws(() => setupShareText(SETUP_TYPES[0], ['token=private']));
  assert.throws(() => setupShareText(SETUP_TYPES[0], []));
});
test('showcase email is a reviewable composer with no publication or newsletter opt-in', () => {
  const summary = setupShareText(SETUP_TYPES[1], [SETUP_FEATURES[2]]);
  const url = new URL(showcaseDraftUrl(summary));
  assert.equal(url.protocol, 'mailto:');
  assert.equal(url.pathname, 'taylor@couchside.tv');
  assert.ok(url.searchParams.get('body')?.includes(summary));
  assert.match(url.searchParams.get('body')!, /contact me before publishing/);
  assert.match(url.searchParams.get('body')!, /does not subscribe me/);
  assert.ok(!FRIEND_MESSAGE.includes('ref='));
});
