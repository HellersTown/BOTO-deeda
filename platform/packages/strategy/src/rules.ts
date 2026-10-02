/**
 * The section 9 rules spec, evaluated for one lot.
 *
 * The rules are data: RULES is the spec's own array, and each rule's `when`
 * runs through the JSONLogic evaluator exactly as written. What the rules read
 * (`derived`) is computed here in TypeScript, from the same resolved lot the
 * calculator uses, so the ceiling a rule compares against is the ceiling the
 * calculator reports.
 *
 * The spec's `derived` expressions are not thrown away. referenceDerive() runs
 * them literally, and test/derived-oracle.test.ts checks that the TypeScript
 * gives the same exact value for every derived name on every test lot. That
 * test is the proof that this file implements the spec's formulas, rather than
 * a hand-copied approximation of them.
 *
 * The four places this file goes beyond the spec are all about taking a value
 * the lot or user actually has over a default (each is noted where it happens):
 * the lot's published next bid, the lot's card fee and tax, the user's pickup,
 * shipping and repair figures, and a personal-use goal.
 */

import {
  type Rat,
  ONE,
  add,
  cmp,
  div,
  floor,
  formatPercent,
  formatPlain,
  formatUsd,
  fromInt,
  fromNumber,
  isRat,
  mul,
  rat,
  roundHalfAway,
  sub,
  toNumber,
  toSafeNumber,
} from './exact.ts';
import {
  type EvalEnv,
  UNKNOWN,
  type Unknown,
  type Value,
  collectVars,
  evaluate,
  lookupPath,
  truthy,
} from './jsonlogic.ts';
import { type CeilingCore, solveCeiling, transportParamNames } from './calculator.ts';
import { type ResolvedLot, resolveLot } from './resolve.ts';
import { EVIDENCE_STATUS, LABEL_FOR_RULES_WITHOUT_EVIDENCE, SPEC } from './spec.ts';
import type {
  EngineOptions,
  EvidenceLabel,
  FiredRule,
  JsonLogic,
  LotContext,
  NotEvaluatedRule,
  OutValue,
  ParamUse,
  RulesResult,
  RulesSpec,
  SpecConstants,
  SpecRule,
} from './types.ts';

export { SPEC, EVIDENCE_STATUS };

/** The spec's rules array, exactly as docs/06 section 9.2 has it. */
export const RULES: readonly SpecRule[] = SPEC.rules;

export type DerivedValue = Rat | string | boolean | null | Unknown;

// ---------------------------------------------------------------- derived values

function constant(lot: ResolvedLot, name: keyof SpecConstants): Rat {
  const r = fromNumber(lot.constants[name]);
  if (r === null) throw new RangeError(`constant ${name} is not a finite number`);
  return r;
}

function below(count: number | Unknown, limit: Rat): boolean | Unknown {
  return count === UNKNOWN ? UNKNOWN : cmp(fromInt(count), limit) < 0;
}

/**
 * Every value in the spec's `derived` list, in the spec's order, computed exactly.
 * Needs a lot with no missing core fields (lot.missing is empty).
 */
export function deriveSpecValues(lot: ResolvedLot, core: CeilingCore, now: Date): Record<string, DerivedValue> {
  const k = lot.k;
  const T = core.transport;
  const current = fromInt(lot.currentBidCents as bigint);
  const next = fromInt(lot.nextMinBidCents as bigint);
  const max = core.hMax === null ? null : fromInt(core.hMax);
  const minutes = rat(BigInt((lot.closesAtMs as number) - now.getTime()), 60000n);
  const bidCount = lot.bidCount;
  const allIn = (hammer: Rat): Rat => add(mul(hammer, k), T);
  const win = lot.effectiveWindowMin;
  const alert: Rat | null = lot.isHardClose
    ? constant(lot, 'hard_close_alert_seconds')
    : lot.isExtendingClose
      ? mul(add(win, constant(lot, 'soft_close_alert_buffer_minutes')), rat(60n))
      : lot.effectiveCloseType === 'live'
        ? constant(lot, 'live_absentee_alert_seconds')
        : lot.effectiveCloseType === 'sealed'
          ? constant(lot, 'sealed_alert_seconds')
          : null;

  return {
    close_type: lot.closeType,
    platform_base: lot.platformBase,
    window_min: lot.windowMin,
    is_hard_close: lot.isHardClose,
    effective_close_type: lot.effectiveCloseType,
    is_extending_close: lot.isExtendingClose,
    bp_assumed: lot.bpAssumed,
    bp_pct: lot.bpPct,
    bp_source: lot.bpSource,
    card_fee_rate: lot.cardFeeRate,
    tax_rate: lot.taxRate,
    cost_multiplier: k,
    transport_known: lot.transport.known,
    transport_cents: T,
    has_value: core.hasValue,
    has_budget: core.hasBudget,
    sell_fee_rate: lot.category.sellFeeRate,
    outbound_ship_cents: lot.category.outboundShipCents,
    uncertainty_haircut_rate: lot.category.uncertaintyHaircutRate,
    repair_reserve_rate: lot.category.repairReserveRate,
    target_margin_rate: lot.category.targetMarginRate,
    min_profit_cents: lot.category.minProfitCents,
    net_proceeds_cents: core.netProceeds,
    profit_target_cents: core.profitTarget,
    risk_reserve_cents: core.riskReserve,
    max_hammer_resale_cents: core.hResale === null ? null : fromInt(core.hResale),
    max_hammer_budget_cents: core.hBudget === null ? null : fromInt(core.hBudget),
    max_hammer_cents: max,
    binding_cap: core.bindingCap,
    increment_cents: fromInt(lot.incrementCents as bigint),
    next_min_bid_cents: next,
    minutes_to_close: minutes,
    is_open: minutes.n > 0n,
    all_in_at_current_cents: allIn(current),
    all_in_at_next_cents: allIn(next),
    all_in_at_max_cents: max === null ? null : allIn(max),
    headroom_cents: max === null ? null : sub(max, next),
    current_to_max_ratio: max !== null && max.n > 0n ? div(current, max) : null,
    profit_at_next_cents:
      core.netProceeds === null || core.riskReserve === null
        ? null
        : sub(core.netProceeds, add(add(mul(next, k), T), core.riskReserve)),
    thirds_rule_cents: core.resale === null ? null : fromInt(floor(div(core.resale, rat(3n)))),
    transport_share: core.resale === null ? null : div(T, core.resale),
    cost_per_100_cents: fromInt(floor(mul(rat(10000n), k))),
    is_thin_listing: below(lot.specInputs.description_word_count, constant(lot, 'thin_listing_max_words')),
    is_few_photos: below(lot.specInputs.image_count, constant(lot, 'full_confidence_min_photos')),
    is_quiet: bidCount === null ? UNKNOWN : cmp(fromInt(bidCount), constant(lot, 'quiet_max_bids')) <= 0,
    herd_bid_count: lot.category.herdBidCount,
    is_crowded: bidCount === null ? UNKNOWN : cmp(fromInt(bidCount), lot.category.herdBidCount) >= 0,
    high_value_risk: lot.category.highValueRisk,
    effective_window_min: win,
    proxy_deadline_minutes_before_close: add(win, ONE),
    alert_seconds_before: alert,
    tag_price_final_day_cents: fromInt(
      floor(mul(current, sub(ONE, constant(lot, 'tag_final_day_discount_rate')))),
    ),
  };
}

/**
 * The spec's `derived` list run literally: each expression through the
 * evaluator, top to bottom, with platform_attr, category_attr and
 * increment_ladder defined exactly as expression_language.custom_ops says. This
 * is the reference the TypeScript above is tested against, and the harness
 * that proves every expression is guarded against null.
 */
export function referenceDerive(
  inputs: Readonly<Record<string, unknown>>,
  now: Date,
  spec: RulesSpec = SPEC,
): Record<string, Value> {
  const key = String(inputs.platform);
  const base = key.split(':')[0] as string;
  const platform = spec.platforms[key] ?? spec.platforms[base] ?? spec.platforms.other;
  const category = spec.categories[String(inputs.category)] ?? spec.categories.other;
  const data: Record<string, unknown> = { ...inputs, constants: spec.constants };
  const env: EvalEnv = {
    data,
    now,
    platformAttr: (attr) => (platform as unknown as Record<string, unknown>)[attr],
    categoryAttr: (attr) => (category as unknown as Record<string, unknown>)[attr],
    incrementLadder: (amount, name) => {
      const ladder = spec.increment_ladders[name];
      if (!ladder) throw new Error(`unknown increment ladder "${name}"`);
      let inc: number | null = null;
      for (const r of ladder.rungs) if (cmp(fromInt(r.from_cents), amount) <= 0) inc = r.increment_cents;
      if (inc === null) throw new Error(`no rung of "${name}" covers the amount`);
      return fromInt(inc);
    },
  };
  const out: Record<string, Value> = {};
  for (const d of spec.derived) {
    const v = evaluate(d.expr, env);
    out[d.name] = v;
    data[d.name] = v;
  }
  return out;
}

// ---------------------------------------------------------------- output formatting

/** A value as it leaves the engine. Money (names ending _cents) becomes whole cents. */
export function outValue(v: unknown, name: string): OutValue {
  if (v === UNKNOWN || v === undefined) return null;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (isRat(v)) return name.endsWith('_cents') ? toSafeNumber(roundHalfAway(v)) : toNumber(v);
  return null;
}

const TEMPLATE = /\{([a-z_][a-z0-9_.]*)(?:\|(usd|pct|min))?\}/g;

export function templateNames(text: string): string[] {
  return [...text.matchAll(TEMPLATE)].map((m) => m[1] as string);
}

function formatForTemplate(raw: unknown, filter: string | undefined, name: string): string {
  if (raw === undefined) throw new Error(`template names "${name}", which has no value`);
  if (raw === null) return 'n/a';
  if (raw === UNKNOWN) return 'unknown';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
  const r = typeof raw === 'number' ? fromNumber(raw) : isRat(raw) ? raw : null;
  if (r === null) return String(raw);
  if (filter === 'usd') return formatUsd(roundHalfAway(r));
  if (filter === 'pct') return formatPercent(r);
  if (filter === 'min') return `${floor(r)} min`;
  return formatPlain(r);
}

/**
 * The spec's output_contract.template_syntax: {name}, {name|usd} (integer cents
 * as $1,234.56), {name|pct} (0.123 -> 12.3%), {name|min} (whole minutes). Dotted
 * names read constants; null renders as "n/a".
 */
export function renderTemplate(text: string, data: Readonly<Record<string, unknown>>): string {
  return text.replace(TEMPLATE, (_m, name: string, filter: string | undefined) =>
    formatForTemplate(lookupPath(data, name), filter, name),
  );
}

// ---------------------------------------------------------------- labels and provenance

const LABEL_STRENGTH: readonly EvidenceLabel[] = ['SE', 'SE-2nd', 'INTERNAL', 'DESIGN', 'UNVERIFIED', 'PLACEHOLDER'];

/** The strongest label among a rule's cited sources: can this claim be shown as sourced? */
export function ruleEvidenceLabel(rule: SpecRule): EvidenceLabel {
  const labels = rule.evidence.map((id) => EVIDENCE_STATUS[id] ?? 'UNVERIFIED');
  if (labels.length === 0) return LABEL_FOR_RULES_WITHOUT_EVIDENCE[rule.id] ?? 'UNVERIFIED';
  return labels.reduce((best, l) => (LABEL_STRENGTH.indexOf(l) < LABEL_STRENGTH.indexOf(best) ? l : best));
}

const DERIVED_EXPR: ReadonlyMap<string, JsonLogic> = new Map(SPEC.derived.map((d) => [d.name, d.expr]));

/** Maps a leaf of the dependency walk onto the provenance entries that describe it. */
function leafParams(leaf: string, lot: ResolvedLot): string[] {
  switch (leaf) {
    case 'buyer_premium_pct':
    case 'platform.bp_default_pct':
    case 'constants.bp_unknown_assumed_pct':
      return ['buyer_premium_pct'];
    case 'platform.card_fee_default_rate':
    case 'constants.card_fee_unknown_assumed_rate':
      return ['card_fee_rate'];
    case 'constants.sales_tax_rate':
      return ['sales_tax_rate'];
    case 'soft_close_window_minutes':
    case 'platform.soft_close_default_minutes':
    case 'constants.unknown_window_assumed_minutes':
      return ['extension_window_minutes'];
    case 'platform.close_type':
      return ['close_type'];
    case 'platform.increment_ladder':
    case 'increment_ladder':
      return ['next_min_bid_cents'];
    case 'pickup_distance_miles':
    case 'constants.mileage_cost_cents_per_mile':
    case 'constants.pickup_time_cost_cents':
      return transportParamNames(lot);
    case 'category.repair_reserve_rate':
      return [lot.repairCents !== null ? 'user.repair_cents' : 'category.repair_reserve_rate'];
    default:
      return leaf.startsWith('category.') || leaf.startsWith('constants.') ? [leaf] : [];
  }
}

/**
 * Parameters behind a set of names: walks the spec's own derived expressions
 * down to inputs, constants and table attributes. A derived value that came out
 * null contributed nothing, so its inputs are not charged to the result (a
 * budget-only ceiling does not depend on the category margin).
 */
function paramsBehind(
  roots: Iterable<string>,
  lot: ResolvedLot,
  core: CeilingCore,
  derived: Readonly<Record<string, DerivedValue>>,
): ParamUse[] {
  const seen = new Set<string>();
  const names = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    if (name === 'profit_target_cents') {
      // max(m x R, Pmin): only the side that won set the number.
      if (core.profitBasis !== null) {
        names.add(core.profitBasis === 'minimum' ? 'category.min_profit_cents' : 'category.target_margin_rate');
      }
      continue;
    }
    const expr = DERIVED_EXPR.get(name);
    if (expr !== undefined) {
      if (derived[name] !== null) for (const v of collectVars(expr)) queue.push(v);
      continue;
    }
    for (const p of leafParams(name, lot)) names.add(p);
  }
  return [...names].map((n) => lot.params[n]).filter((p): p is ParamUse => p !== undefined);
}

function ruleRoots(rule: SpecRule): Set<string> {
  const roots = collectVars(rule.when);
  for (const n of rule.numbers) roots.add(n);
  for (const n of templateNames(rule.text)) roots.add(n);
  return roots;
}

const TIME_NAMES = [
  'minutes_to_close',
  'alert_seconds_before',
  'proxy_deadline_minutes_before_close',
  'constants.manual_snipe_seconds',
];

export const IMPRECISE_CLOSE_CAVEAT =
  'The source publishes only a close DATE, and the listed time is the end of that day. The real close can be up to a day earlier and later again after extensions, so treat any minutes or seconds here as date-level: enter your bid a day early.';

/** Spec input name -> LotContext field, for "not evaluated: needs imageCount". */
const INPUT_FIELD: Readonly<Record<string, string>> = {
  image_count: 'imageCount',
  description_word_count: 'descriptionWords',
  bid_count: 'bidCount',
};

function unknownInputsBehind(expr: JsonLogic, lot: ResolvedLot): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  const queue = [...collectVars(expr)];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const e = DERIVED_EXPR.get(name);
    if (e !== undefined) {
      for (const v of collectVars(e)) queue.push(v);
      continue;
    }
    const field = INPUT_FIELD[name];
    if (field !== undefined && lot.unknownInputs.includes(field)) found.add(field);
  }
  return [...found];
}

// ---------------------------------------------------------------- evaluation

export function assertNow(now: Date): void {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date; the engine never reads the clock itself.');
  }
}

export interface RuleEvaluation {
  readonly result: RulesResult;
  /** null when the rules could not run (invalid input or missing core fields). */
  readonly core: CeilingCore | null;
  readonly derived: Readonly<Record<string, DerivedValue>> | null;
  /** What the rules' `var` read: inputs, derived values and constants. */
  readonly data: Readonly<Record<string, unknown>> | null;
  /** rule id -> fired (true), ruled out (false) or not evaluable (UNKNOWN). */
  readonly firedMap: Readonly<Record<string, boolean | Unknown>>;
}

function inputsOut(lot: ResolvedLot): Record<string, OutValue> {
  return Object.fromEntries(Object.entries(lot.specInputs).map(([k, v]) => [k, outValue(v, k)]));
}

/** evaluateRules for a lot that has already been read. */
export function evaluateResolved(lot: ResolvedLot, now: Date): RuleEvaluation {
  assertNow(now);
  const caveats = lot.closeTimePrecise ? [] : [IMPRECISE_CLOSE_CAVEAT];
  const empty = {
    primary: null,
    actions: [],
    warnings: [],
    info: [],
    fired: [],
    notEvaluated: [],
    derived: {},
    platformKey: lot.errors.length > 0 ? null : lot.platformKey,
    categoryKey: lot.errors.length > 0 ? null : lot.categoryKey,
    notes: lot.notes,
  };
  if (lot.errors.length > 0) {
    return {
      result: { ...empty, status: 'invalid_input', missing: [], errors: lot.errors, inputs: {}, caveats: [] },
      core: null,
      derived: null,
      data: null,
      firedMap: {},
    };
  }
  if (lot.missing.length > 0) {
    return {
      result: { ...empty, status: 'insufficient_data', missing: lot.missing, errors: [], inputs: inputsOut(lot), caveats },
      core: null,
      derived: null,
      data: null,
      firedMap: {},
    };
  }

  const core = solveCeiling(lot);
  const derived = deriveSpecValues(lot, core, now);
  const data: Record<string, unknown> = { ...lot.specInputs, ...derived, constants: lot.constants };
  const env: EvalEnv = { data, now };

  const fired: FiredRule[] = [];
  const notEvaluated: NotEvaluatedRule[] = [];
  const firedMap: Record<string, boolean | Unknown> = {};
  for (const rule of RULES) {
    const v = evaluate(rule.when, env);
    if (v === UNKNOWN) {
      firedMap[rule.id] = UNKNOWN;
      notEvaluated.push({ ruleId: rule.id, code: rule.code, needs: unknownInputsBehind(rule.when, lot) });
      continue;
    }
    firedMap[rule.id] = truthy(v);
    if (!truthy(v)) continue;

    const roots = ruleRoots(rule);
    const parameters = paramsBehind(roots, lot, core, derived);
    const triggeredBy: Record<string, OutValue> = {};
    for (const name of collectVars(rule.when)) triggeredBy[name] = outValue(lookupPath(data, name), name);
    fired.push({
      ruleId: rule.id,
      code: rule.code,
      kind: rule.kind,
      priority: rule.priority,
      confidence: rule.confidence,
      evidence: rule.evidence,
      evidenceLabel: ruleEvidenceLabel(rule),
      text: renderTemplate(rule.text, data),
      numbers: Object.fromEntries(rule.numbers.map((n) => [n, outValue(lookupPath(data, n), n)])),
      triggeredBy,
      parameters,
      placeholder: parameters.some((p) => p.status === 'PLACEHOLDER'),
      caveats: !lot.closeTimePrecise && TIME_NAMES.some((n) => roots.has(n)) ? [IMPRECISE_CLOSE_CAVEAT] : [],
    });
  }
  fired.sort((a, b) => a.priority - b.priority || a.ruleId.localeCompare(b.ruleId));

  const result: RulesResult = {
    status: 'ok',
    missing: [],
    errors: [],
    primary: fired.find((r) => r.kind === 'action') ?? null,
    actions: fired.filter((r) => r.kind === 'action'),
    warnings: fired.filter((r) => r.kind === 'warning'),
    info: fired.filter((r) => r.kind === 'info'),
    fired,
    notEvaluated,
    inputs: inputsOut(lot),
    derived: Object.fromEntries(Object.entries(derived).map(([k, v]) => [k, outValue(v, k)])),
    platformKey: lot.platformKey,
    categoryKey: lot.categoryKey,
    notes: lot.notes,
    caveats,
  };
  return { result, core, derived, data, firedMap };
}

/**
 * Evaluates every section 9 rule for one lot. `now` is the evaluation instant;
 * the spec needs it to turn closes_at into time remaining, and the engine never
 * reads the clock itself.
 */
export function evaluateRules(context: LotContext, now: Date, options: EngineOptions = {}): RulesResult {
  assertNow(now);
  return evaluateResolved(resolveLot(context, options), now).result;
}
