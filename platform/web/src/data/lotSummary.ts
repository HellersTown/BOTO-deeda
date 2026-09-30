/**
 * LotSummary: the one shape every lot card renders, whether the lot came from
 * search_lots(), a hunt match or the watchlist. Mapping lives here so each
 * source of lots is converted in exactly one place.
 */
import type { Json, MatchBasis, SearchLotRow, SourceTier } from './database.types';
import { readClosePrecise, type LotCloseInfo } from './search';

/** 'unknown' when the precision lookup failed: render the date only, never a countdown. */
export type ClosePrecision = 'precise' | 'date_only' | 'unknown';

export interface LotSummary {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly imageUrl: string | null;
  readonly currentBidCents: number | null;
  readonly nextBidCents: number | null;
  readonly bidCount: number | null;
  readonly closesAt: string | null;
  readonly closed: boolean;
  readonly closePrecision: ClosePrecision;
  /** The auction's IANA zone (what a date-only close date is stated in). */
  readonly timeZone: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly ships: boolean;
  readonly distanceMiles: number | null;
  readonly sourceName: string | null;
  readonly sourceTier: SourceTier | null;
  readonly sleeperScore: number | null;
  readonly matchBasis: MatchBasis | null;
}

export function fromSearchRow(row: SearchLotRow, info: LotCloseInfo | undefined): LotSummary {
  return {
    id: row.lot_id,
    title: row.title,
    url: row.url,
    imageUrl: row.primary_image_url,
    currentBidCents: row.current_bid_cents,
    nextBidCents: row.next_bid_cents,
    bidCount: row.bid_count,
    closesAt: row.closes_at,
    closed: false, // search_lots returns open lots only
    closePrecision: info === undefined ? 'unknown' : info.precise ? 'precise' : 'date_only',
    timeZone: info?.timeZone ?? null,
    city: row.pickup_city,
    state: row.pickup_state,
    postalCode: row.pickup_postal_code,
    ships: row.ships === true,
    distanceMiles: row.distance_miles === null ? null : Number(row.distance_miles),
    sourceName: row.source_name,
    sourceTier: row.source_tier,
    sleeperScore: row.sleeper_score === null ? null : Number(row.sleeper_score),
    matchBasis: row.match_basis,
  };
}

/** The lots columns embedded under hunt_matches and watchlist (see EMBEDDED_LOT_SELECT). */
export interface EmbeddedLot {
  id: string;
  title: string;
  url: string | null;
  primary_image_url: string | null;
  current_bid_cents: number | null;
  next_bid_cents: number | null;
  bid_count: number | null;
  closes_at: string | null;
  closed: boolean | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  ships: boolean | null;
  sleeper_score: number | null;
  precise: Json;
  source: { name: string; tier: SourceTier | null } | null;
  auction: { timezone: string | null; pickup_postal_code: string | null } | null;
}

export function fromEmbeddedLot(lot: EmbeddedLot, distanceMiles: number | null = null, matchBasis: MatchBasis | null = null): LotSummary {
  return {
    id: lot.id,
    title: lot.title,
    url: lot.url,
    imageUrl: lot.primary_image_url,
    currentBidCents: lot.current_bid_cents,
    nextBidCents: lot.next_bid_cents,
    bidCount: lot.bid_count,
    closesAt: lot.closes_at,
    closed: lot.closed === true,
    closePrecision: readClosePrecise(lot.precise) ? 'precise' : 'date_only',
    timeZone: lot.auction?.timezone ?? null,
    city: lot.pickup_city,
    state: lot.pickup_state,
    postalCode: lot.pickup_postal_code ?? lot.auction?.pickup_postal_code ?? null,
    ships: lot.ships === true,
    distanceMiles,
    sourceName: lot.source?.name ?? null,
    sourceTier: lot.source?.tier ?? null,
    sleeperScore: lot.sleeper_score === null ? null : Number(lot.sleeper_score),
    matchBasis,
  };
}
