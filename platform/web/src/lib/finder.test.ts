import { computeMaxBid, projectAtHammer } from '@platform/strategy';
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_WEIGHT,
  evaluate,
  focusTerms,
  goalContext,
  isSuggestion,
  priceToday,
  rank,
  soldListingsUrl,
  type AppraisalValues,
  type Candidate,
  type GoalSettings,
  type Suggestion,
} from './finder';
import type { LotFacts } from './lotContext';

/** A PropertyRoom-style tool lot: ships, 0% premium published, next bid $50. */
const FACTS: LotFacts = {
  currentBidCents: 4500,
  nextBidCents: 5000,
  startingBidCents: null,
  bidCount: 3,
  closesAt: '2026-10-04T01:00:00+00:00',
  closeTimePrecise: true,
  softCloseMinutes: null,
  hasReserve: false,
  reserveMet: null,
  buyerPremiumPct: 0,
  sleeperScore: null,
  imageCount: 4,
  descriptionWords: 40,
  categorySlug: 'tools',
  brand: 'Milwaukee',
  model: '2804-22',
  condition: 'used',
  sourcePlatform: 'propertyroom',
  sourceTier: 'municipal',
  auctionFormat: 'online',
  pickupRequired: false,
  ships: true,
};

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return { lotId: 'lot-1', title: 'Milwaukee M18 hammer drill kit', facts: FACTS, distanceMiles: null, matched: [], ...overrides };
}

function appraisal(overrides: Partial<AppraisalValues> = {}): AppraisalValues {
  return {
    item: 'Milwaukee M18 FUEL hammer drill kit',
    lowCents: 12000,
    likelyCents: 15000,
    highCents: 18500,
    newPriceCents: 39900,
    confidence: 'high',
    channel: 'ebay',
    daysToSell: 10,
    projectTags: ['construction', 'woodworking'],
    flags: [],
    compsQuery: 'Milwaukee 2804-22 kit',
    rationale: 'Complete kits sell steadily.',
    ...overrides,
  };
}

const RESALE: GoalSettings = {
  mode: 'resale',
  focus: 'drill',
  budgetCents: null,
  minProfitCents: 4000,
  minReturnPct: null,
  salesTaxPct: 0,
  conservative: false,
};

function suggestion(r: ReturnType<typeof evaluate>): Suggestion {
  if (!isSuggestion(r)) throw new Error(`expected a suggestion, got ${r.why}`);
  return r;
}

describe('focusTerms', () => {
  it('splits a list on commas, semicolons, new lines and "and"; lowercases; drops repeats', () => {
    expect(focusTerms('Table saw, jointer and clamps; Dust collector\nclamps')).toEqual([
      'table saw',
      'jointer',
      'clamps',
      'dust collector',
    ]);
  });
  it('keeps one free-text focus whole, and caps a list at 8', () => {
    expect(focusTerms('  shop   tools ')).toEqual(['shop tools']);
    expect(focusTerms(null)).toEqual([]);
    expect(focusTerms('a, b')).toEqual([]);
    expect(focusTerms(Array.from({ length: 12 }, (_, i) => `item ${i}`).join(', '))).toHaveLength(8);
  });
});

describe('priceToday', () => {
  it('is the next acceptable bid, else the current bid, else the opening bid', () => {
    expect(priceToday({ nextBidCents: 5000, currentBidCents: 4500, startingBidCents: 100 })).toBe(5000);
    expect(priceToday({ nextBidCents: null, currentBidCents: 4500, startingBidCents: 100 })).toBe(4500);
    expect(priceToday({ nextBidCents: null, currentBidCents: null, startingBidCents: 100 })).toBe(100);
    expect(priceToday({ nextBidCents: null, currentBidCents: null, startingBidCents: null })).toBeNull();
  });
});

describe('evaluate: resale', () => {
  it('projects profit at today’s price with the engine, on the goal’s own terms', () => {
    const s = suggestion(evaluate(candidate(), RESALE, appraisal()));
    const ctx = goalContext(candidate(), RESALE, 15000);
    expect(s.projection).toEqual(projectAtHammer(ctx, 5000));
    expect(s.walkAway).toEqual(computeMaxBid(ctx));
    expect(s.valueBasis).toBe('likely');
    expect(s.priceTodayCents).toBe(5000);
    expect(s.projection.profitCents).toBeGreaterThan(4000);
    expect(s.passes).toBe(true);
    expect(s.shortfalls).toEqual([]);
    // The goal's $40 minimum sets the walk-away, so profit at the walk-away is at least $40.
    expect(s.walkAway.status).toBe('ok');
    expect(s.walkAway.profitAtMaxBidCents as number).toBeGreaterThanOrEqual(4000);
  });

  it('a conservative goal values the lot at the low estimate', () => {
    const likely = suggestion(evaluate(candidate(), RESALE, appraisal()));
    const low = suggestion(evaluate(candidate(), { ...RESALE, conservative: true }, appraisal()));
    expect(low.valueBasis).toBe('low');
    expect(low.valueCents).toBe(12000);
    expect(low.projection.profitCents as number).toBeLessThan(likely.projection.profitCents as number);
  });

  it('falls short when the profit, the return or the budget does', () => {
    const thin = suggestion(evaluate(candidate(), { ...RESALE, minProfitCents: 20000 }, appraisal()));
    expect(thin.passes).toBe(false);
    expect(thin.shortfalls).toEqual(['Profit under your $200 minimum']);

    const ret = suggestion(evaluate(candidate(), { ...RESALE, minReturnPct: 500 }, appraisal()));
    expect(ret.shortfalls).toEqual(['Return under your 500%']);

    const budget = suggestion(evaluate(candidate(), { ...RESALE, budgetCents: 4000 }, appraisal()));
    expect(budget.shortfalls).toEqual(['Over your $40 budget']);

    const loss = suggestion(evaluate(candidate({ facts: { ...FACTS, nextBidCents: 30000 } }), RESALE, appraisal()));
    expect(loss.shortfalls).toEqual(['No profit at today’s price']);
  });

  it('a pickup trip costs money: a far lot projects less than a shipped one', () => {
    const near = suggestion(evaluate(candidate(), RESALE, appraisal()));
    const far = suggestion(
      evaluate(candidate({ distanceMiles: 90, facts: { ...FACTS, ships: false, pickupRequired: true } }), RESALE, appraisal()),
    );
    expect(far.projection.transportCents).toBeGreaterThan(0);
    expect(far.projection.profitCents as number).toBeLessThan(near.projection.profitCents as number);
  });
});

describe('evaluate: personal and project', () => {
  const PERSONAL: GoalSettings = { ...RESALE, mode: 'personal', minProfitCents: null };

  it('personal use: the saving against buying it used, with no selling costs', () => {
    const s = suggestion(evaluate(candidate(), PERSONAL, appraisal()));
    expect(s.projection.userGoal).toBe('use');
    expect(s.projection.netProceedsCents).toBe(15000);
    expect(s.passes).toBe(true);
    const dear = suggestion(evaluate(candidate({ facts: { ...FACTS, nextBidCents: 20000 } }), PERSONAL, appraisal()));
    expect(dear.shortfalls).toEqual(['Costs more than buying it used']);
  });

  it('project: fit comes from the search that found it or the appraisal’s tags; off-list lots fall short', () => {
    const goal: GoalSettings = { ...PERSONAL, mode: 'project', focus: 'woodworking, welder' };
    const byTag = suggestion(evaluate(candidate(), goal, appraisal()));
    expect(byTag.fit).toEqual(['woodworking']);
    expect(byTag.passes).toBe(true);
    const bySearch = suggestion(evaluate(candidate({ matched: ['welder'] }), goal, appraisal({ projectTags: [] })));
    expect(bySearch.fit).toEqual(['welder']);
    const off = suggestion(evaluate(candidate(), goal, appraisal({ projectTags: ['kitchen'] })));
    expect(off.shortfalls).toEqual(['Not on your project list']);
  });
});

describe('what cannot be ranked yet', () => {
  it('no appraisal, no value, or no price', () => {
    expect(evaluate(candidate(), RESALE, null)).toEqual({ lotId: 'lot-1', why: 'unappraised' });
    expect(evaluate(candidate(), RESALE, appraisal({ likelyCents: null }))).toEqual({ lotId: 'lot-1', why: 'no_value' });
    const unpriced = candidate({ facts: { ...FACTS, nextBidCents: null, currentBidCents: null, startingBidCents: null } });
    expect(evaluate(unpriced, RESALE, appraisal())).toEqual({ lotId: 'lot-1', why: 'no_price' });
  });
});

describe('rank', () => {
  it('passing suggestions first, then by profit weighed by confidence', () => {
    const strong = suggestion(evaluate(candidate({ lotId: 'a' }), RESALE, appraisal()));
    const shaky = suggestion(evaluate(candidate({ lotId: 'b' }), RESALE, appraisal({ confidence: 'low' })));
    const failing = suggestion(evaluate(candidate({ lotId: 'c' }), { ...RESALE, minProfitCents: 99900 }, appraisal()));
    expect(shaky.projection.profitCents).toBe(strong.projection.profitCents);
    expect(shaky.score).toBeCloseTo((strong.projection.profitCents as number) * CONFIDENCE_WEIGHT.low);
    expect(rank([failing, shaky, strong]).map((s) => s.lotId)).toEqual(['a', 'b', 'c']);
  });
});

describe('soldListingsUrl', () => {
  it('searches eBay’s sold and completed listings', () => {
    expect(soldListingsUrl('  Milwaukee  2804-22 kit ')).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=Milwaukee%202804-22%20kit&LH_Sold=1&LH_Complete=1',
    );
  });
});
