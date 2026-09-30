/**
 * Hunts (standing searches) and their matches.
 *
 *   hunts         owner-only (0003); insert allowed, update limited to the 0009
 *                 columns; the 0003/0004 triggers raise "Hunt limit reached…"
 *                 (check_violation) on insert or on update of `active`.
 *   hunt_matches  owner-only through the hunt; only `dismissed` is updatable (0009).
 *   run_my_hunt   0013: fills one hunt's matches now, without sending alerts.
 */
import type { HuntInsert, HuntRow, Json, MatchBasis } from './database.types';
import { toDataError } from './errors';
import { fromEmbeddedLot, type LotSummary } from './lotSummary';
import { db } from './supabase';

const HUNT_SELECT =
  'id, user_id, name, query_text, parsed, keywords, exclude_keywords, category_ids, brands, required_terms, min_price_cents, max_price_cents, conditions, postal_code, radius_miles, states, include_shippable, sources_only, tiers_only, reference_image_url, min_similarity, min_sleeper_score, active, notify_immediately, last_run_at, match_count, created_at, paused_reason, paused_at' as const;

export async function listMyHunts(userId: string): Promise<HuntRow[]> {
  const { data, error } = await db()
    .from('hunts')
    .select(HUNT_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw toDataError(error, 'hunts');
  return data ?? [];
}

export async function getHunt(huntId: string): Promise<HuntRow | null> {
  const { data, error } = await db().from('hunts').select(HUNT_SELECT).eq('id', huntId).maybeSingle();
  if (error) throw toDataError(error, 'hunt');
  return data;
}

/** Throws DataError kind 'hunt_limit' when the plan's active-hunt cap is reached. */
export async function createHunt(insert: HuntInsert): Promise<HuntRow> {
  const { data, error } = await db().from('hunts').insert(insert).select(HUNT_SELECT).single();
  if (error) throw toDataError(error, 'create hunt');
  return data;
}

export interface RunHuntResult {
  readonly newMatches: number;
  readonly skippedEmpty: boolean;
}

function readRunResult(value: Json): RunHuntResult {
  const o = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const n = o.new_matches;
  const skipped = o.skipped_empty;
  return { newMatches: typeof n === 'number' ? n : 0, skippedEmpty: typeof skipped === 'number' && skipped > 0 };
}

export async function runMyHunt(huntId: string): Promise<RunHuntResult> {
  const { data, error } = await db().rpc('run_my_hunt', { p_hunt_id: huntId });
  if (error) throw toDataError(error, 'run_my_hunt');
  return readRunResult(data);
}

/** Pause or resume. Resuming can hit the plan limit (the trigger fires on update of `active`). */
export async function setHuntActive(huntId: string, active: boolean): Promise<HuntRow> {
  const { data, error } = await db().from('hunts').update({ active }).eq('id', huntId).select(HUNT_SELECT).single();
  if (error) throw toDataError(error, active ? 'resume hunt' : 'pause hunt');
  return data;
}

export async function renameHunt(huntId: string, name: string): Promise<HuntRow> {
  const { data, error } = await db().from('hunts').update({ name }).eq('id', huntId).select(HUNT_SELECT).single();
  if (error) throw toDataError(error, 'rename hunt');
  return data;
}

export async function deleteHunt(huntId: string): Promise<void> {
  const { error } = await db().from('hunts').delete().eq('id', huntId);
  if (error) throw toDataError(error, 'delete hunt');
}

/** The lots columns a card needs, embedded wherever a table points at lots (sale_level and the auction's lot count: 0023). */
export const EMBEDDED_LOT_COLUMNS =
  'id, title, url, primary_image_url, current_bid_cents, next_bid_cents, bid_count, closes_at, closed, pickup_city, pickup_state, pickup_postal_code, ships, sleeper_score, pickup_geo_source, sale_level, precise:raw->_meta->closeTimePrecise, source:sources(name, tier), auction:auctions(timezone, pickup_postal_code, auctioneer, lot_count)' as const;

const MATCH_SELECT =
  `id, score, reason, matched_at, lot:lots(${EMBEDDED_LOT_COLUMNS})` as const;

export interface HuntMatch {
  readonly id: number;
  readonly score: number | null;
  readonly matchedAt: string | null;
  readonly lot: LotSummary;
}

function readReason(reason: Json | null): { distance: number | null; basis: MatchBasis | null } {
  const o = reason !== null && typeof reason === 'object' && !Array.isArray(reason) ? reason : {};
  const d = o.distance_miles;
  const b = o.basis;
  const bases: readonly MatchBasis[] = ['nearby', 'in_state', 'ships_to_you', 'other'];
  return {
    distance: typeof d === 'number' ? d : typeof d === 'string' && d.trim() !== '' && Number.isFinite(Number(d)) ? Number(d) : null,
    basis: typeof b === 'string' && (bases as readonly string[]).includes(b) ? (b as MatchBasis) : null,
  };
}

/** Matches for one hunt, best first, dismissed ones left out. */
export async function listHuntMatches(huntId: string): Promise<HuntMatch[]> {
  const { data, error } = await db()
    .from('hunt_matches')
    .select(MATCH_SELECT)
    .eq('hunt_id', huntId)
    .eq('dismissed', false)
    .order('score', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw toDataError(error, 'hunt matches');
  const out: HuntMatch[] = [];
  for (const m of data ?? []) {
    if (!m.lot) continue;
    const { distance, basis } = readReason(m.reason);
    out.push({
      id: m.id,
      score: m.score === null ? null : Number(m.score),
      matchedAt: m.matched_at,
      lot: fromEmbeddedLot(m.lot, distance, basis),
    });
  }
  return out;
}

export async function dismissHuntMatch(matchId: number): Promise<void> {
  const { error } = await db().from('hunt_matches').update({ dismissed: true }).eq('id', matchId);
  if (error) throw toDataError(error, 'dismiss match');
}
