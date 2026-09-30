/**
 * Search: the search_lots() RPC (0005, fixed in 0006), callable by anon and
 * authenticated. Plus the one thing it does not return that the UI must know:
 * whether a lot's close time is precise (lots.raw->'_meta'->>'closeTimePrecise').
 */
import type { Json, SearchLotRow, SearchLotsArgs } from './database.types';
import { toDataError } from './errors';
import { db } from './supabase';

/** search_lots clamps p_limit to 1..200 (0006), so no single call can return or count more. */
export const SEARCH_LIMIT_MAX = 200;

export async function searchLots(args: SearchLotsArgs): Promise<SearchLotRow[]> {
  const { data, error } = await db().rpc('search_lots', args);
  if (error) throw toDataError(error, 'search_lots');
  return data ?? [];
}

/**
 * How many lots a search matches (at most SEARCH_LIMIT_MAX, the function's own
 * cap), without downloading them: a HEAD request with `Prefer: count=exact`.
 * HEAD sends the arguments as query parameters, where a null would arrive as
 * the text "null", so null arguments are dropped and take their SQL default
 * (which is null for every one of them).
 */
export async function countSearchLots(args: SearchLotsArgs): Promise<number> {
  const defined = Object.fromEntries(
    Object.entries({ ...args, p_limit: SEARCH_LIMIT_MAX, p_offset: 0 }).filter(([, v]) => v !== null && v !== undefined),
  ) as SearchLotsArgs;
  const { count, error } = await db().rpc('search_lots', defined, { count: 'exact', head: true });
  if (error) throw toDataError(error, 'search_lots count');
  return count ?? 0;
}

/** Close-time facts search_lots does not return. */
export interface LotCloseInfo {
  /** false only when the source publishes a close DATE (ingest sets raw._meta.closeTimePrecise = false). */
  readonly precise: boolean;
  /** The auction's IANA zone: the zone a date-only close date is stated in. */
  readonly timeZone: string | null;
}

/** raw._meta.closeTimePrecise, read the way 0013's queue_watch_alerts reads it (absent means precise). */
export function readClosePrecise(value: Json | undefined): boolean {
  return !(value === false || value === 'false');
}

const CLOSE_INFO_CHUNK = 80;

/**
 * Close precision and time zone for a set of lots, in chunks so the `in` list
 * stays well inside URL limits. Lots missing from the answer are simply absent
 * from the map; callers treat that as "unknown".
 */
export async function fetchLotCloseInfo(lotIds: readonly string[]): Promise<Map<string, LotCloseInfo>> {
  const out = new Map<string, LotCloseInfo>();
  const ids = [...new Set(lotIds)];
  for (let i = 0; i < ids.length; i += CLOSE_INFO_CHUNK) {
    const chunk = ids.slice(i, i + CLOSE_INFO_CHUNK);
    const { data, error } = await db()
      .from('lots')
      .select('id, precise:raw->_meta->closeTimePrecise, auction:auctions(timezone)')
      .in('id', chunk);
    if (error) throw toDataError(error, 'lot close info');
    for (const row of data ?? []) {
      out.set(row.id, { precise: readClosePrecise(row.precise), timeZone: row.auction?.timezone ?? null });
    }
  }
  return out;
}
