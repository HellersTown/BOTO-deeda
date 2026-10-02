/**
 * The proof that rules.ts implements the spec's formulas: the spec's own
 * `derived` expressions, run literally by the JSONLogic evaluator, must give
 * exactly the same value as the TypeScript for every derived name, on every lot.
 *
 * It is also the doc's strict harness ("raises on any null reaching arithmetic
 * or an ordering comparison"): the evaluator throws on an unguarded null, so a
 * lot that runs clean proves every expression it touched is guarded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmp, isRat } from '../src/exact.ts';
import { type Value, UNKNOWN, evaluate } from '../src/jsonlogic.ts';
import { solveCeiling } from '../src/calculator.ts';
import { resolveLot } from '../src/resolve.ts';
import { RULES, SPEC, deriveSpecValues, referenceDerive } from '../src/rules.ts';
import { DOC_LOTS, NOW, at, lcg } from './fixtures.ts';
import type { AuctionFormat, LotContext } from '../src/types.ts';

function same(a: unknown, b: Value): boolean {
  if (isRat(a) && isRat(b)) return cmp(a, b) === 0;
  return a === b;
}

function checkLot(ctx: LotContext, label: string): void {
  const lot = resolveLot(ctx);
  assert.deepEqual(lot.errors, [], label);
  assert.deepEqual(lot.missing, [], label);
  const ts = deriveSpecValues(lot, solveCeiling(lot), NOW);
  const ref = referenceDerive(lot.specInputs as unknown as Record<string, unknown>, NOW);
  assert.deepEqual(Object.keys(ts), SPEC.derived.map((d) => d.name), `${label}: derived names and order`);
  for (const name of Object.keys(ref)) {
    assert.ok(same(ts[name], ref[name] as Value), `${label}: ${name} differs (ts ${String(ts[name])}, spec ${String(ref[name])})`);
  }
  // Every rule's `when` runs clean on the reference values too.
  const data = { ...lot.specInputs, ...ref, constants: SPEC.constants };
  for (const rule of RULES) evaluate(rule.when, { data });
}

test('the TypeScript derived values equal the spec expressions on all 13 section 9.3 lots', () => {
  for (const d of DOC_LOTS) checkLot(d.ctx, d.name);
});

test('... and on 2,000 generated lots across every platform row, category and nullable input', () => {
  const rand = lcg(6);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const platforms = [...Object.keys(SPEC.platforms), 'unheard-of', 'hibid:timed', 'ebay:webcast'];
  const categories = [...Object.keys(SPEC.categories), 'tractors'];
  const formats: (AuctionFormat | null)[] = [null, 'online', 'live', 'sealed_bid', 'fixed_price'];
  for (let i = 0; i < 2000; i++) {
    const bidCount = Math.floor(rand() * 25);
    const ctx: LotContext = {
      sourcePlatform: pick(platforms),
      auctionFormat: rand() < 0.3 ? pick(formats) : null,
      category: pick(categories),
      currentBidCents: Math.floor(rand() * 3_000_000),
      bidCount,
      closesAt: at(Math.floor(rand() * 6000) - 300),
      softCloseMinutes: rand() < 0.5 ? null : pick([0, 1, 2, 3, 5, 10, 2.5]),
      buyerPremiumPct: rand() < 0.4 ? null : pick([0, 5, 10, 12.5, 15, 18, 20, 23.75]),
      hasReserve: rand() < 0.5 ? null : rand() < 0.5,
      reserveMet: rand() < 0.5 ? null : rand() < 0.5,
      distanceMiles: rand() < 0.4 ? null : Math.floor(rand() * 3000) / 10,
      pickupRequired: rand() < 0.5 ? null : true,
      imageCount: Math.floor(rand() * 6),
      descriptionWords: Math.floor(rand() * 30),
      // Odd cents on purpose: fractional-cent intermediate values are where floats go wrong.
      estimatedResaleCents: rand() < 0.2 ? null : Math.floor(rand() * 5_000_000),
      maxBudgetCents: rand() < 0.6 ? null : Math.floor(rand() * 5_000_000),
    };
    checkLot(ctx, `generated lot ${i} ${JSON.stringify(ctx)}`);
  }
});

test('the reference evaluator runs the spec verbatim, so an unguarded null in it would throw', () => {
  // Sanity check that the harness is strict: remove a guard and it must fail.
  const unguarded = { '>': [{ var: 'current_to_max_ratio' }, 0] };
  const lot = resolveLot(DOC_LOTS[7]!.ctx); // no value: current_to_max_ratio is null
  const ref = referenceDerive(lot.specInputs as unknown as Record<string, unknown>, NOW);
  assert.equal(ref.current_to_max_ratio, null);
  assert.throws(() => evaluate(unguarded, { data: { ...ref } }), /null reached/);
  assert.notEqual(UNKNOWN, null);
});
