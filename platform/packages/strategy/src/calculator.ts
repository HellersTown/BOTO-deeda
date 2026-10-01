/**
 * The walk-away calculator: docs/06 section 4.1, solved exactly.
 *
 *   k        = (1 + bp/100) x (1 + t) x (1 + c)     invoice dollars per hammer dollar
 *   T        = 2 x d x cpm + time                   pickup (0 if the lot ships)
 *   N        = R x (1 - f) - s                      net proceeds on resale
 *   P        = max(m x R, Pmin)                     profit you require
 *   X        = (u + r) x R                          risk + repair reserve
 *   H_resale = max(0, floor_to_dollar((N - P - T - X) / k))
 *   H_budget = floor_to_dollar(B / k)
 *   H_max    = min of whichever exist
 *
 * Premium, tax and card fee all sit ON TOP of the hammer, compounding (tax on
 * hammer + premium, the card fee on the whole invoice), so the highest hammer that
 * still meets the target is (room / k), not room minus some percentage. That is
 * the one piece of algebra this file exists to get right.
 *
 * Every term is an exact fraction until the end. H is floored to whole dollars,
 * as the doc specifies, so a user never sees a ceiling in cents. The bid to
 * enter is then H rounded down to the increment ladder ($116 -> $110 where bids
 * go in $10 steps), because a site that takes bids in $10 steps will not take
 * $116. It is never rounded below the lot's next acceptable bid, which is valid
 * by definition.
 *
 * Money leaves as whole cents, rounded half away from zero. One rounding
 * function for every displayed amount keeps every inequality intact on screen:
 * if the profit at the max bid meets the target exactly, the rounded numbers
 * still show it meeting the target.
 */

import {
  type Rat,
  add,
  cmp,
  div,
  floor,
  floorDiv,
  formatPercent,
  formatUsd,
  fromInt,
  fromNumber,
  mul,
  rat,
  roundHalfAway,
  sub,
  toNumber,
  toSafeNumber,
} from './exact.ts';
import { type ResolvedLot, resolveLot } from './resolve.ts';
import { SPEC } from './spec.ts';
import type {
  CalculatorBreakdown,
  CalculatorResult,
  EngineOptions,
  InvoiceBreakdown,
  Ladder,
  LadderRung,
  LotContext,
  ParamUse,
  Projection,
} from './types.ts';

// ---------------------------------------------------------------- increment ladders

function freezeLadder(rungs: readonly LadderRung[]): Ladder {
  return Object.freeze(rungs.map((r) => Object.freeze({ ...r })));
}

/**
 * The ladder in ingest money.ts defaultNextBidCents, as rungs. That function is
 * the house default for "the next bid a user would have to place", so rounding
 * the walk-away number to it keeps the two packages agreeing on what a valid bid
 * is. test/ladder.test.ts checks the two stay identical.
 */
export const DEFAULT_LADDER: Ladder = freezeLadder([
  { fromCents: 0, incrementCents: 250 },
  { fromCents: 2500, incrementCents: 500 },
  { fromCents: 10000, incrementCents: 1000 },
  { fromCents: 50000, incrementCents: 2500 },
  { fromCents: 100000, incrementCents: 5000 },
  { fromCents: 500000, incrementCents: 10000 },
  { fromCents: 1000000, incrementCents: 25000 },
]);

/** The spec's ebay_us ladder (section 5.2, SE-2nd), for callers bidding on eBay. */
export const EBAY_US_LADDER: Ladder = freezeLadder(
  (SPEC.increment_ladders.ebay_us?.rungs ?? []).map((r) => ({
    fromCents: r.from_cents,
    incrementCents: r.increment_cents,
  })),
);

function assertLadder(ladder: Ladder): void {
  const ok =
    ladder.length > 0 &&
    ladder[0]?.fromCents === 0 &&
    ladder.every(
      (r, i) =>
        Number.isSafeInteger(r.fromCents) &&
        Number.isSafeInteger(r.incrementCents) &&
        r.incrementCents > 0 &&
        (i === 0 || r.fromCents > (ladder[i - 1] as LadderRung).fromCents),
    );
  if (!ok) {
    throw new TypeError('A ladder needs rungs in ascending fromCents order, starting at 0, with positive whole-cent increments.');
  }
}

function rungIndex(ladder: Ladder, amount: bigint): number {
  let idx = 0;
  for (let j = 0; j < ladder.length; j++) {
    if (BigInt((ladder[j] as LadderRung).fromCents) <= amount) idx = j;
  }
  return idx;
}

/** The increment that applies at `amountCents` on `ladder`. */
export function incrementFor(amountCents: number, ladder: Ladder = DEFAULT_LADDER): number {
  assertLadder(ladder);
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError('amountCents must be a whole, non-negative number of cents.');
  }
  return (ladder[rungIndex(ladder, BigInt(amountCents))] as LadderRung).incrementCents;
}

function roundDownToLadder(ceiling: bigint, ladder: Ladder, nextMin: bigint | null): bigint | null {
  if (nextMin !== null && nextMin > ceiling) return null;
  const rung = ladder[rungIndex(ladder, ceiling)] as LadderRung;
  const from = BigInt(rung.fromCents);
  const inc = BigInt(rung.incrementCents);
  const onGrid = from + ((ceiling - from) / inc) * inc;
  // The lot's next acceptable bid is valid by definition, even when it is not on
  // the grid (a $115 next bid under a $116 ceiling is still a bid you can make).
  return nextMin !== null && nextMin > onGrid ? nextMin : onGrid;
}

/**
 * The walk-away number as a bid the site will take: `ceilingCents` rounded DOWN
 * to the ladder's increment grid for that price (on the default ladder, $116 ->
 * $110, because bids between $100 and $500 go in $10 steps), but never below
 * `nextMinCents`, the smallest bid the lot accepts now, which is valid by
 * definition.
 *
 * null when the next acceptable bid is already above the ceiling: there is no
 * bid to make.
 */
export function highestValidBid(ceilingCents: number, ladder: Ladder = DEFAULT_LADDER, nextMinCents: number | null = null): number | null {
  assertLadder(ladder);
  const checks: [string, number | null][] = [['ceilingCents', ceilingCents], ['nextMinCents', nextMinCents]];
  for (const [name, v] of checks) {
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) {
      throw new RangeError(`${name} must be a whole, non-negative number of cents.`);
    }
  }
  const r = roundDownToLadder(BigInt(ceilingCents), ladder, nextMinCents === null ? null : BigInt(nextMinCents));
  return r === null ? null : Number(r);
}

// ---------------------------------------------------------------- the formula

export interface CeilingCore {
  readonly hasValue: boolean;
  readonly hasBudget: boolean;
  readonly resale: Rat | null;
  readonly budget: Rat | null;
  readonly sellFees: Rat | null;
  readonly outboundShip: Rat | null;
  readonly netProceeds: Rat | null;
  readonly profitTarget: Rat | null;
  readonly profitBasis: 'margin' | 'minimum' | null;
  readonly uncertaintyReserve: Rat | null;
  readonly repairReserve: Rat | null;
  readonly riskReserve: Rat | null;
  readonly transport: Rat;
  readonly room: Rat | null;
  readonly hResale: bigint | null;
  readonly hBudget: bigint | null;
  readonly hMax: bigint | null;
  readonly bindingCap: 'resale value' | 'budget' | 'none';
}

/** The doc's floor_to_dollar: whole dollars, rounded down, in cents. */
function floorToDollar(x: Rat): bigint {
  return floorDiv(x.n, x.d * 100n) * 100n;
}

export function solveCeiling(lot: ResolvedLot): CeilingCore {
  const cat = lot.category;
  const T = lot.transport.cents;
  const R = lot.resaleCents === null ? null : fromInt(lot.resaleCents);
  const B = lot.budgetCents === null ? null : fromInt(lot.budgetCents);

  let sellFees: Rat | null = null;
  let netProceeds: Rat | null = null;
  let profitTarget: Rat | null = null;
  let profitBasis: CeilingCore['profitBasis'] = null;
  let uncertaintyReserve: Rat | null = null;
  let repairReserve: Rat | null = null;
  let riskReserve: Rat | null = null;
  let room: Rat | null = null;
  let hResale: bigint | null = null;

  if (R !== null) {
    sellFees = mul(R, cat.sellFeeRate);
    netProceeds = sub(sub(R, sellFees), cat.outboundShipCents);
    const byMargin = mul(R, cat.targetMarginRate);
    profitBasis = cmp(byMargin, cat.minProfitCents) >= 0 ? 'margin' : 'minimum';
    profitTarget = profitBasis === 'margin' ? byMargin : cat.minProfitCents;
    uncertaintyReserve = mul(R, cat.uncertaintyHaircutRate);
    // A user's own repair estimate replaces the category's r x R reserve.
    repairReserve = lot.repairCents !== null ? fromInt(lot.repairCents) : mul(R, cat.repairReserveRate);
    riskReserve = add(uncertaintyReserve, repairReserve);
    room = sub(netProceeds, add(add(profitTarget, T), riskReserve));
    const h = floorToDollar(div(room, lot.k));
    hResale = h > 0n ? h : 0n;
  }
  const hBudget = B === null ? null : floorToDollar(div(B, lot.k));

  let hMax: bigint | null = null;
  let bindingCap: CeilingCore['bindingCap'] = 'none';
  if (hResale !== null && hBudget !== null) {
    // The spec breaks a tie in favour of the budget (<=).
    bindingCap = hBudget <= hResale ? 'budget' : 'resale value';
    hMax = hBudget <= hResale ? hBudget : hResale;
  } else if (hResale !== null) {
    bindingCap = 'resale value';
    hMax = hResale;
  } else if (hBudget !== null) {
    bindingCap = 'budget';
    hMax = hBudget;
  }

  return {
    hasValue: R !== null,
    hasBudget: B !== null,
    resale: R,
    budget: B,
    sellFees,
    outboundShip: R === null ? null : cat.outboundShipCents,
    netProceeds,
    profitTarget,
    profitBasis,
    uncertaintyReserve,
    repairReserve,
    riskReserve,
    transport: T,
    room,
    hResale,
    hBudget,
    hMax,
    bindingCap,
  };
}

/**
 * The invoice at one hammer price. The total is hammer x k, rounded to the cent.
 * Its lines are split with the largest-remainder method, so they add up to the
 * total exactly and a zero-rate line (no card fee) never picks up a stray cent.
 */
export function invoiceAt(hammerCents: bigint, lot: ResolvedLot): InvoiceBreakdown {
  const h = fromInt(hammerCents);
  const premium = mul(h, div(lot.bpPct, rat(100n)));
  const afterPremium = add(h, premium);
  const tax = mul(afterPremium, lot.taxRate);
  const card = mul(add(afterPremium, tax), lot.cardFeeRate);
  const total = roundHalfAway(mul(h, lot.k));
  const exacts = [premium, tax, card];
  const lines = exacts.map((x) => floor(x));
  let remaining = total - hammerCents - lines.reduce((a, b) => a + b, 0n);
  const order = [0, 1, 2]
    .map((i) => ({ i, frac: sub(exacts[i] as Rat, fromInt(lines[i] as bigint)) }))
    .filter((x) => x.frac.n > 0n)
    .sort((a, b) => cmp(b.frac, a.frac) || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0n) break;
    lines[i] = (lines[i] as bigint) + 1n;
    remaining -= 1n;
  }
  return {
    hammerCents: Number(hammerCents),
    premiumCents: Number(lines[0]),
    taxCents: Number(lines[1]),
    cardFeeCents: Number(lines[2]),
    totalCents: Number(total),
  };
}

// ---------------------------------------------------------------- the public calculator

/** Parameter names behind the transport figure, by how it was worked out. */
export function transportParamNames(lot: ResolvedLot): string[] {
  switch (lot.transport.basis) {
    case 'distance':
      return ['constants.mileage_cost_cents_per_mile', 'constants.pickup_time_cost_cents'];
    case 'pickup_cost':
      return ['user.pickup_cost_cents'];
    case 'shipping':
      return ['user.shipping_cents'];
    default:
      return [];
  }
}

function ceilingParamNames(lot: ResolvedLot, core: CeilingCore): string[] {
  const names = ['buyer_premium_pct', 'sales_tax_rate', 'card_fee_rate'];
  if (core.hasValue) {
    names.push(
      'category.sell_fee_rate',
      'category.outbound_ship_cents',
      core.profitBasis === 'minimum' ? 'category.min_profit_cents' : 'category.target_margin_rate',
      'category.uncertainty_haircut_rate',
      lot.repairCents !== null ? 'user.repair_cents' : 'category.repair_reserve_rate',
      ...transportParamNames(lot),
    );
  }
  return names;
}

function statusList(params: readonly ParamUse[], status: string): string[] {
  return params.filter((p) => p.status === status).map((p) => p.name);
}

/** Whole cents for display, or null when the amount is past exact JS integers. */
function cents(r: Rat | bigint | null, overflow: { hit: boolean }): number | null {
  if (r === null) return null;
  const v = toSafeNumber(typeof r === 'bigint' ? r : roundHalfAway(r));
  if (v === null) overflow.hit = true;
  return v;
}

function transportWords(lot: ResolvedLot): string {
  switch (lot.transport.basis) {
    case 'shipping':
      return 'shipping';
    case 'pickup_cost':
    case 'distance':
      return 'pickup';
    default:
      return 'transport';
  }
}

/** Bad input gets no numbers at all: a ceiling built from a garbled field is worse than none. */
function invalidResult(lot: ResolvedLot): CalculatorResult {
  return {
    status: 'invalid_input',
    reason: lot.errors.join(' '),
    maxBidCents: null,
    hammerCeilingCents: null,
    bindingCap: 'none',
    nextMinBidCents: null,
    ladder: 'none',
    breakdown: {
      userGoal: lot.userGoal,
      expectedResaleCents: null,
      budgetCents: null,
      sellFeesCents: null,
      outboundShipCents: null,
      netProceedsCents: null,
      profitTargetCents: null,
      profitTargetBasis: null,
      uncertaintyReserveCents: null,
      repairReserveCents: null,
      riskReserveCents: null,
      transportCents: 0,
      transportBasis: 'none',
      roomCents: null,
      maxHammerResaleCents: null,
      maxHammerBudgetCents: null,
    },
    invoiceAtMaxBid: null,
    allInAtMaxBidCents: null,
    profitAtMaxBidCents: null,
    thirdsRuleCents: null,
    transportShare: null,
    costMultiplier: 1,
    costPer100Cents: 10000,
    rates: { buyerPremiumPct: 0, salesTaxPct: 0, cardFeePct: 0 },
    parameters: [],
    placeholders: [],
    unverified: [],
    warnings: [],
    notes: [],
    errors: lot.errors,
  };
}

/** Computes the walk-away number for one lot. Pure: same input, same answer. */
export function computeMaxBid(context: LotContext, options: EngineOptions = {}): CalculatorResult {
  return calculate(resolveLot(context, options), options);
}

/**
 * The profit, or for a personal-use buyer the saving, if the lot is won at one
 * hammer price. It uses the walk-away number's own terms and formula, so at the
 * max bid it equals profitAtMaxBidCents. Ranking lots needs it at today's
 * price, not only at the ceiling.
 */
export function projectAtHammer(context: LotContext, hammerCents: number, options: EngineOptions = {}): Projection {
  const lot = resolveLot(context, options);
  const empty = {
    userGoal: lot.userGoal,
    hammerCents,
    invoice: null,
    allInCents: null,
    netProceedsCents: null,
    riskReserveCents: null,
    transportCents: 0,
    profitCents: null,
    returnOnCost: null,
  };
  if (!Number.isSafeInteger(hammerCents) || hammerCents < 0) {
    const why = `hammerCents must be whole, non-negative cents; got ${String(hammerCents)}.`;
    return { ...empty, status: 'invalid_input', errors: [...lot.errors, why] };
  }
  if (lot.errors.length > 0) return { ...empty, status: 'invalid_input', errors: lot.errors };

  const overflow = { hit: false };
  const core = solveCeiling(lot);
  const hammer = BigInt(hammerCents);
  const invoice = invoiceAt(hammer, lot);
  const transportCents = cents(core.transport, overflow) ?? 0;
  const allInCents = invoice.totalCents + transportCents;
  const profitCents =
    core.netProceeds === null || core.riskReserve === null
      ? null
      : cents(sub(core.netProceeds, add(add(mul(fromInt(hammer), lot.k), core.transport), core.riskReserve)), overflow);
  return {
    status: core.hasValue ? 'ok' : 'insufficient_data',
    userGoal: lot.userGoal,
    hammerCents,
    invoice,
    allInCents,
    netProceedsCents: cents(core.netProceeds, overflow),
    riskReserveCents: cents(core.riskReserve, overflow),
    transportCents,
    profitCents,
    returnOnCost: profitCents === null || allInCents <= 0 ? null : profitCents / allInCents,
    errors: overflow.hit ? ['An amount is too large to represent exactly and is shown as null.'] : [],
  };
}

/** computeMaxBid for a lot that has already been read (recommend() reuses the reading). */
export function calculate(lot: ResolvedLot, options: EngineOptions = {}): CalculatorResult {
  const ladder = options.ladder === undefined ? DEFAULT_LADDER : options.ladder;
  if (ladder !== null) assertLadder(ladder);
  if (lot.errors.length > 0) return invalidResult(lot);
  const overflow = { hit: false };
  const core = solveCeiling(lot);
  const k = lot.k;

  const breakdown: CalculatorBreakdown = {
    userGoal: lot.userGoal,
    expectedResaleCents: cents(core.resale, overflow),
    budgetCents: cents(core.budget, overflow),
    sellFeesCents: cents(core.sellFees, overflow),
    outboundShipCents: cents(core.outboundShip, overflow),
    netProceedsCents: cents(core.netProceeds, overflow),
    profitTargetCents: cents(core.profitTarget, overflow),
    profitTargetBasis: core.profitBasis,
    uncertaintyReserveCents: cents(core.uncertaintyReserve, overflow),
    repairReserveCents: cents(core.repairReserve, overflow),
    riskReserveCents: cents(core.riskReserve, overflow),
    transportCents: cents(core.transport, overflow) ?? 0,
    transportBasis: lot.transport.basis,
    roomCents: cents(core.room, overflow),
    maxHammerResaleCents: cents(core.hResale, overflow),
    maxHammerBudgetCents: cents(core.hBudget, overflow),
  };

  const parameters: ParamUse[] = ceilingParamNames(lot, core)
    .map((n) => lot.params[n])
    .filter((p): p is ParamUse => p !== undefined);

  const warnings = [...lot.warnings];
  if (lot.bpAssumed) {
    const bp = lot.params.buyer_premium_pct as ParamUse;
    warnings.push(
      `Buyer's premium was not captured for this lot; using ${String(bp.value)}% (${lot.bpSource}). Check the auction terms: the premium moves the ceiling directly.`,
    );
  }
  const card = lot.params.card_fee_rate as ParamUse;
  if (card.status === 'PLACEHOLDER') {
    warnings.push(`Card fee was not captured; assuming ${formatPercent(lot.cardFeeRate)} (a PLACEHOLDER). Paying by wire or cash may avoid it.`);
  }
  if (!core.hasValue && core.hasBudget) {
    warnings.push('The ceiling comes only from your budget. It does not check whether the lot is worth that; add a sold-comps value.');
  }
  const shareWarn = fromNumber(lot.constants.transport_share_warn);
  if (core.resale !== null && lot.transport.known && shareWarn !== null) {
    const share = div(core.transport, core.resale);
    if (cmp(share, shareWarn) > 0) {
      warnings.push(
        `${transportWords(lot) === 'shipping' ? 'Shipping' : 'The pickup trip'} (${formatUsd(roundHalfAway(core.transport))}) is ${formatPercent(share)} of the value. It is already deducted from the ceiling; combine it with other lots at the same site, or skip.`,
      );
    }
  }

  const rates = {
    buyerPremiumPct: toNumber(lot.bpPct),
    salesTaxPct: toNumber(mul(lot.taxRate, rat(100n))),
    cardFeePct: toNumber(mul(lot.cardFeeRate, rat(100n))),
  };
  const common = {
    hammerCeilingCents: cents(core.hMax, overflow),
    bindingCap: core.bindingCap,
    nextMinBidCents: cents(lot.nextMinBidCents, overflow),
    breakdown,
    thirdsRuleCents: core.resale === null ? null : cents(floor(div(core.resale, rat(3n))), overflow),
    transportShare: core.resale === null ? null : toNumber(div(core.transport, core.resale)),
    costMultiplier: toNumber(k),
    costPer100Cents: Number(floor(mul(k, rat(10000n)))),
    rates,
    parameters,
    placeholders: statusList(parameters, 'PLACEHOLDER'),
    unverified: statusList(parameters, 'UNVERIFIED'),
    notes: lot.notes,
  };

  const done = (
    status: CalculatorResult['status'],
    reason: string | null,
    maxBid: bigint | null,
    ladderUsed: CalculatorResult['ladder'],
    extraParams: ParamUse[] = [],
  ): CalculatorResult => {
    const invoice = maxBid === null ? null : invoiceAt(maxBid, lot);
    const allParams = [...parameters, ...extraParams];
    const result: CalculatorResult = {
      ...common,
      status,
      reason,
      maxBidCents: cents(maxBid, overflow),
      ladder: ladderUsed,
      invoiceAtMaxBid: invoice,
      allInAtMaxBidCents: invoice === null ? null : invoice.totalCents + (cents(core.transport, overflow) ?? 0),
      profitAtMaxBidCents:
        maxBid === null || core.netProceeds === null || core.riskReserve === null
          ? null
          : cents(sub(core.netProceeds, add(add(mul(fromInt(maxBid), k), core.transport), core.riskReserve)), overflow),
      parameters: allParams,
      placeholders: statusList(allParams, 'PLACEHOLDER'),
      unverified: statusList(allParams, 'UNVERIFIED'),
      warnings: overflow.hit ? [...warnings, 'An amount is too large to represent exactly and is shown as null.'] : warnings,
      errors: [],
    };
    return result;
  };

  if (!core.hasValue && !core.hasBudget) {
    return done(
      'insufficient_data',
      'No value estimate. Add the median of recent SOLD prices for this item in this condition (not asking prices), or the most you will pay, to get a walk-away number.',
      null,
      'none',
    );
  }

  const hMax = core.hMax as bigint;
  if (hMax === 0n) {
    if (core.bindingCap === 'budget') {
      return done(
        'walk_away',
        `Your ${formatUsd(core.budget?.n ?? 0n)} budget does not cover a $1 hammer once premium, tax and card fee are added.`,
        null,
        'none',
      );
    }
    return done(
      'walk_away',
      `Skip this lot. Even at a $0 hammer it does not clear your target: ${formatUsd(core.resale?.n ?? 0n)} value, ` +
        `${formatUsd(roundHalfAway(core.netProceeds as Rat))} after selling costs, minus ${formatUsd(roundHalfAway(core.profitTarget as Rat))} required profit, ` +
        `${formatUsd(roundHalfAway(core.transport))} ${transportWords(lot)} and ${formatUsd(roundHalfAway(core.riskReserve as Rat))} risk and repair reserve.`,
      null,
      'none',
    );
  }

  const anchor = lot.nextMinBidCents;
  if (anchor !== null && anchor > hMax) {
    const what =
      lot.effectiveCloseType === 'fixed'
        ? `The tag price is ${formatUsd(anchor)}`
        : lot.effectiveCloseType === 'sealed'
          ? `The minimum bid is ${formatUsd(anchor)}`
          : `The next bid would be ${formatUsd(anchor)}`;
    return done(
      'walk_away',
      `${what}; your ceiling is ${formatUsd(hMax)}. Raise a ceiling only for new information about the item, never because other people are bidding.`,
      null,
      'none',
    );
  }

  // Sealed bids and tag prices are offers of any amount, so there is no ladder to walk.
  const rounding = ladder !== null && lot.effectiveCloseType !== 'fixed' && lot.effectiveCloseType !== 'sealed';
  if (!rounding) return done('ok', null, hMax, 'none');

  const maxBid = roundDownToLadder(hMax, ladder, anchor);
  const ladderParam: ParamUse =
    ladder === DEFAULT_LADDER
      ? { name: 'increment_ladder', value: 'money.ts defaultNextBidCents', status: 'INTERNAL', source: 'packages/ingest money.ts' }
      : { name: 'increment_ladder', value: 'custom', status: 'OVERRIDE', source: 'options.ladder' };
  const ladderUsed = ladder === DEFAULT_LADDER ? 'default' : 'custom';
  if (maxBid === null || maxBid <= 0n) {
    return done('walk_away', `No bid on the increment ladder fits under your ceiling of ${formatUsd(hMax)}.`, null, ladderUsed, [ladderParam]);
  }
  return done('ok', null, maxBid, ladderUsed, [ladderParam]);
}
