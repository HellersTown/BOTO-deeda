import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../src/rules.ts';
import { DOC_LOTS, NOW } from './fixtures.ts';

// docs/06 section 9.3: "It was run against 13 synthetic lots at now = 2026-09-27T18:00Z."
for (const d of DOC_LOTS) {
  test(`section 9.3: ${d.name} -> ${d.primary}, ceiling ${d.ceilingCents === null ? '-' : `$${d.ceilingCents / 100}`}`, () => {
    const r = evaluateRules(d.ctx, NOW);
    assert.equal(r.status, 'ok');
    assert.equal(r.primary?.code, d.primary);
    assert.equal(r.derived.max_hammer_cents ?? null, d.ceilingCents);
    const codes = r.fired.map((f) => f.code);
    for (const also of d.alsoFires) assert.ok(codes.includes(also), `${also} should also fire; fired ${codes.join(', ')}`);
  });
}

test('section 9.3: "Several ceilings are low ... the cause is the placeholder margins": each is labelled so', () => {
  for (const d of DOC_LOTS) {
    const r = evaluateRules(d.ctx, NOW);
    const primary = r.primary;
    if (primary === null || r.derived.max_hammer_cents === null) continue;
    if (d.ctx.estimatedResaleCents === undefined) continue; // budget-only ceilings do not rest on category values
    const ceilingRule = r.fired.find((f) => 'max_hammer_cents' in f.numbers || f.code === 'WALK_AWAY_UNECONOMIC');
    assert.ok(ceilingRule?.placeholder, `${d.name}: a ceiling built on PLACEHOLDER category values must say so`);
  }
});
