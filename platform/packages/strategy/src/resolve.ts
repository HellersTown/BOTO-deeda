/**
 * Reading a LotContext into the spec's terms.
 *
 * Everything the calculator and the rules need is decided here, once: which row
 * of the platforms table applies, which category, what premium, card fee and tax
 * go into k, what the next acceptable bid is, and what the pickup costs. Both
 * the calculator and the rules read the result, so there is one answer to "what
 * is k for this lot", not two that can drift.
 *
 * Each decision also records WHERE its value came from (a ParamUse). That is
 * what lets a ceiling built on a PLACEHOLDER say so in the UI.
 */

import {
  type Rat,
  ONE,
  add,
  cmp,
  div,
  fromInt,
  fromNumber,
  mul,
  parseInstant,
  rat,
  toNumber,
} from './exact.ts';
import { UNKNOWN, type Unknown } from './jsonlogic.ts';
import { SPEC } from './spec.ts';
import type {
  AuctionFormat,
  CloseType,
  EffectiveCloseType,
  EngineOptions,
  EvidenceLabel,
  LotContext,
  OutValue,
  ParamStatus,
  ParamUse,
  ReserveFlag,
  SourceTier,
  SpecCategory,
  SpecConstants,
  SpecPlatform,
  TransportBasis,
  UserGoal,
} from './types.ts';

/** docs/06 S18 and section 6.6: "Covers GSA, GovDeals, Public Surplus, Municibid and Wisconsin Surplus." */
export const GOVERNMENT_PLATFORMS: readonly string[] = [
  'gsa',
  'govdeals',
  'public-surplus',
  'municibid',
  'wisconsin-surplus',
];

/** Source tiers that are government sellers. S17: "all government surplus" is pickup-only. */
export const GOVERNMENT_TIERS: readonly SourceTier[] = ['federal', 'state', 'county', 'municipal', 'school'];

export type BpSource = "the lot's terms" | 'platform default' | 'conservative assumption';

export interface ResolvedCategory {
  readonly sellFeeRate: Rat;
  readonly outboundShipCents: Rat;
  readonly repairReserveRate: Rat;
  readonly uncertaintyHaircutRate: Rat;
  readonly targetMarginRate: Rat;
  readonly minProfitCents: Rat;
  readonly herdBidCount: Rat;
  readonly highValueRisk: boolean;
}

/** The spec inputs, as section 9.2 `inputs` names them. UNKNOWN marks a required field the lot lacks. */
export interface SpecInputs {
  readonly current_bid_cents: number | null;
  readonly bid_count: number | Unknown;
  readonly closes_at: string | null;
  readonly soft_close_window_minutes: number | null;
  readonly platform: string;
  readonly buyer_premium_pct: number | null;
  readonly reserve_flag: ReserveFlag;
  readonly pickup_distance_miles: number | null;
  readonly image_count: number | Unknown;
  readonly description_word_count: number | Unknown;
  readonly category: string;
  readonly expected_resale_cents: number | null;
  readonly user_max_budget_cents: number | null;
}

export interface ResolvedLot {
  readonly ctx: LotContext;
  /** Invalid input: nothing is evaluated. */
  readonly errors: readonly string[];
  /** Lot fields without which the rules cannot run (the calculator still can). */
  readonly missing: readonly string[];
  /** Required-by-spec fields that are absent but only switch off a few rules. */
  readonly unknownInputs: readonly string[];
  readonly notes: readonly string[];
  readonly warnings: readonly string[];

  readonly platformKey: string;
  readonly platformEntryKey: string;
  readonly platform: SpecPlatform;
  readonly platformBase: string;
  readonly closeType: CloseType;
  readonly windowMin: Rat | null;
  readonly isHardClose: boolean;
  readonly effectiveCloseType: EffectiveCloseType;
  readonly isExtendingClose: boolean;
  readonly effectiveWindowMin: Rat;

  readonly categoryKey: string;
  readonly category: ResolvedCategory;
  /** The spec constants after overrides and user settings, as plain numbers. */
  readonly constants: SpecConstants;

  readonly bpAssumed: boolean;
  /** Percent, e.g. 12.5. */
  readonly bpPct: Rat;
  readonly bpSource: BpSource;
  /** Fractions. */
  readonly cardFeeRate: Rat;
  readonly taxRate: Rat;
  /** k = (1 + bp/100)(1 + tax)(1 + card fee). */
  readonly k: Rat;

  readonly currentBidCents: bigint | null;
  readonly startingBidCents: bigint | null;
  readonly bidCount: number | null;
  readonly nextMinBidCents: bigint | null;
  readonly nextMinBidSource: 'lot' | 'opening' | 'ladder' | 'tag' | null;
  readonly incrementCents: bigint | null;
  readonly closesAtMs: number | null;
  readonly closeTimePrecise: boolean;
  readonly reserveFlag: ReserveFlag;

  readonly userGoal: UserGoal;
  /** R, only when > 0 (the spec's has_value). */
  readonly resaleCents: bigint | null;
  /** B, only when > 0 (the spec's has_budget). */
  readonly budgetCents: bigint | null;
  readonly transport: { readonly cents: Rat; readonly known: boolean; readonly basis: TransportBasis };
  readonly repairCents: bigint | null;

  readonly specInputs: SpecInputs;
  /** Provenance for every parameter, keyed by display name. */
  readonly params: Readonly<Record<string, ParamUse>>;
}

// ---------------------------------------------------------------- platform names

/**
 * Spellings of the same platform seen in this repo (seed/sources.sql uses
 * 'public-surplus', seed/wisconsin_sources.json uses 'publicsurplus') and in the
 * brief ('estatesales'). Only unambiguous ones are listed.
 */
const PLATFORM_ALIASES: Readonly<Record<string, { readonly base: string; readonly suffix?: string; readonly note?: string }>> = {
  publicsurplus: { base: 'public-surplus' },
  wisconsinsurplus: { base: 'wisconsin-surplus' },
  kbid: { base: 'k-bid' },
  purplewave: { base: 'purple-wave' },
  estatesalesnet: { base: 'estatesales-net' },
  'auction-ninja': { base: 'auctionninja' },
  'bid-spotter': { base: 'bidspotter' },
  'auction-zip': { base: 'auctionzip' },
  // "estatesales" could be EstateSales.NET or EstateSales.org. Both list tag
  // sales, and other:tag carries exactly the same numbers as estatesales-net, so
  // the mechanics are right without claiming which site it is.
  estatesales: { base: 'other', suffix: 'tag', note: '"estatesales" does not say which site; read as a tag sale (other:tag), which has the same defaults as estatesales-net.' },
  'estatesales-org': { base: 'other', suffix: 'tag', note: 'EstateSales.org is not in the spec; read as a tag sale (other:tag).' },
};

/** Names that cover several sites with different rules. Refusing to pick is the point. */
const AMBIGUOUS_PLATFORMS: Readonly<Record<string, string>> = {
  'liquidity-services':
    'sourcePlatform "liquidity-services" runs GovDeals, AllSurplus and Liquidation.com, which have different rules. Using the "other" defaults; pass the site itself (e.g. "govdeals") to use its terms.',
};

const FORMAT_SUFFIX: Readonly<Record<AuctionFormat, string>> = {
  live: 'webcast',
  hybrid: 'webcast',
  sealed_bid: 'sealed',
  fixed_price: 'tag',
  online: 'timed',
};

const SUFFIXES = new Set(['timed', 'webcast', 'sealed', 'tag', 'hard']);
const KNOWN_BASES = new Set(Object.values(SPEC.platforms).map((p) => p.base));

// ---------------------------------------------------------------- category names

const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  coin: 'coins_bullion',
  coins: 'coins_bullion',
  bullion: 'coins_bullion',
  tool: 'tools',
  vehicle: 'vehicles',
  jewellery: 'jewelry',
  collectible: 'collectibles',
  household: 'household_general',
};

// ---------------------------------------------------------------- labels

/**
 * The label at the front of a platform `_meta` note ("SE-2nd govdeals_thirdparty
 * ..."). Notes that cite this repo's own docs are INTERNAL. A value with no note
 * at all is UNVERIFIED, which is what the doc calls anything it did not source.
 */
export function labelFromMeta(text: string | undefined): EvidenceLabel | null {
  if (text === undefined || text === '') return null;
  const m = /^(SE-2nd|SE|UNVERIFIED|INTERNAL|PLACEHOLDER|DESIGN)\b/.exec(text);
  if (m) return m[1] as EvidenceLabel;
  if (/\.md\b/.test(text)) return 'INTERNAL';
  return 'UNVERIFIED';
}

function constantLabel(name: keyof SpecConstants): EvidenceLabel {
  return (labelFromMeta(SPEC.constants_meta[name].status) ?? 'UNVERIFIED') as EvidenceLabel;
}

function categoryLabel(): EvidenceLabel {
  return labelFromMeta(SPEC.categories_meta.status) ?? 'PLACEHOLDER';
}

// ---------------------------------------------------------------- validation

const CENTS_FIELDS = [
  'currentBidCents',
  'nextBidCents',
  'startingBidCents',
  'estimatedResaleCents',
  'estimatedValueCents',
  'maxBudgetCents',
  'minProfitCents',
  'shippingCents',
  'pickupCostCents',
  'timeValueCents',
  'repairCents',
] as const;
const COUNT_FIELDS = ['bidCount', 'imageCount', 'descriptionWords'] as const;
const PCT_FIELDS = ['buyerPremiumPct', 'cardFeePct', 'salesTaxPct', 'targetMarginPct'] as const;
const NON_NEGATIVE_FIELDS = ['distanceMiles', 'costPerMileCents', 'softCloseMinutes'] as const;
const BOOLEAN_FIELDS = ['closeTimePrecise', 'hasReserve', 'reserveMet', 'pickupRequired', 'ships'] as const;

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  userGoal: ['resell', 'use'],
  riskTolerance: ['low', 'medium', 'high'],
  auctionFormat: ['live', 'online', 'hybrid', 'sealed_bid', 'fixed_price'],
  sourceTier: ['federal', 'state', 'county', 'municipal', 'school', 'private', 'estate', 'wholesale', 'marketplace', 'dealer'],
};

function present(v: unknown): boolean {
  return v !== null && v !== undefined;
}

function validate(ctx: LotContext): string[] {
  const errors: string[] = [];
  const c = ctx as Record<string, unknown>;
  for (const k of CENTS_FIELDS) {
    const v = c[k];
    if (present(v) && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) {
      errors.push(`${k} must be a whole, non-negative number of cents (got ${String(v)}).`);
    }
  }
  for (const k of COUNT_FIELDS) {
    const v = c[k];
    if (present(v) && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) {
      errors.push(`${k} must be a whole, non-negative count (got ${String(v)}).`);
    }
  }
  for (const k of PCT_FIELDS) {
    const v = c[k];
    if (present(v) && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)) {
      errors.push(`${k} must be a percentage from 0 to 100 (got ${String(v)}).`);
    }
  }
  for (const k of NON_NEGATIVE_FIELDS) {
    const v = c[k];
    if (present(v) && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      errors.push(`${k} must be a finite, non-negative number (got ${String(v)}).`);
    }
  }
  for (const k of BOOLEAN_FIELDS) {
    const v = c[k];
    if (present(v) && typeof v !== 'boolean') errors.push(`${k} must be true, false or null (got ${String(v)}).`);
  }
  for (const [k, allowed] of Object.entries(ENUMS)) {
    const v = c[k];
    if (present(v) && !(typeof v === 'string' && allowed.includes(v))) {
      errors.push(`${k} must be one of ${allowed.join(', ')} (got ${String(v)}).`);
    }
  }
  const s = ctx.sleeperScore;
  if (present(s) && !(typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 10)) {
    errors.push(`sleeperScore must be between 0 and 10 (got ${String(s)}).`);
  }
  for (const k of ['closesAt', 'sourcePlatform', 'category', 'brand', 'model', 'condition'] as const) {
    const v = c[k];
    if (present(v) && typeof v !== 'string') errors.push(`${k} must be a string (got ${String(v)}).`);
  }
  return errors;
}

// ---------------------------------------------------------------- helpers

function big(v: number | null | undefined): bigint | null {
  return v === null || v === undefined ? null : BigInt(v);
}

/** A validated JS number as an exact fraction. Validation already rejected NaN and infinities. */
function exact(v: number): Rat {
  return fromNumber(v) as Rat;
}

function pctToFraction(v: number): Rat {
  return div(exact(v), rat(100n));
}

function out(r: Rat): number {
  return toNumber(r);
}

/** The increment of the highest rung whose from_cents <= amount (the spec's increment_ladder op). */
export function specIncrement(amountCents: Rat, ladderName: string): Rat {
  const ladder = SPEC.increment_ladders[ladderName];
  if (!ladder) throw new Error(`unknown increment ladder "${ladderName}"`);
  let inc: number | null = null;
  for (const rung of ladder.rungs) {
    if (cmp(fromInt(rung.from_cents), amountCents) <= 0) inc = rung.increment_cents;
  }
  if (inc === null) throw new Error(`increment ladder "${ladderName}" has no rung for ${out(amountCents)} cents`);
  return fromInt(inc);
}

// ---------------------------------------------------------------- the reader

export function resolveLot(ctx: LotContext, options: EngineOptions = {}): ResolvedLot {
  const errors = validate(ctx);
  const notes: string[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  const unknownInputs: string[] = [];
  const params: Record<string, ParamUse> = {};
  const ov = options.overrides ?? {};

  const put = (name: string, value: OutValue, status: ParamStatus, source: string): void => {
    params[name] = { name, value, status, source };
  };

  // Past validation, every field is either absent or well-formed. When input is
  // invalid we still build a (meaningless) result so callers get errors, not a crash.
  const safe = errors.length === 0 ? ctx : {};

  // ---- constants: the doc's defaults, then calibrated overrides, then the user's own numbers
  const userConstant: Partial<Record<keyof SpecConstants, number>> = {};
  if (present(safe.costPerMileCents)) userConstant.mileage_cost_cents_per_mile = safe.costPerMileCents as number;
  if (present(safe.timeValueCents)) userConstant.pickup_time_cost_cents = safe.timeValueCents as number;
  const constants: SpecConstants = { ...SPEC.constants, ...(ov.constants ?? {}), ...userConstant };
  for (const name of Object.keys(SPEC.constants) as (keyof SpecConstants)[]) {
    const status: ParamStatus =
      name in userConstant ? 'USER' : ov.constants && name in ov.constants ? 'OVERRIDE' : constantLabel(name);
    const source =
      status === 'USER' ? 'your setting' : status === 'OVERRIDE' ? 'calibrated override' : 'spec constant';
    put(`constants.${name}`, constants[name], status, source);
  }
  const c = (name: keyof SpecConstants): Rat => exact(constants[name]);

  // ---- platform (spec input `platform`, looked up the way platform_attr does)
  const raw = (safe.sourcePlatform ?? '').trim().toLowerCase();
  const colon = raw.indexOf(':');
  let base = (colon >= 0 ? raw.slice(0, colon) : raw).replace(/[\s_.]+/g, '-').replace(/^-+|-+$/g, '');
  let suffix: string | null = colon >= 0 ? raw.slice(colon + 1).trim() || null : null;
  if (base === '') {
    notes.push('No sourcePlatform: using the spec\'s "other" platform defaults.');
    base = 'other';
  }
  const alias = PLATFORM_ALIASES[base];
  if (alias) {
    base = alias.base;
    suffix = suffix ?? alias.suffix ?? null;
    if (alias.note) notes.push(alias.note);
  }
  if (!KNOWN_BASES.has(base)) {
    notes.push(
      AMBIGUOUS_PLATFORMS[base] ??
        `Platform "${safe.sourcePlatform}" is not in the spec's table: using the "other" defaults (conservative premium and card fee; closing rule from the auction format, if known).`,
    );
    base = 'other';
  }
  if (suffix !== null && !SUFFIXES.has(suffix)) {
    notes.push(`Format suffix ":${suffix}" is not one the spec knows; ignored.`);
    suffix = null;
  }
  if (suffix === null && safe.auctionFormat) suffix = FORMAT_SUFFIX[safe.auctionFormat];
  const platformKey = suffix ? `${base}:${suffix}` : base;
  const platformEntryKey =
    platformKey in SPEC.platforms ? platformKey : base in SPEC.platforms ? base : 'other';
  const specPlatform = SPEC.platforms[platformEntryKey] as SpecPlatform;
  const platformOv = ov.platforms?.[platformEntryKey] ?? {};
  const platform: SpecPlatform = { ...specPlatform, ...platformOv };
  const platformStatus = (attr: keyof SpecPlatform, fallbackMeta?: string): ParamStatus => {
    if (attr in platformOv) return 'OVERRIDE';
    return labelFromMeta(platform._meta[attr]) ?? labelFromMeta(fallbackMeta) ?? 'UNVERIFIED';
  };
  const platformBase = platform.base;
  const closeType = platform.close_type;
  put('close_type', closeType, platformStatus('close_type', platform._meta.soft_close_default_minutes), `platform ${platformEntryKey}`);

  // ---- closing rule: window_min, is_hard_close, effective_close_type (spec derived, same order)
  const lotWindow = present(safe.softCloseMinutes) ? exact(safe.softCloseMinutes as number) : null;
  const platformWindow = platform.soft_close_default_minutes === null ? null : exact(platform.soft_close_default_minutes);
  const windowMin = lotWindow ?? platformWindow;
  if (lotWindow !== null) {
    put('extension_window_minutes', out(lotWindow), 'LOT', "the lot's terms");
  } else if (platformWindow !== null) {
    put(
      'extension_window_minutes',
      out(platformWindow),
      platformStatus('soft_close_default_minutes', platform._meta.close_type),
      `platform default (${platformEntryKey})`,
    );
  } else {
    put(
      'extension_window_minutes',
      constants.unknown_window_assumed_minutes,
      params['constants.unknown_window_assumed_minutes']?.status ?? 'DESIGN',
      'not captured; assumed (constants.unknown_window_assumed_minutes)',
    );
  }
  const isHardClose =
    closeType === 'hard' ||
    (['soft', 'inactivity', 'unknown'].includes(closeType) && windowMin !== null && windowMin.n === 0n);
  const effectiveCloseType: EffectiveCloseType = ['live', 'sealed', 'fixed'].includes(closeType)
    ? closeType
    : isHardClose
      ? 'hard'
      : ['soft', 'inactivity'].includes(closeType)
        ? closeType
        : windowMin !== null && windowMin.n > 0n
          ? 'soft'
          : 'unknown';
  const isExtendingClose = effectiveCloseType === 'soft' || effectiveCloseType === 'inactivity';
  const effectiveWindowMin = windowMin ?? c('unknown_window_assumed_minutes');

  // ---- category
  const rawCategory = (safe.category ?? '').trim();
  let categoryKey = rawCategory.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  categoryKey = CATEGORY_ALIASES[categoryKey] ?? categoryKey;
  if (!(categoryKey in SPEC.categories)) {
    notes.push(
      rawCategory === ''
        ? 'No category: using the spec\'s "other" category defaults.'
        : `Category "${rawCategory}" is not in the spec's table: using the "other" defaults.`,
    );
    categoryKey = 'other';
  }
  const catOv = ov.categories?.[categoryKey] ?? {};
  const cat: SpecCategory = { ...(SPEC.categories[categoryKey] as SpecCategory), ...catOv };
  const userGoal: UserGoal = safe.userGoal ?? 'resell';
  const catStatus = (attr: keyof SpecCategory): ParamStatus => (attr in catOv ? 'OVERRIDE' : categoryLabel());
  const catSource = `category ${categoryKey}`;

  let sellFeeRate = exact(cat.sell_fee_rate);
  let outboundShip = exact(cat.outbound_ship_cents);
  let targetMargin = exact(cat.target_margin_rate);
  let minProfit = exact(cat.min_profit_cents);
  let sellFeeStatus = catStatus('sell_fee_rate');
  let shipStatus = catStatus('outbound_ship_cents');
  let marginStatus = catStatus('target_margin_rate');
  let minProfitStatus = catStatus('min_profit_cents');
  let sellFeeSource = catSource;
  let shipSource = catSource;
  let marginSource = catSource;
  let minProfitSource = catSource;
  if (userGoal === 'use') {
    // docs/06 S2: a personal-use buyer's value is the best fixed-price
    // alternative, and the cap is all-in <= that. Selling fees and a resale
    // profit target describe a resale that will not happen, so they are zero
    // unless the user asks for a margin (a discount against the alternative).
    sellFeeRate = rat(0n);
    outboundShip = rat(0n);
    targetMargin = rat(0n);
    minProfit = rat(0n);
    sellFeeStatus = shipStatus = marginStatus = minProfitStatus = 'DESIGN';
    sellFeeSource = shipSource = marginSource = minProfitSource = 'personal use: no resale';
  }
  if (present(safe.targetMarginPct)) {
    targetMargin = pctToFraction(safe.targetMarginPct as number);
    marginStatus = 'USER';
    marginSource = 'your setting';
  }
  if (present(safe.minProfitCents)) {
    minProfit = fromInt(safe.minProfitCents as number);
    minProfitStatus = 'USER';
    minProfitSource = 'your setting';
  }
  const category: ResolvedCategory = {
    sellFeeRate,
    outboundShipCents: outboundShip,
    repairReserveRate: exact(cat.repair_reserve_rate),
    uncertaintyHaircutRate: exact(cat.uncertainty_haircut_rate),
    targetMarginRate: targetMargin,
    minProfitCents: minProfit,
    herdBidCount: exact(cat.herd_bid_count),
    highValueRisk: cat.high_value_risk,
  };
  put('category.sell_fee_rate', out(sellFeeRate), sellFeeStatus, sellFeeSource);
  put('category.outbound_ship_cents', out(outboundShip), shipStatus, shipSource);
  put('category.uncertainty_haircut_rate', cat.uncertainty_haircut_rate, catStatus('uncertainty_haircut_rate'), catSource);
  put('category.repair_reserve_rate', cat.repair_reserve_rate, catStatus('repair_reserve_rate'), catSource);
  put('category.target_margin_rate', out(targetMargin), marginStatus, marginSource);
  put('category.min_profit_cents', out(minProfit), minProfitStatus, minProfitSource);
  put('category.herd_bid_count', cat.herd_bid_count, catStatus('herd_bid_count'), catSource);
  put('category.high_value_risk', cat.high_value_risk, catStatus('high_value_risk'), catSource);

  // ---- premium, tax, card fee, k
  const lotBp = present(safe.buyerPremiumPct) ? exact(safe.buyerPremiumPct as number) : null;
  const bpAssumed = lotBp === null;
  let bpPct: Rat;
  let bpSource: BpSource;
  if (lotBp !== null) {
    bpPct = lotBp;
    bpSource = "the lot's terms";
    put('buyer_premium_pct', out(bpPct), 'LOT', bpSource);
  } else if (platform.bp_default_pct !== null) {
    bpPct = exact(platform.bp_default_pct);
    bpSource = 'platform default';
    put('buyer_premium_pct', out(bpPct), platformStatus('bp_default_pct'), `platform default (${platformEntryKey})`);
  } else {
    bpPct = c('bp_unknown_assumed_pct');
    bpSource = 'conservative assumption';
    const p = params['constants.bp_unknown_assumed_pct'] as ParamUse;
    put('buyer_premium_pct', out(bpPct), p.status, 'not captured; assumed (constants.bp_unknown_assumed_pct)');
  }

  let cardFeeRate: Rat;
  if (present(safe.cardFeePct)) {
    // The spec's card_fee_rate reads only the platform default. The lot's own
    // terms win over any default (section 4.3: "The lot's terms always win").
    cardFeeRate = pctToFraction(safe.cardFeePct as number);
    put('card_fee_rate', out(cardFeeRate), 'LOT', "the lot's terms");
  } else if (platform.card_fee_default_rate !== null) {
    cardFeeRate = exact(platform.card_fee_default_rate);
    put('card_fee_rate', out(cardFeeRate), platformStatus('card_fee_default_rate'), `platform default (${platformEntryKey})`);
  } else {
    cardFeeRate = c('card_fee_unknown_assumed_rate');
    const p = params['constants.card_fee_unknown_assumed_rate'] as ParamUse;
    put('card_fee_rate', out(cardFeeRate), p.status, 'not captured; assumed (constants.card_fee_unknown_assumed_rate)');
  }

  let taxRate: Rat;
  if (present(safe.salesTaxPct)) {
    taxRate = pctToFraction(safe.salesTaxPct as number);
    put('sales_tax_rate', out(taxRate), 'LOT', "the lot's terms");
  } else {
    taxRate = c('sales_tax_rate');
    const p = params['constants.sales_tax_rate'] as ParamUse;
    put('sales_tax_rate', out(taxRate), p.status, 'spec constant (Wisconsin 5% + 0.5% county)');
  }
  const k = mul(mul(add(ONE, div(bpPct, rat(100n))), add(ONE, taxRate)), add(ONE, cardFeeRate));

  // ---- the lot's bid state
  const fixed = effectiveCloseType === 'fixed';
  let current = big(safe.currentBidCents);
  const starting = big(safe.startingBidCents);
  const lotNext = big(safe.nextBidCents);
  let bidCount = present(safe.bidCount) ? (safe.bidCount as number) : null;
  if (fixed) {
    // A tag sale has a price, not bids. The spec reads the tag price as current_bid_cents.
    current = current ?? starting ?? lotNext;
    bidCount = bidCount ?? 0;
  } else if (current === null && bidCount === 0) {
    // "For a lot with no bids, the opening/minimum bid" (spec input doc).
    current = starting ?? lotNext;
  }
  if (current === null) missing.push('currentBidCents');

  const ladderName = platform.increment_ladder;
  const incrementCents = current === null ? null : specIncrement(fromInt(current), ladderName).n;
  let nextMinBidCents: bigint | null = null;
  let nextMinBidSource: ResolvedLot['nextMinBidSource'] = null;
  if (current !== null) {
    if (fixed) {
      nextMinBidCents = current;
      nextMinBidSource = 'tag';
    } else if (lotNext !== null && lotNext >= current) {
      // The ebay_us ladder note: "Auctioneers and GSA set their own increments;
      // the lot page wins." A next bid the source published is the lot page.
      nextMinBidCents = lotNext;
      nextMinBidSource = 'lot';
    } else {
      if (lotNext !== null) warnings.push('nextBidCents is below currentBidCents, so it was ignored.');
      if (bidCount === 0) {
        nextMinBidCents = current;
        nextMinBidSource = 'opening';
      } else if (bidCount !== null) {
        nextMinBidCents = current + (incrementCents as bigint);
        nextMinBidSource = 'ladder';
      } else {
        missing.push('bidCount');
      }
    }
  }
  if (nextMinBidSource === 'lot') {
    put('next_min_bid_cents', Number(nextMinBidCents), 'LOT', "the lot's published next bid");
  } else if (nextMinBidSource === 'ladder') {
    put(
      'next_min_bid_cents',
      Number(nextMinBidCents),
      (labelFromMeta(SPEC.increment_ladders[ladderName]?.status) ?? 'UNVERIFIED') as ParamStatus,
      `current bid + one ${ladderName} increment`,
    );
  }
  if (bidCount === null && !missing.includes('bidCount')) unknownInputs.push('bidCount');

  // ---- time
  let closesAtMs: number | null = null;
  if (!present(safe.closesAt)) {
    missing.push('closesAt');
  } else {
    closesAtMs = parseInstant(safe.closesAt as string);
    if (closesAtMs === null) {
      missing.push('closesAt');
      notes.push(`closesAt "${safe.closesAt}" is not an ISO-8601 instant with an explicit offset, so it cannot be read without guessing.`);
    }
  }
  const closeTimePrecise = safe.closeTimePrecise !== false;

  // ---- reserve
  let reserveFlag: ReserveFlag = 'unknown';
  if (safe.hasReserve === false) reserveFlag = 'absolute';
  else if (safe.reserveMet === true) reserveFlag = 'reserve_met';
  else if (safe.reserveMet === false) reserveFlag = 'reserve_not_met';

  // ---- descriptive fields
  const imageCount = present(safe.imageCount) ? (safe.imageCount as number) : null;
  const descriptionWords = present(safe.descriptionWords) ? (safe.descriptionWords as number) : null;
  if (imageCount === null) unknownInputs.push('imageCount');
  if (descriptionWords === null) unknownInputs.push('descriptionWords');

  // ---- value and budget
  const preferred = userGoal === 'use' ? safe.estimatedValueCents : safe.estimatedResaleCents;
  const other = userGoal === 'use' ? safe.estimatedResaleCents : safe.estimatedValueCents;
  if (present(preferred) && present(other) && preferred !== other) {
    notes.push(
      userGoal === 'use'
        ? 'Both estimatedValueCents and estimatedResaleCents are set; personal use reads estimatedValueCents (the fixed-price alternative).'
        : 'Both estimatedResaleCents and estimatedValueCents are set; resale reads estimatedResaleCents (sold comps).',
    );
  }
  const valueInput = present(preferred) ? (preferred as number) : present(other) ? (other as number) : null;
  const resaleCents = valueInput !== null && valueInput > 0 ? BigInt(valueInput) : null;
  const budgetInput = present(safe.maxBudgetCents) ? (safe.maxBudgetCents as number) : null;
  const budgetCents = budgetInput !== null && budgetInput > 0 ? BigInt(budgetInput) : null;

  // ---- transport (T)
  const distance = present(safe.distanceMiles) ? (safe.distanceMiles as number) : null;
  // Spec input doc: "null = ships or unknown". A lot that ships and does not
  // require pickup has no pickup trip, whatever its distance.
  const pickupDistance = distance !== null && (safe.pickupRequired === true || safe.ships !== true) ? distance : null;
  // A user's own figure beats the formula. A shipping quote is respected even on a
  // pickup-only lot: a freight company collecting on the buyer's behalf is a
  // normal way to move one, and the user is the one who knows.
  let transport: ResolvedLot['transport'] = { cents: rat(0n), known: false, basis: 'none' };
  if (present(safe.pickupCostCents)) {
    transport = { cents: fromInt(safe.pickupCostCents as number), known: true, basis: 'pickup_cost' };
    put('user.pickup_cost_cents', safe.pickupCostCents as number, 'USER', 'your pickup cost');
  } else if (present(safe.shippingCents)) {
    transport = { cents: fromInt(safe.shippingCents as number), known: true, basis: 'shipping' };
    put('user.shipping_cents', safe.shippingCents as number, 'USER', 'your shipping quote');
  }
  if (transport.basis === 'none') {
    if (pickupDistance !== null) {
      // T = 2 x d x cpm + time cost (section 4.1), exact.
      const cents = add(mul(mul(exact(pickupDistance), rat(2n)), c('mileage_cost_cents_per_mile')), c('pickup_time_cost_cents'));
      transport = { cents, known: true, basis: 'distance' };
    } else if (safe.pickupRequired === true) {
      warnings.push('Pickup is required but the distance is unknown, so the ceiling does not include the pickup trip. Add distanceMiles or pickupCostCents.');
    } else if (safe.ships === true) {
      warnings.push('This lot ships, and inbound shipping is not in the ceiling (the doc does not model it). Add shippingCents to include it.');
    } else {
      warnings.push('Transport cost is unknown and not in the ceiling. Add distanceMiles, pickupCostCents or shippingCents.');
    }
  }

  const repairCents = big(safe.repairCents);
  if (repairCents !== null) put('user.repair_cents', Number(repairCents), 'USER', 'your repair estimate');

  const specInputs: SpecInputs = {
    current_bid_cents: current === null ? null : Number(current),
    bid_count: bidCount === null ? UNKNOWN : bidCount,
    closes_at: closesAtMs === null ? null : (safe.closesAt as string),
    soft_close_window_minutes: present(safe.softCloseMinutes) ? (safe.softCloseMinutes as number) : null,
    platform: platformKey,
    buyer_premium_pct: present(safe.buyerPremiumPct) ? (safe.buyerPremiumPct as number) : null,
    reserve_flag: reserveFlag,
    pickup_distance_miles: pickupDistance,
    image_count: imageCount === null ? UNKNOWN : imageCount,
    description_word_count: descriptionWords === null ? UNKNOWN : descriptionWords,
    category: categoryKey,
    expected_resale_cents: valueInput,
    user_max_budget_cents: budgetInput,
  };

  return {
    ctx,
    errors,
    missing,
    unknownInputs,
    notes,
    warnings,
    platformKey,
    platformEntryKey,
    platform,
    platformBase,
    closeType,
    windowMin,
    isHardClose,
    effectiveCloseType,
    isExtendingClose,
    effectiveWindowMin,
    categoryKey,
    category,
    constants,
    bpAssumed,
    bpPct,
    bpSource,
    cardFeeRate,
    taxRate,
    k,
    currentBidCents: current,
    startingBidCents: starting,
    bidCount,
    nextMinBidCents,
    nextMinBidSource,
    incrementCents,
    closesAtMs,
    closeTimePrecise,
    reserveFlag,
    userGoal,
    resaleCents,
    budgetCents,
    transport,
    repairCents,
    specInputs,
    params,
  };
}
