'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const check = path.resolve(__dirname, '../app/scripts/check-hermes-memory.cjs');

// Disposable dependency trees exercise the same CLI used by CI without changing
// the installed app dependencies. Both positive and negative controls must work.
for (const [name, runtime, compiler, passes] of [
    ['affected engine', '250829098.0.14', '250829098.0.14', false],
    ['last affected patch', '250829098.0.15', '250829098.0.15', false],
    ['minimum fixed engine', '250829098.0.16', '250829098.0.16', true],
    ['numeric patch comparison', '250829098.0.100', '250829098.0.100', true],
    ['mismatched compiler', '250829098.0.16', '250829098.0.14', false],
    ['missing native metadata', null, '250829098.0.16', false],
    ['missing compiler metadata', '250829098.0.16', null, false],
    ['malformed native version', 'unknown', '250829098.0.16', false],
]) {
    test(`Hermes dependency gate: ${name}`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'couchside-hermes-check-'));
        try {
            const nativeDir = path.join(root, 'node_modules/react-native/sdks/hermes-engine');
            const compilerDir = path.join(root, 'node_modules/hermes-compiler');
            fs.mkdirSync(nativeDir, { recursive: true });
            fs.mkdirSync(compilerDir, { recursive: true });
            if (runtime !== null) fs.writeFileSync(path.join(nativeDir, 'version.properties'), `HERMES_V1_VERSION_NAME=${runtime}\n`);
            if (compiler !== null) fs.writeFileSync(path.join(compilerDir, 'package.json'), JSON.stringify({ version: compiler }));
            const result = spawnSync(process.execPath, [check, root], { encoding: 'utf8', timeout: 10000 });
            assert.ifError(result.error);
            assert.equal(result.status, passes ? 0 : 1, result.stderr || result.stdout);
            if (passes) assert.match(result.stdout, /memory-regression fix present/);
            else assert.ok(result.stderr.trim(), 'failed checks explain why');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
