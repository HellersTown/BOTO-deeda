/**
 * The 21 strategies of docs/06 section 2, and recommend(), which turns one lot
 * into: a walk-away number, a moment to act, the strategies that apply, and the
 * reasons, in plain words.
 *
 * Skeuos cannot bid, so every strategy ends the same way: compute a number,
 * pick a moment, alert the user, deep-link to the lot. The strategies differ in
 * which moment and why.
 *
 * Each strategy's "when" is JSONLogic over the same values the section 9 rules
 * read, plus which rules fired. Most strategies are operationalised by rules
 * (S4 is R10, S8 is R32) and simply apply when their rule fires; the rest carry
 * the doc's "Applies to" as a condition. Three are not about a single lot at all
 * (S11 and S16 are about finding lots, S19 about a set of bids), so they are
 * never "applicable" to one and recommend() does not list them.
 */

import { type Rat, cmp, formatPlain, formatUsd, toNumber } from './exact.ts';
import { type EvalEnv, UNKNOWN, type Unknown, evaluate, truthy } from './jsonlogic.ts';
import { calculate } from './calculator.ts';
import { GOVERNMENT_PLATFORMS, GOVERNMENT_TIERS, type ResolvedLot, resolveLot } from './resolve.ts';
import { type DerivedValue, IMPRECISE_CLOSE_CAVEAT, assertNow, evaluateResolved, renderTemplate } from './rules.ts';
import type {
  AlertKind,
  CalculatorResult,
  Confidence,
  EngineOptions,
  FiredRule,
  LotContext,
  ParamStatus,
  ParamUse,
  RankedStrategy,
  Recommendation,
  RiskTolerance,
  Strategy,
  StrategyId,
  Timing,
} from './types.ts';

// ---------------------------------------------------------------- parameters of our own

/**
 * The few numbers this file adds to the doc. All are DESIGN choices, not
 * findings, and all are overridable per call.
 */
export interface StrategyParameters {
  /** S7 is for "multi-day timed auctions ... don't bid until the final hours": more than this many minutes left. */
  readonly multi_day_minutes: number;
  /** S9 is for "low openings ($1 starts)": an opening bid at or under this. */
  readonly low_opening_max_cents: number;
  /**
   * How far before closesAt the real close can be when only a date is published.
   * The ingest GSA adapter resolves a date to 23:59:59 America/New_York, so up to
   * a day.
   */
  readonly imprecise_close_uncertainty_seconds: number;
}

export const STRATEGY_PARAMETERS: StrategyParameters = Object.freeze({
  multi_day_minutes: 1440,
  low_opening_max_cents: 100,
  imprecise_close_uncertainty_seconds: 86400,
});

export interface RecommendOptions extends EngineOptions {
  readonly strategyParameters?: Partial<StrategyParameters>;
}

// ---------------------------------------------------------------- the library

const OPEN = { var: 'is_open' };
const NOT_WALKING_AWAY = { '!': [{ var: 'walking_away' }] };
const TIMED = ['hard', 'soft', 'inactivity', 'unknown'];
const ONLINE = [...TIMED, 'live'];
const fired = (id: string) => ({ var: `fired.${id}` });

/** docs/06 section 2, S1 to S21. Messages use the rules' template syntax. */
export const STRATEGIES: readonly Strategy[] = [
  {
    id: 'S1',
    name: 'Set the walk-away number before you look at the bidding',
    summary: 'Decide the most the hammer may reach from what the item sells for, and never bid above it.',
    appliesTo: 'Every format, platform and category.',
    scope: 'lot',
    when: OPEN,
    // R19 is not attached to any strategy in the doc; it is S1's number entered as one max bid.
    rules: ['R01', 'R02', 'R19', 'R20', 'R21'],
    alert: 'none',
    message:
      'Set your walk-away number from sold comps before you look at the bidding. Never bid above it; revise it only for new information about the item (condition, completeness, provenance, better comps), never because someone else bid.',
    evidence: ['lee_malmendier_2011', 'bazerman_samuelson_1983', 'ku_malhotra_murnighan_2005'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S2',
    name: 'Cap every bid at the fixed-price alternative',
    summary: 'Never pay more all-in than the same item costs at a fixed price.',
    appliesTo:
      'Anything that also sells at a fixed price, such as eBay Buy It Now, retail or dealer stock. It matters most for personal-use buyers.',
    scope: 'lot',
    when: { and: [OPEN, { var: 'has_value' }, { or: [{ '==': [{ var: 'user_goal' }, 'use'] }, fired('R30')] }] },
    rules: ['R30'],
    alert: 'none',
    message:
      'Your all-in cost, with premium, tax, card fee and pickup, must stay at or below the best fixed-price alternative. Check Buy It Now, retail and dealer stock before bidding.',
    evidence: ['lee_malmendier_2011', 'schneider_2016'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S3',
    name: 'Price the whole invoice, not the hammer',
    summary: 'Premium, tax and card fee multiply the hammer; pickup comes on top.',
    appliesTo: 'Every auction with a premium, tax, card fee, storage or removal cost.',
    scope: 'lot',
    when: { and: [OPEN, { or: [{ '>': [{ var: 'cost_multiplier' }, 1] }, { '>': [{ var: 'transport_cents' }, 0] }] }] },
    // Section 4.5 attributes WALK_AWAY_UNECONOMIC (R01) to S3 and S17.
    rules: ['R01', 'R35', 'R36'],
    alert: 'none',
    message:
      'Every $100 of hammer costs about {cost_per_100_cents|usd} on the invoice before pickup. Judge the lot by the all-in number, never the hammer.',
    evidence: ['govdeals_thirdparty', 'wisconsin_surplus_terms', 'gsa_thirdparty', 'gsa_faq'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: ['buyer_premium_pct', 'sales_tax_rate', 'card_fee_rate'],
  },
  {
    id: 'S4',
    name: 'Hard close: one bid, at your ceiling, in the last seconds',
    summary: 'On a fixed end time, place a single bid at your ceiling about 10 seconds before the close.',
    appliesTo: 'eBay, and any lot whose published extension window is 0.',
    scope: 'lot',
    // A last-seconds bid needs a close time to the second; a date-only close gets S5's proxy advice instead.
    when: { and: [fired('R10'), { var: 'close_time_precise' }] },
    rules: ['R10'],
    alert: 'hard_close',
    message:
      "Don't bid while watching. At the alert, place one bid of your ceiling with about {constants.manual_snipe_seconds} seconds left. Don't go later by hand: very late bids can fail to register.",
    evidence: ['roth_ockenfels_2002', 'ariely_ockenfels_roth_2005', 'ockenfels_roth_2006', 'ely_hossain_2009', 'gray_reiley_2013'],
    evidenceLabel: 'SE',
    confidence: 'medium',
    displayAs: 'advice',
    parameters: ['constants.hard_close_alert_seconds', 'constants.manual_snipe_seconds'],
  },
  {
    id: 'S5',
    name: 'Extending close: enter your ceiling as a proxy before the window opens',
    summary: 'Where late bids extend the clock, enter your full ceiling once, before the extension window.',
    appliesTo:
      'GovDeals, Public Surplus, Municibid, Wisconsin Surplus, HiBid timed, K-BID, Proxibid timed, MaxSold, AuctionNinja and GSA (inactivity close).',
    scope: 'lot',
    when: { or: [fired('R11'), fired('R12')] },
    rules: ['R11', 'R12', 'R13'],
    alert: 'extension_window',
    message:
      'Enter your ceiling once as a max (proxy) bid at least {proxy_deadline_minutes_before_close} minutes before the scheduled close, then leave it. A bid in the last {effective_window_min} minutes only restarts the clock.',
    evidence: ['ockenfels_roth_2006', 'overstock_softclose_2019', 'public_surplus_extensions', 'wisconsin_surplus_terms', 'gsa_faq'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: ['extension_window_minutes', 'constants.soft_close_alert_buffer_minutes'],
  },
  {
    id: 'S6',
    name: 'Bid once; never increment',
    summary: 'At most one bid per lot, at your ceiling; a second only after new information about the item.',
    appliesTo: 'All online formats.',
    scope: 'lot',
    when: { and: [OPEN, NOT_WALKING_AWAY, { in: [{ var: 'effective_close_type' }, ONLINE] }] },
    rules: [],
    alert: 'none',
    message:
      'Place one bid, at your ceiling. A second bid is for new information about the item, never an answer to another bidder.',
    evidence: ['ockenfels_roth_2006', 'backus_et_al_2015', 'heyman_orhun_ariely_2004'],
    evidenceLabel: 'SE',
    confidence: 'medium-high',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S7',
    name: "Don't sit in the lead for days",
    summary: 'Watch a multi-day auction, but bid only at the end.',
    appliesTo: 'Multi-day timed auctions.',
    scope: 'lot',
    when: {
      and: [
        OPEN,
        NOT_WALKING_AWAY,
        { in: [{ var: 'effective_close_type' }, TIMED] },
        { '>': [{ var: 'minutes_to_close' }, { var: 'strategy.multi_day_minutes' }] },
      ],
    },
    rules: [],
    alert: 'none',
    message:
      "Watch, but don't bid yet. Leading for longer makes bidders value a lot more, and an early bid of yours draws other bidders to it. Bid just before the extension window, or in the final seconds on a hard close.",
    evidence: ['heyman_orhun_ariely_2004', 'simonsohn_ariely_2008'],
    evidenceLabel: 'SE',
    confidence: 'medium',
    displayAs: 'advice',
    parameters: ['strategy.multi_day_minutes'],
  },
  {
    id: 'S8',
    name: 'Fade the herd: a high bid count is not a quality signal',
    summary: 'Bidders herd into lots that already have bids; that is not evidence of quality.',
    appliesTo: 'All online auctions.',
    scope: 'lot',
    when: fired('R32'),
    rules: ['R32'],
    alert: 'none',
    message:
      'Crowded lot. The bid count is not evidence of quality: look for a quieter comparable lot, and if you stay, keep to your ceiling.',
    evidence: ['simonsohn_ariely_2008'],
    evidenceLabel: 'SE',
    confidence: 'medium-high',
    displayAs: 'advice',
    parameters: ['category.herd_bid_count'],
  },
  {
    id: 'S9',
    name: 'Anchor on comps, never on the opening price',
    summary: 'A low start predicts a higher finish, not a bargain.',
    appliesTo: 'No-reserve lots and low openings ($1 starts, "no reserve" farm and estate auctions).',
    scope: 'lot',
    when: {
      and: [
        OPEN,
        NOT_WALKING_AWAY,
        { in: [{ var: 'effective_close_type' }, ONLINE] },
        {
          or: [
            { '==': [{ var: 'reserve_flag' }, 'absolute'] },
            {
              and: [
                { '!=': [{ var: 'opening_bid_cents' }, null] },
                { '<=': [{ var: 'opening_bid_cents' }, { var: 'strategy.low_opening_max_cents' }] },
              ],
            },
          ],
        },
      ],
    },
    rules: [],
    alert: 'none',
    message:
      'Ignore the opening price and the current bid when judging value. A low start predicts a higher finish, not a bargain.',
    evidence: ['ku_galinsky_murnighan_2006'],
    evidenceLabel: 'SE',
    confidence: 'medium-high',
    displayAs: 'advice',
    parameters: ['strategy.low_opening_max_cents'],
  },
  {
    id: 'S10',
    name: 'Hunt thin disclosure, with a condition haircut',
    summary: 'Thin listings draw fewer rivals and carry more condition risk; the ceiling prices the risk in.',
    appliesTo: 'Every platform, and especially general-merchandise, estate and municipal lots.',
    scope: 'lot',
    when: { or: [fired('R33'), fired('R34'), fired('R45')] },
    rules: ['R33', 'R34', 'R45'],
    alert: 'none',
    message:
      'Few photos or little text means fewer rivals and more condition risk. Identify the item from the photos before bidding; with no photos on a high-value category, inspect at preview or skip.',
    evidence: ['lewis_2011', 'nizard_thesis', 'sleeper_internal'],
    evidenceLabel: 'SE',
    confidence: 'medium',
    displayAs: 'advice',
    parameters: [
      'constants.thin_listing_max_words',
      'constants.full_confidence_min_photos',
      'constants.quiet_max_bids',
      'category.uncertainty_haircut_rate',
    ],
  },
  {
    id: 'S11',
    name: 'Hunt misspelled and miscategorised lots',
    summary: 'Typo and miscategorised listings draw few rivals; find them with typo variants and image matches.',
    appliesTo: 'eBay and any keyword-searched platform.',
    scope: 'hunt',
    when: null,
    rules: [],
    alert: 'none',
    message:
      'Search typo variants and category-agnostic image matches in every standing hunt. Treat a hit like a thin listing: few rivals, so identify it carefully.',
    evidence: ['nyt_misspelling_2004'],
    evidenceLabel: 'SE',
    confidence: 'low-medium',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S12',
    name: "Shade uncertain-value lots for the winner's curse",
    summary: 'When every bidder is guessing the same unknown value, the winner is the one who guessed highest.',
    appliesTo: 'Mixed and box lots, "untested" electronics, vehicles, equipment, jewelry and aircraft.',
    scope: 'lot',
    when: fired('R44'),
    rules: ['R44'],
    alert: 'none',
    message:
      "Everyone is guessing the same unknown value, so the winner is usually whoever guessed highest. Your ceiling already deducts a {uncertainty_haircut_rate|pct} uncertainty haircut; don't bid past it.",
    evidence: ['bazerman_samuelson_1983', 'bajari_hortacsu_2003'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: ['category.uncertainty_haircut_rate', 'constants.winners_curse_note_min_haircut'],
  },
  {
    id: 'S13',
    name: "Treat a secret reserve as a floor you probably won't like",
    summary: 'An unmet secret reserve near your ceiling is a reason to stop and watch for a relist.',
    appliesTo: 'Reserve auctions where the reserve is not met.',
    scope: 'lot',
    when: {
      and: [OPEN, { '!=': [{ var: 'effective_close_type' }, 'fixed'] }, { '==': [{ var: 'reserve_flag' }, 'reserve_not_met'] }],
    },
    rules: ['R03'],
    alert: 'none',
    message:
      'A secret reserve suggests the seller values the lot highly. If bidding is already near your ceiling, stop and watch for a relist.',
    evidence: ['katkar_reiley_2006', 'bajari_hortacsu_2003'],
    evidenceLabel: 'SE',
    confidence: 'medium',
    displayAs: 'advice',
    parameters: ['constants.reserve_stop_ratio'],
  },
  {
    id: 'S14',
    name: 'Keep your ceiling hidden from shills',
    summary: 'An early proxy bid can be probed; enter it late and never raise into a staircase.',
    appliesTo: 'Proxy-bidding platforms, where a proxy bid entered early can be probed.',
    scope: 'lot',
    when: { and: [OPEN, NOT_WALKING_AWAY, { in: [{ var: 'effective_close_type' }, TIMED] }] },
    rules: [],
    alert: 'none',
    message:
      'Enter your ceiling late. If the price climbs in minimum steps only while you lead, and the other bidder stops just short, treat it as a possible shill and do not raise.',
    evidence: ['engelberg_williams_2009'],
    evidenceLabel: 'SE',
    confidence: 'medium',
    // Detecting it needs bidder-level history (bid_events), which is outside the section 9 inputs.
    displayAs: 'prose',
    parameters: [],
  },
  {
    id: 'S15',
    name: 'Expect higher prices where the clock extends',
    summary: 'Soft-close auctions finish higher than hard-close ones; plan for less discount.',
    appliesTo: 'Every extending-close platform.',
    scope: 'lot',
    when: fired('R37'),
    rules: ['R37'],
    alert: 'none',
    message:
      'Auctions that extend on late bids have finished higher than fixed-end ones in the published comparisons. Use them for items you need; hunt bargains where attention is thin.',
    evidence: ['glover_raviv_2012', 'houser_wooders_2005', 'overstock_softclose_2019'],
    evidenceLabel: 'SE',
    confidence: 'medium',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S16',
    name: 'End time, day of week and duration: weak signals',
    summary: 'For choosing what to watch only: crowded closing windows and short listings, no day-of-week rules.',
    appliesTo: 'Choosing which lots to watch, not how much to bid.',
    scope: 'hunt',
    when: null,
    rules: [],
    alert: 'none',
    message:
      'When choosing lots to watch, prefer ones closing in crowded windows and short listings. Day-of-week rules are not supported by the evidence.',
    evidence: ['simonsohn_2010', 'lucking_reiley_2007'],
    evidenceLabel: 'SE',
    confidence: 'low-medium',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S17',
    name: 'Price the pickup before the bid',
    summary: 'A far-away small lot is worth nothing once the trip is priced honestly.',
    appliesTo: 'Pickup-only lots: all government surplus and most HiBid, K-BID and estate lots.',
    scope: 'lot',
    when: {
      and: [
        OPEN,
        {
          or: [
            { '==': [{ var: 'pickup_required' }, true] },
            { '==': [{ var: 'transport_basis' }, 'distance'] },
            { '==': [{ var: 'transport_basis' }, 'pickup_cost'] },
            {
              and: [
                { '!=': [{ var: 'ships' }, true] },
                {
                  or: [
                    { in: [{ var: 'platform_base' }, GOVERNMENT_PLATFORMS] },
                    { in: [{ var: 'source_tier' }, GOVERNMENT_TIERS] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    rules: ['R01', 'R31', 'R38', 'R39', 'R40'],
    alert: 'none',
    message:
      'Price the round trip (2 x miles x cost per mile, plus your time) before bidding; it comes off the ceiling. Check the removal deadline and whether the site loads for you, and combine lots at one site into one trip.',
    evidence: ['gsa_terms', 'wisconsin_surplus_terms'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: ['constants.mileage_cost_cents_per_mile', 'constants.pickup_time_cost_cents', 'constants.transport_share_warn'],
  },
  {
    id: 'S18',
    name: 'Government-surplus specifics that change the play',
    summary: 'Inactivity closes, shrinking increments, hard payment and removal deadlines, title paperwork.',
    appliesTo: 'GSA, GovDeals, Public Surplus, Municibid and Wisconsin Surplus.',
    scope: 'lot',
    when: { and: [OPEN, { in: [{ var: 'platform_base' }, GOVERNMENT_PLATFORMS] }] },
    rules: ['R38', 'R39', 'R40', 'R41', 'R43'],
    alert: 'none',
    message:
      'Plan payment and removal before you bid. GSA wants payment within 2 business days and removal within 10, and does not ship; Wisconsin Surplus charges $10 a day after its removal deadline; other agencies set their own terms. On a quiet GSA lot the minimum increment shrinks after a spell with no bids, so there is no rush to bid early.',
    evidence: ['gsa_faq', 'gsa_terms', 'gsa_realestate_faq', 'cbca_2007', 'gsa_sf97', 'wisconsin_surplus_terms', 'govdeals_thirdparty'],
    evidenceLabel: 'SE',
    confidence: 'high',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S19',
    name: 'Allocate a budget across many lots',
    summary: 'Keep the total you could owe, if every live bid wins, within your budget.',
    appliesTo: 'Users bidding on several lots in one night or one catalog.',
    scope: 'portfolio',
    when: null,
    rules: [],
    alert: 'none',
    message:
      'Keep total exposure (every live bid times its cost multiplier, plus one pickup per site) within your budget, unless you accept winning everything.',
    evidence: ['ely_hossain_2009'],
    evidenceLabel: 'DESIGN',
    confidence: 'low-medium',
    displayAs: 'advice',
    parameters: [],
  },
  {
    id: 'S20',
    name: 'Format-specific plays',
    summary: 'Live webcast: absentee bid. Sealed: submit the ceiling. Tag sale: early for scarce, last day for bulky.',
    appliesTo: 'Live webcasts, sealed bids and estate tag sales.',
    scope: 'lot',
    when: { or: [fired('R14'), fired('R15'), fired('R16'), fired('R17'), fired('R18')] },
    rules: ['R14', 'R15', 'R16', 'R17', 'R18'],
    alert: 'none',
    message: 'Use the play for this format.',
    evidence: ['ku_malhotra_murnighan_2005', 'bazerman_samuelson_1983', 'bajari_hortacsu_2003'],
    evidenceLabel: 'SE',
    confidence: 'low-medium',
    displayAs: 'advice',
    parameters: [],
    variants: {
      live: {
        message:
          'Leave an absentee (max) bid at your ceiling before the sale instead of bidding live. Rivalry, an audience and a fast clock are when bidders overpay.',
        alert: 'before_sale',
        evidenceLabel: 'SE',
        confidence: 'medium',
      },
      sealed: {
        message: 'You pay what you bid: submit your ceiling or less, never more. The margin and risk reserve are already inside it.',
        alert: 'before_deadline',
        evidenceLabel: 'SE',
        confidence: 'medium',
      },
      fixed: {
        message:
          'Tag sale: buy scarce items priced under your ceiling early on day 1; for bulky, common items over it, come back on the last day if the company discounts. Discount schedules vary and are not verified.',
        alert: 'none',
        evidenceLabel: 'UNVERIFIED',
        confidence: 'low',
      },
    },
  },
  {
    id: 'S21',
    name: 'Practitioner rules of thumb (cross-check only)',
    summary: 'The rule of thirds, shown next to the ceiling as an unverified cross-check.',
    appliesTo: 'Any lot with a value estimate. Shown only as a labelled cross-check, never as the ceiling.',
    scope: 'lot',
    when: { and: [OPEN, { var: 'has_value' }] },
    rules: [],
    alert: 'none',
    message:
      'Rule of thirds: about {thirds_rule_cents|usd} (pay a third, a third covers costs, a third is profit). An UNVERIFIED practitioner heuristic; your walk-away number is the ceiling, not this.',
    evidence: [],
    evidenceLabel: 'UNVERIFIED',
    confidence: 'unverified',
    displayAs: 'cross-check',
    parameters: [],
  },
];

// ---------------------------------------------------------------- ranking

const CONFIDENCE_ORDER: readonly Confidence[] = ['high', 'medium-high', 'medium', 'low-medium', 'low', 'unverified'];

/** Rules whose firing means "do not bid on this lot". */
const WALK_AWAY_RULES = new Set(['R01', 'R02', 'R03', 'R18']);

// ---------------------------------------------------------------- timing

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function secondsPhrase(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

interface TimingInput {
  readonly lot: ResolvedLot;
  readonly derived: Readonly<Record<string, DerivedValue>>;
  readonly walkAway: CalculatorResult;
  readonly primary: FiredRule | null;
  readonly walkingAway: boolean;
  readonly now: Date;
  readonly params: StrategyParameters;
}

/**
 * When to act, for this lot's closing rule. Alert and bid moments are the spec's
 * (alert_seconds_before, proxy_deadline_minutes_before_close); this adds the
 * wording, the ISO instants, and what to do when the close is known only to the
 * day.
 */
function planTiming(t: TimingInput): Timing {
  const { lot, derived, walkAway, primary, walkingAway, now, params } = t;
  const closeMs = lot.closesAtMs as number;
  const nowMs = now.getTime();
  const precise = lot.closeTimePrecise;
  const type = lot.effectiveCloseType;
  const W = lot.effectiveWindowMin;
  const windowMinutes = toNumber(W);
  const windowAssumed = lot.windowMin === null;
  const K = lot.constants;
  // A date-only close can be up to a day earlier than closesAt, so every lead moves a day earlier.
  const shift = precise ? 0 : params.imprecise_close_uncertainty_seconds;
  const bid = walkAway.maxBidCents === null ? 'your walk-away number' : formatUsd(walkAway.maxBidCents);
  const prefix = walkAway.status === 'insufficient_data' ? 'No walk-away number yet; add sold comps first. Then: ' : '';

  const specAlert = derived.alert_seconds_before as Rat | null;
  const specAlertSeconds = specAlert === null ? null : toNumber(specAlert);
  const proxyLead = derived.proxy_deadline_minutes_before_close as Rat;
  const proxyLeadSeconds = toNumber(proxyLead) * 60;
  const windowPhrase = `${formatPlain(W)} minute${windowMinutes === 1 ? '' : 's'}`;
  const windowAdjective = `${formatPlain(W)}-minute`;
  const assumedNote = windowAssumed ? ` The window was not captured, so Skeuos assumes ${windowPhrase}; check the auction terms.` : '';
  const inactivityNote =
    type === 'inactivity'
      ? ` It closes only after ${windowPhrase} with no bids, and changing your own proxy bid late restarts that clock too.`
      : '';

  const base = { closeType: type, precise, countdown: precise, windowMinutes, windowAssumed };
  const alertAt = (secondsBefore: number | null): string | null => {
    if (secondsBefore === null) return null;
    const ms = closeMs - secondsBefore * 1000;
    return ms >= nowMs ? iso(ms) : null;
  };
  const bidBy = (secondsBefore: number): string => iso(Math.max(nowMs, closeMs - secondsBefore * 1000));

  if (derived.is_open !== true) {
    return {
      ...base,
      mode: 'closed',
      alertSecondsBefore: null,
      alertAt: null,
      bidAt: null,
      instruction: 'This lot has closed. Record the result (won, lost, price) so Skeuos can calibrate your ceilings.',
    };
  }

  if (walkingAway) {
    const reason =
      primary !== null && WALK_AWAY_RULES.has(primary.ruleId) ? primary.text : (walkAway.reason ?? 'No bid meets your target.');
    return { ...base, mode: 'walk_away', alertSecondsBefore: null, alertAt: null, bidAt: null, instruction: `Don't bid. ${reason}` };
  }

  // Timed lots whose close is known only to the day: no countdown, act a day early.
  if (!precise && (type === 'hard' || type === 'soft' || type === 'inactivity' || type === 'unknown')) {
    const lead = type === 'hard' ? 0 : proxyLeadSeconds;
    const alertBase = specAlertSeconds ?? (windowMinutes + K.soft_close_alert_buffer_minutes) * 60;
    const s = alertBase + shift;
    const extendsNote =
      type === 'soft'
        ? ` Late bids extend it by ${windowPhrase}.${assumedNote}`
        : type === 'unknown'
          ? ' Its closing rule was not captured either; a bid entered this early works whether or not it extends.'
          : type === 'inactivity'
            ? assumedNote
            : '';
    return {
      ...base,
      mode: 'proxy_before_close_date',
      alertSecondsBefore: s,
      alertAt: alertAt(s),
      bidAt: bidBy(shift + lead),
      instruction:
        `${prefix}The source publishes only a close date, so there is no countdown to trust and a last-moment bid cannot be timed. ` +
        `Enter your single max bid of ${bid} as a proxy at least a day before the listed close, then leave it alone.${extendsNote}${inactivityNote}`,
    };
  }

  if (type === 'hard') {
    const s = specAlertSeconds ?? K.hard_close_alert_seconds;
    const snipe = K.manual_snipe_seconds;
    return {
      ...base,
      mode: 'snipe',
      alertSecondsBefore: s,
      alertAt: alertAt(s),
      bidAt: bidBy(snipe),
      instruction:
        `${prefix}Hard close: the clock will not extend. Don't bid while watching. Skeuos alerts you at T-${secondsPhrase(s)}; ` +
        `then place ONE bid of ${bid} with about ${snipe} seconds left (T-${snipe} s). Don't go later by hand: very late bids can fail to register.`,
    };
  }

  if (type === 'soft' || type === 'inactivity') {
    const s = specAlertSeconds ?? (windowMinutes + K.soft_close_alert_buffer_minutes) * 60;
    if (cmp(derived.minutes_to_close as Rat, W) <= 0) {
      return {
        ...base,
        mode: 'in_extension_window',
        alertSecondsBefore: s,
        alertAt: null,
        bidAt: iso(nowMs),
        instruction:
          `${prefix}You are inside the ${windowAdjective} extension window, so any bid restarts the clock. If your max bid is not in yet, ` +
          `enter ${bid} once now; do not raise it because the clock is running.${inactivityNote}`,
      };
    }
    return {
      ...base,
      mode: 'proxy_before_window',
      alertSecondsBefore: s,
      alertAt: alertAt(s),
      bidAt: bidBy(proxyLeadSeconds),
      instruction:
        `${prefix}Extending close: a bid in the last ${windowPhrase} pushes the close back, so a last-second bid gains nothing. ` +
        `Enter your single max bid of ${bid} once, at T-${formatPlain(proxyLead)} min or earlier, then leave it alone.${inactivityNote}${assumedNote}`,
    };
  }

  if (type === 'live') {
    const s = (specAlertSeconds ?? K.live_absentee_alert_seconds) + shift;
    return {
      ...base,
      mode: 'absentee',
      alertSecondsBefore: s,
      alertAt: alertAt(s),
      bidAt: bidBy(s),
      instruction:
        `${prefix}Live webcast: leave an absentee (max) bid of ${bid} before the sale instead of bidding live. ` +
        'If you do bid live, write the ceiling down before the lot opens.',
    };
  }

  if (type === 'sealed') {
    const s = (specAlertSeconds ?? K.sealed_alert_seconds) + shift;
    return {
      ...base,
      mode: 'sealed',
      alertSecondsBefore: s,
      alertAt: alertAt(s),
      bidAt: bidBy(s),
      instruction: `${prefix}Sealed bid: you pay what you bid. Submit ${bid} or less before the deadline; your margin and risk reserve are already inside that number.`,
    };
  }

  if (type === 'fixed') {
    const tagText =
      primary !== null && (primary.ruleId === 'R16' || primary.ruleId === 'R17')
        ? primary.text
        : 'Tag sale: add a value estimate to see whether the tag price is under your ceiling.';
    return { ...base, mode: 'tag', alertSecondsBefore: null, alertAt: null, bidAt: null, instruction: tagText };
  }

  // Closing rule not captured. The spec arms no alert here (alert_seconds_before is
  // null), but R19 tells the user to bid (W + 1) minutes before the close, and the
  // watchlist's default 10-minute reminder would fire after that moment. So this
  // arms the alert an extending close gets. DESIGN, not in the spec.
  const s = (windowMinutes + K.soft_close_alert_buffer_minutes) * 60;
  return {
    ...base,
    mode: 'unknown_rule',
    alertSecondsBefore: s,
    alertAt: alertAt(s),
    bidAt: bidBy(proxyLeadSeconds),
    instruction:
      `${prefix}Closing rule not captured for this platform. Enter one max bid of ${bid} about ${formatPlain(proxyLead)} minutes before the close; ` +
      'that works whether or not the lot extends.',
  };
}

// ---------------------------------------------------------------- recommend

function alertSecondsFor(kind: AlertKind, timing: Timing | null): number | null {
  // The timing already carries the spec's alert and the date-only shift.
  return kind === 'none' || timing === null ? null : timing.alertSecondsBefore;
}

function strategyParamUses(names: readonly string[], lot: ResolvedLot, sp: StrategyParameters, overridden: ReadonlySet<string>): ParamUse[] {
  const uses: ParamUse[] = [];
  for (const n of names) {
    if (n.startsWith('strategy.')) {
      const key = n.slice('strategy.'.length) as keyof StrategyParameters;
      const status: ParamStatus = overridden.has(key) ? 'OVERRIDE' : 'DESIGN';
      uses.push({ name: n, value: sp[key], status, source: overridden.has(key) ? 'strategyParameters' : 'strategies.ts' });
    } else {
      const p = lot.params[n];
      if (p !== undefined) uses.push(p);
    }
  }
  return uses;
}

function uniqueByName(list: readonly ParamUse[]): ParamUse[] {
  const seen = new Map<string, ParamUse>();
  for (const p of list) if (!seen.has(p.name)) seen.set(p.name, p);
  return [...seen.values()];
}

/** Rules whose text the timing instruction already says in other words. */
const SAID_BY_TIMING = new Set(['R00', 'R10', 'R11', 'R12', 'R14', 'R15', 'R16', 'R17', 'R19']);

function explain(
  lot: ResolvedLot,
  walkAway: CalculatorResult,
  timing: Timing | null,
  primary: FiredRule | null,
  warnings: readonly FiredRule[],
  labels: { placeholders: readonly string[]; unverified: readonly string[] },
): string[] {
  const lines: string[] = [];
  const b = walkAway.breakdown;
  const H = walkAway.hammerCeilingCents;

  // 1. The walk-away number and where it came from.
  if (walkAway.status === 'insufficient_data') {
    // R20's text says the same and adds what $100 of hammer costs here.
    lines.push(primary?.ruleId === 'R20' ? primary.text : (walkAway.reason ?? 'No walk-away number yet.'));
  } else if (H !== null && b.expectedResaleCents === null) {
    lines.push(`Walk-away: ${formatUsd(H)} hammer, from your ${formatUsd(b.budgetCents ?? 0)} budget.`);
  } else if (H !== null && b.expectedResaleCents !== null && b.netProceedsCents !== null) {
    const valueWord = lot.userGoal === 'use' ? 'fixed-price alternative' : 'resale value';
    const transportWord =
      b.transportBasis === 'shipping' ? 'shipping' : b.transportBasis === 'none' ? 'transport (not included)' : 'pickup';
    lines.push(
      `Walk-away: ${formatUsd(H)} hammer. From a ${formatUsd(b.expectedResaleCents)} ${valueWord}: ${formatUsd(b.netProceedsCents)} after selling costs, ` +
        `minus ${formatUsd(b.profitTargetCents ?? 0)} required profit, ${formatUsd(b.transportCents)} ${transportWord} and ` +
        // k to four places, as the doc writes it ("k = 1.282"); the ceiling itself used k exactly.
        `${formatUsd(b.riskReserveCents ?? 0)} risk and repair reserve, divided by ${Number(walkAway.costMultiplier.toFixed(4))} for premium, tax and card fee` +
        (walkAway.bindingCap === 'budget' ? `; your ${formatUsd(b.budgetCents ?? 0)} budget caps it lower.` : '.'),
    );
  }
  if (walkAway.status === 'ok' && walkAway.maxBidCents !== null && walkAway.allInAtMaxBidCents !== null) {
    lines.push(
      walkAway.maxBidCents !== H
        ? `Enter it as ${formatUsd(walkAway.maxBidCents)}, your ceiling rounded down to a bid the increment ladder allows. Winning there costs about ${formatUsd(walkAway.allInAtMaxBidCents)} all-in.`
        : `Winning at ${formatUsd(walkAway.maxBidCents)} costs about ${formatUsd(walkAway.allInAtMaxBidCents)} all-in.`,
    );
  }

  // 2. When to act.
  if (timing !== null) lines.push(timing.instruction);

  // 3. The primary rule, unless the lines above already say it.
  const alreadySaid =
    primary === null ||
    SAID_BY_TIMING.has(primary.ruleId) ||
    (primary.ruleId === 'R20' && walkAway.status === 'insufficient_data') ||
    (timing !== null && timing.instruction.includes(primary.text));
  if (!alreadySaid && primary !== null) lines.push(primary.text);

  // 4. Warnings: the rules', then input gaps only the reader sees (transport not priced).
  for (const w of warnings) lines.push(w.text);
  for (const w of lot.warnings) lines.push(w);

  // 5. What the numbers rest on.
  if (labels.placeholders.length > 0) {
    lines.push(
      `Placeholder values behind these numbers (not measurements; replace them before relying on the advice): ${labels.placeholders.join(', ')}.`,
    );
  }
  if (labels.unverified.length > 0) lines.push(`Unverified values: ${labels.unverified.join(', ')}.`);
  if (!lot.closeTimePrecise) lines.push(IMPRECISE_CLOSE_CAVEAT);
  for (const n of lot.notes) lines.push(n);
  return lines;
}

/**
 * Everything the app should tell the user about one lot, at `now`.
 *
 * Returns the walk-away number (the calculator), when and how to bid (timing,
 * with the platform's closing rule and a date-only close time taken into
 * account), the applicable strategies ranked, and a plain-English explanation.
 */
export function recommend(context: LotContext, now: Date, options: RecommendOptions = {}): Recommendation {
  assertNow(now);
  const sp: StrategyParameters = { ...STRATEGY_PARAMETERS, ...(options.strategyParameters ?? {}) };
  const overridden = new Set(Object.keys(options.strategyParameters ?? {}));
  const lot = resolveLot(context, options);
  const walkAway = calculate(lot, options);
  const ev = evaluateResolved(lot, now);
  const rules = ev.result;

  const labelsFrom = (params: readonly ParamUse[]) => ({
    placeholders: [...new Set(params.filter((p) => p.status === 'PLACEHOLDER').map((p) => p.name))],
    unverified: [...new Set(params.filter((p) => p.status === 'UNVERIFIED').map((p) => p.name))],
  });

  if (rules.status !== 'ok' || ev.derived === null || ev.data === null) {
    const labels = labelsFrom(walkAway.parameters);
    const explanation =
      rules.status === 'invalid_input'
        ? [...lot.errors]
        : [
            ...(walkAway.status === 'ok' && walkAway.hammerCeilingCents !== null
              ? [`Walk-away: ${formatUsd(walkAway.hammerCeilingCents)} hammer.`]
              : walkAway.reason !== null
                ? [walkAway.reason]
                : []),
            `Cannot time or check this lot without: ${rules.missing.join(', ')}.`,
            ...lot.notes,
          ];
    return {
      status: rules.status,
      walkAway,
      timing: null,
      primary: null,
      strategies: [],
      explanation,
      labels,
      rules,
    };
  }

  const derived = ev.derived;
  const primary = rules.primary;
  const isOpen = derived.is_open === true;
  const walkingAway =
    isOpen &&
    ((primary !== null && WALK_AWAY_RULES.has(primary.ruleId)) ||
      (walkAway.status === 'walk_away' && lot.effectiveCloseType !== 'fixed'));

  const timing = planTiming({ lot, derived, walkAway, primary, walkingAway, now, params: sp });

  // What strategy conditions read: everything the rules read, plus which rules
  // fired and a few context facts the rules do not need.
  const snapshot: Record<string, unknown> = {
    ...ev.data,
    fired: ev.firedMap,
    walking_away: walkingAway,
    close_time_precise: lot.closeTimePrecise,
    user_goal: lot.userGoal,
    pickup_required: context.pickupRequired ?? null,
    ships: context.ships ?? null,
    source_tier: context.sourceTier ?? null,
    opening_bid_cents: lot.startingBidCents === null ? null : Number(lot.startingBidCents),
    transport_basis: lot.transport.basis,
    strategy: sp,
  };
  const env: EvalEnv = { data: snapshot, now };
  const firedById = new Map(rules.fired.map((r) => [r.ruleId, r]));
  const risk: RiskTolerance = context.riskTolerance ?? 'medium';

  const applicable: (RankedStrategy & { readonly sortKey: readonly number[] })[] = [];
  for (const s of STRATEGIES) {
    if (s.scope !== 'lot' || s.when === null) continue;
    const v = evaluate(s.when, env);
    if (v === UNKNOWN || !truthy(v as Exclude<typeof v, Unknown>)) continue;
    const variant = s.variants?.[lot.effectiveCloseType];
    const firedRules = s.rules.filter((id) => firedById.has(id));
    const ruleParams = firedRules.flatMap((id) => (firedById.get(id) as FiredRule).parameters);
    const own = s.id === 'S1' ? [...walkAway.parameters] : strategyParamUses(s.parameters, lot, sp, overridden);
    const parameters = uniqueByName([...own, ...ruleParams]);
    const alert = variant?.alert ?? s.alert;
    const confidence = variant?.confidence ?? s.confidence;
    const ownsPrimary = primary !== null && s.rules.includes(primary.ruleId);
    const hasActionOrWarning = firedRules.some((id) => (firedById.get(id) as FiredRule).kind !== 'info');
    const tier = ownsPrimary ? 0 : s.id === 'S1' ? 1 : hasActionOrWarning ? 2 : 3;
    const minPriority = Math.min(1000, ...firedRules.map((id) => (firedById.get(id) as FiredRule).priority));
    // Risk tolerance moves only the ordering of S10, the thin-listing gamble. The
    // doc gives no basis for changing a number with it.
    const riskKey = s.id === 'S10' ? (risk === 'low' ? 1 : risk === 'high' ? -1 : 0) : 0;
    applicable.push({
      rank: 0,
      id: s.id,
      name: s.name,
      summary: s.summary,
      message: renderTemplate(variant?.message ?? s.message, snapshot),
      alert: { kind: alert, secondsBefore: alertSecondsFor(alert, timing) },
      evidenceLabel: variant?.evidenceLabel ?? s.evidenceLabel,
      confidence,
      firedRules,
      displayAs: s.displayAs,
      parameters,
      placeholder: parameters.some((p) => p.status === 'PLACEHOLDER'),
      sortKey: [tier, riskKey, minPriority, CONFIDENCE_ORDER.indexOf(confidence), Number(s.id.slice(1))],
    });
  }
  applicable.sort((a, b) => {
    for (let i = 0; i < a.sortKey.length; i++) {
      const d = (a.sortKey[i] as number) - (b.sortKey[i] as number);
      if (d !== 0) return d;
    }
    return 0;
  });
  const strategies: RankedStrategy[] = applicable.map(({ sortKey: _sortKey, ...rest }, i) => ({ ...rest, rank: i + 1 }));

  const allParams = [
    ...walkAway.parameters,
    ...rules.fired.flatMap((r) => r.parameters),
    ...strategies.flatMap((s) => s.parameters),
  ];
  const labels = labelsFrom(allParams);

  let status: Recommendation['status'] = 'ok';
  if (!isOpen) status = 'closed';
  else if (walkingAway) status = 'walk_away';
  else if (walkAway.status === 'insufficient_data') status = 'needs_value';

  return {
    status,
    walkAway,
    timing,
    primary,
    strategies,
    explanation: explain(lot, walkAway, timing, primary, rules.warnings, labels),
    labels,
    rules,
  };
}

// ---------------------------------------------------------------- S19: exposure across lots

export interface ExposureEntry {
  readonly walkAway: CalculatorResult;
  /** Lots at the same pickup site share one trip (docs/06 S19). null = its own trip. */
  readonly siteKey?: string | null;
}

export interface ExposureResult {
  /** Sum of every live bid's invoice plus one trip per site: what you owe if every bid wins. */
  readonly exposureCents: number;
  readonly invoiceCents: number;
  readonly transportCents: number;
  readonly liveBids: number;
  readonly sites: number;
  readonly budgetCents: number | null;
  readonly withinBudget: boolean | null;
}

/**
 * docs/06 S19: exposure = sum over lots with a live bid of H x k + T, keeping
 * exposure within the budget unless the user accepts winning everything. T is
 * charged once per pickup site, since one trip collects every lot there (the
 * doc notes the per-lot spec overcharges it). A lot with no bid to place adds
 * nothing. Expected spend (the doc's p_win version) needs win rates Skeuos does
 * not have yet, so it is not computed.
 */
export function portfolioExposure(entries: readonly ExposureEntry[], budgetCents: number | null = null): ExposureResult {
  if (budgetCents !== null && (!Number.isSafeInteger(budgetCents) || budgetCents < 0)) {
    throw new RangeError('budgetCents must be a whole, non-negative number of cents.');
  }
  let invoice = 0n;
  const tripBySite = new Map<string, bigint>();
  let live = 0;
  entries.forEach((e, i) => {
    const w = e.walkAway;
    if (w.status !== 'ok' || w.invoiceAtMaxBid === null) return;
    live += 1;
    invoice += BigInt(w.invoiceAtMaxBid.totalCents);
    const site = e.siteKey ?? `lot#${i}`;
    const trip = BigInt(w.breakdown.transportCents);
    const prev = tripBySite.get(site);
    // Same site, same trip. The larger figure wins, so a rounding difference never undercounts.
    if (prev === undefined || trip > prev) tripBySite.set(site, trip);
  });
  const transport = [...tripBySite.values()].reduce((a, b) => a + b, 0n);
  const exposure = invoice + transport;
  return {
    exposureCents: Number(exposure),
    invoiceCents: Number(invoice),
    transportCents: Number(transport),
    liveBids: live,
    sites: tripBySite.size,
    budgetCents,
    withinBudget: budgetCents === null ? null : exposure <= BigInt(budgetCents),
  };
}

/** The strategy with this id. */
export function strategyById(id: StrategyId): Strategy {
  const s = STRATEGIES.find((x) => x.id === id);
  if (s === undefined) throw new RangeError(`no strategy ${id}`);
  return s;
}
