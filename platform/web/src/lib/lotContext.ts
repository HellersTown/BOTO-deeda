/**
 * Building the strategy engine's LotContext (@platform/strategy src/types.ts)
 * from database rows: the lot, its auction, its source, plus what the user
 * typed into the walk-away calculator.
 *
 * Every field is optional in the engine, and a missing value is reported by
 * the engine rather than guessed here, so this maps only what the rows
 * actually hold and passes null for the rest.
 */
import type { AuctionFormat, LotContext, SourceTier, UserGoal } from '@platform/strategy';
import type { Json } from '../data/database.types';
import { readLotMeta, type LotDetail } from '../data/lots';
import type { WatchedLot } from '../data/watchlist';

/** What the rows say about a lot, in the engine's vocabulary. */
export interface LotFacts {
  readonly currentBidCents: number | null;
  readonly nextBidCents: number | null;
  readonly startingBidCents: number | null;
  readonly bidCount: number | null;
  readonly closesAt: string | null;
  /** lots.raw->'_meta'->>'closeTimePrecise'; false for a date-only close. */
  readonly closeTimePrecise: boolean;
  /** GSA's raw._meta.inactivityMinutes: the extension window. */
  readonly softCloseMinutes: number | null;
  readonly hasReserve: boolean | null;
  readonly reserveMet: boolean | null;
  /** auctions.buyer_premium_pct (percent). null = not captured; the engine then assumes, and labels it. */
  readonly buyerPremiumPct: number | null;
  readonly sleeperScore: number | null;
  readonly imageCount: number | null;
  readonly descriptionWords: number | null;
  readonly categorySlug: string | null;
  readonly brand: string | null;
  readonly model: string | null;
  readonly condition: string | null;
  readonly sourcePlatform: string | null;
  readonly sourceTier: SourceTier | null;
  readonly auctionFormat: AuctionFormat | null;
  readonly pickupRequired: boolean | null;
  readonly ships: boolean;
}

/** What the user typed into the calculator. */
export interface WalkAwayInputs {
  /** A resale estimate: median of recent SOLD prices, in cents (the engine's default 'resell' goal). */
  readonly estimatedResaleCents: number | null;
  /**
   * With a resale estimate, the profit wanted, percent of resale (null keeps the
   * category default, a PLACEHOLDER). With userGoal 'use', the cushion kept
   * below what it is worth (null: none).
   */
  readonly targetMarginPct: number | null;
  /**
   * "Worth to you" (Count the cost): what the same thing costs at a fixed price
   * elsewhere, in cents. The engine reads it when userGoal is 'use'.
   */
  readonly estimatedValueCents?: number | null;
  /**
   * 'use': a buyer who keeps the thing (docs/06 S2). The engine then drops
   * selling fees, outbound shipping and the resale profit target.
   */
  readonly userGoal?: UserGoal | null;
}

export const NO_INPUTS: WalkAwayInputs = { estimatedResaleCents: null, targetMarginPct: null };

/** A whole, non-negative cent amount, or null: the engine rejects anything else outright. */
function cents(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function count(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function pct(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

export function factsFromDetail(detail: LotDetail): LotFacts {
  return {
    currentBidCents: detail.currentBidCents,
    nextBidCents: detail.nextBidCents,
    startingBidCents: detail.startingBidCents,
    bidCount: detail.bidCount,
    closesAt: detail.closesAt,
    closeTimePrecise: detail.meta.closeTimePrecise,
    softCloseMinutes: detail.meta.inactivityMinutes,
    hasReserve: detail.meta.hasReserve,
    reserveMet: detail.reserveMet,
    buyerPremiumPct: detail.auction?.buyerPremiumPct ?? null,
    sleeperScore: detail.sleeperScore,
    imageCount: detail.imageCount,
    descriptionWords: detail.descriptionWords,
    categorySlug: detail.category?.slug ?? null,
    brand: detail.brand,
    model: detail.model,
    condition: detail.condition,
    sourcePlatform: detail.source?.platform ?? null,
    sourceTier: detail.source?.tier ?? null,
    auctionFormat: detail.auction?.format ?? null,
    pickupRequired: detail.auction?.pickupRequired ?? null,
    ships: detail.ships,
  };
}

export function factsFromWatched(lot: WatchedLot): LotFacts {
  const meta = readLotMeta(lot.meta as Json);
  return {
    currentBidCents: lot.currentBidCents,
    nextBidCents: lot.nextBidCents,
    startingBidCents: lot.startingBidCents,
    bidCount: lot.bidCount,
    closesAt: lot.closesAt,
    closeTimePrecise: meta.closeTimePrecise,
    softCloseMinutes: meta.inactivityMinutes,
    hasReserve: meta.hasReserve,
    reserveMet: lot.reserveMet,
    buyerPremiumPct: lot.buyerPremiumPct,
    sleeperScore: lot.sleeperScore,
    imageCount: lot.imageCount,
    descriptionWords: lot.descriptionWords,
    categorySlug: lot.categorySlug,
    brand: lot.brand,
    model: lot.model,
    condition: lot.condition,
    sourcePlatform: lot.sourcePlatform,
    sourceTier: lot.sourceTier,
    auctionFormat: lot.auctionFormat,
    pickupRequired: lot.pickupRequired,
    ships: lot.ships,
  };
}

/**
 * The engine's input for one lot. `distanceMiles` is one-way miles from the
 * user's home ZIP to the pickup site (search_lots' distance when the user came
 * from search, else ZIP centroid to ZIP centroid); null when unknown.
 */
export function buildLotContext(facts: LotFacts, distanceMiles: number | null, inputs: WalkAwayInputs = NO_INPUTS): LotContext {
  const score = facts.sleeperScore;
  return {
    currentBidCents: cents(facts.currentBidCents),
    nextBidCents: cents(facts.nextBidCents),
    startingBidCents: cents(facts.startingBidCents),
    bidCount: count(facts.bidCount),
    closesAt: facts.closesAt,
    closeTimePrecise: facts.closeTimePrecise,
    softCloseMinutes: typeof facts.softCloseMinutes === 'number' && facts.softCloseMinutes >= 0 ? facts.softCloseMinutes : null,
    hasReserve: facts.hasReserve,
    reserveMet: facts.reserveMet,
    buyerPremiumPct: pct(facts.buyerPremiumPct),
    sleeperScore: typeof score === 'number' && Number.isFinite(score) ? Math.min(10, Math.max(0, score)) : null,
    imageCount: count(facts.imageCount),
    descriptionWords: count(facts.descriptionWords),
    category: facts.categorySlug,
    brand: facts.brand,
    model: facts.model,
    condition: facts.condition,
    sourcePlatform: facts.sourcePlatform,
    sourceTier: facts.sourceTier,
    auctionFormat: facts.auctionFormat,
    pickupRequired: facts.pickupRequired,
    distanceMiles: typeof distanceMiles === 'number' && Number.isFinite(distanceMiles) && distanceMiles >= 0 ? distanceMiles : null,
    ships: facts.ships,
    estimatedResaleCents: cents(inputs.estimatedResaleCents),
    targetMarginPct: pct(inputs.targetMarginPct),
    ...(inputs.userGoal ? { userGoal: inputs.userGoal } : {}),
    ...(inputs.estimatedValueCents !== undefined ? { estimatedValueCents: cents(inputs.estimatedValueCents) } : {}),
  };
}
