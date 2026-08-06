/**
 * Buffer is NOT a global in Hermes. Using it unqualified compiles, typechecks,
 * passes every Node test (Node HAS the global), and then throws
 * "Property 'Buffer' doesn't exist" on a real phone.
 *
 * That is exactly what happened: Google TV pairing reached the TV, completed
 * TLS, read the certificate — and died on `Buffer.from`. Node could never have
 * caught it, so this guard reads the SOURCE instead of running it.
 *
 * The rule: any lib file mentioning Buffer must import it from 'buffer'
 * (which react-native-tcp-socket itself does, and which wol.ts and
 * boxDiscovery.ts already did — atvnative.ts was the one that broke rank).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('no lib file uses Buffer without importing it (Hermes has no global)', () => {
  const root = join(import.meta.dirname, '..');
  const offenders: string[] = [];
  for (const file of sourceFiles(root)) {
    const src = readFileSync(file, 'utf8');
    // Strip comments/strings cheaply: only flag real member/type usage.
    const usesBuffer = /(?<![\w.'"])Buffer\s*[.<)\],;]/.test(
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''),
    );
    if (!usesBuffer) continue;
    const imports = /import\s*\{[^}]*\bBuffer\b[^}]*\}\s*from\s*['"]buffer['"]/.test(src);
    if (!imports) offenders.push(file.slice(root.length + 1));
  }
  assert.deepEqual(offenders, [], `these use Buffer without importing it: ${offenders.join(', ')}`);
});

test('the guard actually fires (control)', () => {
  // A guard that cannot fail is not a guard. Same detection over a fake source
  // that uses Buffer with no import must be caught.
  const bad = 'const x = Buffer.from("hi");';
  const stripped = bad.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/(?<![\w.'"])Buffer\s*[.<)\],;]/.test(stripped), 'detector must flag bare Buffer use');
  assert.ok(!/import\s*\{[^}]*\bBuffer\b[^}]*\}\s*from\s*['"]buffer['"]/.test(bad));
});
