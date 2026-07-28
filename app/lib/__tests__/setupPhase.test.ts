/**
 * Interactive setup card decisions — lib/setupPhase.ts.
 *
 * Run: from app/, `node --experimental-strip-types --test lib/__tests__/*.test.ts`
 * (CI runs exactly that glob, so this file is picked up with no workflow edit.)
 *
 * WHY THESE TESTS AND NOT OTHERS. This card changes state from a network event
 * the user cannot see, while they are looking at a different screen in another
 * room. Nothing about it is verifiable by feel. Per CLAUDE.md §11 every rule
 * below is exercised in BOTH directions and carries a control — an input whose
 * answer is known independently — because a table that only ever asserts "no"
 * passes just as well against a function that always says no.
 *
 * The version floors in particular are read from the agent sources at the
 * commits that introduced them, not from memory:
 *   Linux   2.9.12   commit 1f0952f (agent/couchsided.py, VERSION = "2.9.12")
 *   Windows 0.4.2-win commit a131bc5 (agent/win/couchsided-win.py, VERSION = "0.4.2-win")
 * Today's shipping versions are 2.9.61 and 0.4.3-win.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acceptsSighting,
  DIAGNOSE_AFTER_MS,
  formatCountdown,
  isSearching,
  netVerdict,
  nextPhase,
  PIN_PAIR_MIN_LINUX,
  PIN_PAIR_MIN_WINDOWS,
  stepMarks,
  supportsPinPairing,
  SWEEP_FAST_WINDOW_MS,
  SWEEP_GAP_BACKOFF_MS,
  SWEEP_GAP_MS,
  SWEEP_GIVE_UP_MS,
  sweepPolicy,
  TRANSIENT,
  ttlRemaining,
  type SetupBox,
  type SetupEvent,
  type SetupPhase,
} from '../setupPhase.ts';

const box = (version: string, over: Partial<SetupBox> = {}): SetupBox => ({
  name: 'bazzite',
  host: 'bazzite.local',
  ip: '10.1.1.60',
  port: 8787,
  version,
  ...over,
});

const MODERN = box('2.9.61');
const ANCIENT = box('2.9.11');

// ---------------------------------------------------------------------------
// Which agents can PIN-pair
// ---------------------------------------------------------------------------

test('THE SPEC BUG: a modern Windows agent is NOT unsupported', () => {
  // The spec said the Windows agent has no PIN pairing at all, from a grep. It
  // shipped in 0.4.2-win. A single-track semver floor would compare 0.4.3-win
  // against 2.9.12 and mark EVERY Windows box unsupported.
  assert.equal(supportsPinPairing('0.4.3-win'), true, 'current Windows agent');
  assert.equal(supportsPinPairing('0.4.2-win'), true, 'the exact Windows floor');
  // CONTROL, the other direction: the release BEFORE the floor really is
  // unsupported — so this cannot pass by accepting every -win string.
  assert.equal(supportsPinPairing('0.4.1-win'), false, 'predates Windows PIN pairing');
  assert.equal(supportsPinPairing('0.3.7-win'), false);
});

test('the Linux floor is exact in both directions', () => {
  assert.equal(supportsPinPairing('2.9.12'), true, 'the exact Linux floor');
  assert.equal(supportsPinPairing('2.9.11'), false, 'one release below it');
  assert.equal(supportsPinPairing('2.9.61'), true, 'current shipping agent');
  // Numeric, not lexical: a string compare reads '2.9.9' > '2.9.12'.
  assert.equal(supportsPinPairing('2.9.9'), false);
  assert.equal(supportsPinPairing('2.10.0'), true);
  assert.equal(supportsPinPairing('3.0.0'), true);
  // The declared constants are the ones actually enforced.
  assert.equal(supportsPinPairing(PIN_PAIR_MIN_LINUX), true);
  assert.equal(supportsPinPairing(`${PIN_PAIR_MIN_WINDOWS}-win`), true);
});

test('an unreadable version degrades CLOSED', () => {
  // pingHost writes '' when the agent sends no version string.
  for (const v of ['', '   ', 'unknown', 'v2.9.61', 'null', 'win']) {
    assert.equal(supportsPinPairing(v), false, `${JSON.stringify(v)} was accepted`);
  }
  // CONTROL: a well-formed current version still passes, so "closed" is not
  // "closed to everything".
  assert.equal(supportsPinPairing('2.9.61'), true);
});

// ---------------------------------------------------------------------------
// PIN countdown
// ---------------------------------------------------------------------------

test('ttlRemaining counts down and stops at zero — never negative', () => {
  // Anchored to a relative offset, never a literal date: a hardcoded date
  // fixture with an age cap once turned main red with no code change.
  const now = Date.now();
  assert.equal(ttlRemaining(now + 120_000, now), 120);
  assert.equal(ttlRemaining(now + 1_500, now), 2, 'partial second rounds up, so 1 is not shown as 0');
  assert.equal(ttlRemaining(now, now), 0, 'exactly expired');
  // The other direction: past expiry it clamps instead of going negative.
  assert.equal(ttlRemaining(now - 30_000, now), 0);
  // Garbage in is zero, not NaN — a NaN countdown renders as "NaN:NaN".
  assert.equal(ttlRemaining(Number.NaN, now), 0);
});

test('formatCountdown is m:ss and clamps', () => {
  assert.equal(formatCountdown(120), '2:00');
  assert.equal(formatCountdown(119), '1:59');
  assert.equal(formatCountdown(7), '0:07');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(formatCountdown(Number.NaN), '0:00');
});

// ---------------------------------------------------------------------------
// Sweep policy
// ---------------------------------------------------------------------------

test('sweep cadence backs off, then gives up — both sides of each boundary', () => {
  assert.deepEqual(sweepPolicy(0), { shouldSweep: true, delayMs: SWEEP_GAP_MS, giveUp: false });
  assert.equal(sweepPolicy(SWEEP_FAST_WINDOW_MS - 1).delayMs, SWEEP_GAP_MS, 'still fast at 59.999s');
  assert.equal(sweepPolicy(SWEEP_FAST_WINDOW_MS).delayMs, SWEEP_GAP_BACKOFF_MS, 'backed off at 60s');

  // The give-up boundary, both sides. 254 connection attempts every 6s forever
  // is battery burn and looks like a port scan to a router.
  const justBefore = sweepPolicy(SWEEP_GIVE_UP_MS - 1);
  assert.equal(justBefore.giveUp, false, 'at 4:59.999 it is still sweeping');
  assert.equal(justBefore.shouldSweep, true);
  const atLimit = sweepPolicy(SWEEP_GIVE_UP_MS);
  assert.equal(atLimit.giveUp, true, 'at 5:00 it stops');
  assert.equal(atLimit.shouldSweep, false);

  // Nonsense elapsed times must not produce a NaN delay or a silent give-up.
  assert.equal(sweepPolicy(-1).shouldSweep, true);
  assert.equal(sweepPolicy(Number.NaN).giveUp, false);
  assert.ok(DIAGNOSE_AFTER_MS < SWEEP_GIVE_UP_MS, 'the honest copy appears before the give-up');
});

// ---------------------------------------------------------------------------
// Should we sweep at all
// ---------------------------------------------------------------------------

test('netVerdict states only what is knowable', () => {
  // Sweepable — the control. Everything below must be measured against a case
  // that is known to succeed.
  assert.deepEqual(netVerdict({ networkType: 'WIFI', isConnected: true, selfIp: '10.1.1.42' }), {
    k: 'sweepable',
    subnet: '10.1.1.x',
  });
  // Ethernet counts too (a tablet on a dock, a desktop browser).
  assert.equal(
    netVerdict({ networkType: 'ETHERNET', isConnected: true, selfIp: '192.168.4.7' }).k,
    'sweepable',
  );
  // Unknown network type is NOT a verdict on its own; the IP still decides.
  assert.equal(netVerdict({ selfIp: '172.16.0.9' }).k, 'sweepable');

  assert.equal(netVerdict({ isConnected: false, selfIp: '10.1.1.42' }).k, 'offline');
  assert.equal(netVerdict({ networkType: 'NONE' }).k, 'offline');

  // ORDER MATTERS: a real cellular IP is often CGNAT (100.64/10), which
  // isValidLanIp accepts. If the cellular test ran second, a phone on mobile
  // data would sweep the carrier's /24 — 254 connections to strangers.
  assert.equal(
    netVerdict({ networkType: 'CELLULAR', isConnected: true, selfIp: '100.72.3.4' }).k,
    'cellular',
  );
  // CONTROL: the same CGNAT address on Wi-Fi (Tailscale lives here) IS swept.
  assert.equal(
    netVerdict({ networkType: 'WIFI', isConnected: true, selfIp: '100.72.3.4' }).k,
    'sweepable',
  );

  // A public IP is never swept. Measured behaviour on the web target: expo-network
  // returns the PUBLIC WAN IP there, so without this the app would connect to
  // 254 hosts on a stranger's /24.
  assert.equal(netVerdict({ networkType: 'WIFI', selfIp: '216.139.119.131' }).k, 'no-lan-ip');
  assert.equal(netVerdict({ networkType: 'WIFI' }).k, 'no-lan-ip', 'no IP at all');
  // The octal escape the LAN gate exists for: 010.1.1.5 resolves to 8.1.1.5.
  assert.equal(netVerdict({ selfIp: '010.1.1.5' }).k, 'no-lan-ip');
});

// ---------------------------------------------------------------------------
// The phase machine
// ---------------------------------------------------------------------------

/** One of every phase, for cross-product sweeps. */
const ALL_PHASES: SetupPhase[] = [
  { k: 'idle' },
  { k: 'looking', since: 1000, sweeps: 2 },
  { k: 'stalled', since: 1000, sweeps: 40 },
  { k: 'nonet', verdict: { k: 'cellular' } },
  { k: 'found', box: MODERN },
  { k: 'unsupported', box: ANCIENT },
  { k: 'starting', box: MODERN },
  { k: 'pin', box: MODERN, expiresAt: 500_000 },
  { k: 'pairing', box: MODERN, expiresAt: 500_000 },
  { k: 'failed', box: MODERN, msg: 'wrong PIN', expiresAt: 500_000, shown: true },
  { k: 'paired', box: MODERN },
];

/** One of every event. */
const ALL_EVENTS: SetupEvent[] = [
  { t: 'SWEEP_START', now: 2000 },
  { t: 'SWEEP_EMPTY' },
  { t: 'FOUND', box: MODERN },
  { t: 'NO_NET', verdict: { k: 'offline' } },
  { t: 'GIVE_UP' },
  { t: 'KEEP_LOOKING', now: 3000 },
  { t: 'START_PIN' },
  { t: 'START_OK', ttl: 120, now: 4000 },
  { t: 'START_ERR', msg: 'boom' },
  { t: 'UNSUPPORTED' },
  { t: 'SUBMIT' },
  { t: 'PAIR_OK' },
  { t: 'PAIR_ERR', msg: 'wrong PIN' },
  { t: 'BACK' },
  { t: 'RESET' },
];

test('INVARIANT: the machine is total — no (phase x event) pair throws or leaves the union', () => {
  const kinds = new Set(ALL_PHASES.map((p) => p.k));
  for (const p of ALL_PHASES) {
    for (const e of ALL_EVENTS) {
      const n = nextPhase(p, e);
      assert.ok(n && typeof n.k === 'string', `${p.k} + ${e.t} produced ${JSON.stringify(n)}`);
      assert.ok(kinds.has(n.k), `${p.k} + ${e.t} produced unknown phase ${n.k}`);
    }
  }
  assert.equal(kinds.size, 11, 'ALL_PHASES must cover every variant of the union');
});

test('INVARIANT: RESET returns to idle from every phase — always a way back', () => {
  for (const p of ALL_PHASES) {
    assert.equal(nextPhase(p, { t: 'RESET' }).k, 'idle', `no way back from ${p.k}`);
  }
});

test('INVARIANT: no in-flight phase is a resting state — each is left by BOTH ok and error', () => {
  // This is the rule that stops a stuck spinner. Every transient phase must have
  // a success event and a failure event that move it somewhere else.
  const exits: Record<string, { ok: SetupEvent; err: SetupEvent }> = {
    looking: { ok: { t: 'FOUND', box: MODERN }, err: { t: 'GIVE_UP' } },
    starting: { ok: { t: 'START_OK', ttl: 120, now: 1 }, err: { t: 'START_ERR', msg: 'x' } },
    pairing: { ok: { t: 'PAIR_OK' }, err: { t: 'PAIR_ERR', msg: 'wrong PIN' } },
  };
  for (const k of TRANSIENT) {
    const p = ALL_PHASES.find((x) => x.k === k);
    assert.ok(p, `no fixture for transient phase ${k}`);
    const pair = exits[k];
    assert.ok(pair, `transient phase ${k} has no declared exits`);
    assert.notEqual(nextPhase(p, pair.ok).k, k, `${k} does not leave on success`);
    assert.notEqual(nextPhase(p, pair.err).k, k, `${k} does not leave on failure`);
  }
  // CONTROL, the other direction: a RESTING phase legitimately ignores events
  // that do not apply to it, so "leaves on every event" is not the rule.
  assert.equal(nextPhase({ k: 'found', box: MODERN }, { t: 'PAIR_OK' }).k, 'found');
});

test('a late sighting cannot yank the screen out from under a typed PIN', () => {
  // The sweep is still draining when the user taps Pair now. Its stragglers
  // arrive seconds later.
  const committed: SetupPhase[] = [
    { k: 'found', box: MODERN },
    { k: 'starting', box: MODERN },
    { k: 'pin', box: MODERN, expiresAt: 500_000 },
    { k: 'pairing', box: MODERN, expiresAt: 500_000 },
    { k: 'failed', box: MODERN, msg: 'wrong PIN', expiresAt: 500_000, shown: true },
    { k: 'paired', box: MODERN },
    { k: 'unsupported', box: ANCIENT },
  ];
  for (const p of committed) {
    assert.equal(acceptsSighting(p), false, `${p.k} should refuse a sighting`);
    assert.deepEqual(nextPhase(p, { t: 'FOUND', box: box('2.9.61', { ip: '10.1.1.99' }) }), p);
    assert.deepEqual(nextPhase(p, { t: 'NO_NET', verdict: { k: 'cellular' } }), p);
  }
  // CONTROL: while searching, the very same event IS acted on — otherwise this
  // test would pass against a reducer that ignores FOUND entirely.
  for (const p of ALL_PHASES.filter((x) => acceptsSighting(x))) {
    assert.equal(nextPhase(p, { t: 'FOUND', box: MODERN }).k, 'found', `${p.k} ignored a sighting`);
  }
});

test('a sighting routes by agent version, not by platform', () => {
  const looking: SetupPhase = { k: 'looking', since: 0, sweeps: 1 };
  assert.equal(nextPhase(looking, { t: 'FOUND', box: box('2.9.61') }).k, 'found');
  assert.equal(nextPhase(looking, { t: 'FOUND', box: box('0.4.3-win') }).k, 'found', 'Windows');
  assert.equal(nextPhase(looking, { t: 'FOUND', box: box('2.9.11') }).k, 'unsupported');
  assert.equal(nextPhase(looking, { t: 'FOUND', box: box('0.4.1-win') }).k, 'unsupported');
  assert.equal(nextPhase(looking, { t: 'FOUND', box: box('') }).k, 'unsupported', 'no version');
});

test('the full happy path, end to end', () => {
  let p: SetupPhase = { k: 'idle' };
  p = nextPhase(p, { t: 'SWEEP_START', now: 1_000 });
  assert.deepEqual(p, { k: 'looking', since: 1_000, sweeps: 0 });
  p = nextPhase(p, { t: 'SWEEP_EMPTY' });
  assert.equal((p as { sweeps: number }).sweeps, 1);
  // A second SWEEP_START must not reset the clock, or the give-up never fires.
  const before = p;
  p = nextPhase(p, { t: 'SWEEP_START', now: 9_999 });
  assert.equal(p, before, 'SWEEP_START while looking is identity');

  p = nextPhase(p, { t: 'FOUND', box: MODERN });
  assert.deepEqual(p, { k: 'found', box: MODERN });
  p = nextPhase(p, { t: 'START_PIN' });
  assert.equal(p.k, 'starting');
  // The countdown comes from the RETURNED ttl. Inside the agent's 3s debounce
  // that is the live pairing's REMAINING seconds, not a fresh 120.
  p = nextPhase(p, { t: 'START_OK', ttl: 119, now: 50_000 });
  assert.deepEqual(p, { k: 'pin', box: MODERN, expiresAt: 50_000 + 119_000 });
  p = nextPhase(p, { t: 'SUBMIT' });
  assert.equal(p.k, 'pairing');
  p = nextPhase(p, { t: 'PAIR_OK' });
  assert.deepEqual(p, { k: 'paired', box: MODERN });
});

test('a wrong PIN keeps the live pairing so retry needs no re-scan', () => {
  const expiresAt = 500_000;
  const p = nextPhase({ k: 'pairing', box: MODERN, expiresAt }, {
    t: 'PAIR_ERR',
    // The agent's own string, verbatim. Never matched on: Linux writes an em
    // dash where Windows writes a hyphen for the other two failures.
    msg: 'wrong PIN',
  });
  assert.deepEqual(p, { k: 'failed', box: MODERN, msg: 'wrong PIN', expiresAt, shown: true });
  // Straight back into the same pairing — no new PIN, no new sweep.
  assert.equal(nextPhase(p, { t: 'SUBMIT' }).k, 'pairing');
  // And the other direction: a pairing that is SPENT server-side must not keep
  // a countdown running over a PIN that can no longer work.
  const dead = nextPhase({ k: 'pairing', box: MODERN, expiresAt }, {
    t: 'PAIR_ERR',
    msg: 'host refused: not a LAN address or local name',
    dead: true,
  });
  assert.equal((dead as { expiresAt: number }).expiresAt, 0);
});

test('a start that failed offers a new PIN, not a dead text field', () => {
  const p = nextPhase({ k: 'starting', box: MODERN }, { t: 'START_ERR', msg: 'Timed out after 8s' });
  assert.deepEqual(p, { k: 'failed', box: MODERN, msg: 'Timed out after 8s', expiresAt: 0,
                       shown: false });
  // expiresAt 0 is what makes the card render "SHOW A NEW PIN" instead of PAIR.
  assert.equal(ttlRemaining((p as { expiresAt: number }).expiresAt, Date.now()), 0);
  // START_PIN from `failed` is the retry; it must go back through /pair/start.
  assert.equal(nextPhase(p, { t: 'START_PIN' }).k, 'starting');
});

test('an agent that answers 401 is routed away from the PIN input', () => {
  // An agent below the floor whose version we somehow believed. unauthPost
  // RESOLVES the 401 body rather than throwing, so without this the card would
  // print the bare word "unauthorized" at the user.
  assert.equal(nextPhase({ k: 'starting', box: MODERN }, { t: 'UNSUPPORTED' }).k, 'unsupported');
  assert.equal(nextPhase({ k: 'found', box: MODERN }, { t: 'UNSUPPORTED' }).k, 'unsupported');
  // CONTROL: it is not a global override — it cannot kill a live PIN entry.
  const pin: SetupPhase = { k: 'pin', box: MODERN, expiresAt: 1 };
  assert.deepEqual(nextPhase(pin, { t: 'UNSUPPORTED' }), pin);
});

test('give up, then keep looking, with a fresh clock', () => {
  const looking: SetupPhase = { k: 'looking', since: 1_000, sweeps: 47 };
  const stalled = nextPhase(looking, { t: 'GIVE_UP' });
  assert.deepEqual(stalled, { k: 'stalled', since: 1_000, sweeps: 47 });
  assert.equal(isSearching(stalled), false, 'a stalled card must not claim to be looking');
  const again = nextPhase(stalled, { t: 'KEEP_LOOKING', now: 900_000 });
  assert.deepEqual(again, { k: 'looking', since: 900_000, sweeps: 0 });
  assert.equal(isSearching(again), true);
  // GIVE_UP is only meaningful while looking — it cannot strand a live PIN.
  const pin: SetupPhase = { k: 'pin', box: MODERN, expiresAt: 9 };
  assert.deepEqual(nextPhase(pin, { t: 'GIVE_UP' }), pin);
});

test('BACK returns to the found box without losing it', () => {
  const pin: SetupPhase = { k: 'pin', box: MODERN, expiresAt: 5 };
  assert.deepEqual(nextPhase(pin, { t: 'BACK' }), { k: 'found', box: MODERN });
  const failed: SetupPhase = { k: 'failed', box: MODERN, msg: 'wrong PIN', expiresAt: 5, shown: true };
  assert.deepEqual(nextPhase(failed, { t: 'BACK' }), { k: 'found', box: MODERN });
  // CONTROL: BACK does not interrupt an in-flight request.
  const pairing: SetupPhase = { k: 'pairing', box: MODERN, expiresAt: 5 };
  assert.deepEqual(nextPhase(pairing, { t: 'BACK' }), pairing);
});

// ---------------------------------------------------------------------------
// The four steps
// ---------------------------------------------------------------------------

test('the card never marks a step done on a guess, and stops claiming to watch', () => {
  // Steps 1-2 happen on the user's PC and are unverifiable from the phone, so
  // they go done ONLY once a box has actually answered — which proves both.
  assert.deepEqual(stepMarks({ k: 'idle' }), ['active', 'todo', 'todo', 'todo']);
  assert.deepEqual(stepMarks({ k: 'looking', since: 0, sweeps: 0 }), [
    'active',
    'active',
    'active',
    'todo',
  ]);
  assert.deepEqual(stepMarks({ k: 'found', box: MODERN }), ['done', 'done', 'done', 'active']);
  assert.deepEqual(stepMarks({ k: 'paired', box: MODERN }), ['done', 'done', 'done', 'done']);

  // Step 3 is "watch this screen — it updates by itself". It may be marked
  // active ONLY while a sweep loop is genuinely running. Both directions:
  for (const p of ALL_PHASES) {
    if (isSearching(p)) assert.equal(stepMarks(p)[2], 'active', `${p.k} should be watching`);
    else assert.notEqual(stepMarks(p)[2], 'active', `${p.k} claims to be watching and is not`);
  }
});

test('stepMarks is total and only ever emits the three marks', () => {
  const allowed = new Set(['todo', 'active', 'done']);
  for (const p of ALL_PHASES) {
    const m = stepMarks(p);
    assert.equal(m.length, 4, `${p.k} did not produce four steps`);
    for (const x of m) assert.ok(allowed.has(x), `${p.k} emitted ${x}`);
  }
});

// ---------------------------------------------------------------- honesty ---
// Both of these come from the adversarial review of this card. Its entire value
// is being trusted while someone stands at their PC, so a claim it cannot back
// is worse than a missing feature.

test('HIGH: a spent PIN kills the countdown, so the card stops advertising a live PIN', () => {
  // Both agents null PAIR_PIN before raising these two, so the session is GONE
  // server-side. Carrying expiresAt forward kept rendering "A 6-digit PIN is on
  // <box>'s screen. Expires in 1:03." with PAIR enabled — every press doomed.
  // The flagship scenario hits it: the installer restarting the agent mid-pair
  // (PAIR_PIN is an in-memory global) lands on "no active pairing".
  // PAIR_ERR only ever arrives from `pairing` — it follows a SUBMIT.
  const live: SetupPhase = { k: 'pairing', box: MODERN, expiresAt: 500_000 };
  for (const msg of ['too many wrong PINs — start again',
                     'no active pairing — start it again from the app']) {
    const p = nextPhase(live, { t: 'PAIR_ERR', msg, dead: true });
    assert.equal(p.k, 'failed');
    assert.equal(p.k === 'failed' && p.expiresAt, 0, `${msg} left a countdown running`);
  }
  // CONTROL, the other direction: a merely WRONG pin does not kill the session,
  // so the countdown must survive and retry must stay possible.
  const wrong = nextPhase(live, { t: 'PAIR_ERR', msg: 'wrong PIN', dead: false });
  assert.equal(wrong.k === 'failed' && wrong.expiresAt, 500_000);
});

test('HIGH: "expired" is never claimed for a PIN that was never shown', () => {
  // START_ERR is the pairStart-NEVER-SUCCEEDED path — box off Wi-Fi, or the 8s
  // timeout. Nothing was displayed on the TV, so the card must not say a PIN
  // expired; that sends the user to look at a blank screen, and sits next to
  // "Could not reach that box" as a contradiction.
  const starting: SetupPhase = { k: 'starting', box: MODERN };
  const p = nextPhase(starting, { t: 'START_ERR', msg: 'Could not reach that box.' });
  assert.equal(p.k, 'failed');
  assert.equal(p.k === 'failed' && p.shown, false, 'claimed a PIN was shown');
  // CONTROL: a failure that arrives AFTER a PIN was shown is marked shown, so
  // "expired" remains sayable in the one case where it is true.
  const live: SetupPhase = { k: 'pairing', box: MODERN, expiresAt: 500_000 };
  const after = nextPhase(live, { t: 'PAIR_ERR', msg: 'wrong PIN', dead: false });
  assert.equal(after.k === 'failed' && after.shown, true);
});
