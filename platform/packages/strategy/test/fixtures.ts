/**
 * Shared test lots. `now` is pinned to the instant the doc's own harness used
 * (docs/06 section 9.3: "now = 2026-09-27T18:00Z").
 */

import type { LotContext } from '../src/types.ts';

export const NOW = new Date('2026-09-27T18:00:00Z');

/** An ISO instant `minutes` from NOW. */
export function at(minutes: number, from: Date = NOW): string {
  return new Date(from.getTime() + minutes * 60000).toISOString();
}

/**
 * A plain, open HiBid tool lot with every field present, which fires only the
 * info rules R11, R36 and R37. Tests change one thing at a time from here.
 *
 * k = 1.15 x 1.055 x 1.03 = 1.2496475 (15% premium, 5.5% tax, 3% card fee default)
 * T = 2 x 5 x 70 + 2500 = 3200; N = 25800; P = 9000; X = 4500
 * H = floor_to_dollar((25800 - 9000 - 3200 - 4500) / 1.2496475) = floor_to_dollar(7282.05) = $72
 * next bid = 2000 + 50 (ebay_us rung from $5) = 2050
 */
export function lot(overrides: Partial<LotContext> = {}): LotContext {
  return {
    sourcePlatform: 'hibid',
    category: 'tools',
    currentBidCents: 2000,
    bidCount: 3,
    closesAt: at(600),
    softCloseMinutes: 3,
    buyerPremiumPct: 15,
    imageCount: 6,
    descriptionWords: 40,
    estimatedResaleCents: 30000,
    distanceMiles: 5,
    pickupRequired: true,
    hasReserve: false,
    ...overrides,
  };
}

export const BASE_CEILING = 7200;

export interface DocLot {
  readonly name: string;
  readonly ctx: LotContext;
  /** From the section 9.3 table. */
  readonly primary: string;
  readonly ceilingCents: number | null;
  /** Other rules the table lists in brackets. */
  readonly alsoFires: readonly string[];
}

/**
 * The 13 synthetic lots of docs/06 section 9.3. The doc lists outcomes, not
 * inputs, so these inputs were reconstructed: each uses the doc's defaults and
 * the smallest round numbers that reproduce the listed ceiling exactly. The
 * working is next to each lot.
 */
export const DOC_LOTS: readonly DocLot[] = [
  {
    // Section 4.2 column 1: (258 - 90 - 0 - 45) / 1.055 = $116.
    name: 'eBay tool lot, $300 comps, closes in 2 days',
    ctx: { sourcePlatform: 'ebay', category: 'tools', estimatedResaleCents: 30000, ships: true, currentBidCents: 4000, bidCount: 3, closesAt: at(2880), imageCount: 8, descriptionWords: 60 },
    primary: 'HARD_CLOSE_SINGLE_LATE_BID',
    ceilingCents: 11600,
    alsoFires: [],
  },
  {
    // Section 4.2 column 2: (172 - 60 - 81 - 30) / 1.282247 -> $0.
    name: 'HiBid tool lot, $200 comps, 40 mi, 18% premium',
    ctx: { sourcePlatform: 'hibid', category: 'tools', estimatedResaleCents: 20000, buyerPremiumPct: 18, distanceMiles: 40, pickupRequired: true, currentBidCents: 1000, bidCount: 2, closesAt: at(1800), imageCount: 4, descriptionWords: 25 },
    primary: 'WALK_AWAY_UNECONOMIC',
    ceilingCents: 0,
    alsoFires: [],
  },
  {
    // k = 1.125 x 1.055 x 1.03; T = 2 x 60 x 70 + 2500 = 10900;
    // (900000 - 180000 - 10900 - 225000) / 1.22248125 = 395997.9 -> $3,959. Next bid 455000.
    name: 'GovDeals vehicle, $9,000 comps, bid $4,500, reserve not met',
    ctx: { sourcePlatform: 'govdeals', category: 'vehicles', estimatedResaleCents: 900000, currentBidCents: 450000, bidCount: 12, hasReserve: true, reserveMet: false, distanceMiles: 60, pickupRequired: true, closesAt: at(1200), imageCount: 20, descriptionWords: 150 },
    primary: 'WALK_AWAY_OVER_MAX',
    ceilingCents: 395900,
    alsoFires: ['RESERVE_NOT_MET_STOP'],
  },
  {
    // 5000000 / 1.055 = 4739336.5 -> $47,393. GSA publishes a date only.
    name: 'GSA aircraft, budget $50,000 only, window not captured',
    ctx: { sourcePlatform: 'gsa', category: 'aircraft', maxBudgetCents: 5000000, currentBidCents: 1500000, bidCount: 4, closesAt: at(4320), closeTimePrecise: false, imageCount: 6, descriptionWords: 400 },
    primary: 'PROXY_BEFORE_WINDOW',
    ceilingCents: 4739300,
    alsoFires: ['EXTENSION_RULE_UNKNOWN', 'AIRCRAFT_REMOVAL_COSTS', 'BUDGET_ONLY_CEILING'],
  },
  {
    // k = 1.08665; T = 2 x 10 x 70 + 2500 = 3900; (25000 - 10000 - 3900 - 5000) / 1.08665 = 5613.5 -> $56.
    // Final-day tag 7500 > 5600, so pass.
    name: 'EstateSales.net tag $150, $250 comps furniture',
    ctx: { sourcePlatform: 'estatesales-net', category: 'furniture', estimatedResaleCents: 25000, currentBidCents: 15000, distanceMiles: 10, pickupRequired: true, closesAt: at(3000), imageCount: 3, descriptionWords: 20 },
    primary: 'TAG_PASS',
    ceilingCents: 5600,
    alsoFires: [],
  },
  {
    // k = 1.1 x 1.055 x 1.03 = 1.195315; T = 2 x 90 x 70 + 2500 = 15100;
    // (1800000 - 400000 - 15100 - 500000) / 1.195315 = 740307.4 -> $7,403.
    name: 'Proxibid webcast, $20,000 comps farm equipment',
    ctx: { sourcePlatform: 'proxibid', auctionFormat: 'live', category: 'farm_equipment', estimatedResaleCents: 2000000, buyerPremiumPct: 10, distanceMiles: 90, pickupRequired: true, currentBidCents: 100000, bidCount: 0, closesAt: at(1560), imageCount: 12, descriptionWords: 90 },
    primary: 'WEBCAST_ABSENTEE_BID',
    ceilingCents: 740300,
    alsoFires: [],
  },
  {
    // No premium; k = 1.08665; T = 2 x 25 x 70 + 2500 = 6000;
    // (360000 - 80000 - 6000 - 100000) / 1.08665 = 160124.2 -> $1,601.
    name: 'Public Surplus sealed, $4,000 comps construction equipment',
    ctx: { sourcePlatform: 'public-surplus', auctionFormat: 'sealed_bid', category: 'construction_equipment', estimatedResaleCents: 400000, buyerPremiumPct: 0, distanceMiles: 25, pickupRequired: true, currentBidCents: 50000, bidCount: 0, closesAt: at(5760), imageCount: 5, descriptionWords: 80 },
    primary: 'SEALED_BID_AT_CEILING',
    ceilingCents: 160100,
    alsoFires: [],
  },
  {
    name: 'MaxSold collectible, no value, no budget',
    ctx: { sourcePlatform: 'maxsold', category: 'collectibles', currentBidCents: 500, bidCount: 1, closesAt: at(300), imageCount: 6, descriptionWords: 30 },
    primary: 'NEED_VALUE',
    ceilingCents: null,
    alsoFires: [],
  },
  {
    // Section 4.2 column 3: (285 - 30 - 67 - 15) / 1.195315 = $144; the $200 budget allows $167.
    // 'wisconsinsurplus' is how seed/wisconsin_sources.json spells the platform.
    name: 'Wisconsin Surplus coin lot, 6 words, 1 photo, 0 bids',
    ctx: { sourcePlatform: 'wisconsinsurplus', category: 'coins_bullion', estimatedResaleCents: 30000, maxBudgetCents: 20000, buyerPremiumPct: 10, distanceMiles: 30, pickupRequired: true, currentBidCents: 500, bidCount: 0, closesAt: at(360), imageCount: 1, descriptionWords: 6 },
    primary: 'PROXY_BEFORE_WINDOW',
    ceilingCents: 14400,
    alsoFires: ['SLEEPER_CANDIDATE', 'CLOSING_QUIET'],
  },
  {
    // k = 1.055; T = 2 x 45 x 70 + 2500 = 8800; (1400000 - 280000 - 8800 - 350000) / 1.055 = 721516.6 -> $7,215.
    // Next bid 750000 + 10000 = 760000 is over it.
    name: 'GSA vehicle inside a 10-min inactivity window, over ceiling',
    ctx: { sourcePlatform: 'gsa', category: 'vehicles', estimatedResaleCents: 1400000, distanceMiles: 45, pickupRequired: true, currentBidCents: 750000, bidCount: 9, softCloseMinutes: 10, closesAt: at(6), imageCount: 10, descriptionWords: 120 },
    primary: 'WALK_AWAY_OVER_MAX',
    ceilingCents: 721500,
    alsoFires: ['SF97_TITLE_CHECK'],
  },
  {
    // Premium not captured -> 20%; k = 1.30398; T = 2 x 150 x 70 + 2500 = 23500;
    // (1080000 - 240000 - 23500 - 300000) / 1.30398 = 396095.0 -> $3,960.
    name: 'Purple Wave (close rule not captured)',
    ctx: { sourcePlatform: 'purple-wave', category: 'construction_equipment', estimatedResaleCents: 1200000, distanceMiles: 150, pickupRequired: true, currentBidCents: 150000, bidCount: 5, closesAt: at(1800), imageCount: 30, descriptionWords: 200 },
    primary: 'BID_UP_TO_MAX',
    ceilingCents: 396000,
    alsoFires: [],
  },
  {
    name: 'K-BID lot already closed',
    ctx: { sourcePlatform: 'k-bid', category: 'tools', currentBidCents: 2500, bidCount: 3, closesAt: at(-120), imageCount: 4, descriptionWords: 20 },
    primary: 'LOT_CLOSED',
    ceilingCents: null,
    alsoFires: [],
  },
  {
    // k = 1.282247; T = 2 x 80 x 70 + 2500 = 13700; 30000 - 12000 - 13700 - 6000 < 0 -> $0.
    name: 'AuctionNinja furniture 80 mi away',
    ctx: { sourcePlatform: 'auctionninja', category: 'furniture', estimatedResaleCents: 30000, distanceMiles: 80, pickupRequired: true, currentBidCents: 2000, bidCount: 1, closesAt: at(1200), imageCount: 5, descriptionWords: 40 },
    primary: 'WALK_AWAY_UNECONOMIC',
    ceilingCents: 0,
    alsoFires: ['PICKUP_EATS_MARGIN'],
  },
];

/** A small deterministic generator, so a failing random case reproduces. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Walks an object and yields [path, value] for every key ending in "Cents". */
export function* centsFields(obj: unknown, path = ''): Generator<[string, unknown]> {
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (/Cents$/.test(k)) yield [p, v];
    if (v !== null && typeof v === 'object') yield* centsFields(v, p);
  }
}
