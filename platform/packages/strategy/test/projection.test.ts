import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMaxBid, projectAtHammer } from '../src/calculator.ts';
import { centsFields, lcg } from './fixtures.ts';
import type { LotContext } from '../src/types.ts';

// The doc's section 4.2 tool lot: $300 comps, 0% premium, ships, so no trip.
const TOOL_LOT: LotContext = { sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: 30000, ships: true, buyerPremiumPct: 0 };

test('at the max bid, the projection is exactly profitAtMaxBidCents', () => {
  const r = computeMaxBid(TOOL_LOT);
  assert.equal(r.status, 'ok');
  const p = projectAtHammer(TOOL_LOT, r.maxBidCents as number);
  assert.equal(p.status, 'ok');
  assert.equal(p.profitCents, r.profitAtMaxBidCents);
  assert.equal(p.allInCents, r.allInAtMaxBidCents);
  assert.deepEqual(p.invoice, r.invoiceAtMaxBid);
});

test('section 4.2 numbers: N 258.00, X 45.00, k 1.055; at a $50 hammer the profit is $160.25', () => {
  const p = projectAtHammer(TOOL_LOT, 5000);
  assert.equal(p.netProceedsCents, 25800);
  assert.equal(p.riskReserveCents, 4500);
  assert.equal(p.transportCents, 0);
  assert.equal(p.invoice?.totalCents, 5275); // 50 x 1.055
  assert.equal(p.allInCents, 5275);
  assert.equal(p.profitCents, 25800 - 5275 - 4500);
  assert.ok(Math.abs((p.returnOnCost as number) - 16025 / 5275) < 1e-12);
});

test('profit falls as the hammer rises, by hammer x k', () => {
  const rnd = lcg(7);
  let last = Infinity;
  for (let h = 0; h <= 30000; h += 100 + Math.floor(rnd() * 900)) {
    const p = projectAtHammer(TOOL_LOT, h);
    assert.ok((p.profitCents as number) < last, `profit at ${h} should be below the previous step`);
    last = p.profitCents as number;
  }
});

test('the pickup trip is a cost: distance adds transport and lowers profit', () => {
  const shipped = projectAtHammer(TOOL_LOT, 5000);
  const driven = projectAtHammer({ ...TOOL_LOT, ships: false, distanceMiles: 40 }, 5000);
  assert.ok(driven.transportCents > 0);
  assert.equal(driven.allInCents, (driven.invoice?.totalCents as number) + driven.transportCents);
  assert.equal((shipped.profitCents as number) - (driven.profitCents as number), driven.transportCents);
});

test('personal use: the saving against the fixed-price alternative, with no selling costs', () => {
  const ctx: LotContext = { ...TOOL_LOT, estimatedResaleCents: null, estimatedValueCents: 30000, userGoal: 'use' };
  const p = projectAtHammer(ctx, 5000);
  assert.equal(p.status, 'ok');
  assert.equal(p.userGoal, 'use');
  assert.equal(p.netProceedsCents, 30000); // no fees, no outbound shipping
  assert.equal(p.profitCents, 30000 - 5275 - (p.riskReserveCents as number));
  const r = computeMaxBid(ctx);
  assert.equal(projectAtHammer(ctx, r.maxBidCents as number).profitCents, r.profitAtMaxBidCents);
});

test('without a value it still prices the invoice, but projects no profit', () => {
  const p = projectAtHammer({ ...TOOL_LOT, estimatedResaleCents: null }, 5000);
  assert.equal(p.status, 'insufficient_data');
  assert.equal(p.profitCents, null);
  assert.equal(p.returnOnCost, null);
  assert.equal(p.allInCents, 5275);
});

test('a bad hammer or a bad lot is invalid_input, never a number', () => {
  for (const h of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    const p = projectAtHammer(TOOL_LOT, h);
    assert.equal(p.status, 'invalid_input', `hammer ${h}`);
    assert.equal(p.profitCents, null);
    assert.ok(p.errors.length > 0);
  }
  const bad = projectAtHammer({ ...TOOL_LOT, estimatedResaleCents: -5 }, 5000);
  assert.equal(bad.status, 'invalid_input');
});

test('every money field is whole cents', () => {
  const rnd = lcg(11);
  for (let i = 0; i < 200; i++) {
    const ctx: LotContext = {
      sourcePlatform: 'hibid',
      category: 'tools',
      estimatedResaleCents: 1000 + Math.floor(rnd() * 500000),
      buyerPremiumPct: Math.floor(rnd() * 25),
      salesTaxPct: 5.5,
      distanceMiles: Math.floor(rnd() * 120),
      ships: false,
    };
    const p = projectAtHammer(ctx, Math.floor(rnd() * 200000));
    for (const [path, v] of centsFields(p)) {
      if (path.endsWith('returnOnCost')) continue;
      assert.ok(v === null || Number.isSafeInteger(v), `${path} = ${String(v)}`);
    }
  }
});
