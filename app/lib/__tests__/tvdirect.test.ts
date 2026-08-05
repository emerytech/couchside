/**
 * Remote-only mode's direct-to-TV path — lib/tvdirect/{model,roku}.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 *
 * WHY THIS FILE EXISTS. In remote-only mode there is no agent between the phone
 * and the TV, so two things that were previously the box's problem become the
 * app's:
 *
 *  1. THE KEY TABLES ARE NOW DUPLICATED. lib/tvdirect/roku.ts carries a copy of
 *     the agent's _ROKU_KEYS / _ROKU_OP_KEY (agent/couchsided.py:8752, :8759)
 *     because there is no agent to ask. A copy drifts silently, so the tables
 *     are pinned here against the values read out of the agent — if someone
 *     "fixes" the pause->Play collision on one side only, this fails.
 *  2. THE HOST IS NOW A COMMAND DESTINATION CHOSEN IN THE APP. The agent used
 *     to be the only thing that opened sockets. isValidTvHost is the gate, and
 *     it is tested in both directions (a private IP accepted, a public one and
 *     the KI-033 octal form refused) rather than as an all-rejects list.
 *
 * The Roku client is driven against a REAL loopback HTTP server that records
 * what it received, so "the key was sent" and "the right path was requested"
 * are separate observations, and a 403 branch is proven to produce the hint
 * rather than a generic failure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DIRECT_BRANDS,
  isValidTvHost,
  nextTvId,
  normalizeTv,
  normalizeTvState,
} from '../tvdirect/model.ts';
import {
  ROKU_KEYS,
  ROKU_OP_KEY,
  ROKU_PORT,
  rokuIdentify,
  rokuKey,
  rokuOp,
  rokuText,
} from '../tvdirect/roku.ts';
import { sweepCandidates, sweepForRokus } from '../tvdirect/scan.ts';

// ---------------------------------------------------------------- key tables

test('the Roku key table matches the agent VERBATIM (drift guard)', () => {
  // Copied from agent/couchsided.py:8759 _ROKU_KEYS. The collisions are real
  // and deliberate: Roku's Play toggles (no distinct pause/stop) and it has no
  // menu key (Info is the "*" options key).
  assert.deepEqual(ROKU_KEYS, {
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    ok: 'Select',
    menu: 'Info',
    home: 'Home',
    back: 'Back',
    exit: 'Home',
    info: 'Info',
    play: 'Play',
    pause: 'Play',
    stop: 'Play',
    rewind: 'Rev',
    fast_forward: 'Fwd',
  });
});

test('the Roku op table matches the agent VERBATIM (drift guard)', () => {
  // agent/couchsided.py:8752 _ROKU_OP_KEY. power_on is an ECP keypress, NOT
  // Wake-on-LAN: a Roku stays reachable in standby. If this ever becomes a WoL
  // packet the app has no relay box to send it through on iOS.
  assert.deepEqual(ROKU_OP_KEY, {
    power_off: 'PowerOff',
    power_on: 'PowerOn',
    volume_up: 'VolumeUp',
    volume_down: 'VolumeDown',
    mute: 'VolumeMute',
  });
  assert.equal(ROKU_PORT, 8060);
});

// ------------------------------------------------------------------ the gate

test('a TV host must be a LAN IP literal — both directions', () => {
  // Accepted: real private addresses (the control that stops this passing by
  // rejecting everything).
  assert.equal(isValidTvHost('192.168.1.24'), true);
  assert.equal(isValidTvHost('10.1.1.60'), true);
  // Refused: public, the KI-033 octal smuggle (010.1.1.5 resolves to 8.1.1.5),
  // hostnames (what a name resolves to is up to whoever answers DNS), and junk.
  assert.equal(isValidTvHost('8.8.8.8'), false);
  assert.equal(isValidTvHost('010.1.1.5'), false);
  assert.equal(isValidTvHost('roku.local'), false);
  assert.equal(isValidTvHost('my-tv'), false);
  assert.equal(isValidTvHost(''), false);
  assert.equal(isValidTvHost(undefined), false);
});

test('only implemented brands are offered', () => {
  // If a brand is added to DIRECT_BRANDS without a transport, the setup card
  // will offer a TV it cannot drive. Change this list only alongside a client.
  // 'androidtv' joined when the Google TV client landed (atvproto/androidtv +
  // the native TLS adapter), proven against real hardware before being listed.
  assert.deepEqual([...DIRECT_BRANDS], ['roku', 'androidtv']);
});

// ------------------------------------------------------------ the TV store's
// validation (pure half; the persistence half needs SecureStore and is not
// loadable here — noted in the PR body rather than faked)

test('an entry with an unusable host is DROPPED, not repaired', () => {
  assert.equal(normalizeTv({ id: 'tv-0', brand: 'roku', host: '8.8.8.8' }), null);
  assert.equal(normalizeTv({ id: 'tv-0', brand: 'lg', host: '10.0.0.5' }), null);
  assert.equal(normalizeTv({ id: '', brand: 'roku', host: '10.0.0.5' }), null);
  // CONTROL: the same shape with a good host survives, so this is not passing
  // by dropping everything.
  assert.deepEqual(normalizeTv({ id: 'tv-0', brand: 'roku', host: '10.0.0.5' }), {
    id: 'tv-0',
    name: '10.0.0.5', // no name given -> host, never blank
    brand: 'roku',
    host: '10.0.0.5',
  });
});

test('a blob keeps only trustworthy entries and never leaves a dangling active id', () => {
  const state = normalizeTvState({
    tvs: [
      { id: 'tv-0', name: 'Living room', brand: 'roku', host: '10.0.0.5' },
      { id: 'tv-1', name: 'Evil', brand: 'roku', host: '203.0.113.9' }, // public: dropped
      { id: 'tv-2', name: 'Dupe', brand: 'roku', host: '10.0.0.5' }, // same TV: dropped
    ],
    activeTvId: 'tv-1', // points at the dropped one
  });
  assert.equal(state.tvs.length, 1);
  assert.equal(state.tvs[0].id, 'tv-0');
  // Falls back to the surviving TV rather than null — a remote with TVs and
  // none selected is a dead end.
  assert.equal(state.activeTvId, 'tv-0');
  // Garbage in, empty out; never a throw.
  assert.deepEqual(normalizeTvState(null), { tvs: [], activeTvId: null });
  assert.deepEqual(normalizeTvState('nope'), { tvs: [], activeTvId: null });
});

test('ids do not collide with persisted ones', () => {
  assert.equal(nextTvId([]), 'tv-0');
  assert.equal(nextTvId([{ id: 'tv-0', name: 'a', brand: 'roku', host: '10.0.0.5' }]), 'tv-1');
  // A gap must not produce a reused id.
  assert.equal(nextTvId([{ id: 'tv-4', name: 'a', brand: 'roku', host: '10.0.0.5' }]), 'tv-5');
});

// ------------------------------------------------------- the client, against
// a real server (the port is not 8060, so these drive an explicit host:port —
// see the note on rokuAt below)

type Hit = { method: string; url: string };

/** Start a stub ECP server. `status` decides what every keypress answers. */
async function stubRoku(opts: { status?: number; deviceInfo?: string | null } = {}) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' });
    if (req.url === '/query/device-info') {
      if (opts.deviceInfo === null) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(
        opts.deviceInfo ??
          '<device-info><udn>abc-123</udn><model-name>Roku TV</model-name><user-device-name>Living Room TV</user-device-name></device-info>',
      );
      return;
    }
    res.writeHead(opts.status ?? 200).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    /** Host string the client will use — see rokuAt. */
    host: `127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * The client builds `http://<host>:8060`; the stub is on an ephemeral port. So
 * these tests pass "127.0.0.1:PORT" as the host, which produces a URL with a
 * trailing ":8060" — Node's fetch rejects that, which is exactly what we do NOT
 * want to test. Instead the host carries the port and the client's own port is
 * neutralised by pointing at a path-preserving proxy... which would be more
 * machinery than the thing under test.
 *
 * Simplest honest approach: temporarily bind the stub's behaviour behind a
 * fetch shim that rewrites ONLY the port, so every other part of the request
 * (method, path, empty body, abort) is the real client's work.
 */
function withPortRewrite<T>(realHostPort: string, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.port, String(ROKU_PORT), 'client must target the ECP port');
    const [h, p] = realHostPort.split(':');
    url.hostname = h;
    url.port = p;
    return original(url.toString(), init);
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test('a key press becomes exactly one ECP POST at the mapped path', async () => {
  const s = await stubRoku();
  try {
    const r = await withPortRewrite(s.host, () => rokuKey('10.0.0.5', 'ok'));
    assert.equal(r.ok, true);
    assert.deepEqual(s.hits, [{ method: 'POST', url: '/keypress/Select' }]);
  } finally {
    await s.close();
  }
});

test('an op press uses the op table, not the key table', async () => {
  const s = await stubRoku();
  try {
    const r = await withPortRewrite(s.host, () => rokuOp('10.0.0.5', 'power_on'));
    assert.equal(r.ok, true);
    assert.deepEqual(s.hits, [{ method: 'POST', url: '/keypress/PowerOn' }]);
  } finally {
    await s.close();
  }
});

test('403 produces the actionable hint, other failures do not', async () => {
  const denied = await stubRoku({ status: 403 });
  try {
    const r = await withPortRewrite(denied.host, () => rokuKey('10.0.0.5', 'home'));
    assert.equal(r.ok, false);
    assert.equal(r.hint, 'roku_control_disabled');
  } finally {
    await denied.close();
  }
  // CONTROL, the other direction: a 500 is a failure with NO hint, so the
  // "Control by mobile apps" alert cannot fire for an unrelated fault.
  const broken = await stubRoku({ status: 500 });
  try {
    const r = await withPortRewrite(broken.host, () => rokuKey('10.0.0.5', 'home'));
    assert.equal(r.ok, false);
    assert.equal(r.hint, undefined);
  } finally {
    await broken.close();
  }
});

test('an unreachable TV fails closed instead of throwing into a press handler', async () => {
  // Nothing is listening: the press must resolve to a failed result. A rejected
  // promise here would be an unhandled rejection on every tap.
  const r = await rokuKey('10.255.255.1', 'up');
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
});

test('text is sent one percent-encoded character at a time and stops at the first failure', async () => {
  const s = await stubRoku();
  try {
    const r = await withPortRewrite(s.host, () => rokuText('10.0.0.5', 'a b&c'));
    assert.equal(r.ok, true);
    assert.deepEqual(
      s.hits.map((h) => h.url),
      ['/keypress/Lit_a', '/keypress/Lit_%20', '/keypress/Lit_b', '/keypress/Lit_%26', '/keypress/Lit_c'],
    );
    // Nothing in the text can escape its path segment: a '/' or '?' would
    // otherwise re-target the request.
    s.hits.length = 0;
    await withPortRewrite(s.host, () => rokuText('10.0.0.5', '/?'));
    assert.deepEqual(
      s.hits.map((h) => h.url),
      ['/keypress/Lit_%2F', '/keypress/Lit_%3F'],
    );
  } finally {
    await s.close();
  }
  // A refusing TV stops the string rather than typing half of it blindly.
  const denied = await stubRoku({ status: 403 });
  try {
    const r = await withPortRewrite(denied.host, () => rokuText('10.0.0.5', 'abc'));
    assert.equal(r.ok, false);
    assert.equal(denied.hits.length, 1, 'stopped after the first refusal');
  } finally {
    await denied.close();
  }
});

test('identify accepts a Roku and refuses anything else', async () => {
  const s = await stubRoku();
  try {
    const info = await withPortRewrite(s.host, () => rokuIdentify('10.0.0.5'));
    assert.equal(info?.name, 'Living Room TV');
    assert.equal(info?.model, 'Roku TV');
  } finally {
    await s.close();
  }
  // Something else answering on 8060 with a 200 but no Roku fields is NOT a
  // Roku — otherwise the setup card would add a device that never responds.
  const impostor = await stubRoku({ deviceInfo: '<html>hello</html>' });
  try {
    assert.equal(await withPortRewrite(impostor.host, () => rokuIdentify('10.0.0.5')), null);
  } finally {
    await impostor.close();
  }
  // And a 404 is not a Roku either.
  const missing = await stubRoku({ deviceInfo: null });
  try {
    assert.equal(await withPortRewrite(missing.host, () => rokuIdentify('10.0.0.5')), null);
  } finally {
    await missing.close();
  }
});

// ---------------------------------------------------------------- the sweep

test('sweep candidates cover the /24, excluding the phone and network/broadcast', () => {
  const ips = sweepCandidates('10.1.1.60');
  assert.equal(ips.length, 253); // 254 hosts minus the phone itself
  assert.ok(!ips.includes('10.1.1.60'), 'never probes the phone');
  assert.ok(!ips.includes('10.1.1.0') && !ips.includes('10.1.1.255'));
  assert.ok(ips.every((ip) => ip.startsWith('10.1.1.')));
  assert.ok(ips.includes('10.1.1.1') && ips.includes('10.1.1.254'));
});

test('no usable LAN address means NO sweep — same gate as TV hosts', () => {
  // A phone on cellular/VPN must not spray 254 requests at a public /24.
  assert.deepEqual(sweepCandidates(undefined), []);
  assert.deepEqual(sweepCandidates('8.8.8.8'), []);
  assert.deepEqual(sweepCandidates('010.1.1.5'), []); // KI-033 octal form
  // CONTROL: a real LAN address does sweep (not passing by refusing all).
  assert.ok(sweepCandidates('192.168.1.7').length === 253);
});

test('the sweep returns exactly the hosts that identified as Rokus', async () => {
  const probed: string[] = [];
  const found = await sweepForRokus(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'], {
    identify: async (h) => {
      probed.push(h);
      // .2 is a Roku; .3 answers as something-else (identify returns null);
      // .1/.4 are dead (null). Only .2 may appear.
      return h === '10.0.0.2' ? { name: 'Bedroom Roku', model: 'Roku TV' } : null;
    },
  });
  assert.deepEqual(found, [
    { brand: 'roku', host: '10.0.0.2', name: 'Bedroom Roku', model: 'Roku TV' },
  ]);
  assert.equal(probed.length, 4, 'every candidate was probed');
});

test('onFound streams results and abort stops the workers', async () => {
  const streamed: string[] = [];
  const found = await sweepForRokus(['a', 'b'], {
    identify: async () => ({ name: 'TV', model: 'M' }),
    onFound: (tv) => streamed.push(tv.host),
  });
  assert.equal(found.length, 2);
  assert.deepEqual(streamed.sort(), ['a', 'b']); // reported as they landed
  // Aborted before start: no probes at all (the empty-result CONTROL for the
  // signal path — a sweep that ignores its signal would still probe).
  let probes = 0;
  const aborted = await sweepForRokus(['a', 'b', 'c'], {
    signal: { aborted: true },
    identify: async () => {
      probes++;
      return { name: 'TV', model: 'M' };
    },
  });
  assert.deepEqual(aborted, []);
  assert.equal(probes, 0);
});
