'use strict';
// Check the installed native engine, not just the app's requested dependency range.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
try {
  const native = fs.readFileSync(path.join(root, 'node_modules/react-native/sdks/hermes-engine/version.properties'), 'utf8');
  const runtime = /^HERMES_V1_VERSION_NAME=(\d+\.\d+\.\d+)\s*$/m.exec(native)?.[1];
  const compiler = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/hermes-compiler/package.json'), 'utf8')).version;
  if (!runtime || runtime !== compiler) throw Error('Native Hermes and compiler versions are missing or differ; review the dependency update.');
  const actual = runtime.split('.').map(Number);
  const minimum = [250829098, 0, 16];
  let comparison = 0;
  for (let i = 0; i < minimum.length && comparison === 0; i++) comparison = Math.sign(actual[i] - minimum[i]);
  if (comparison < 0) throw Error('Installed Hermes is affected by the memory regression; require 250829098.0.16 or newer.');
  console.log(`Verified native Hermes and compiler ${runtime}: memory-regression fix present.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
