import assert from 'node:assert/strict';
import test from 'node:test';

import type { CeremonyStage } from '../api';
import { couchModeSummary } from '../couchModeSummary.ts';

const stage = (key: CeremonyStage['key'], state: CeremonyStage['state'], reason?: string): CeremonyStage => ({
  key, state, label: key, reason, fatal: key === 'session',
});

test('TV certificate failure is not reported as an audio failure or verified TV output', () => {
  const summary = couchModeSummary({ state: 'done', stages: [
    stage('tv_power_on', 'failed', 'SSLError: SSLV3_ALERT_CERTIFICATE_UNKNOWN'),
    stage('tv_input', 'skipped', 'no TV control backend'),
    stage('output', 'skipped', 'no external display selected'),
    stage('session', 'ok'),
    stage('audio', 'skipped', 'no external display; audio stays on the box'),
  ] });
  assert.equal(summary, 'Game Mode is ready. TV power needs attention. See the details above.');
  assert.doesNotMatch(summary, /sound|audio|on the TV/i);
});

test('audio-only failure names audio, without blaming TV power', () => {
  const summary = couchModeSummary({ state: 'done', stages: [
    stage('tv_power_on', 'ok'), stage('session', 'ok'), stage('audio', 'failed'),
  ] });
  assert.equal(summary, 'Game Mode is ready. Audio needs attention. See the details above.');
  assert.doesNotMatch(summary, /TV power|on the TV/);
});

test('multiple optional failures name each affected stage', () => {
  const summary = couchModeSummary({ state: 'done', stages: [
    stage('tv_power_on', 'failed'), stage('tv_input', 'failed'),
    stage('output', 'failed'), stage('session', 'ok'), stage('audio', 'failed'),
  ] });
  assert.equal(summary, 'Game Mode is ready. TV power, TV input, display selection and audio need attention. See the details above.');
});

test('undocked success explains skipped audio without claiming a TV is in use', () => {
  const summary = couchModeSummary({ state: 'done', stages: [
    stage('output', 'skipped', 'no external display selected'),
    stage('session', 'ok'),
    stage('audio', 'skipped', 'no external display; audio stays on the box'),
  ] });
  assert.equal(summary, 'Game Mode is ready. No external display was detected; audio stays on the box.');
  assert.doesNotMatch(summary, /attention|failed|on the TV/);
});

test('all stages OK reports the verified session, without claiming display readback', () => {
  const stages = ['tv_power_on', 'tv_input', 'output', 'session', 'audio'] as const;
  assert.equal(couchModeSummary({ state: 'done', stages: stages.map((key) => stage(key, 'ok')) }),
    'Game Mode is ready.');
});

test('fatal session failure remains a failure and preserves the agent reason', () => {
  assert.equal(couchModeSummary({ state: 'failed', stages: [
    stage('session', 'failed', 'Game Mode did not appear'), stage('audio', 'failed'),
  ] }), "Couldn't reach Game Mode — Game Mode did not appear.");
});

test('partial bodies and normal skipped stages remain safe and do not invent failures', () => {
  assert.equal(couchModeSummary({ state: 'done' }), 'Game Mode is ready.');
  assert.equal(couchModeSummary({ state: 'done', stages: null }), 'Game Mode is ready.');
  assert.equal(couchModeSummary({ state: 'failed' }), "Couldn't reach Game Mode.");
  assert.equal(couchModeSummary({ state: 'done', stages: [
    stage('output', 'skipped', 'this session picks its own output (SteamOS)'),
  ] }), 'Game Mode is ready.');
});

test('unfinished states never announce success', () => {
  assert.equal(couchModeSummary({ state: 'running', stages: [] }), 'Switching to Game Mode…');
  assert.equal(couchModeSummary({ state: 'idle', stages: [] }), '');
});
