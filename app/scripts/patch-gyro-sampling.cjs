'use strict';
// expo-sensors 57.0.3 is MIT licensed. Retain its notices.
// Its Android fallback requests SENSOR_DELAY_NORMAL (~200ms) without the
// high-rate permission. Air Mouse needs 50Hz, safely below Android's 200Hz cap.
// Change only the gyro fallback; other sensors and permissions stay unchanged.
const fs = require('node:fs');
const path = require('node:path');
const before = `    } else {
      SensorManager.SENSOR_DELAY_NORMAL
    }`;
const after = `    } else if (sensorType == Sensor.TYPE_GYROSCOPE) {
      // Couchside Air Mouse: 50Hz needs no high-sampling-rate permission.
      SensorManager.SENSOR_DELAY_GAME
    } else {
      SensorManager.SENSOR_DELAY_NORMAL
    }`;
function patchSource(source) {
  if (source.includes(after)) return source;
  if (source.split(before).length !== 2) throw new Error('expo-sensors sampling source changed; review gyro patch');
  return source.replace(before, after);
}
if (require.main === module) {
  const file = path.join(__dirname, '../node_modules/expo-sensors/android/src/main/java/expo/modules/sensors/SensorSubscription.kt');
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchSource(source);
  if (source !== patched) fs.writeFileSync(file, patched);
  console.log('Android gyro 50Hz sampling patch verified');
}
module.exports = { patchSource, before, after };
