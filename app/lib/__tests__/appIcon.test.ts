import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aliasFromValue,
  DEFAULT_ICON_VALUE,
  iconValue,
  parseAppIconChoices,
} from '../appIcon.ts';

// The direct edition's declaration: default gold Pro + a Standard alias.
const DIRECT = [
  { alias: null, label: 'Pro' },
  { alias: 'Standard', label: 'Standard' },
];

test('the direct-edition declaration parses to two choices, default first as declared', () => {
  assert.deepEqual(parseAppIconChoices(DIRECT), [
    { alias: null, label: 'Pro' },
    { alias: 'Standard', label: 'Standard' },
  ]);
});

test('the default is declared by OMITTING alias (what the direct build ships)', () => {
  assert.deepEqual(
    parseAppIconChoices([{ label: 'Pro' }, { alias: 'Standard', label: 'Standard' }]),
    [
      { alias: null, label: 'Pro' },
      { alias: 'Standard', label: 'Standard' },
    ],
  );
});

test('a null alias mangled to {} by the release config pipeline is refused, not guessed (control)', () => {
  // Observed in assets/app.config of the first direct vc5 APK: {"alias": {}, "label": "Pro"}.
  // Refusing it (fail closed: no row) is correct; the fix is the declaration, not the parser.
  assert.deepEqual(
    parseAppIconChoices([
      { alias: {}, label: 'Pro' },
      { alias: 'Standard', label: 'Standard' },
    ]),
    [],
  );
});

test('no declaration (the store build) means no choices, so no Setup row', () => {
  assert.deepEqual(parseAppIconChoices(undefined), []);
  assert.deepEqual(parseAppIconChoices(null), []);
  assert.deepEqual(parseAppIconChoices([]), []);
  assert.deepEqual(parseAppIconChoices('Standard'), []);
  assert.deepEqual(parseAppIconChoices({ alias: 'Standard', label: 'x' }), []);
});

test('fewer than two valid choices is not a choice', () => {
  assert.deepEqual(parseAppIconChoices([{ alias: null, label: 'Pro' }]), []);
  assert.deepEqual(parseAppIconChoices([{ alias: 'Standard', label: 'Standard' }]), []);
});

test('exactly one default is required: none or two cannot be expressed by the reset-to-null API', () => {
  assert.deepEqual(
    parseAppIconChoices([
      { alias: 'A', label: 'A' },
      { alias: 'B', label: 'B' },
    ]),
    [],
  );
  // two defaults collapse to one by de-dup, leaving a single choice -> []
  assert.deepEqual(
    parseAppIconChoices([
      { alias: null, label: 'One' },
      { alias: null, label: 'Two' },
    ]),
    [],
  );
});

test('malformed entries are dropped, never thrown on', () => {
  const raw = [
    { alias: null, label: 'Pro' },
    { alias: 'Standard', label: 'Standard' },
    { alias: '../Evil', label: 'nope' }, // alias must be a plain identifier (it becomes a class-name suffix)
    { alias: 'standard', label: 'nope' }, // must be PascalCase: the plugin PascalCases names, so this would point at a component that does not exist
    { alias: 'Bad Name', label: 'nope' },
    { alias: 'Ok', label: '' }, // empty label
    { alias: 'Ok2', label: 'x'.repeat(25) }, // over-long label
    { alias: 42, label: 'nope' },
    'garbage',
    null,
    { alias: 'Standard', label: 'Duplicate' }, // duplicate alias keeps the first
  ];
  assert.deepEqual(parseAppIconChoices(raw), [
    { alias: null, label: 'Pro' },
    { alias: 'Standard', label: 'Standard' },
  ]);
});

test('picker values round-trip; an unknown value is refused rather than sent to the native side', () => {
  const choices = parseAppIconChoices(DIRECT);
  assert.equal(iconValue(null), DEFAULT_ICON_VALUE);
  assert.equal(iconValue('Standard'), 'Standard');
  assert.equal(aliasFromValue(DEFAULT_ICON_VALUE, choices), null);
  assert.equal(aliasFromValue('Standard', choices), 'Standard');
  assert.equal(aliasFromValue('Nope', choices), undefined);
});

test('a preview KEY is kept; anything path-like or hostile is dropped (the choice stays, text fallback)', () => {
  const parsed = parseAppIconChoices([
    { label: 'Pro', preview: 'pro' },
    { alias: 'Standard', label: 'Standard', preview: 'standard' },
    { alias: 'Evil', label: 'Evil', preview: '../../assets/images/secret.png' },
    { alias: 'Up', label: 'Up', preview: 'Standard' }, // keys are lowercase identifiers
    { alias: 'Num', label: 'Num', preview: 42 },
  ]);
  assert.deepEqual(parsed, [
    { alias: null, label: 'Pro', preview: 'pro' },
    { alias: 'Standard', label: 'Standard', preview: 'standard' },
    { alias: 'Evil', label: 'Evil' },
    { alias: 'Up', label: 'Up' },
    { alias: 'Num', label: 'Num' },
  ]);
});

test('no preview declared is fine: choices parse exactly as before (the text-button fallback)', () => {
  assert.deepEqual(parseAppIconChoices([{ label: 'Pro' }, { alias: 'Standard', label: 'Standard' }]), [
    { alias: null, label: 'Pro' },
    { alias: 'Standard', label: 'Standard' },
  ]);
});
