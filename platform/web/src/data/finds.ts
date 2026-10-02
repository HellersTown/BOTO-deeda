/**
 * Finds (0044): the user's goals, the open lots a goal searches, the facts the
 * strategy engine needs for each, their appraisals, and the appraise-lots
 * function that values the rest. The ranking itself is lib/finder.ts.
 */
import { parseQuery } from '@platform/query';
import type { Json, LotAppraisalRow, FinderGoalInsert, FinderGoalRow, FinderGoalUpdate, SearchLotRow } from './database.types';
import { toDataError } from './errors';
import { readLotMeta } from './lots';
import { searchLots } from './search';
import { db } from './supabase';
import { focusTerms, type AppraisalValues } from '../lib/finder';
import type { LotFacts } from '../lib/lotContext';
import { toSearchArgs, type SearchFilters } from '../lib/searchParams';

const GOAL_COLUMNS =
  'id, user_id, name, mode, focus, budget_cents, min_profit_cents, min_return_pct, postal_code, radius_miles, closing_within_hours, include_shippable, sales_tax_pct, conservative, created_at, updated_at' as const;

export async function listGoals(): Promise<FinderGoalRow[]> {
  const { data, error } = await db().from('finder_goals').select(GOAL_COLUMNS).order('updated_at', { ascending: false });
  if (error) throw toDataError(error, 'finder goals');
  return data ?? [];
}

export async function createGoal(goal: FinderGoalInsert): Promise<FinderGoalRow> {
  const { data, error } = await db().from('finder_goals').insert(goal).select(GOAL_COLUMNS).single();
  if (error) throw toDataError(error, 'save goal');
  return data;
}

export async function updateGoal(id: string, patch: FinderGoalUpdate): Promise<FinderGoalRow> {
  const { data, error } = await db().from('finder_goals').update(patch).eq('id', id).select(GOAL_COLUMNS).single();
  if (error) throw toDataError(error, 'save goal');
  return data;
}

export async function deleteGoal(id: string): Promise<void> {
  const { error } = await db().from('finder_goals').delete().eq('id', id);
  if (error) throw toDataError(error, 'delete goal');
}

// ---------------------------------------------------------------- candidates

/** Lots one goal considers. More would mean more appraisals than a goal needs. */
export const CANDIDATE_LIMIT = 120;

export interface CandidateSet {
  /** search_lots rows, sales left out: a sale card has no single price to project. */
  readonly rows: SearchLotRow[];
  /** lot id -> the focus-list items whose search found it. */
  readonly matched: ReadonlyMap<string, readonly string[]>;
}

export interface GoalOrigin {
  readonly zip: string | null;
  readonly radiusMiles: number;
}

/**
 * The goal's searches: one per item on its focus list, or one for the whole
 * focus, or (with no focus) everything near enough, soonest closing first.
 * Each is the search box's own search, parsed the same way.
 */
export async function findCandidates(goal: FinderGoalRow, home: GoalOrigin): Promise<CandidateSet> {
  const terms = focusTerms(goal.focus);
  const queries = terms.length > 1 ? terms : [goal.focus?.trim() ?? ''];
  const zip = goal.postal_code ?? home.zip;
  const radius = goal.radius_miles ?? home.radiusMiles;
  const perQuery = Math.max(10, Math.ceil(CANDIDATE_LIMIT / queries.length));
  const filters: SearchFilters = {
    radius,
    includeShippable: goal.include_shippable,
    tiers: null,
    minCents: null,
    // No hammer above the budget can come in under it once premium and tax are added.
    maxCents: goal.budget_cents,
    sort: 'closing',
  };

  const results = await Promise.all(
    queries.map(async (query) => {
      const parse = parseQuery(query, { homePostalCode: zip ?? undefined, defaultRadiusMiles: radius });
      const args = toSearchArgs(
        { ...parse.searchParams, p_closing_within_hours: goal.closing_within_hours ?? parse.searchParams.p_closing_within_hours },
        filters,
        { homeZip: zip, page: { limit: perQuery, offset: 0 }, tsquery: parse.tsquery },
      );
      return { query, rows: args ? await searchLots(args) : [] };
    }),
  );

  const byId = new Map<string, SearchLotRow>();
  const matched = new Map<string, string[]>();
  for (const { query, rows } of results) {
    for (const row of rows) {
      if (row.sale_level) continue;
      if (!byId.has(row.lot_id)) byId.set(row.lot_id, row);
      if (terms.includes(query.toLowerCase())) {
        const list = matched.get(row.lot_id) ?? [];
        if (!list.includes(query.toLowerCase())) list.push(query.toLowerCase());
        matched.set(row.lot_id, list);
      }
    }
  }
  return { rows: [...byId.values()].slice(0, CANDIDATE_LIMIT), matched };
}

// ---------------------------------------------------------------------- facts

const FACTS_SELECT = `id, current_bid_cents, next_bid_cents, starting_bid_cents, bid_count, closes_at, reserve_met,
  image_count, desc_richness, sleeper_score, brand, model, condition, ships,
  meta:raw->_meta,
  source:sources(tier, platform),
  category:categories(slug),
  auction:auctions(format, pickup_required, buyer_premium_pct)` as const;

const CHUNK = 80;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** What the engine needs about each lot, beyond what search_lots returns. */
export async function fetchFinderFacts(lotIds: readonly string[]): Promise<Map<string, LotFacts>> {
  const out = new Map<string, LotFacts>();
  const ids = [...new Set(lotIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db()
      .from('lots')
      .select(FACTS_SELECT)
      .in('id', ids.slice(i, i + CHUNK));
    if (error) throw toDataError(error, 'lot facts');
    for (const row of data ?? []) {
      const meta = readLotMeta(row.meta as Json);
      out.set(row.id, {
        currentBidCents: row.current_bid_cents,
        nextBidCents: row.next_bid_cents,
        startingBidCents: row.starting_bid_cents,
        bidCount: row.bid_count,
        closesAt: row.closes_at,
        closeTimePrecise: meta.closeTimePrecise,
        softCloseMinutes: meta.inactivityMinutes,
        hasReserve: meta.hasReserve,
        reserveMet: row.reserve_met,
        buyerPremiumPct: num(row.auction?.buyer_premium_pct),
        sleeperScore: num(row.sleeper_score),
        imageCount: row.image_count,
        descriptionWords: row.desc_richness,
        categorySlug: row.category?.slug ?? null,
        brand: row.brand,
        model: row.model,
        condition: row.condition,
        sourcePlatform: row.source?.platform ?? null,
        sourceTier: row.source?.tier ?? null,
        auctionFormat: row.auction?.format ?? null,
        pickupRequired: row.auction?.pickup_required ?? null,
        ships: row.ships === true,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------- appraisals

/** Every column users may read (0044 grants these, not who asked). */
const APPRAISAL_COLUMNS =
  'lot_id, model, item, resale_low_cents, resale_likely_cents, resale_high_cents, new_price_cents, confidence, channel, days_to_sell, project_tags, flags, comps_query, rationale, lot_title, bid_cents_at, created_at' as const;

export interface StoredAppraisal extends AppraisalValues {
  readonly lotTitle: string;
  readonly model: string;
  readonly createdAt: string;
}

function toAppraisal(row: LotAppraisalRow): StoredAppraisal {
  return {
    item: row.item,
    lowCents: row.resale_low_cents,
    likelyCents: row.resale_likely_cents,
    highCents: row.resale_high_cents,
    newPriceCents: row.new_price_cents,
    confidence: row.confidence,
    channel: row.channel,
    daysToSell: row.days_to_sell,
    projectTags: row.project_tags ?? [],
    flags: row.flags ?? [],
    compsQuery: row.comps_query,
    rationale: row.rationale,
    lotTitle: row.lot_title,
    model: row.model,
    createdAt: row.created_at,
  };
}

export async function fetchAppraisals(lotIds: readonly string[]): Promise<Map<string, StoredAppraisal>> {
  const out = new Map<string, StoredAppraisal>();
  const ids = [...new Set(lotIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db()
      .from('lot_appraisals')
      .select(APPRAISAL_COLUMNS)
      .in('lot_id', ids.slice(i, i + CHUNK));
    if (error) throw toDataError(error, 'appraisals');
    for (const row of data ?? []) out.set(row.lot_id, toAppraisal(row));
  }
  return out;
}

// ------------------------------------------------------------------ appraiser

/** Lots one appraise request may carry (the function's own limit). */
export const APPRAISE_BATCH = 20;

export interface AppraiserStatus {
  /** false until ANTHROPIC_API_KEY is set for Edge Functions. */
  readonly configured: boolean;
  readonly model: string | null;
  /** Appraisals left in the last 24 hours. */
  readonly remaining: number;
  readonly cap: number;
}

export interface AppraiseResult extends AppraiserStatus {
  readonly appraised: number;
  readonly failed: number;
  readonly skipped: Readonly<Record<string, number>>;
  readonly errors: readonly string[];
}

/** The function's own message for a non-2xx answer, when it sent one. */
async function functionError(error: unknown, what: string): Promise<Error> {
  const context = (error as { context?: unknown }).context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown };
      if (typeof body.error === 'string') return toDataError({ message: body.error }, what);
    } catch {
      // Not JSON: fall through to the client's own message.
    }
  }
  return toDataError(error, what);
}

function readStatus(data: unknown): AppraiserStatus {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    configured: d.configured === true,
    model: typeof d.model === 'string' ? d.model : null,
    remaining: typeof d.remaining === 'number' ? d.remaining : 0,
    cap: typeof d.cap === 'number' ? d.cap : 0,
  };
}

export async function appraiserStatus(): Promise<AppraiserStatus> {
  const { data, error } = await db().functions.invoke('appraise-lots', { body: { check: true } });
  if (error) throw await functionError(error, 'appraiser');
  return readStatus(data);
}

export async function requestAppraisals(lotIds: readonly string[]): Promise<AppraiseResult> {
  const { data, error } = await db().functions.invoke('appraise-lots', { body: { lot_ids: lotIds.slice(0, APPRAISE_BATCH) } });
  if (error) throw await functionError(error, 'appraise');
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    ...readStatus(data),
    appraised: typeof d.appraised === 'number' ? d.appraised : 0,
    failed: typeof d.failed === 'number' ? d.failed : 0,
    skipped: (typeof d.skipped === 'object' && d.skipped !== null ? d.skipped : {}) as Record<string, number>,
    errors: Array.isArray(d.errors) ? d.errors.filter((e): e is string => typeof e === 'string') : [],
  };
}
