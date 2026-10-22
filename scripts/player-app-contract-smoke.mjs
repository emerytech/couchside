#!/usr/bin/env node
// Execute the checked-in app's API methods against a local test package.
// No app build/dependencies, phone, production agent, or LAN host is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const [base, tokenFile] = process.argv.slice(2);
const url = new URL(base);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.protocol, 'http:');
const token = readFileSync(tokenFile, 'utf8').trim();
const source = readFileSync(new URL('../app/lib/api.ts', import.meta.url), 'utf8');
const names = ['ping', 'status', 'launchers', 'player', 'playerOp', 'playerCatalogOpen'];
const methods = names.map(name => {
  const pattern = new RegExp(`^  (?:async )?${name}\\(`, 'm');
  const start = source.search(pattern);
  assert(start >= 0, `app method ${name} exists`);
  const end = source.indexOf('\n  },', start);
  assert(end > start, `app method ${name} has expected boundary`);
  return source.slice(start, end + 5);
}).join('\n');
const lastCaps = new Map();
const hostKey = s => `${s.host}:${s.port}`;
const cachedCaps = s => lastCaps.get(hostKey(s));
const calls = [];
// Transport harness: direct loopback HTTP in place of React Native networking.
// API method bodies and their serialized payloads above come from app source.
async function request(settings, path, opts = {}) {
  assert.equal(settings.token, token);
  const response = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.auth === false ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(15000),
  });
  calls.push([opts.method ?? 'GET', path, response.status]);
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), {status: response.status});
  return response.json();
}
const code = stripTypeScriptTypes(`const api = {${methods}};`) + '\nreturn api;';
const api = new Function('request', 'lastCaps', 'hostKey', 'cachedCaps', 'probeGated', 'probeOrNull', code)(
  request, lastCaps, hostKey, cachedCaps,
  (cap, fn) => cap === false ? Promise.resolve(null) : fn(),
  promise => promise.catch(e => { if (e.status === 404) return null; throw e; }),
);
const settings = {host: '127.0.0.1', port: Number(url.port), token};
assert.equal((await api.ping(settings)).app, 'couchside-agent');
assert.equal((await api.status(settings)).caps.player, true);
assert.deepEqual(await api.launchers(settings), {launchers: [], create_enabled: false});
const state = await api.player(settings);
assert.deepEqual(state.services, ['sample']);
assert.deepEqual(state.seek_secs, [-10, 10]);
await api.playerOp(settings, 'close');
await api.playerOp(settings, 'open', {service: state.services[0]});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const s = await api.player(settings);
    assert(!s.playback?.error, 'video has no media error');
    if (predicate(s)) return s;
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function motion() {
  const first = await until(s => s.playback?.playing, 'playing');
  await sleep(2500);
  const last = await api.player(settings);
  assert(last.playback.position > first.playback.position + 1);
  assert(last.playback.decodedFrames > first.playback.decodedFrames);
}
await motion();
await api.playerOp(settings, 'playpause');
await until(s => s.playback && !s.playback.playing, 'paused');
await api.playerOp(settings, 'seek', {secs: 10});
await until(s => s.playback?.position >= 9.5 && !s.playback.seeking, 'forward seek');
await api.playerOp(settings, 'seek', {secs: -10});
await until(s => s.playback?.position < 5 && !s.playback.seeking, 'backward seek');
await api.playerOp(settings, 'mute');
await until(s => s.playback?.muted, 'muted');
await api.playerOp(settings, 'mute');
await until(s => s.playback && !s.playback.muted, 'unmuted');
await api.playerOp(settings, 'playpause');
await motion();
await api.playerOp(settings, 'close');
assert.equal((await api.player(settings)).running, false);
await api.playerOp(settings, 'open', {service: 'sample'});
await motion();
await api.playerOp(settings, 'close');
assert.equal((await api.player(settings)).running, false);
// Never print request credentials or secret-bearing URLs.
console.log(`PASS app-source API methods: connection, sample tile, motion, pause/resume, seek, mute, Stop, reopen (${calls.length} loopback requests)`);
