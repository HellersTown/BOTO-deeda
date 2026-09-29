import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LADDER, EBAY_US_LADDER, incrementFor } from '../src/calculator.ts';
// A test-only read of the sibling package, the same way ingest's own
// function-libs test reads a file outside its package: the claim "the default
// ladder is money.ts's ladder" is exactly the kind that drifts silently.
import { defaultNextBidCents } from '../../ingest/src/money.ts';

test('DEFAULT_LADDER is exactly the ladder in ingest money.ts defaultNextBidCents', () => {
  const probes = new Set<number>([0, 1, 2499, 2500, 2501, 9999, 10000, 49999, 50000, 99999, 100000, 499999, 500000, 999999, 1000000, 123456789]);
  for (const r of DEFAULT_LADDER) {
    probes.add(r.fromCents);
    if (r.fromCents > 0) probes.add(r.fromCents - 1);
  }
  for (const c of probes) {
    assert.equal(incrementFor(c, DEFAULT_LADDER), (defaultNextBidCents(c) as number) - c, `increment at ${c} cents`);
  }
});

test('EBAY_US_LADDER is the section 5.2 table: 5 cents under $1 up to $100 from $5,000', () => {
  const table: [number, number][] = [
    [1, 5], [99, 5], [100, 25], [499, 25], [500, 50], [2499, 50], [2500, 100], [9999, 100],
    [10000, 250], [24999, 250], [25000, 500], [49999, 500], [50000, 1000], [99999, 1000],
    [100000, 2500], [249999, 2500], [250000, 5000], [499999, 5000], [500000, 10000],
  ];
  for (const [amount, inc] of table) assert.equal(incrementFor(amount, EBAY_US_LADDER), inc, `at ${amount}`);
});
