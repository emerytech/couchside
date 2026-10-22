import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseThemeDocument } from '../lib/themeFormat.ts';
const f=JSON.parse(fs.readFileSync(new URL('../../protocol/fixtures/theme-v1.json',import.meta.url),'utf8'));
assert.deepEqual(parseThemeDocument(f.valid),f.valid);
for(const patch of f.invalidPatches) assert.throws(()=>parseThemeDocument({...f.valid,...patch}));
assert.throws(()=>parseThemeDocument({...f.valid, name:' '.repeat(4)}));
console.log('PASS shared theme format rejects code, URLs, paths, wrong types and unsupported versions');
