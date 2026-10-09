import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LADDER,
  EBAY_US_LADDER,
  computeMaxBid,
  highestValidBid,
  incrementFor,
} from '../src/calculator.ts';
import { centsFields, lcg, lot } from './fixtures.ts';
import type { CalculatorResult, LotContext } from '../src/types.ts';

function assertNoFloats(r: CalculatorResult, label = ''): void {
  for (const [path, v] of centsFields(r)) {
    assert.ok(v === null || Number.isSafeInteger(v), `${label} ${path} = ${String(v)} is not whole cents`);
  }
}

// ---------------------------------------------------------------- the doc's worked example (section 4.2)

test('section 4.2, eBay tool lot: $300 comps -> $116 ceiling, $100 thirds cross-check', () => {
  const r = computeMaxBid({ sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: 30000, ships: true, buyerPremiumPct: 0 });
  assert.equal(r.status, 'ok');
  assert.equal(r.breakdown.netProceedsCents, 25800); // N = 300 x 0.86
  assert.equal(r.breakdown.profitTargetCents, 9000); // max(90, 25)
  assert.equal(r.breakdown.profitTargetBasis, 'margin');
  assert.equal(r.breakdown.riskReserveCents, 4500); // (10% + 5%) x 300
  assert.equal(r.breakdown.transportCents, 0);
  assert.equal(r.costMultiplier, 1.055);
  assert.equal(r.breakdown.maxHammerResaleCents, 11600);
  assert.equal(r.hammerCeilingCents, 11600);
  assert.equal(r.thirdsRuleCents, 10000);
});

test('section 4.2, HiBid tool lot 40 miles away: pickup priced honestly makes it worth $0', () => {
  const r = computeMaxBid({ sourcePlatform: 'hibid', category: 'tools', estimatedResaleCents: 20000, buyerPremiumPct: 18, distanceMiles: 40, pickupRequired: true });
  assert.equal(r.breakdown.transportCents, 8100); // 2 x 40 x $0.70 + $25
  assert.equal(r.costPer100Cents, 12822); // k = 1.18 x 1.055 x 1.03 = 1.282247
  assert.equal(r.hammerCeilingCents, 0);
  assert.equal(r.status, 'walk_away');
  assert.equal(r.maxBidCents, null);
  assert.match(r.reason ?? '', /Even at a \$0 hammer/);
  assert.equal(r.thirdsRuleCents, 6666);
});

test('section 4.2, Wisconsin Surplus coin lot: resale binds at $144 under a $200 budget ($167)', () => {
  const r = computeMaxBid({ sourcePlatform: 'wisconsin-surplus', category: 'coins_bullion', estimatedResaleCents: 30000, maxBudgetCents: 20000, buyerPremiumPct: 10, distanceMiles: 30, pickupRequired: true });
  assert.equal(r.breakdown.transportCents, 6700);
  assert.equal(r.breakdown.maxHammerResaleCents, 14400);
  assert.equal(r.breakdown.maxHammerBudgetCents, 16700);
  assert.equal(r.hammerCeilingCents, 14400);
  assert.equal(r.bindingCap, 'resale value');
});

// ---------------------------------------------------------------- premium + card fee + tax

test('premium, tax and card fee compound on top of the hammer: k = (1+bp)(1+t)(1+c), not their sum', () => {
  const r = computeMaxBid({ sourcePlatform: 'hibid', category: 'tools', estimatedResaleCents: 30000, buyerPremiumPct: 18, cardFeePct: 3, salesTaxPct: 5.5, ships: true, shippingCents: 0 });
  // Section 3 (S3): "At an 18% premium, 5.5% tax and a 3% card fee, k = 1.282, so a $100 bid is a $128 invoice."
  assert.equal(r.costMultiplier, 1.282247);
  assert.equal(r.costPer100Cents, 12822);
  assert.notEqual(r.costMultiplier, 1 + 0.18 + 0.055 + 0.03);
  // The solved hammer, grossed back up, fits inside the room; one more dollar would not.
  const room = r.breakdown.roomCents as number;
  const H = r.hammerCeilingCents as number;
  assert.ok(H * 1.282247 <= room + 0.5);
  assert.ok((H + 100) * 1.282247 > room);
});

test('the invoice at the max bid itemises premium, tax and card fee, and the lines add up exactly', () => {
  const r = computeMaxBid(lot({ buyerPremiumPct: 12.5, cardFeePct: 3.5, salesTaxPct: 5.6, estimatedResaleCents: 123457, distanceMiles: 7 }));
  const inv = r.invoiceAtMaxBid;
  assert.ok(inv !== null);
  assert.equal(inv.hammerCents + inv.premiumCents + inv.taxCents + inv.cardFeeCents, inv.totalCents);
  // Tax is on hammer + premium, the card fee on everything before it.
  assert.equal(inv.premiumCents, Math.round(inv.hammerCents * 0.125));
  assert.ok(Math.abs(inv.taxCents - (inv.hammerCents + inv.premiumCents) * 0.056) <= 1);
  assert.ok(Math.abs(inv.cardFeeCents - (inv.hammerCents + inv.premiumCents + inv.taxCents) * 0.035) <= 1);
  assert.equal(r.allInAtMaxBidCents, inv.totalCents + r.breakdown.transportCents);
});

test('a zero-rate line never picks up a rounding cent', () => {
  const r = computeMaxBid({ sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: 30000, ships: true, shippingCents: 0, buyerPremiumPct: 0 });
  assert.equal(r.invoiceAtMaxBid?.premiumCents, 0);
  assert.equal(r.invoiceAtMaxBid?.cardFeeCents, 0);
});

test('a sales tax with three decimals (8.875%) is exact, and an exempt reseller can set 0', () => {
  const nyc = computeMaxBid(lot({ salesTaxPct: 8.875 }));
  assert.equal(nyc.rates.salesTaxPct, 8.875);
  const exempt = computeMaxBid(lot({ salesTaxPct: 0 }));
  assert.equal(exempt.rates.salesTaxPct, 0);
  assert.ok((exempt.hammerCeilingCents as number) >= (nyc.hammerCeilingCents as number));
  assert.equal(exempt.parameters.find((p) => p.name === 'sales_tax_rate')?.status, 'LOT');
});

// ---------------------------------------------------------------- walk away

test('zero room means walk away, with the reason spelled out', () => {
  // N - P - T - X = 0 exactly: tools, R = 10000 -> N 8600, P 3000, X 1500, so T must be 4100.
  const r = computeMaxBid(lot({ estimatedResaleCents: 10000, pickupCostCents: 4100, distanceMiles: null }));
  assert.equal(r.breakdown.roomCents, 0);
  assert.equal(r.hammerCeilingCents, 0);
  assert.equal(r.status, 'walk_away');
  assert.equal(r.maxBidCents, null);
});

test('negative room also means walk away, never a negative ceiling', () => {
  const r = computeMaxBid(lot({ estimatedResaleCents: 5000, distanceMiles: 100 }));
  assert.ok((r.breakdown.roomCents as number) < 0);
  assert.equal(r.hammerCeilingCents, 0);
  assert.equal(r.status, 'walk_away');
});

test('a ceiling under one dollar floors to $0: users never see a ceiling in cents', () => {
  // Room of 99 cents at k = 1 cannot buy a $1 hammer.
  const r = computeMaxBid(lot({ sourcePlatform: 'ebay', buyerPremiumPct: 0, salesTaxPct: 0, estimatedResaleCents: 10000, pickupCostCents: 4001, distanceMiles: null }));
  assert.equal(r.breakdown.roomCents, 99);
  assert.equal(r.hammerCeilingCents, 0);
});

test('when the next bid is already over the ceiling, the answer is walk away, not a lower number', () => {
  const r = computeMaxBid(lot({ currentBidCents: 8000 })); // next bid 8100 > $72 ceiling
  assert.equal(r.hammerCeilingCents, 7200);
  assert.equal(r.nextMinBidCents, 8100);
  assert.equal(r.status, 'walk_away');
  assert.equal(r.maxBidCents, null);
  assert.match(r.reason ?? '', /next bid would be \$81\.00; your ceiling is \$72\.00/);
});

// ---------------------------------------------------------------- missing value

test('no value estimate and no budget: null walk-away, and the reason says what to add', () => {
  const r = computeMaxBid(lot({ estimatedResaleCents: null }));
  assert.equal(r.status, 'insufficient_data');
  assert.equal(r.maxBidCents, null);
  assert.equal(r.hammerCeilingCents, null);
  assert.match(r.reason ?? '', /SOLD prices/);
  assert.equal(r.breakdown.netProceedsCents, null);
});

test('a zero value is treated as missing, the way the spec defines has_value (> 0)', () => {
  assert.equal(computeMaxBid(lot({ estimatedResaleCents: 0 })).status, 'insufficient_data');
});

test('a budget alone gives a ceiling, flagged as not checking what the lot is worth', () => {
  const r = computeMaxBid(lot({ estimatedResaleCents: null, maxBudgetCents: 10000 }));
  assert.equal(r.bindingCap, 'budget');
  assert.equal(r.hammerCeilingCents, 8000); // 10000 / 1.2496475 = 8002.3
  assert.ok(r.warnings.some((w) => /only from your budget/.test(w)));
  assert.deepEqual(r.placeholders, ['card_fee_rate']); // no category placeholders behind a budget ceiling
});

test('a tie between budget and resale is won by the budget, as the spec has it (<=)', () => {
  const r = computeMaxBid(lot({ maxBudgetCents: 9000 }));
  // 9000 / 1.2496475 = 7202.0 -> $72, same as the resale ceiling.
  assert.equal(r.breakdown.maxHammerBudgetCents, 7200);
  assert.equal(r.breakdown.maxHammerResaleCents, 7200);
  assert.equal(r.bindingCap, 'budget');
});

// ---------------------------------------------------------------- increment rounding

test('the walk-away bid is rounded down to the money.ts ladder: $72 -> $70 in $5 steps', () => {
  const r = computeMaxBid(lot());
  assert.equal(r.hammerCeilingCents, 7200);
  assert.equal(r.maxBidCents, 7000);
  assert.equal(r.ladder, 'default');
  assert.equal(r.parameters.find((p) => p.name === 'increment_ladder')?.status, 'INTERNAL');
});

test('rounding follows each band of the ladder', () => {
  assert.equal(highestValidBid(11600), 11000); // $10 steps from $100
  assert.equal(highestValidBid(14400), 14000);
  assert.equal(highestValidBid(2400), 2250); // $2.50 steps under $25
  assert.equal(highestValidBid(4739300), 4725000); // $250 steps from $10,000: $47,393 -> $47,250
  assert.equal(highestValidBid(99999), 97500); // $25 steps from $500
  assert.equal(highestValidBid(100000), 100000);
});

test('never rounded below the next acceptable bid, which is valid by definition', () => {
  assert.equal(highestValidBid(11600, DEFAULT_LADDER, 11500), 11500);
  assert.equal(highestValidBid(11600, DEFAULT_LADDER, 11700), null);
  const r = computeMaxBid(lot({ currentBidCents: 7050, bidCount: 4 })); // next bid 7150 <= $72
  assert.equal(r.nextMinBidCents, 7150);
  assert.equal(r.maxBidCents, 7150);
});

test('the ladder is overridable; the spec eBay ladder gives $115 for a $116 ceiling', () => {
  const r = computeMaxBid(
    { sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: 30000, ships: true, shippingCents: 0, buyerPremiumPct: 0 },
    { ladder: EBAY_US_LADDER },
  );
  assert.equal(r.maxBidCents, 11500);
  assert.equal(r.ladder, 'custom');
  const none = computeMaxBid({ sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: 30000, ships: true, shippingCents: 0 }, { ladder: null });
  assert.equal(none.maxBidCents, 11600);
  assert.equal(none.ladder, 'none');
  assert.throws(() => computeMaxBid(lot(), { ladder: [{ fromCents: 5, incrementCents: 1 }] }), TypeError);
});

test('sealed bids and tag prices are not rounded: any amount is a valid offer', () => {
  const sealed = computeMaxBid(lot({ sourcePlatform: 'public-surplus', auctionFormat: 'sealed_bid', bidCount: 0, currentBidCents: 1000 }));
  assert.equal(sealed.hammerCeilingCents, 7200);
  assert.equal(sealed.maxBidCents, 7200);
  assert.equal(sealed.ladder, 'none');
  const tag = computeMaxBid(lot({ sourcePlatform: 'estatesales-net', currentBidCents: 5000, bidCount: null }));
  assert.equal(tag.maxBidCents, tag.hammerCeilingCents);
  // A platform with no sealed variant in the spec falls back to its base row, as platform_attr does.
  const hibidSealed = computeMaxBid(lot({ auctionFormat: 'sealed_bid' }));
  assert.equal(hibidSealed.maxBidCents, 7000);
});

test('incrementFor reads the ladder rung for an amount', () => {
  assert.equal(incrementFor(0), 250);
  assert.equal(incrementFor(2499), 250);
  assert.equal(incrementFor(2500), 500);
  assert.equal(incrementFor(1000000), 25000);
  assert.equal(incrementFor(4000, EBAY_US_LADDER), 100);
  assert.throws(() => incrementFor(-1), RangeError);
  assert.throws(() => incrementFor(1.5), RangeError);
});

// ---------------------------------------------------------------- huge values and no floats

test('huge values are exact: a $90 trillion value computes to the cent', () => {
  const R = 9_000_000_000_000_000; // under Number.MAX_SAFE_INTEGER
  const r = computeMaxBid({ sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: R, ships: true, shippingCents: 0, buyerPremiumPct: 0 });
  // Independent BigInt working: room = R x (0.86 - 0.30 - 0.15) = 0.41 R; H = floor_to_dollar(room / 1.055).
  const room = (BigInt(R) * 41n) / 100n;
  const H = ((room * 1000n) / (1055n * 100n)) * 100n;
  assert.equal(r.breakdown.roomCents, Number(room));
  assert.equal(r.hammerCeilingCents, Number(H));
  assertNoFloats(r, 'huge');
});

test('a budget of Number.MAX_SAFE_INTEGER cents still solves exactly', () => {
  const r = computeMaxBid(lot({ estimatedResaleCents: null, maxBudgetCents: Number.MAX_SAFE_INTEGER }));
  assert.ok(Number.isSafeInteger(r.hammerCeilingCents));
  assert.equal((r.hammerCeilingCents as number) % 100, 0);
});

test('every cents field of every result is a whole number, across a thousand random lots', () => {
  const rand = lcg(20260927);
  const platforms = ['ebay', 'hibid', 'gsa', 'govdeals', 'maxsold', 'public-surplus', 'auctionninja', 'estatesales', 'nowhere'];
  const cats = ['tools', 'electronics', 'vehicles', 'furniture', 'coins_bullion', 'jewelry', 'aircraft', 'mystery'];
  for (let i = 0; i < 1000; i++) {
    const ctx: LotContext = {
      sourcePlatform: platforms[Math.floor(rand() * platforms.length)],
      category: cats[Math.floor(rand() * cats.length)],
      estimatedResaleCents: rand() < 0.9 ? Math.floor(rand() * 5_000_000) : null,
      maxBudgetCents: rand() < 0.3 ? Math.floor(rand() * 5_000_000) : null,
      buyerPremiumPct: rand() < 0.5 ? Math.round(rand() * 2500) / 100 : null,
      cardFeePct: rand() < 0.2 ? Math.round(rand() * 400) / 100 : null,
      salesTaxPct: rand() < 0.2 ? Math.round(rand() * 10000) / 1000 : null,
      distanceMiles: rand() < 0.6 ? Math.round(rand() * 2000) / 10 : null,
      pickupRequired: rand() < 0.5,
      costPerMileCents: rand() < 0.2 ? 65.5 : null,
      repairCents: rand() < 0.1 ? Math.floor(rand() * 50000) : null,
      currentBidCents: Math.floor(rand() * 1_000_000),
      bidCount: Math.floor(rand() * 30),
    };
    const r = computeMaxBid(ctx);
    assertNoFloats(r, `lot ${i}`);
    if (r.status === 'ok' && r.profitAtMaxBidCents !== null && r.breakdown.profitTargetCents !== null) {
      // At the max bid, the target is still met (rounding is monotone, so this holds on screen too).
      assert.ok(r.profitAtMaxBidCents >= r.breakdown.profitTargetCents, `lot ${i} misses its target`);
    }
    if (r.status === 'ok') assert.ok((r.maxBidCents as number) <= (r.hammerCeilingCents as number));
  }
});

test('the doc formula run in floats floors this lot to $19; exact arithmetic gives the true $20', () => {
  // Room 2390.63 cents, k 1.195315: the quotient is exactly 2000 cents.
  const r = computeMaxBid({ sourcePlatform: 'hibid', category: 'tools', estimatedResaleCents: 15343, buyerPremiumPct: 10, distanceMiles: 10, pickupRequired: true });
  assert.equal(r.hammerCeilingCents, 2000);
});

// ---------------------------------------------------------------- the user's own numbers

test('targetMarginPct and minProfitCents replace the category placeholders and are labelled USER', () => {
  const r = computeMaxBid(lot({ targetMarginPct: 20 }));
  assert.equal(r.breakdown.profitTargetCents, 6000);
  assert.equal(r.parameters.find((p) => p.name === 'category.target_margin_rate')?.status, 'USER');
  assert.ok(!r.placeholders.includes('category.target_margin_rate'));
  const floorOnly = computeMaxBid(lot({ targetMarginPct: 1, minProfitCents: 5000 }));
  assert.equal(floorOnly.breakdown.profitTargetCents, 5000);
  assert.equal(floorOnly.breakdown.profitTargetBasis, 'minimum');
});

test('a repair estimate replaces the r x R reserve; the uncertainty haircut stays', () => {
  const r = computeMaxBid(lot({ repairCents: 2000 }));
  assert.equal(r.breakdown.uncertaintyReserveCents, 3000);
  assert.equal(r.breakdown.repairReserveCents, 2000);
  assert.equal(r.breakdown.riskReserveCents, 5000);
  assert.ok(r.parameters.some((p) => p.name === 'user.repair_cents'));
});

test('pickup: distance x cost per mile (fractional cents allowed) + time, or the user\'s own trip cost', () => {
  const irs2023 = computeMaxBid(lot({ distanceMiles: 12.35, costPerMileCents: 65.5, timeValueCents: 4000 }));
  // 2 x 12.35 x 65.5 + 4000 = 5617.85 -> shown as 5618; the ceiling uses the exact value.
  assert.equal(irs2023.breakdown.transportCents, 5618);
  assert.equal(irs2023.breakdown.transportBasis, 'distance');
  const own = computeMaxBid(lot({ pickupCostCents: 1234 }));
  assert.equal(own.breakdown.transportCents, 1234);
  assert.equal(own.breakdown.transportBasis, 'pickup_cost');
});

test('shipping: a shipping quote stands in for pickup; with none, the gap is a warning', () => {
  const shipped = computeMaxBid(lot({ ships: true, pickupRequired: false, shippingCents: 2500 }));
  assert.equal(shipped.breakdown.transportCents, 2500);
  assert.equal(shipped.breakdown.transportBasis, 'shipping');
  const unquoted = computeMaxBid(lot({ ships: true, pickupRequired: false }));
  assert.equal(unquoted.breakdown.transportCents, 0);
  assert.ok(unquoted.warnings.some((w) => /inbound shipping is not in the ceiling/.test(w)));
  const noDistance = computeMaxBid(lot({ distanceMiles: null }));
  assert.ok(noDistance.warnings.some((w) => /distance is unknown/.test(w)));
});

test('personal use: no resale fees or profit target, so all-in at the ceiling stays under the fixed-price alternative (S2)', () => {
  const r = computeMaxBid(lot({ userGoal: 'use', estimatedValueCents: 30000, estimatedResaleCents: null }));
  assert.equal(r.breakdown.sellFeesCents, 0);
  assert.equal(r.breakdown.profitTargetCents, 0);
  assert.ok((r.allInAtMaxBidCents as number) <= 30000);
  assert.equal(r.parameters.find((p) => p.name === 'category.sell_fee_rate')?.status, 'DESIGN');
  const wantsDiscount = computeMaxBid(lot({ userGoal: 'use', estimatedValueCents: 30000, targetMarginPct: 20 }));
  assert.equal(wantsDiscount.breakdown.profitTargetCents, 6000);
});

test('calibrated overrides replace a PLACEHOLDER and the label changes to OVERRIDE', () => {
  const r = computeMaxBid(lot(), { overrides: { categories: { tools: { sell_fee_rate: 0.1325 } }, constants: { pickup_time_cost_cents: 3000 } } });
  assert.equal(r.parameters.find((p) => p.name === 'category.sell_fee_rate')?.status, 'OVERRIDE');
  assert.equal(r.parameters.find((p) => p.name === 'constants.pickup_time_cost_cents')?.status, 'OVERRIDE');
  assert.equal(r.breakdown.sellFeesCents, 3975);
});

test('PLACEHOLDER parameters behind a default ceiling are listed so the UI can mark it unverified', () => {
  const r = computeMaxBid(lot({ buyerPremiumPct: null }));
  for (const name of ['buyer_premium_pct', 'card_fee_rate', 'category.target_margin_rate', 'category.uncertainty_haircut_rate', 'constants.pickup_time_cost_cents']) {
    assert.ok(r.placeholders.includes(name), `${name} should be flagged`);
  }
  assert.ok(r.unverified.includes('sales_tax_rate'));
  assert.ok(r.unverified.includes('constants.mileage_cost_cents_per_mile'));
  assert.ok(r.warnings.some((w) => /premium was not captured/.test(w)));
});

// ---------------------------------------------------------------- bad input

test('invalid input returns invalid_input and no numbers at all', () => {
  const cases: [Partial<LotContext>, RegExp][] = [
    [{ estimatedResaleCents: -100 }, /estimatedResaleCents/],
    [{ currentBidCents: 19.99 }, /currentBidCents/],
    [{ buyerPremiumPct: 150 }, /buyerPremiumPct/],
    [{ distanceMiles: Number.NaN }, /distanceMiles/],
    [{ userGoal: 'flip' as never }, /userGoal/],
    [{ pickupRequired: 'yes' as never }, /pickupRequired/],
  ];
  for (const [bad, re] of cases) {
    const r = computeMaxBid(lot(bad));
    assert.equal(r.status, 'invalid_input');
    assert.equal(r.maxBidCents, null);
    assert.equal(r.hammerCeilingCents, null);
    assert.match(r.errors.join(' '), re);
  }
});
