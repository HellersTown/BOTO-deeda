import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EVIDENCE_STATUS, LABEL_FOR_RULES_WITHOUT_EVIDENCE, SPEC } from '../src/spec.ts';
import { RULES } from '../src/rules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, '..', '..', '..', 'docs', '06-bidding-strategies.md');

function specFromDoc(): unknown {
  const lines = readFileSync(docPath, 'utf8').split('\n');
  const start = lines.indexOf('### 9.2 The spec');
  assert.ok(start >= 0, 'docs/06 no longer has a "### 9.2 The spec" heading');
  const open = lines.indexOf('```json', start);
  const close = lines.indexOf('```', open + 1);
  assert.ok(open > start && close > open, 'could not find the JSON block under 9.2');
  return JSON.parse(lines.slice(open + 1, close).join('\n'));
}

test('the embedded spec is exactly the JSON block in docs/06 section 9.2', () => {
  // If this fails, the doc changed: re-copy the block into src/spec.ts. Editing
  // values in spec.ts alone would let the code and the documented rules drift.
  assert.deepEqual(SPEC, specFromDoc());
});

test('RULES is the spec rules array itself, all 32 of them, with unique ids and priorities', () => {
  assert.equal(RULES, SPEC.rules);
  assert.equal(RULES.length, 32);
  assert.equal(new Set(RULES.map((r) => r.id)).size, 32);
  assert.equal(new Set(RULES.map((r) => r.priority)).size, 32);
});

test('every evidence id a rule cites is in evidence_index and has a label', () => {
  for (const rule of RULES) {
    for (const id of rule.evidence) {
      assert.ok(id in SPEC.evidence_index, `${rule.id} cites unknown evidence ${id}`);
      assert.ok(id in EVIDENCE_STATUS, `${id} has no label`);
    }
    if (rule.evidence.length === 0) assert.ok(rule.id in LABEL_FOR_RULES_WITHOUT_EVIDENCE, `${rule.id} needs a label`);
  }
  assert.deepEqual(Object.keys(EVIDENCE_STATUS).sort(), Object.keys(SPEC.evidence_index).sort());
});

test('every PLACEHOLDER in constants_meta is a named constant, so it can be overridden', () => {
  const placeholders = Object.entries(SPEC.constants_meta)
    .filter(([, m]) => m.status === 'PLACEHOLDER')
    .map(([k]) => k)
    .sort();
  assert.deepEqual(placeholders, [
    'bp_unknown_assumed_pct',
    'card_fee_unknown_assumed_rate',
    'pickup_time_cost_cents',
    'reserve_stop_ratio',
    'tag_final_day_discount_rate',
    'transport_share_warn',
  ]);
  for (const k of placeholders) assert.ok(k in SPEC.constants);
  assert.equal(SPEC.categories_meta.status, 'PLACEHOLDER');
});
