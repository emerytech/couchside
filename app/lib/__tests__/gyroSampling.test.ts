import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { patchSource, before, after } = require('../../scripts/patch-gyro-sampling.cjs');
test('gyro requests game-rate sampling without high-rate permission; patch is narrow and repeatable', () => {
  const source = `prefix\n${before}\nsuffix`;
  assert.equal(patchSource(source), `prefix\n${after}\nsuffix`);
  assert.equal(patchSource(patchSource(source)), patchSource(source));
  assert.match(after, /sensorType == Sensor.TYPE_GYROSCOPE/);
  assert.match(after, /SENSOR_DELAY_GAME/);
  assert.match(after, /else \{\n      SensorManager.SENSOR_DELAY_NORMAL/);
  assert.throws(() => patchSource('upstream changed'), /review gyro patch/);
});

test('Android builds the patched sensors module rather than its precompiled AAR', () => {
  const config = require('../../package.json');
  assert.deepEqual(config.expo.autolinking.android.buildFromSource, ['expo-sensors']);
});
