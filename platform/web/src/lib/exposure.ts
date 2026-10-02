/**
 * "If every bid wins, you owe": docs/06 S19 through the engine's
 * portfolioExposure(), which sums each live bid's invoice (hammer x k, premium,
 * tax and card fee) plus one pickup trip per site.
 *
 * portfolioExposure takes one CalculatorResult per lot. The watchlist keeps the
 * number the user committed to (max_bid_cents, the engine's hammer ceiling, or
 * the bid they placed), not the resale estimate it came from, so the result is
 * rebuilt from that number: the engine's budget arm (H = floor_to_dollar(B / k))
 * is searched for the smallest whole-cent budget whose ceiling reaches the
 * hammer. The invoice, the premium, the tax and the trip are then the engine's
 * own exact figures at that hammer, and no amount is ever divided as a float
 * here. The engine's ceilings are whole dollars, so a placed bid with cents is
 * priced at the next whole dollar, never below what was bid.
 */
import {
  computeMaxBid,
  portfolioExposure,
  type CalculatorResult,
  type ExposureEntry,
  type ExposureResult,
  type LotContext,
} from '@platform/strategy';

/** The whole-dollar hammer at or above `cents`, in cents. */
export function wholeDollarAtLeast(cents: number): number {
  const rest = cents % 100;
  return rest === 0 ? cents : cents + (100 - rest);
}

/**
 * The engine's CalculatorResult for bidding exactly `hammerCents` (rounded up
 * to a whole dollar) on this lot. Status 'ok' means a live bid; 'walk_away'
 * means the lot's next acceptable bid is already above it, so it cannot win.
 * Null for a zero or invalid hammer.
 */
export function walkAwayAtHammer(context: LotContext, hammerCents: number): CalculatorResult | null {
  if (!Number.isSafeInteger(hammerCents) || hammerCents <= 0) return null;
  const target = wholeDollarAtLeast(hammerCents);
  const base: LotContext = { ...context, estimatedResaleCents: null, estimatedValueCents: null, maxBudgetCents: null };
  const at = (budget: number): CalculatorResult => computeMaxBid({ ...base, maxBudgetCents: budget }, { ladder: null });
  const ceiling = (budget: number): number => at(budget).hammerCeilingCents ?? -1;

  const probe = at(target);
  if (probe.status === 'invalid_input') return null;

  // k >= 1, so the budget is at least the hammer; double until it is enough.
  let lo = target;
  let hi = target * 2;
  let guard = 0;
  while (ceiling(hi) < target) {
    lo = hi;
    hi *= 2;
    guard += 1;
    if (guard > 20 || !Number.isSafeInteger(hi)) return null;
  }
  // Smallest budget in [lo, hi] whose ceiling reaches the target.
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (ceiling(mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  const result = at(lo);
  return result.hammerCeilingCents === target ? result : null;
}

export interface ExposureLine {
  readonly lotId: string;
  readonly context: LotContext;
  /** The bid the user says they placed, else their walk-away number. */
  readonly hammerCents: number;
  /** Lots at one pickup site share a trip: the auction id, when known. */
  readonly siteKey: string | null;
}

export interface ExposureSummary {
  readonly result: ExposureResult;
  /** Lots priced into the total (a bid that can still win). */
  readonly live: number;
  /** Lots whose next bid is already above the number, so they add nothing. */
  readonly outbid: number;
  /** Lots priced without a pickup trip because their distance is unknown. */
  readonly noTrip: number;
}

export function summarizeExposure(lines: readonly ExposureLine[], budgetCents: number | null = null): ExposureSummary {
  const entries: ExposureEntry[] = [];
  let outbid = 0;
  let noTrip = 0;
  for (const line of lines) {
    const walkAway = walkAwayAtHammer(line.context, line.hammerCents);
    if (!walkAway) continue;
    if (walkAway.status !== 'ok') outbid += 1;
    else if (walkAway.breakdown.transportBasis === 'none' && line.context.ships !== true) noTrip += 1;
    entries.push({ walkAway, siteKey: line.siteKey });
  }
  const result = portfolioExposure(entries, budgetCents);
  return { result, live: result.liveBids, outbid, noTrip };
}
