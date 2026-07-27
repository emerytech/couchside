/**
 * Pairing-link validation — lib/pairLink.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * Picked up by the CI `app-input` job's glob.
 *
 * WHAT THIS GUARDS. A pairing link is the one string from outside the app that
 * becomes a bearer-token destination: the app opens a WebSocket to that host,
 * polls it forever, and will upload a user-picked file to it. A QR sticker on a
 * public machine is therefore a one-tap exploit unless the accept surface is
 * enumerable. Every ACCEPT below is a real producer's real output; every REJECT
 * is an attack or a mistake we have a specific answer for.
 *
 * CONTROLS (CLAUDE.md §11.3) are in every table: each reject table also asserts
 * the nearest legitimate string is ACCEPTED, so a passing reject test can never
 * be a validator that refuses everything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEEPLINK_FORMS,
  SCAN_FORMS,
  buildPairLink,
  pairCollision,
  parsePairLink,
  type PairRejectReason,
} from '../pairLink.ts';

const PORT = 8787; // lib/settings.ts DEFAULT_PORT, passed in by the caller
const scan = (raw: string) => parsePairLink(raw, { forms: SCAN_FORMS, defaultPort: PORT });
const link = (raw: string) => parsePairLink(raw, { forms: DEEPLINK_FORMS, defaultPort: PORT });

const T = '9f3c1a7b2e5d8064af12cd39e7b04a6518d2c7f0aa1b3e94'; // 48 hex, install.sh shape

/**
 * VERBATIM fixture. Produced by executing the agent's own build_pair_url()
 * out of agent/couchsided.py (CLAUDE.md §6: fixtures copied from the real
 * thing, not retyped). Note the UPPERCASE in the hostname — it is what
 * socket.gethostname() actually returned on a real machine, and it is the
 * reason this validator checks case without folding it.
 */
const AGENT_QR =
  'https://couchside.tv/pair#host=MacBook-Pro-M2-4.local&port=8787' +
  `&token=${T}&ip=10.1.1.89`;

function ok(r: ReturnType<typeof scan>) {
  assert.equal(r.ok, true, `expected accept, got reject: ${!r.ok ? r.reason : ''}`);
  if (!r.ok) throw new Error('unreachable');
  return r.link;
}
function why(r: ReturnType<typeof scan>): PairRejectReason | 'ACCEPTED' {
  return r.ok ? 'ACCEPTED' : r.reason;
}

// ---------------------------------------------------------------- accepts ---

test('CONTROL: the agent QR, executed out of couchsided.py, is accepted whole', () => {
  const l = ok(scan(AGENT_QR));
  assert.equal(l.host, 'MacBook-Pro-M2-4.local'); // case preserved, not folded
  assert.equal(l.port, 8787);
  assert.equal(l.token, T);
  assert.equal(l.ip, '10.1.1.89');
});

test("CONTROL: the app's own SHOW QR output round-trips through the parser", () => {
  const built = buildPairLink({ host: 'bazzite.local', port: 8787, token: T, lastIp: '10.1.1.50' });
  assert.notEqual(built, null);
  const l = ok(scan(built as string));
  assert.deepEqual(l, { host: 'bazzite.local', port: 8787, token: T, ip: '10.1.1.50' });
});

test('a link with no ip= is accepted; ip is simply absent', () => {
  const l = ok(scan(`https://couchside.tv/pair#host=deck.local&port=8787&token=${T}`));
  assert.equal(l.ip, undefined);
});

test('port may be omitted and falls back to the port the CALLER supplied', () => {
  assert.equal(ok(scan(`https://couchside.tv/pair#host=deck.local&token=${T}`)).port, PORT);
});

test('a private IPv4 host is accepted (show-qr.sh users pass an IP)', () => {
  for (const h of ['10.1.1.89', '192.168.1.50', '172.16.0.2', '169.254.3.4', '100.64.0.9']) {
    assert.equal(why(scan(`https://couchside.tv/pair#host=${h}&token=${T}`)), 'ACCEPTED', h);
  }
});

test('a bare single label is accepted — agent/show-qr.sh emits one', () => {
  assert.equal(why(link(`couchside://setup?host=steamdeck&port=8787&token=${T}`)), 'ACCEPTED');
});

test('a token containing % survives (single-decode, the DeepLink rationale)', () => {
  const l = ok(scan('https://couchside.tv/pair#host=deck.local&token=abc%25def%25ghi'));
  assert.equal(l.token, 'abc%def%ghi');
});

test('unknown params are ignored, not fatal (forward compat with a newer agent)', () => {
  const l = ok(scan(`https://couchside.tv/pair#host=deck.local&token=${T}&futureCap=1`));
  assert.equal(l.host, 'deck.local');
});

test('a trailing slash on the path is accepted', () => {
  assert.equal(why(scan(`https://couchside.tv/pair/#host=deck.local&token=${T}`)), 'ACCEPTED');
});

// ------------------------------------------------------- form segregation ---

test('BOTH STATES: the scheme form is accepted by DeepLink and refused by the scanner', () => {
  const url = `couchside://setup?host=deck.local&port=8787&token=${T}`;
  assert.equal(why(link(url)), 'ACCEPTED'); // shipped deep-link path keeps working
  assert.equal(why(scan(url)), 'not-pair-link'); // a QR is never this form
});

test('scheme case is folded — Android hands the scheme back lowercased', () => {
  assert.equal(why(link(`COUCHSIDE://SETUP?host=deck.local&token=${T}`)), 'ACCEPTED');
});

// ---------------------------------------------------------------- rejects ---

test('ATTACK: origin lookalikes are all refused, and the real origin still passes', () => {
  const cases: [string, string][] = [
    ['suffix graft', `https://couchside.tv.evil.com/pair#host=deck.local&token=${T}`],
    ['userinfo spoof', `https://couchside.tv@evil.com/pair#host=deck.local&token=${T}`],
    ['backslash spoof', `https://couchside.tv\\@evil.com/pair#host=deck.local&token=${T}`],
    ['subdomain', `https://pair.couchside.tv/pair#host=deck.local&token=${T}`],
    ['www', `https://www.couchside.tv/pair#host=deck.local&token=${T}`],
    ['plaintext http', `http://couchside.tv/pair#host=deck.local&token=${T}`],
    ['origin in a query', `https://evil.com/pair?x=couchside.tv#host=deck.local&token=${T}`],
    ['wrong path', `https://couchside.tv/pairs#host=deck.local&token=${T}`],
    ['path traversal', `https://couchside.tv/pair/../x#host=deck.local&token=${T}`],
  ];
  for (const [label, url] of cases) {
    assert.equal(why(scan(url)), 'not-pair-link', label);
  }
  // CONTROL: the genuine article, otherwise "everything is refused" would pass.
  assert.equal(why(scan(AGENT_QR)), 'ACCEPTED', 'CONTROL genuine agent QR');
});

test('ATTACK: the host may not leave the LAN, and a LAN host still passes', () => {
  const cases: [string, string][] = [
    ['public IPv4', '1.2.3.4'],
    ['public name', 'box.evil.com'],
    ['loopback (no producer emits it)', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['v4-mapped v6 — public wearing a v6 costume', '::ffff:1.2.3.4'],
    ['v6 ULA (ws:// has no bracket handling)', 'fd00::1'],
    ['v6 link-local with zone', 'fe80::1%25en0'],
    ['integer form', '2130706433'],
    ['hex form', '0x7f.1'],
    ['host:port smuggled into host', 'deck.local:9999'],
    ['path smuggled into host', 'deck.local/evil'],
    ['userinfo smuggled into host', 'user@evil.com'],
    ['trailing-dot FQDN escape', 'evil.com.'],
    ['empty label', 'deck..local'],
    ['leading hyphen label', '-deck.local'],
  ];
  for (const [label, h] of cases) {
    const r = scan(`https://couchside.tv/pair#host=${encodeURIComponent(h)}&token=${T}`);
    assert.equal(why(r), 'bad-host', label);
  }
  // CONTROL: the shapes we DO allow, so this table cannot pass by refusing all.
  for (const h of ['deck.local', '10.1.1.89', 'steamdeck']) {
    assert.equal(why(scan(`https://couchside.tv/pair#host=${h}&token=${T}`)), 'ACCEPTED', h);
  }
});

test('ATTACK: a bare label that is an address in disguise is refused', () => {
  // MEASURED 2026-07-27 through plain getaddrinfo — no exotic parser needed:
  //   0x08080808 -> 8.8.8.8, 0xdeadbeef -> 222.173.190.239, 0X8 -> 0.0.0.8,
  //   134744072 -> 8.8.8.8. A "single label with no dot" allowlist would have
  //   walked each of these straight to a PUBLIC address with the bearer token.
  for (const h of ['0x08080808', '0xdeadbeef', '0X8', '0x', '134744072', '08', '1-2']) {
    assert.equal(why(link(`couchside://setup?host=${h}&token=${T}`)), 'bad-host', h);
  }
  // CONTROLS, same run: real labels resolve as NAMES or not at all — measured
  // "steamdeck" and "bazzite" do not getaddrinfo to an address. And a label
  // that merely CONTAINS hex chars is a name, not a number.
  for (const h of ['steamdeck', 'bazzite', 'deck0x1', 'b0x']) {
    assert.equal(why(link(`couchside://setup?host=${h}&token=${T}`)), 'ACCEPTED', h);
  }
});

test('ATTACK: leading-zero octets are refused — 010.0.0.1 is 8.0.0.1 to inet_aton', () => {
  // Measured on the BSD resolver family iOS shares: getaddrinfo reads
  // "010.0.0.1" as 10.0.0.1 (private) while inet_aton reads it as octal ->
  // 8.0.0.1 (PUBLIC). Same string, two destinations, so the form is refused
  // rather than reasoned about.
  for (const h of ['010.0.0.1', '0177.0.0.1', '192.0168.1.1', '010.010.010.010']) {
    assert.equal(why(scan(`https://couchside.tv/pair#host=${h}&token=${T}`)), 'bad-host', h);
  }
  // CONTROL: the same addresses without leading zeros are fine.
  assert.equal(why(scan(`https://couchside.tv/pair#host=10.0.0.1&token=${T}`)), 'ACCEPTED');
});

test('ATTACK: a malformed port is REJECTED, never silently defaulted', () => {
  for (const p of ['0', '65536', '99999', '8787x', '-1', '+80', '87 87', '0x1f', '', ' ']) {
    const r = scan(`https://couchside.tv/pair#host=deck.local&port=${encodeURIComponent(p)}&token=${T}`);
    // Only a literally EMPTY value means "absent" and falls back to the
    // caller's default. A whitespace-only port is malformed, not absent — we
    // reject rather than trim it into validity (CLAUDE.md §3.6). This
    // expectation was wrong on first write and the test caught it.
    const expected = p === '' ? 'ACCEPTED' : 'bad-port';
    assert.equal(why(r), expected, `port=${JSON.stringify(p)}`);
  }
  // CONTROL: a real non-default port is accepted and carried through.
  assert.equal(ok(scan(`https://couchside.tv/pair#host=deck.local&port=9001&token=${T}`)).port, 9001);
});

test('token shape: rejected when absent/short/whitespace/control, kept when merely unusual', () => {
  const bad: [string, PairRejectReason][] = [
    ['', 'missing-token'],
    ['short', 'bad-token'],
    ['has a space in it', 'bad-token'],
    ['tab\there1234', 'bad-token'],
    ['newline\n12345678', 'bad-token'],
    ['x'.repeat(257), 'bad-token'],
  ];
  for (const [tok, reason] of bad) {
    const r = scan(`https://couchside.tv/pair#host=deck.local&token=${encodeURIComponent(tok)}`);
    assert.equal(why(r), reason, JSON.stringify(tok.slice(0, 20)));
  }
  // CONTROL: NOT hex-only. `--token` accepts a literal and migrated
  // pre-Couchside tokens exist; tightening to /^[0-9a-f]{48}$/ would refuse
  // legitimately configured boxes, so these must pass.
  for (const tok of ['MyLiteralToken!', 'a'.repeat(8), 'rescue-remote-legacy-token-2024']) {
    assert.equal(why(scan(`https://couchside.tv/pair#host=deck.local&token=${tok}`)), 'ACCEPTED', tok);
  }
});

test('ATTACK: a repeated param is refused rather than resolved by last-wins', () => {
  const r = scan(`https://couchside.tv/pair#host=deck.local&token=${T}&token=evil12345`);
  assert.equal(why(r), 'duplicate-param');
  const r2 = scan(`https://couchside.tv/pair#host=deck.local&host=evil.com&token=${T}`);
  assert.equal(why(r2), 'duplicate-param');
  // CONTROL: one of each is fine.
  assert.equal(why(scan(AGENT_QR)), 'ACCEPTED');
});

test('__proto__ in the payload cannot pollute the parsed object', () => {
  const r = scan(`https://couchside.tv/pair#__proto__=polluted&host=deck.local&token=${T}`);
  assert.equal(why(r), 'ACCEPTED');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('a bad ip= is DROPPED, not fatal — it is only a fallback route', () => {
  for (const bad of ['8.8.8.8', 'notanip', '010.0.0.1', '999.1.1.1']) {
    const l = ok(scan(`https://couchside.tv/pair#host=deck.local&token=${T}&ip=${bad}`));
    assert.equal(l.ip, undefined, bad);
  }
  // CONTROL: a good one survives. addBox allows loopback for ip, so we do too.
  assert.equal(ok(scan(`https://couchside.tv/pair#host=deck.local&token=${T}&ip=127.0.0.1`)).ip, '127.0.0.1');
});

test('the OTHER QR on the box screen gets its own reason, not a generic one', () => {
  assert.equal(why(scan('https://couchside.tv/#get')), 'store-code');
});

test('BOTH STATES: real-world non-Couchside QRs are refused without throwing', () => {
  // The RN URL shim THROWS a TypeError on a string with '#' and no '://'
  // (Libraries/Blob/URL.js:88 does .includes on undefined) while Node's URL
  // parses it — which is exactly why this module never constructs a URL.
  // These must all return a reason, never raise.
  const junk: [string, PairRejectReason][] = [
    ['WIFI:S=home;T=WPA;P=hunter2;;', 'not-pair-link'],
    ['BEGIN:VCARD\nFN:Bob\nEND:VCARD', 'not-pair-link'],
    ['https://example.com/hello', 'not-pair-link'],
    ['javascript:alert(1)//#host=deck.local', 'not-pair-link'],
    ['data:text/html,<script>1</script>', 'not-pair-link'],
    ['deck.local:8787:sometoken', 'not-pair-link'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['x'.repeat(4096), 'too-long'],
  ];
  for (const [raw, reason] of junk) {
    assert.equal(why(scan(raw)), reason, JSON.stringify(raw.slice(0, 30)));
  }
  // CONTROL: the genuine QR in the same run.
  assert.equal(why(scan(AGENT_QR)), 'ACCEPTED');
});

test('a link missing host or token is named precisely, so the UI can explain', () => {
  assert.equal(why(scan(`https://couchside.tv/pair#token=${T}`)), 'missing-host');
  assert.equal(why(scan('https://couchside.tv/pair#host=deck.local')), 'missing-token');
  assert.equal(why(scan('https://couchside.tv/pair')), 'missing-host');
  assert.equal(why(scan('https://couchside.tv/pair#')), 'missing-host');
});

test('a rejection carries ONLY a reason — no field a bearer token could ride on', () => {
  // The Logs tab and any future error toast will render whatever a reject
  // carries; a token echoed there is a credential leak. Structural, not
  // value-based: the reject object must have exactly {ok, reason}.
  const r = scan(`https://couchside.tv/pair#host=evil.com&token=${T}`);
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r).sort(), ['ok', 'reason']);
  assert.equal(JSON.stringify(r).includes(T), false, 'token leaked into the reject');
});

// ------------------------------------------------------------- collisions ---

test('pairCollision: the token-change case is named, both other states observed', () => {
  const fleet = [{ host: 'bazzite.local', port: 8787, token: T, name: 'Living Room' }];
  // A hostile QR carrying a DIFFERENT token for a box the user already owns
  // would silently swap their working credential — this is the case the
  // scanner must confirm before addBox is allowed to overwrite.
  const swap = pairCollision(fleet, { host: 'bazzite.local', port: 8787, token: 'evil1234' });
  assert.deepEqual(swap, { kind: 'token-change', name: 'Living Room' });
  // CONTROL both directions: a re-scan of the same QR is not a collision...
  const same = pairCollision(fleet, { host: 'bazzite.local', port: 8787, token: T });
  assert.deepEqual(same, { kind: 'same-token', name: 'Living Room' });
  // ...and a different port is a different box, mirroring sameTarget exactly.
  assert.deepEqual(pairCollision(fleet, { host: 'bazzite.local', port: 9001, token: T }), { kind: 'new' });
  assert.deepEqual(pairCollision(fleet, { host: 'deck.local', port: 8787, token: T }), { kind: 'new' });
});

// ------------------------------------------------- writer/reader symmetry ---

test('SYMMETRY: buildPairLink refuses every box whose link the reader would refuse', () => {
  // The writer must be a subset of the reader (degrade closed): the app must
  // never render a QR that its own scanner rejects.
  const bad = [
    { host: 'evil.com', port: 8787, token: T }, // public name
    { host: '8.8.8.8', port: 8787, token: T }, // public IP
    { host: '0x08080808', port: 8787, token: T }, // address in disguise
    { host: '010.1.1.5', port: 8787, token: T }, // octal-ambiguous
    { host: 'deck.local', port: 0, token: T }, // bad port
    { host: 'deck.local', port: 8787, token: 'short' }, // bad token
    { host: '', port: 8787, token: T }, // no host
  ];
  for (const b of bad) {
    assert.equal(buildPairLink(b), null, JSON.stringify(b.host || b.port || b.token));
  }
  // CONTROL + round trip: every accepted build parses back to the same link,
  // and a lastIp the reader would drop is dropped by the writer too.
  const good = { host: 'bazzite.local', port: 9001, token: T, lastIp: '10.1.1.50' };
  const url = buildPairLink(good);
  assert.notEqual(url, null);
  const l = ok(scan(url as string));
  assert.deepEqual(l, { host: 'bazzite.local', port: 9001, token: T, ip: '10.1.1.50' });
  const publicIp = buildPairLink({ ...good, lastIp: '8.8.8.8' });
  assert.equal(ok(scan(publicIp as string)).ip, undefined, 'public lastIp must not be encoded');
});
