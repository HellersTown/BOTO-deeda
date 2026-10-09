/**
 * Input and output types for the strategy engine.
 *
 * The input is a LotContext: what the app already has for one lot (lots,
 * auctions and sources rows) plus what the user told us about it. Every field is
 * optional, because a missing value is a fact we must report, not a gap to fill:
 * a lot with no captured premium gets a labelled conservative assumption, and a
 * lot with no value estimate gets no walk-away number at all.
 *
 * Money is integer cents throughout, as in packages/ingest. Rates the user or a
 * source supplies are percentages (15 for 15%), matching auctions.buyer_premium_pct.
 * Nothing here reads the clock: every function that needs "now" takes it as an
 * argument, so a test can pin it and a replay gives the same answer.
 */

// ---------------------------------------------------------------- vocabulary

/** Mirrors packages/ingest SourceTier. */
export type SourceTier =
  | 'federal'
  | 'state'
  | 'county'
  | 'municipal'
  | 'school'
  | 'private'
  | 'estate'
  | 'wholesale'
  | 'marketplace'
  | 'dealer';

/** Mirrors packages/ingest AuctionFormat. Maps onto the spec's platform suffixes. */
export type AuctionFormat = 'live' | 'online' | 'hybrid' | 'sealed_bid' | 'fixed_price';

export type UserGoal = 'resell' | 'use';
export type RiskTolerance = 'low' | 'medium' | 'high';

/** Closing rules as the spec's platforms table names them. */
export type CloseType = 'hard' | 'soft' | 'inactivity' | 'live' | 'sealed' | 'fixed' | 'unknown';
/** The spec's derived `effective_close_type`: the same set, after the lot's own window is applied. */
export type EffectiveCloseType = CloseType;

export type ReserveFlag = 'absolute' | 'reserve_met' | 'reserve_not_met' | 'unknown';

/**
 * Evidence labels from docs/06 ("Read this first"). They travel with every value
 * that came from the research, so the UI can refuse to present a PLACEHOLDER as
 * advice.
 */
export type EvidenceLabel = 'SE' | 'SE-2nd' | 'UNVERIFIED' | 'PLACEHOLDER' | 'INTERNAL' | 'DESIGN';

/**
 * Where a parameter value actually came from. The doc's labels, plus three that
 * mean "not the doc's default": the lot's own terms (LOT), the user's own input
 * (USER), and a calibrated replacement passed in by the app (OVERRIDE).
 */
export type ParamStatus = EvidenceLabel | 'LOT' | 'USER' | 'OVERRIDE';

export type Confidence = 'high' | 'medium-high' | 'medium' | 'low-medium' | 'low' | 'unverified';

// ---------------------------------------------------------------- input

export interface LotContext {
  // ---- The lot, as stored. Names follow packages/ingest NormalizedLot where one exists.

  /** Current high bid. On a lot with no bids, sources usually show the opening bid here. */
  currentBidCents?: number | null;
  /** The next bid the source will accept. When present it beats any increment ladder. */
  nextBidCents?: number | null;
  /** Opening / minimum bid. Used as the current bid when there are no bids yet. */
  startingBidCents?: number | null;
  bidCount?: number | null;
  /** ISO-8601 with an explicit offset. A time without an offset is ambiguous and is refused. */
  closesAt?: string | null;
  /**
   * False when the source publishes only a date (GSA's AucEndDt). The ingest GSA
   * adapter resolves that date to 23:59:59 America/New_York, so closesAt is then the
   * END of the close day and the real close can be up to a day earlier. Defaults to
   * true, which is what every other adapter produces.
   */
  closeTimePrecise?: boolean | null;
  /** The lot's published extension (anti-sniping) window in minutes; 0 = hard close. */
  softCloseMinutes?: number | null;
  /** false = no reserve (absolute auction). */
  hasReserve?: boolean | null;
  reserveMet?: boolean | null;
  /** Percent, e.g. 15 for 15%. null = not captured (the spec then assumes). */
  buyerPremiumPct?: number | null;
  /** Card surcharge in percent, when the lot's terms state it. */
  cardFeePct?: number | null;
  /** Sales/use tax in percent. 0 for a reseller buying with an exemption certificate. */
  salesTaxPct?: number | null;
  /** compute_sleeper() score, 0-10. Display only; the spec's R34 uses the raw thresholds. */
  sleeperScore?: number | null;
  imageCount?: number | null;
  /** Word count of title + description, i.e. lots.desc_richness. */
  descriptionWords?: number | null;
  /** A key of the spec's categories table (tools, electronics, vehicles, ...). Others fall back to 'other'. */
  category?: string | null;
  brand?: string | null;
  model?: string | null;
  condition?: string | null;
  /** sources.platform, e.g. 'gsa', 'hibid', 'ebay', 'govdeals', 'maxsold'. May carry a ':webcast' style suffix. */
  sourcePlatform?: string | null;
  sourceTier?: SourceTier | null;
  /** The auction's format. Picks the spec's ':webcast', ':sealed', ':tag' or ':timed' variant of the platform. */
  auctionFormat?: AuctionFormat | null;
  pickupRequired?: boolean | null;
  /** One-way road miles from the user to the pickup site. */
  distanceMiles?: number | null;
  ships?: boolean | null;

  // ---- The user's inputs.

  /** Median of recent SOLD comps, same item, same condition. Needed for a value-based ceiling. */
  estimatedResaleCents?: number | null;
  /** For a personal-use buyer: the best fixed-price alternative (docs/06 S2). */
  estimatedValueCents?: number | null;
  /** The most the user will pay the auction for this lot, invoice total. The spec's user_max_budget_cents. */
  maxBudgetCents?: number | null;
  /** Replaces the category's target margin (a PLACEHOLDER). Percent of resale. */
  targetMarginPct?: number | null;
  /** Replaces the category's minimum profit per lot (a PLACEHOLDER). */
  minProfitCents?: number | null;
  /**
   * Inbound shipping: what it costs to have the lot shipped to you. The doc does
   * not model this ("inbound shipping not modelled"); when given it stands in for
   * the pickup cost, because a shipped lot has no pickup trip.
   */
  shippingCents?: number | null;
  /** The whole pickup trip, if the user knows it. Replaces 2 x miles x cost-per-mile + time. */
  pickupCostCents?: number | null;
  /** Replaces the 70 cents/mile default (UNVERIFIED). May be fractional, e.g. 65.5. */
  costPerMileCents?: number | null;
  /** The value of the user's time for one pickup trip. Replaces the $25 PLACEHOLDER. */
  timeValueCents?: number | null;
  /** A known repair estimate. Replaces the category's repair reserve rate. */
  repairCents?: number | null;
  /** Default 'resell'. 'use' drops resale costs and the profit target (see README). */
  userGoal?: UserGoal | null;
  /** Changes wording and ordering only. The doc gives no basis for changing the numbers with it. */
  riskTolerance?: RiskTolerance | null;
}

// ---------------------------------------------------------------- options

export interface LadderRung {
  readonly fromCents: number;
  readonly incrementCents: number;
}
export type Ladder = readonly LadderRung[];

/** Calibrated replacements for spec parameters. Anything replaced is labelled OVERRIDE in the output. */
export interface SpecOverrides {
  readonly constants?: Partial<SpecConstants>;
  readonly categories?: Readonly<Record<string, Partial<SpecCategory>>>;
  readonly platforms?: Readonly<Record<string, Partial<Omit<SpecPlatform, '_meta' | 'base'>>>>;
}

export interface EngineOptions {
  readonly overrides?: SpecOverrides;
  /**
   * Increment ladder used to round the walk-away number down to a bid the site
   * will accept. Default: DEFAULT_LADDER, the ladder in ingest money.ts
   * defaultNextBidCents. null turns rounding off. Never applied to sealed bids or
   * tag sales, where any amount is a valid offer.
   */
  readonly ladder?: Ladder | null;
}

// ---------------------------------------------------------------- shared output pieces

/** A number, a string or a flag as it leaves the engine. Money is integer cents. */
export type OutValue = number | string | boolean | null;

/** One parameter that fed a result, with where it came from. */
export interface ParamUse {
  readonly name: string;
  readonly value: OutValue;
  readonly status: ParamStatus;
  /** Plain words: "platform default (govdeals)", "the lot's terms", "category tools". */
  readonly source: string;
}

// ---------------------------------------------------------------- calculator output

export type TransportBasis = 'distance' | 'pickup_cost' | 'shipping' | 'none';

export interface CalculatorBreakdown {
  readonly userGoal: UserGoal;
  /** R: resale value (or fixed-price alternative for personal use). */
  readonly expectedResaleCents: number | null;
  /** B: the user's budget, invoice total. */
  readonly budgetCents: number | null;
  /** R x f: marketplace and payment fees on resale. */
  readonly sellFeesCents: number | null;
  /** s: outbound shipping the user absorbs on resale. */
  readonly outboundShipCents: number | null;
  /** N = R(1 - f) - s. */
  readonly netProceedsCents: number | null;
  /** P = max(m x R, Pmin). */
  readonly profitTargetCents: number | null;
  /** Which side of max(m x R, Pmin) set P. */
  readonly profitTargetBasis: 'margin' | 'minimum' | null;
  /** u x R: winner's-curse / lemon reserve. */
  readonly uncertaintyReserveCents: number | null;
  /** r x R, or the user's repair estimate. */
  readonly repairReserveCents: number | null;
  /** X = uncertainty + repair. */
  readonly riskReserveCents: number | null;
  /** T: pickup trip, or inbound shipping. */
  readonly transportCents: number;
  readonly transportBasis: TransportBasis;
  /** N - P - T - X: the most the invoice can be. Negative means no price works. */
  readonly roomCents: number | null;
  /** H_resale = max(0, floor_to_dollar(room / k)). */
  readonly maxHammerResaleCents: number | null;
  /** H_budget = floor_to_dollar(B / k). */
  readonly maxHammerBudgetCents: number | null;
}

/** An invoice at one hammer price. Lines add up exactly to totalCents. */
export interface InvoiceBreakdown {
  readonly hammerCents: number;
  readonly premiumCents: number;
  readonly taxCents: number;
  readonly cardFeeCents: number;
  /** hammer x k, rounded to the nearest cent (halves up), like an invoice line. */
  readonly totalCents: number;
}

export interface CalculatorResult {
  /**
   * ok: there is a bid to place. walk_away: no bid meets the target.
   * insufficient_data: no value estimate and no budget. invalid_input: see errors.
   */
  readonly status: 'ok' | 'walk_away' | 'insufficient_data' | 'invalid_input';
  /** Why the result is not 'ok', in plain words. */
  readonly reason: string | null;
  /**
   * The walk-away number to type into the site: the hammer ceiling rounded down
   * to the increment ladder, never below the lot's next acceptable bid.
   * null = don't bid.
   */
  readonly maxBidCents: number | null;
  /** The spec's H_max (max_hammer_cents): the most the hammer may reach, whole dollars. */
  readonly hammerCeilingCents: number | null;
  readonly bindingCap: 'resale value' | 'budget' | 'none';
  /** The smallest bid the lot accepts now. The max bid is never rounded below it. null = unknown. */
  readonly nextMinBidCents: number | null;
  readonly ladder: 'default' | 'custom' | 'none';
  readonly breakdown: CalculatorBreakdown;
  readonly invoiceAtMaxBid: InvoiceBreakdown | null;
  /** Invoice at the max bid plus transport: what winning at that bid really costs. */
  readonly allInAtMaxBidCents: number | null;
  /** N - all-in - X at the max bid. Never below the profit target when the status is ok. */
  readonly profitAtMaxBidCents: number | null;
  /** R / 3, the practitioner rule of thirds. UNVERIFIED; a cross-check, never the ceiling. */
  readonly thirdsRuleCents: number | null;
  /** T / R. */
  readonly transportShare: number | null;
  /** k = (1 + bp) x (1 + tax) x (1 + card fee). For display; the math uses it exactly. */
  readonly costMultiplier: number;
  /** floor(10000 x k): what $100 of hammer costs on the invoice. */
  readonly costPer100Cents: number;
  readonly rates: { readonly buyerPremiumPct: number; readonly salesTaxPct: number; readonly cardFeePct: number };
  /** Every parameter that set the ceiling, with its status. */
  readonly parameters: readonly ParamUse[];
  /** Names of PLACEHOLDER parameters behind the ceiling. Non-empty means: show it as unverified. */
  readonly placeholders: readonly string[];
  /** Names of UNVERIFIED parameters behind the ceiling. */
  readonly unverified: readonly string[];
  /** Things that move the number and that the user can fix. */
  readonly warnings: readonly string[];
  /** How the inputs were read (aliases, fallbacks). */
  readonly notes: readonly string[];
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------- projection output

/**
 * What winning at one hammer price makes, or for a personal-use buyer saves, on
 * the walk-away number's own terms. projectAtHammer at the max bid gives
 * exactly profitAtMaxBidCents.
 */
export interface Projection {
  /** ok: a value was given. insufficient_data: no value, so the cost only. invalid_input: see errors. */
  readonly status: 'ok' | 'insufficient_data' | 'invalid_input';
  readonly userGoal: UserGoal;
  readonly hammerCents: number;
  readonly invoice: InvoiceBreakdown | null;
  /** Invoice plus transport: what winning at this hammer costs out the door. */
  readonly allInCents: number | null;
  /** N: resale after selling fees and outbound shipping; for 'use', the fixed-price alternative. */
  readonly netProceedsCents: number | null;
  /** X: the uncertainty and repair reserve, counted as a cost as in profitAtMaxBidCents. */
  readonly riskReserveCents: number | null;
  readonly transportCents: number;
  /** N - hammer x k - T - X. The profit, or for 'use' the saving against the alternative. null without a value. */
  readonly profitCents: number | null;
  /** profitCents / allInCents, a fraction. null when either is missing or the all-in cost is 0. */
  readonly returnOnCost: number | null;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------- rules output

export type RuleKind = 'action' | 'warning' | 'info';

/** One fired rule, per the spec's output_contract (rule_id is ruleId here). */
export interface FiredRule {
  readonly ruleId: string;
  readonly code: string;
  /** The spec's `kind`, which is the severity: action, then warning, then info. */
  readonly kind: RuleKind;
  readonly priority: number;
  readonly confidence: 'high' | 'medium' | 'low';
  /** evidence_index ids. */
  readonly evidence: readonly string[];
  /** The strongest label among the cited sources (docs/06 section 11). */
  readonly evidenceLabel: EvidenceLabel;
  /** The rendered message. */
  readonly text: string;
  /** name -> value for every name in the rule's `numbers`. */
  readonly numbers: Readonly<Record<string, OutValue>>;
  /** Every variable the rule's `when` reads, with its value: the inputs that made it fire. */
  readonly triggeredBy: Readonly<Record<string, OutValue>>;
  /** Parameters behind the rule, with their status. */
  readonly parameters: readonly ParamUse[];
  /** True when any parameter behind the rule is a PLACEHOLDER. */
  readonly placeholder: boolean;
  readonly caveats: readonly string[];
}

export interface NotEvaluatedRule {
  readonly ruleId: string;
  readonly code: string;
  /** The missing lot fields that the rule needs. */
  readonly needs: readonly string[];
}

export interface RulesResult {
  readonly status: 'ok' | 'insufficient_data' | 'invalid_input';
  /** Lot fields without which nothing can be evaluated. */
  readonly missing: readonly string[];
  readonly errors: readonly string[];
  /** The fired action with the lowest priority number (output_contract.primary). */
  readonly primary: FiredRule | null;
  readonly actions: readonly FiredRule[];
  readonly warnings: readonly FiredRule[];
  readonly info: readonly FiredRule[];
  /** All fired rules, ascending priority. */
  readonly fired: readonly FiredRule[];
  /** Rules that could neither fire nor be ruled out, because a lot field is missing. */
  readonly notEvaluated: readonly NotEvaluatedRule[];
  /** The spec inputs as read from the context. */
  readonly inputs: Readonly<Record<string, OutValue>>;
  /** Every derived value (output_contract.derived). Money rounded to whole cents for display. */
  readonly derived: Readonly<Record<string, OutValue>>;
  readonly platformKey: string | null;
  readonly categoryKey: string | null;
  readonly notes: readonly string[];
  readonly caveats: readonly string[];
}

// ---------------------------------------------------------------- strategies output

export type StrategyId =
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7'
  | 'S8' | 'S9' | 'S10' | 'S11' | 'S12' | 'S13' | 'S14'
  | 'S15' | 'S16' | 'S17' | 'S18' | 'S19' | 'S20' | 'S21';

export type AlertKind = 'hard_close' | 'extension_window' | 'before_sale' | 'before_deadline' | 'none';

/** What a strategy says for one closing rule, where the advice differs by format (S20). */
export interface StrategyVariant {
  readonly message: string;
  readonly alert: AlertKind;
  readonly evidenceLabel: EvidenceLabel;
  readonly confidence: Confidence;
}

/** One of the 21 strategies in docs/06 section 2, as data. */
export interface Strategy {
  readonly id: StrategyId;
  readonly name: string;
  /** One line. */
  readonly summary: string;
  /** The doc's "Applies to", verbatim or nearly. */
  readonly appliesTo: string;
  /**
   * lot: decided per lot by `when`. hunt: a way of finding lots (search side).
   * portfolio: spans several lots. Only lot strategies are ever "applicable" to a lot.
   */
  readonly scope: 'lot' | 'hunt' | 'portfolio';
  /** When it applies, as JSONLogic over the lot's derived values and fired rules. null for hunt/portfolio. */
  readonly when: JsonLogic | null;
  /** The section 9 rules that operationalise it. */
  readonly rules: readonly string[];
  /** The alert the app should arm for it. */
  readonly alert: AlertKind;
  /** What to tell the user. Template syntax as the rules use. */
  readonly message: string;
  readonly evidence: readonly string[];
  readonly evidenceLabel: EvidenceLabel;
  readonly confidence: Confidence;
  readonly displayAs: 'advice' | 'cross-check' | 'prose';
  /** Parameters the advice itself leans on, by provenance name (e.g. 'category.herd_bid_count'). */
  readonly parameters: readonly string[];
  /** Per-format message and labels, keyed by effective close type. */
  readonly variants?: Readonly<Partial<Record<EffectiveCloseType, StrategyVariant>>>;
}

export interface Timing {
  readonly mode:
    | 'snipe'
    | 'proxy_before_window'
    | 'in_extension_window'
    | 'proxy_before_close_date'
    | 'absentee'
    | 'sealed'
    | 'tag'
    | 'unknown_rule'
    | 'walk_away'
    | 'closed';
  readonly closeType: EffectiveCloseType;
  /** false: the close is known only to the day. Show no countdown. */
  readonly precise: boolean;
  /** Whether a countdown to closesAt is honest to show. Same as precise. */
  readonly countdown: boolean;
  /** Extension window used for the advice, minutes. */
  readonly windowMinutes: number | null;
  /** True when the window was not captured and the spec's 10-minute assumption applies. */
  readonly windowAssumed: boolean;
  /** Pre-fill for watchlist.remind_seconds_before. */
  readonly alertSecondsBefore: number | null;
  readonly alertAt: string | null;
  /** When to enter the single bid: the target moment for a hard close, otherwise the latest safe moment. */
  readonly bidAt: string | null;
  readonly instruction: string;
}

export interface RankedStrategy {
  readonly rank: number;
  readonly id: StrategyId;
  readonly name: string;
  readonly summary: string;
  /** What to tell the user, rendered for this lot. */
  readonly message: string;
  readonly alert: { readonly kind: AlertKind; readonly secondsBefore: number | null };
  readonly evidenceLabel: EvidenceLabel;
  readonly confidence: Confidence;
  /** The strategy's section 9 rules that fired for this lot. */
  readonly firedRules: readonly string[];
  /** advice: show as advice. cross-check: show next to the ceiling, labelled, never as the ceiling. prose: a caution, not automated. */
  readonly displayAs: 'advice' | 'cross-check' | 'prose';
  readonly parameters: readonly ParamUse[];
  readonly placeholder: boolean;
}

export interface Recommendation {
  readonly status: 'ok' | 'walk_away' | 'needs_value' | 'closed' | 'insufficient_data' | 'invalid_input';
  readonly walkAway: CalculatorResult;
  readonly timing: Timing | null;
  readonly primary: FiredRule | null;
  /** Applicable strategies, most important first. */
  readonly strategies: readonly RankedStrategy[];
  /** Plain-English lines, in reading order. */
  readonly explanation: readonly string[];
  /** Everything unverified behind this recommendation, for the UI's "unverified" badge. */
  readonly labels: { readonly placeholders: readonly string[]; readonly unverified: readonly string[] };
  readonly rules: RulesResult;
}

// ---------------------------------------------------------------- the section 9 spec, typed

export type JsonLogic =
  | null
  | boolean
  | number
  | string
  | readonly JsonLogic[]
  | { readonly [op: string]: JsonLogic };

export interface SpecConstants {
  readonly sales_tax_rate: number;
  readonly bp_unknown_assumed_pct: number;
  readonly card_fee_unknown_assumed_rate: number;
  readonly mileage_cost_cents_per_mile: number;
  readonly pickup_time_cost_cents: number;
  readonly transport_share_warn: number;
  readonly reserve_stop_ratio: number;
  readonly thin_listing_max_words: number;
  readonly full_confidence_min_photos: number;
  readonly quiet_max_bids: number;
  readonly closing_quiet_minutes: number;
  readonly hard_close_alert_seconds: number;
  readonly manual_snipe_seconds: number;
  readonly soft_close_alert_buffer_minutes: number;
  readonly unknown_window_assumed_minutes: number;
  readonly live_absentee_alert_seconds: number;
  readonly sealed_alert_seconds: number;
  readonly tag_final_day_discount_rate: number;
  readonly winners_curse_note_min_haircut: number;
}

export interface SpecPlatform {
  readonly base: string;
  readonly close_type: CloseType;
  readonly soft_close_default_minutes: number | null;
  readonly bp_default_pct: number | null;
  readonly card_fee_default_rate: number | null;
  readonly increment_ladder: string;
  readonly _meta: Readonly<Record<string, string>>;
}

export interface SpecCategory {
  readonly sell_fee_rate: number;
  readonly outbound_ship_cents: number;
  readonly repair_reserve_rate: number;
  readonly uncertainty_haircut_rate: number;
  readonly target_margin_rate: number;
  readonly min_profit_cents: number;
  readonly herd_bid_count: number;
  readonly high_value_risk: boolean;
}

export interface SpecRule {
  readonly id: string;
  readonly code: string;
  readonly kind: RuleKind;
  readonly priority: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly evidence: readonly string[];
  readonly when: JsonLogic;
  readonly text: string;
  readonly numbers: readonly string[];
}

export interface SpecInputDef {
  readonly type: string | readonly string[];
  readonly required: boolean;
  readonly format?: string;
  readonly enum?: readonly string[];
  readonly user_input?: boolean;
  readonly doc?: string;
}

export interface RulesSpec {
  readonly spec: string;
  readonly version: string;
  readonly as_of: string;
  readonly status_legend: Readonly<Record<string, string>>;
  readonly expression_language: {
    readonly name: string;
    readonly standard_ops: readonly string[];
    readonly notes: readonly string[];
    readonly custom_ops: Readonly<Record<string, string>>;
  };
  readonly inputs: Readonly<Record<string, SpecInputDef>>;
  readonly context: Readonly<Record<string, string>>;
  readonly constants: SpecConstants;
  readonly constants_meta: { readonly [K in keyof SpecConstants]: { readonly status: string; readonly note?: string } };
  readonly increment_ladders: Readonly<
    Record<
      string,
      {
        readonly status: string;
        readonly source: string;
        readonly note: string;
        readonly rungs: readonly { readonly from_cents: number; readonly increment_cents: number }[];
      }
    >
  >;
  readonly platforms: Readonly<Record<string, SpecPlatform>>;
  readonly categories: Readonly<Record<string, SpecCategory>>;
  readonly categories_meta: { readonly status: string; readonly note: string };
  readonly derived: readonly { readonly name: string; readonly expr: JsonLogic; readonly doc?: string }[];
  readonly rules: readonly SpecRule[];
  readonly output_contract: {
    readonly per_lot: Readonly<Record<string, unknown>>;
    readonly template_syntax: string;
  };
  readonly evidence_index: Readonly<Record<string, string>>;
}
