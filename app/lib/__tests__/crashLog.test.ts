/**
 * The app's local error log (lib/crashLogCore.ts): ring buffer, recovery, and
 * the global-handler chain.
 *
 * Why these matter: the log runs at import time on every launch and sits in the
 * path of every fatal JS error. A log that throws on a corrupt blob stops the
 * app from starting; a handler that swallows a fatal turns a crash into a
 * zombie; a buffer that grows without bound or keeps one repeated error twenty
 * times loses the error that explains the crash. Each is pinned below.
 *
 * CONTROLS (CLAUDE.md §11): with the `prev(error, isFatal)` call removed from
 * chainGlobalHandler, the "never swallows" tests FAIL; with `.slice(-LOG_CAP)`
 * removed from appendEntry, the capacity test FAILS; with parseLog's JSON.parse
 * try/catch removed, the corrupt-storage test FAILS. See the PR body.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  appendEntry,
  chainGlobalHandler,
  DEDUPE_MS,
  describeError,
  emptyLog,
  exitEntryFromMarker,
  fitBudget,
  formatReport,
  LOG_BYTES_MAX,
  LOG_CAP,
  makeEntry,
  markPending,
  MESSAGE_MAX,
  parseLog,
  parseMarker,
  redact,
  serializeLog,
  serializeMarker,
  shrinkLog,
  STACK_MAX,
  truncate,
  utf8Length,
  type CrashLog,
} from '../crashLogCore.ts';

const T0 = 1_760_000_000_000;
const CTX = { app: '2.9.61 (vc 109)', route: '/pad' };

function err(message: string, stack?: string): Error {
  const e = new Error(message);
  if (stack !== undefined) e.stack = stack;
  return e;
}

/** n distinct errors, 1 minute apart (outside the dedupe window). */
function fill(n: number, start: CrashLog = emptyLog()): CrashLog {
  let log = start;
  for (let i = 0; i < n; i++) {
    log = appendEntry(log, makeEntry(err(`boom ${i}`), 'error', T0 + i * 60_000, { ...CTX, id: `e${i}` })).log;
  }
  return log;
}

// ------------------------------------------------------------------ ring buffer

test('capacity: keeps the newest LOG_CAP entries, oldest fall off the front', () => {
  const log = fill(LOG_CAP + 5);
  assert.equal(log.entries.length, LOG_CAP);
  assert.equal(log.entries[0].id, 'e5', 'the 5 oldest are gone');
  assert.equal(log.entries[LOG_CAP - 1].id, `e${LOG_CAP + 4}`, 'the newest is last');
});

test('order: stored oldest-first, reported newest-first', () => {
  const log = fill(3);
  assert.deepEqual(log.entries.map((e) => e.id), ['e0', 'e1', 'e2']);
  const text = formatReport(log.entries, { app: CTX.app, appId: 'com.ets3d.rescueremote.direct', device: 'android 15 (API 35)', now: T0 });
  const i2 = text.indexOf('boom 2');
  const i0 = text.indexOf('boom 0');
  assert.ok(i2 > 0 && i0 > i2, 'newest (boom 2) is printed before oldest (boom 0)');
  assert.match(text, /^#1 JS ERROR/m);
  assert.match(text, /com\.ets3d\.rescueremote\.direct/, 'package id in the header (store vs direct)');
  assert.match(text, /2\.9\.61 \(vc 109\)/, 'version + build in the header (picks the source map)');
});

test('timestamps: an entry carries the time it happened, as ISO in the report', () => {
  const e = makeEntry(err('x'), 'fatal', T0, CTX);
  assert.equal(e.ts, T0);
  assert.equal(e.lastTs, T0);
  assert.equal(e.count, 1);
  const text = formatReport([e], { app: CTX.app, appId: '', device: 'web', now: T0 + 5 });
  assert.ok(text.includes(new Date(T0).toISOString()));
  assert.ok(text.includes('FATAL JS ERROR'));
});

test('dedupe: the same error back-to-back folds (count, lastTs), and does not evict others', () => {
  let log = fill(2);
  const base = T0 + 10 * 60_000;
  for (let i = 0; i < 50; i++) {
    log = appendEntry(log, makeEntry(err('mashed', 'at onPress (index.android.bundle:1:42)'), 'fatal', base + i * 100, CTX)).log;
  }
  assert.equal(log.entries.length, 3, 'two earlier errors survive a 50x repeat');
  const last = log.entries[2];
  assert.equal(last.count, 50);
  assert.equal(last.ts, base, 'first occurrence kept');
  assert.equal(last.lastTs, base + 49 * 100, 'last occurrence tracked');
});

test('dedupe: outside the window, or a different kind, is a new entry', () => {
  let log = appendEntry(emptyLog(), makeEntry(err('same'), 'error', T0, CTX)).log;
  log = appendEntry(log, makeEntry(err('same'), 'error', T0 + DEDUPE_MS + 1, CTX)).log;
  assert.equal(log.entries.length, 2, 'past the window');
  log = appendEntry(log, makeEntry(err('same'), 'fatal', T0 + DEDUPE_MS + 2, CTX)).log;
  assert.equal(log.entries.length, 3, 'a fatal is never folded into a non-fatal');
});

test('truncation: a huge stack and message are capped, and say so', () => {
  const huge = 'at frame (index.android.bundle:1:123456)\n'.repeat(5000); // ~200 KB
  const e = makeEntry(err('m'.repeat(50_000), huge), 'fatal', T0, CTX);
  assert.ok(e.stack.length <= STACK_MAX, `stack ${e.stack.length} <= ${STACK_MAX}`);
  assert.ok(e.message.length <= MESSAGE_MAX);
  assert.match(e.stack, /… \[\+\d+ chars\]$/);
  assert.ok(e.stack.startsWith('at frame'), 'the TOP frames are the ones kept');
  assert.equal(truncate('short', 10), 'short');
});

test('byte budget: 20 max-size entries still serialize under LOG_BYTES_MAX; pending survives', () => {
  const huge = 'x'.repeat(STACK_MAX * 4);
  let log = emptyLog();
  log = appendEntry(log, makeEntry(err('the crash', huge), 'fatal', T0, { ...CTX, id: 'crash' })).log;
  log = markPending(log, 'crash');
  for (let i = 1; i < LOG_CAP; i++) {
    log = appendEntry(log, makeEntry(err(`e${i} ${'y'.repeat(MESSAGE_MAX)}`, huge), 'error', T0 + i * 60_000, CTX)).log;
  }
  const s = serializeLog(log);
  assert.ok(utf8Length(s) <= LOG_BYTES_MAX, `${utf8Length(s)} <= ${LOG_BYTES_MAX}`);
  const back = parseLog(s);
  assert.equal(back.pending, 'crash', 'the pending crash is never the one trimmed');
  assert.ok(back.entries.some((e) => e.id === 'crash'));
  assert.equal(back.entries[back.entries.length - 1].message.startsWith(`e${LOG_CAP - 1} `), true, 'newest kept');
});

test('fitBudget always keeps at least one entry', () => {
  const log = fill(3);
  assert.equal(fitBudget(log, 10).entries.length, 1);
});

test('shrinkLog halves, keeping the newest and the pending crash', () => {
  let log = fill(10);
  log = markPending(log, 'e0');
  const s = shrinkLog(log);
  assert.equal(s.entries.length, 5);
  assert.equal(s.pending, 'e0');
  assert.ok(s.entries.some((e) => e.id === 'e0'));
  assert.equal(s.entries[s.entries.length - 1].id, 'e9');
});

// ------------------------------------------------------------------ recovery

test('corrupt storage: garbage in any shape reads as an empty log, never throws', () => {
  for (const raw of [null, undefined, '', 'not json', '{', '[]', 'null', '42', '"str"', '{"entries":"x"}', '{"v":1}']) {
    const log = parseLog(raw as string | null);
    assert.deepEqual(log, emptyLog(), `input ${JSON.stringify(raw)}`);
  }
});

test('corrupt storage: bad entries are dropped, good ones kept, dangling pending cleared', () => {
  const good = makeEntry(err('kept'), 'error', T0, { ...CTX, id: 'good' });
  const raw = JSON.stringify({
    v: 1,
    pending: 'gone',
    entries: [
      1,
      null,
      { id: 'noTs', kind: 'error', message: 'x' },
      { id: 'badKind', ts: T0, kind: 'weird', message: 'x' },
      { id: '', ts: T0, kind: 'error', message: 'x' },
      { id: 'noMsg', ts: T0, kind: 'error' },
      good,
      { id: 'legacy', ts: T0 + 1, kind: 'render', message: 'm'.repeat(MESSAGE_MAX * 3), count: -4 },
    ],
  });
  const log = parseLog(raw);
  assert.deepEqual(log.entries.map((e) => e.id), ['good', 'legacy']);
  assert.equal(log.pending, null, 'pending pointed at a missing entry');
  assert.equal(log.entries[1].count, 1, 'nonsense count repaired');
  assert.ok(log.entries[1].message.length <= MESSAGE_MAX, 'oversized stored field re-capped');
});

test('round trip: serialize -> parse is lossless for a normal log', () => {
  let log = fill(4);
  log = markPending(log, 'e3');
  assert.deepEqual(parseLog(serializeLog(log)), log);
});

// ------------------------------------------------------------------ content

test('redact: bearer tokens and token= / "token": values never reach the log', () => {
  assert.equal(redact('Authorization: Bearer abc.DEF-123_x'), 'Authorization: Bearer [redacted]');
  assert.equal(
    redact('Invalid URL couchside://pair#host=10.1.1.5&port=8787&token=s3cr3tT0ken&fp=ab'),
    'Invalid URL couchside://pair#host=10.1.1.5&port=8787&token=[redacted]&fp=ab',
  );
  assert.equal(redact('{"host":"box","token":"s3cr3t"}'), '{"host":"box","token":"[redacted]"}');
  assert.equal(redact("token: 'abc'"), "token: '[redacted]'");
  assert.equal(redact('tokenize failed'), 'tokenize failed', 'ordinary words untouched');
  const e = makeEntry(err('bad pair link token=LEAKME'), 'error', T0, CTX);
  assert.ok(!e.message.includes('LEAKME'));
});

test('describeError: Error, string, null, object, and hostile getters', () => {
  const d = describeError(err('boom', 'Error: boom\n    at a (x.js:1:2)'));
  assert.equal(d.name, 'Error');
  assert.equal(d.message, 'boom');
  assert.equal(d.stack, '    at a (x.js:1:2)', 'the duplicated "Error: boom" head line is dropped');
  assert.deepEqual(describeError('plain'), { name: 'Thrown', message: 'plain', stack: '' });
  assert.equal(describeError(null).message, 'null');
  assert.equal(describeError(undefined).message, 'undefined');
  assert.equal(describeError({ code: 7 }).message, '{"code":7}');
  const hostile = {
    get message(): string {
      throw new Error('getter');
    },
  };
  assert.doesNotThrow(() => describeError(hostile));
  const t = new TypeError('x');
  assert.equal(describeError(t).name, 'TypeError');
});

test('utf8Length counts bytes, not UTF-16 units', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('é'), 2);
  assert.equal(utf8Length('…'), 3);
  assert.equal(utf8Length('🛋️'), 4 + 3); // couch (surrogate pair) + variation selector
});

// ------------------------------------------------------------------ global handler

type Handler = (e: unknown, isFatal?: boolean) => void;
function fakeErrorUtils(initial: Handler | null) {
  let h: Handler | null = initial;
  return {
    getGlobalHandler: () => h as Handler,
    setGlobalHandler: (n: Handler) => {
      h = n;
    },
    fire(e: unknown, fatal?: boolean) {
      (h as Handler)(e, fatal);
    },
  };
}

test('chain: records, THEN hands the identical error + flag to the previous handler', () => {
  const calls: string[] = [];
  const prevArgs: unknown[][] = [];
  const eu = fakeErrorUtils((e, f) => {
    calls.push('prev');
    prevArgs.push([e, f]);
  });
  const recorded: [unknown, boolean][] = [];
  assert.equal(
    chainGlobalHandler(eu, (e, f) => {
      calls.push('record');
      recorded.push([e, f]);
    }),
    true,
  );
  const boom = new Error('boom');
  eu.fire(boom, true);
  eu.fire('soft', false);
  eu.fire('noflag');
  assert.deepEqual(calls, ['record', 'prev', 'record', 'prev', 'record', 'prev']);
  assert.strictEqual(prevArgs[0][0], boom, 'same object, not a copy');
  assert.equal(prevArgs[0][1], true, 'fatal stays fatal');
  assert.equal(prevArgs[2][1], undefined, 'an absent flag is passed through as absent');
  assert.deepEqual(recorded.map((r) => r[1]), [true, false, false]);
});

test('chain: a recorder that throws can NOT stop the fatal reaching the previous handler', () => {
  let reached = 0;
  const eu = fakeErrorUtils(() => {
    reached++;
  });
  chainGlobalHandler(eu, () => {
    throw new Error('storage exploded');
  });
  assert.doesNotThrow(() => eu.fire(new Error('real crash'), true));
  assert.equal(reached, 1);
});

test('chain: with no previous handler a fatal is re-thrown, a non-fatal is not', () => {
  const eu = fakeErrorUtils(null);
  chainGlobalHandler(eu, () => {});
  const boom = new Error('boom');
  assert.throws(() => eu.fire(boom, true), (e) => e === boom);
  assert.doesNotThrow(() => eu.fire(new Error('soft'), false));
});

test('chain: installing twice does not double-wrap (one record per error)', () => {
  let prevCalls = 0;
  const eu = fakeErrorUtils(() => {
    prevCalls++;
  });
  let n = 0;
  chainGlobalHandler(eu, () => {
    n++;
  });
  chainGlobalHandler(eu, () => {
    n++;
  });
  eu.fire(new Error('x'), false);
  assert.equal(n, 1);
  assert.equal(prevCalls, 1);
});

test('chain: an absent ErrorUtils (not guaranteed on web) or a malformed one is a no-op', () => {
  assert.equal(chainGlobalHandler(undefined, () => {}), false);
  assert.equal(chainGlobalHandler(null, () => {}), false);
  assert.equal(chainGlobalHandler({ getGlobalHandler: 1 }, () => {}), false);
});

// ------------------------------------------------------------------ session marker

test('marker: a previous process that died ON SCREEN becomes an exit entry', () => {
  const prev = parseMarker(serializeMarker({ state: 'fg', ts: T0, app: '2.9.60 (vc 108)', route: '/pad' }));
  const e = exitEntryFromMarker(prev, 'x1');
  assert.ok(e);
  assert.equal(e.kind, 'exit');
  assert.equal(e.ts, T0, 'last time it was known on screen');
  assert.equal(e.app, '2.9.60 (vc 108)', 'blames the version that crashed, not the one reading');
  assert.equal(e.route, '/pad');
  assert.equal(e.stack, '');
});

test('marker: the exit is stamped no earlier than the last error that process recorded', () => {
  const prev = parseMarker(serializeMarker({ state: 'fg', ts: T0, app: '', route: '/pad' }));
  // The previous process logged an error 40s after its last marker write.
  const e = exitEntryFromMarker(prev, 'x2', T0 + 40_000);
  assert.equal(e?.ts, T0 + 40_000, 'provably alive until then');
  // An older entry (from an even earlier process) does not move it back.
  assert.equal(exitEntryFromMarker(prev, 'x3', T0 - 5_000)?.ts, T0);
  // So in a newest-first report the exit really is newest.
  let log = appendEntry(emptyLog(), makeEntry(err('late'), 'error', T0 + 40_000, { ...CTX, id: 'late' })).log;
  log = appendEntry(log, exitEntryFromMarker(prev, 'x4', log.entries[0].lastTs)!).log;
  const text = formatReport(log.entries, { app: '', appId: '', device: 'android', now: T0 + 60_000 });
  assert.ok(text.indexOf('CLOSED UNEXPECTEDLY') < text.indexOf('late'));
});

test('marker: backgrounded, already-recorded fatal, missing or corrupt -> no exit entry', () => {
  assert.equal(exitEntryFromMarker(parseMarker(serializeMarker({ state: 'bg', ts: T0, app: '', route: '' }))), null);
  assert.equal(exitEntryFromMarker(parseMarker(serializeMarker({ state: 'crashed', ts: T0, app: '', route: '' }))), null);
  for (const raw of [null, '', 'x', '{"state":"fg"}', '{"state":"zzz","ts":1}', '[]']) {
    assert.equal(exitEntryFromMarker(parseMarker(raw)), null, `input ${JSON.stringify(raw)}`);
  }
});

test('pending: points at a real entry or nothing', () => {
  const log = fill(2);
  assert.equal(markPending(log, 'e1').pending, 'e1');
  assert.equal(markPending(log, 'nope').pending, null);
  // An entry pushed off the end takes its pending mark with it.
  let l = markPending(fill(1), 'e0');
  for (let i = 1; i <= LOG_CAP; i++) {
    l = appendEntry(l, makeEntry(err(`n${i}`), 'error', T0 + i * 60_000, CTX)).log;
  }
  assert.equal(l.pending, null);
});
