/**
 * Finds: open lots ranked against a goal (0044). Pure. The page fetches the
 * candidates, their facts and their appraisals; this decides what each lot is
 * worth to the goal, and every dollar comes from the strategy engine
 * (projectAtHammer at today's price, computeMaxBid for the walk-away number),
 * the same calculator as the lot page.
 *
 *   resale    profit if won at today's price: the appraised resale less selling
 *             fees and shipping, the invoice, the trip and the engine's risk
 *             reserve. The walk-away keeps the goal's minimum profit.
 *   personal  the saving against buying the same thing used elsewhere, after the
 *             invoice, the trip and the reserve. No selling costs.
 *   project   personal use, for lots that match an item on the project's list,
 *             best fit first.
 *
 * An appraisal is an estimate. Each suggestion carries its confidence, and the
 * sort weighs a low-confidence value down rather than hiding it.
 */
import { computeMaxBid, projectAtHammer, type CalculatorResult, type LotContext, type Projection } from '@platform/strategy';
import { buildLotContext, type LotFacts } from './lotContext';

export type FinderMode = 'resale' | 'personal' | 'project';

export const MODE_LABELS: Readonly<Record<FinderMode, string>> = {
  resale: 'Resale profit',
  personal: 'Personal use',
  project: 'Project',
};

/** What a goal asks for, as the ranking reads it. */
export interface GoalSettings {
  readonly mode: FinderMode;
  readonly focus: string | null;
  /** The most to pay the auction for one lot, invoice total (the engine's maxBudgetCents). */
  readonly budgetCents: number | null;
  /** resale: the smallest profit worth buying for. */
  readonly minProfitCents: number | null;
  /** resale: the smallest profit / all-in cost, in percent. */
  readonly minReturnPct: number | null;
  /** 0 with a resale certificate; null keeps the engine's default. */
  readonly salesTaxPct: number | null;
  /** Value lots at the low estimate instead of the likely one. */
  readonly conservative: boolean;
}

/** One lot_appraisals row, as the ranking reads it. */
export interface AppraisalValues {
  readonly item: string;
  readonly lowCents: number | null;
  readonly likelyCents: number | null;
  readonly highCents: number | null;
  readonly newPriceCents: number | null;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly channel: string | null;
  readonly daysToSell: number | null;
  readonly projectTags: readonly string[];
  readonly flags: readonly string[];
  readonly compsQuery: string | null;
  readonly rationale: string | null;
}

export interface Candidate {
  readonly lotId: string;
  readonly title: string;
  readonly facts: LotFacts;
  /** One-way miles from the goal's origin, from search_lots. */
  readonly distanceMiles: number | null;
  /** The focus-list items whose search found this lot. */
  readonly matched: readonly string[];
}

export interface Suggestion {
  readonly lotId: string;
  readonly mode: FinderMode;
  /** The hammer the projection assumes: the next acceptable bid, else the current bid, else the opening bid. */
  readonly priceTodayCents: number;
  /** The value fed to the engine, and which estimate it is. */
  readonly valueCents: number;
  readonly valueBasis: 'likely' | 'low';
  /** Profit (resale) or saving (personal, project) if won at today's price. */
  readonly projection: Projection;
  /** The most to bid and still meet the goal. */
  readonly walkAway: CalculatorResult;
  /** Focus-list items this lot matches, by search or by its appraisal's project tags. */
  readonly fit: readonly string[];
  /** Meets every threshold the goal sets. */
  readonly passes: boolean;
  /** Why it falls short, in plain words; empty when it passes. */
  readonly shortfalls: readonly string[];
  /** The sort key, higher first: the profit or saving, weighed by confidence. */
  readonly score: number;
}

export type Unranked =
  | { readonly lotId: string; readonly why: 'unappraised' }
  | { readonly lotId: string; readonly why: 'no_value' }
  | { readonly lotId: string; readonly why: 'no_price' };

/** How much a value's confidence counts in the sort. The numbers shown are never weighed. */
export const CONFIDENCE_WEIGHT: Readonly<Record<AppraisalValues['confidence'], number>> = { high: 1, medium: 0.8, low: 0.5 };

/** The goal's focus as a list: "table saw, jointer and clamps" is three searches. */
export function focusTerms(focus: string | null): string[] {
  if (!focus) return [];
  const out: string[] = [];
  for (const part of focus.split(/[,;\n]|\s+and\s+/i)) {
    const term = part.replace(/\s+/g, ' ').trim().toLowerCase();
    if (term.length >= 2 && !out.includes(term)) out.push(term);
    if (out.length === 8) break;
  }
  return out;
}

function whole(v: number | null): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** What winning it now would take: the next acceptable bid, else the current bid, else the opening bid. */
export function priceToday(facts: Pick<LotFacts, 'nextBidCents' | 'currentBidCents' | 'startingBidCents'>): number | null {
  for (const c of [facts.nextBidCents, facts.currentBidCents, facts.startingBidCents]) if (whole(c)) return c;
  return null;
}

/** The engine's input for one lot under one goal. */
export function goalContext(candidate: Candidate, goal: GoalSettings, valueCents: number): LotContext {
  const resale = goal.mode === 'resale';
  const base = buildLotContext(
    candidate.facts,
    candidate.distanceMiles,
    resale
      ? // The goal's own minimum profit sets the target, not a category default.
        { estimatedResaleCents: valueCents, targetMarginPct: 0, userGoal: 'resell' }
      : { estimatedResaleCents: null, estimatedValueCents: valueCents, targetMarginPct: null, userGoal: 'use' },
  );
  return {
    ...base,
    ...(goal.salesTaxPct !== null ? { salesTaxPct: goal.salesTaxPct } : {}),
    ...(resale ? { minProfitCents: goal.minProfitCents ?? 0 } : {}),
    ...(goal.budgetCents !== null ? { maxBudgetCents: goal.budgetCents } : {}),
  };
}

function fitFor(candidate: Candidate, appraisal: AppraisalValues, terms: readonly string[]): string[] {
  const tags = appraisal.projectTags.map((t) => t.toLowerCase());
  return terms.filter((term) => candidate.matched.includes(term) || tags.some((t) => t === term || t.includes(term) || term.includes(t)));
}

function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

/** One lot under one goal: a suggestion, or why it cannot be ranked yet. */
export function evaluate(candidate: Candidate, goal: GoalSettings, appraisal: AppraisalValues | null): Suggestion | Unranked {
  if (appraisal === null) return { lotId: candidate.lotId, why: 'unappraised' };
  const valueBasis = goal.conservative && whole(appraisal.lowCents) ? 'low' : 'likely';
  const valueCents = valueBasis === 'low' ? appraisal.lowCents : appraisal.likelyCents;
  if (!whole(valueCents) || valueCents === 0) return { lotId: candidate.lotId, why: 'no_value' };
  const price = priceToday(candidate.facts);
  if (price === null) return { lotId: candidate.lotId, why: 'no_price' };

  const ctx = goalContext(candidate, goal, valueCents);
  const projection = projectAtHammer(ctx, price);
  const walkAway = computeMaxBid(ctx);
  const profit = projection.profitCents;
  const terms = focusTerms(goal.focus);
  const fit = fitFor(candidate, appraisal, terms);

  const shortfalls: string[] = [];
  if (profit === null) {
    shortfalls.push('The engine could not price it');
  } else if (goal.mode === 'resale') {
    const floor = goal.minProfitCents ?? 1;
    if (profit < floor) {
      shortfalls.push(profit <= 0 ? 'No profit at today’s price' : `Profit under your ${usd(floor)} minimum`);
    }
    const ret = projection.returnOnCost;
    if (goal.minReturnPct !== null && (ret === null || ret * 100 < goal.minReturnPct)) {
      shortfalls.push(`Return under your ${goal.minReturnPct}%`);
    }
  } else if (profit <= 0) {
    shortfalls.push('Costs more than buying it used');
  }
  if (goal.budgetCents !== null && projection.invoice !== null && projection.invoice.totalCents > goal.budgetCents) {
    shortfalls.push(`Over your ${usd(goal.budgetCents)} budget`);
  }
  if (goal.mode === 'project' && terms.length > 0 && fit.length === 0) {
    shortfalls.push('Not on your project list');
  }

  const weighed = (profit ?? 0) * CONFIDENCE_WEIGHT[appraisal.confidence];
  return {
    lotId: candidate.lotId,
    mode: goal.mode,
    priceTodayCents: price,
    valueCents,
    valueBasis,
    projection,
    walkAway,
    fit,
    passes: shortfalls.length === 0,
    shortfalls,
    // A project ranks by how much of the list a lot covers, then by the saving.
    score: goal.mode === 'project' ? fit.length * 1e12 + weighed : weighed,
  };
}

export function isSuggestion(r: Suggestion | Unranked): r is Suggestion {
  return 'projection' in r;
}

/** Suggestions that meet the goal first, each group best first; ties go to the cheaper buy. */
export function rank(suggestions: readonly Suggestion[]): Suggestion[] {
  return [...suggestions].sort(
    (a, b) => Number(b.passes) - Number(a.passes) || b.score - a.score || a.priceTodayCents - b.priceTodayCents,
  );
}

/** eBay's sold-and-completed search for comparable items: the check on every estimate. */
export function soldListingsUrl(query: string): string {
  const q = query.replace(/\s+/g, ' ').trim();
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`;
}
