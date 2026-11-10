import test from 'node:test';
import assert from 'node:assert/strict';
import { STORY_ANSWER_LIMIT, setupShareText, showcaseDraftUrl } from '../setupSharing.ts';

test('sharing includes only explicit answers and omits blank questions', () => {
  const text = setupShareText({ favorite: ' Air Mouse ', mostUsed: 'Playing from the couch', future: '' });
  assert.match(text, /favorite part of Couchside\?\nAir Mouse/);
  assert.match(text, /Playing from the couch/);
  assert.ok(!text.includes('in the future'));
  assert.ok(text.endsWith('https://couchside.tv/'));
  const withBox = { favorite: '', mostUsed: '', future: 'More game presets', token: 'secret', host: 'private.local' };
  assert.ok(!setupShareText(withBox).includes('secret'));
  assert.ok(!setupShareText(withBox).includes('private.local'));
  assert.throws(() => setupShareText({ favorite: ' ', mostUsed: '', future: '' }));
  assert.throws(() => setupShareText({ favorite: 'a'.repeat(STORY_ANSWER_LIMIT + 1), mostUsed: '', future: '' }));
});
test('email safely encodes answer punctuation without adding recipients or opting in', () => {
  const summary = setupShareText({ favorite: 'Air Mouse & TV? #1', mostUsed: '', future: 'More layouts' });
  const url = new URL(showcaseDraftUrl(summary));
  assert.equal(url.protocol, 'mailto:');
  assert.equal(url.pathname, 'taylor@couchside.tv');
  assert.ok(url.searchParams.get('body')?.includes(summary));
  assert.equal(url.searchParams.size, 2);
  assert.match(url.searchParams.get('body')!, /contact me before publishing/);
  assert.match(url.searchParams.get('body')!, /does not subscribe me/);
});
