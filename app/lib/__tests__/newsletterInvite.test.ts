import test from 'node:test';
import assert from 'node:assert/strict';
import { showNewsletterInvite, NEWSLETTER_URL } from '../newsletterInvite.ts';
test('invite waits for saved settings and a configured device, and respects dismissal', () => {
 assert.equal(showNewsletterInvite(true, true, false), true);
 assert.equal(showNewsletterInvite(false, true, false), false);
 assert.equal(showNewsletterInvite(true, false, false), false);
 assert.equal(showNewsletterInvite(true, true, true), false);
 assert.equal(NEWSLETTER_URL, 'https://couchside.tv/news/');
});
