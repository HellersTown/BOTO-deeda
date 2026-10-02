import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, portfolioExposure, recommend, strategyById } from '../src/strategies.ts';
import { computeMaxBid } from '../src/calculator.ts';
import { EVIDENCE_STATUS, RULES, SPEC } from '../src/rules.ts';
import { NOW, at, lot } from './fixtures.ts';
import type { LotContext, RankedStrategy, StrategyId } from '../src/types.ts';

const tested = new Set<string>();

function strategyTest(id: StrategyId, title: string, fn: () => void): void {
  tested.add(id);
  test(`${id} ${strategyById(id).name}: ${title}`, fn);
}

const applicable = (ctx: LotContext): readonly RankedStrategy[] => recommend(ctx, NOW).strategies;
const has = (ctx: LotContext, id: StrategyId): RankedStrategy => {
  const s = applicable(ctx).find((x) => x.id === id);
  assert.ok(s, `${id} should apply; got ${applicable(ctx).map((x) => x.id).join(',')}`);
  return s;
};
const lacks = (ctx: LotContext, id: StrategyId): void => {
  const got = applicable(ctx).map((x) => x.id);
  assert.ok(!got.includes(id), `${id} should not apply; got ${got.join(',')}`);
};

// ---------------------------------------------------------------- the library as data

test('there are 21 strategies, S1 to S21 in order, with names, summaries and conditions', () => {
  assert.deepEqual(STRATEGIES.map((s) => s.id), Array.from({ length: 21 }, (_, i) => `S${i + 1}`));
  for (const s of STRATEGIES) {
    assert.ok(s.name.length > 0 && s.summary.length > 0 && s.appliesTo.length > 0 && s.message.length > 0, s.id);
    assert.equal(s.when === null, s.scope !== 'lot', `${s.id}: only lot strategies carry a per-lot condition`);
  }
});

test('every rule a strategy names exists, and every rule but R00 and R42 belongs to a strategy', () => {
  const ruleIds = new Set(RULES.map((r) => r.id));
  const owned = new Set<string>();
  for (const s of STRATEGIES) {
    for (const r of s.rules) {
      assert.ok(ruleIds.has(r), `${s.id} names unknown rule ${r}`);
      owned.add(r);
    }
  }
  // R00 (record the result) and R42 (vehicle paperwork, a section 8.1 red flag) belong to no section 2 strategy.
  assert.deepEqual([...ruleIds].filter((r) => !owned.has(r)).sort(), ['R00', 'R42']);
});

test('evidence ids exist, and a strategy labelled SE cites at least one SE source', () => {
  for (const s of STRATEGIES) {
    for (const e of s.evidence) assert.ok(e in SPEC.evidence_index, `${s.id}: ${e}`);
    if (s.evidenceLabel === 'SE') assert.ok(s.evidence.some((e) => EVIDENCE_STATUS[e] === 'SE'), s.id);
  }
  assert.equal(strategyById('S19').evidenceLabel, 'DESIGN'); // "Rule (DESIGN)"
  assert.equal(strategyById('S21').evidenceLabel, 'UNVERIFIED');
  assert.equal(strategyById('S21').displayAs, 'cross-check');
  assert.equal(strategyById('S14').displayAs, 'prose');
});

test('confidence follows the doc: high for S1, S2, S3, S5, S12, S17, S18; unverified for S21', () => {
  const conf = Object.fromEntries(STRATEGIES.map((s) => [s.id, s.confidence]));
  for (const id of ['S1', 'S2', 'S3', 'S5', 'S12', 'S17', 'S18']) assert.equal(conf[id], 'high', id);
  assert.equal(conf.S4, 'medium');
  assert.equal(conf.S6, 'medium-high');
  assert.equal(conf.S21, 'unverified');
});

// ---------------------------------------------------------------- one test per strategy

strategyTest('S1', 'applies to every open lot; not to a closed one', () => {
  const s = has(lot(), 'S1');
  assert.ok(s.placeholder, 'the default ceiling rests on PLACEHOLDER category values');
  lacks(lot({ closesAt: at(-1) }), 'S1');
});

strategyTest('S2', 'applies to a personal-use buyer, or when all-in already reaches the value', () => {
  has(lot({ userGoal: 'use', estimatedValueCents: 30000 }), 'S2');
  has(lot({ currentBidCents: 26000 }), 'S2'); // R30 fires
  lacks(lot(), 'S2');
});

strategyTest('S3', 'applies whenever fees or pickup sit on top of the hammer', () => {
  assert.match(has(lot(), 'S3').message, /Every \$100 of hammer costs about \$124\.96/);
  lacks(lot({ sourcePlatform: 'ebay', buyerPremiumPct: 0, salesTaxPct: 0, ships: true, pickupRequired: false, shippingCents: 0 }), 'S3');
});

strategyTest('S4', 'applies to a biddable hard close with a precise time; not to a date-only one', () => {
  const s = has(lot({ sourcePlatform: 'ebay' }), 'S4');
  assert.equal(s.alert.kind, 'hard_close');
  assert.equal(s.alert.secondsBefore, 120);
  lacks(lot({ sourcePlatform: 'ebay', closeTimePrecise: false }), 'S4');
  lacks(lot(), 'S4');
});

strategyTest('S5', 'applies to a biddable extending close, before or inside the window', () => {
  const s = has(lot(), 'S5');
  assert.equal(s.alert.secondsBefore, 480);
  assert.match(s.message, /at least 4 minutes before the scheduled close/);
  has(lot({ closesAt: at(2) }), 'S5');
  lacks(lot({ sourcePlatform: 'ebay' }), 'S5');
  lacks(lot({ currentBidCents: 9000 }), 'S5'); // walk away: no bid to time
});

strategyTest('S6', 'applies to online formats while there is a bid to make', () => {
  has(lot(), 'S6');
  has(lot({ auctionFormat: 'live' }), 'S6');
  lacks(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid', bidCount: 0 }), 'S6');
  lacks(lot({ currentBidCents: 9000 }), 'S6');
});

strategyTest('S7', 'applies to a timed lot with more than a day left', () => {
  has(lot({ closesAt: at(2 * 1440) }), 'S7');
  lacks(lot({ closesAt: at(600) }), 'S7');
  // The threshold is a DESIGN choice and overridable.
  const r = recommend(lot({ closesAt: at(600) }), NOW, { strategyParameters: { multi_day_minutes: 300 } });
  const s7 = r.strategies.find((s) => s.id === 'S7');
  assert.equal(s7?.parameters.find((p) => p.name === 'strategy.multi_day_minutes')?.status, 'OVERRIDE');
});

strategyTest('S8', 'applies to a crowded lot', () => {
  assert.ok(has(lot({ bidCount: 15 }), 'S8').placeholder, 'the herd threshold is a PLACEHOLDER');
  lacks(lot(), 'S8');
});

strategyTest('S9', 'applies to absolute auctions and $1 starts', () => {
  has(lot(), 'S9'); // hasReserve: false
  has(lot({ hasReserve: null, startingBidCents: 100 }), 'S9');
  lacks(lot({ hasReserve: true, reserveMet: true, startingBidCents: 500 }), 'S9');
});

strategyTest('S10', 'applies to thin listings, no-photo high-risk lots and quiet lots near the close', () => {
  has(lot({ bidCount: 0, descriptionWords: 6 }), 'S10'); // R34
  has(lot({ category: 'electronics', imageCount: 0 }), 'S10'); // R33
  has(lot({ bidCount: 1 }), 'S10'); // R45: quiet, 10 hours left
  lacks(lot(), 'S10');
});

strategyTest('S11', 'is a hunting practice, never applicable to a single lot', () => {
  assert.equal(strategyById('S11').scope, 'hunt');
  lacks(lot({ descriptionWords: 3, bidCount: 0 }), 'S11');
});

strategyTest('S12', 'applies where the category haircut is 15% or more', () => {
  assert.match(has(lot({ category: 'jewelry' }), 'S12').message, /25\.0% uncertainty haircut/);
  lacks(lot(), 'S12');
});

strategyTest('S13', 'applies while a reserve is not met', () => {
  has(lot({ hasReserve: true, reserveMet: false }), 'S13');
  lacks(lot({ hasReserve: true, reserveMet: true }), 'S13');
});

strategyTest('S14', 'is a prose caution on timed proxy lots', () => {
  assert.equal(has(lot(), 'S14').displayAs, 'prose');
  lacks(lot({ auctionFormat: 'live' }), 'S14');
});

strategyTest('S15', 'applies to extending closes', () => {
  has(lot(), 'S15');
  lacks(lot({ sourcePlatform: 'ebay' }), 'S15');
});

strategyTest('S16', 'is a watch-list heuristic, never applicable to a single lot', () => {
  assert.equal(strategyById('S16').scope, 'hunt');
  lacks(lot({ closesAt: at(30) }), 'S16');
});

strategyTest('S17', 'applies to pickup lots, including government surplus with no shipping', () => {
  has(lot(), 'S17');
  has(lot({ sourcePlatform: 'gsa', pickupRequired: null, distanceMiles: null }), 'S17');
  has(lot({ sourcePlatform: 'custom', sourceTier: 'county', pickupRequired: null, distanceMiles: null }), 'S17');
  lacks(lot({ ships: true, pickupRequired: false, distanceMiles: null, shippingCents: 1000 }), 'S17');
});

strategyTest('S18', 'applies on the five government-surplus platforms', () => {
  for (const p of ['gsa', 'govdeals', 'public-surplus', 'municibid', 'wisconsin-surplus']) has(lot({ sourcePlatform: p }), 'S18');
  lacks(lot(), 'S18');
});

strategyTest('S19', 'spans several lots: exposure charges one trip per pickup site', () => {
  assert.equal(strategyById('S19').scope, 'portfolio');
  const a = computeMaxBid(lot());
  const b = computeMaxBid(lot({ estimatedResaleCents: 40000 }));
  const gone = computeMaxBid(lot({ currentBidCents: 9000 }));
  // $70 and $100 max bids (ceilings $72 and $105, on $5 and $10 steps): invoices
  // $87.48 and $124.96, and one $32 trip for the shared site.
  assert.equal(a.invoiceAtMaxBid?.totalCents, 8748);
  assert.equal(b.invoiceAtMaxBid?.totalCents, 12496);
  const invoices = 8748 + 12496;
  const shared = portfolioExposure([{ walkAway: a, siteKey: 'depot' }, { walkAway: b, siteKey: 'depot' }, { walkAway: gone }], invoices + 3200);
  assert.equal(shared.liveBids, 2); // the walk-away lot has no live bid
  assert.equal(shared.sites, 1);
  assert.equal(shared.exposureCents, invoices + 3200);
  assert.equal(shared.withinBudget, true); // exposure <= budget
  const apart = portfolioExposure([{ walkAway: a }, { walkAway: b }], invoices + 6400 - 1);
  assert.equal(apart.exposureCents, invoices + 6400); // two trips
  assert.equal(apart.withinBudget, false);
  assert.equal(portfolioExposure([{ walkAway: a }]).withinBudget, null);
  assert.throws(() => portfolioExposure([], -1), RangeError);
  lacks(lot(), 'S19');
});

strategyTest('S20', 'gives the play for live, sealed and tag formats, with that format\'s label', () => {
  const live = has(lot({ auctionFormat: 'live' }), 'S20');
  assert.equal(live.alert.kind, 'before_sale');
  assert.equal(live.alert.secondsBefore, 3600);
  const sealed = has(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid', bidCount: 0 }), 'S20');
  assert.equal(sealed.alert.secondsBefore, 86400);
  const tag = has(lot({ sourcePlatform: 'estatesales-net', currentBidCents: 5000 }), 'S20');
  assert.equal(tag.evidenceLabel, 'UNVERIFIED');
  assert.equal(tag.confidence, 'low');
  lacks(lot(), 'S20');
});

strategyTest('S21', 'shows the rule of thirds as an UNVERIFIED cross-check when there is a value', () => {
  const s = has(lot(), 'S21');
  assert.match(s.message, /about \$100\.00/);
  assert.equal(s.evidenceLabel, 'UNVERIFIED');
  lacks(lot({ estimatedResaleCents: null }), 'S21');
});

test('every one of the 21 strategies has its own test above', () => {
  assert.deepEqual([...tested].sort(), STRATEGIES.map((s) => s.id).sort());
});

// ---------------------------------------------------------------- ranking

test('the strategy behind the primary action ranks first, then S1, then the rest by rule priority', () => {
  const hard = applicable(lot({ sourcePlatform: 'ebay' })).map((s) => s.id);
  assert.deepEqual(hard.slice(0, 2), ['S4', 'S1']);
  const walk = applicable(lot({ currentBidCents: 9000 })).map((s) => s.id);
  assert.equal(walk[0], 'S1'); // R02 is S1's
  const uneconomic = applicable(lot({ estimatedResaleCents: 5000, distanceMiles: 40 })).map((s) => s.id);
  assert.deepEqual(uneconomic.slice(0, 3), ['S1', 'S3', 'S17']); // R01: S1, and section 4.5's S3 and S17
  const ranks = applicable(lot()).map((s) => s.rank);
  assert.deepEqual(ranks, ranks.map((_, i) => i + 1));
});

test('risk tolerance reorders the thin-listing gamble (S10) and changes no number', () => {
  const ctx = lot({ bidCount: 1, descriptionWords: 6 });
  const order = (risk: 'low' | 'high') => recommend({ ...ctx, riskTolerance: risk }, NOW);
  const low = order('low');
  const high = order('high');
  const pos = (r: typeof low) => r.strategies.findIndex((s) => s.id === 'S10');
  assert.ok(pos(high) < pos(low));
  assert.equal(low.walkAway.maxBidCents, high.walkAway.maxBidCents);
});
