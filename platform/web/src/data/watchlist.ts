/**
 * The watchlist: bid management. Owner-only through RLS (0003); 0009 leaves its
 * table grants alone, so every column here is the user's to write.
 *
 *   max_bid_cents          the walk-away number (the strategy engine's hammer ceiling)
 *   remind_seconds_before  the closing reminder lead (0013 reminds at 08:00 on the
 *                          close date instead when the close time is date-only)
 *   placed_bid(_cents)     self-reported: we cannot see the user's account on the source
 *   outcome                'won' | 'lost' | 'passed', recorded after the close
 */
import type { AuctionFormat, Json, SourceTier, WatchlistInsert, WatchlistRow, WatchlistUpdate } from './database.types';
import { toDataError } from './errors';
import { db } from './supabase';

const WATCH_COLUMNS =
  'id, user_id, lot_id, max_bid_cents, notes, remind_seconds_before, reminded_at, placed_bid, placed_bid_cents, outcome, created_at' as const;

/** Everything the Bids page shows, and everything the strategy engine needs to price a win. */
const WATCH_SELECT = `${WATCH_COLUMNS},
  lot:lots(id, title, url, primary_image_url, current_bid_cents, next_bid_cents, starting_bid_cents, bid_count,
    sold_price_cents, reserve_met, closes_at, closed, pickup_city, pickup_state, pickup_postal_code, ships,
    image_count, desc_richness, sleeper_score, brand, model, condition, auction_id,
    meta:raw->_meta,
    source:sources(name, tier, platform),
    category:categories(slug),
    auction:auctions(id, timezone, format, pickup_required, pickup_postal_code, buyer_premium_pct))` as const;

export interface WatchedLot {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly imageUrl: string | null;
  readonly currentBidCents: number | null;
  readonly nextBidCents: number | null;
  readonly startingBidCents: number | null;
  readonly bidCount: number | null;
  readonly soldPriceCents: number | null;
  readonly reserveMet: boolean | null;
  readonly closesAt: string | null;
  readonly closed: boolean;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly ships: boolean;
  readonly imageCount: number | null;
  readonly descriptionWords: number | null;
  readonly sleeperScore: number | null;
  readonly brand: string | null;
  readonly model: string | null;
  readonly condition: string | null;
  readonly meta: Json;
  readonly sourceName: string | null;
  readonly sourceTier: SourceTier | null;
  readonly sourcePlatform: string | null;
  readonly categorySlug: string | null;
  readonly auctionId: string | null;
  readonly timeZone: string | null;
  readonly auctionFormat: AuctionFormat | null;
  readonly pickupRequired: boolean | null;
  readonly buyerPremiumPct: number | null;
}

export interface WatchEntry {
  readonly watch: WatchlistRow;
  /** null only if the lot row is unreadable, which RLS never causes for the public catalogue. */
  readonly lot: WatchedLot | null;
}

export async function listMyWatchlist(userId: string): Promise<WatchEntry[]> {
  const { data, error } = await db()
    .from('watchlist')
    .select(WATCH_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw toDataError(error, 'watchlist');
  return (data ?? []).map(({ lot, ...watch }) => ({
    watch,
    lot: lot
      ? {
          id: lot.id,
          title: lot.title,
          url: lot.url,
          imageUrl: lot.primary_image_url,
          currentBidCents: lot.current_bid_cents,
          nextBidCents: lot.next_bid_cents,
          startingBidCents: lot.starting_bid_cents,
          bidCount: lot.bid_count,
          soldPriceCents: lot.sold_price_cents,
          reserveMet: lot.reserve_met,
          closesAt: lot.closes_at,
          closed: lot.closed === true,
          city: lot.pickup_city,
          state: lot.pickup_state,
          postalCode: lot.pickup_postal_code ?? lot.auction?.pickup_postal_code ?? null,
          ships: lot.ships === true,
          imageCount: lot.image_count,
          descriptionWords: lot.desc_richness,
          sleeperScore: lot.sleeper_score === null ? null : Number(lot.sleeper_score),
          brand: lot.brand,
          model: lot.model,
          condition: lot.condition,
          meta: lot.meta,
          sourceName: lot.source?.name ?? null,
          sourceTier: lot.source?.tier ?? null,
          sourcePlatform: lot.source?.platform ?? null,
          categorySlug: lot.category?.slug ?? null,
          auctionId: lot.auction_id,
          timeZone: lot.auction?.timezone ?? null,
          auctionFormat: lot.auction?.format ?? null,
          pickupRequired: lot.auction?.pickup_required ?? null,
          buyerPremiumPct: lot.auction?.buyer_premium_pct === null || lot.auction?.buyer_premium_pct === undefined
            ? null
            : Number(lot.auction.buyer_premium_pct),
        }
      : null,
  }));
}

export async function getMyWatch(userId: string, lotId: string): Promise<WatchlistRow | null> {
  const { data, error } = await db()
    .from('watchlist')
    .select(WATCH_COLUMNS)
    .eq('user_id', userId)
    .eq('lot_id', lotId)
    .maybeSingle();
  if (error) throw toDataError(error, 'watch');
  return data;
}

/**
 * Watch a lot, or refresh the walk-away number and reminder on one already
 * watched (unique on user_id + lot_id). Only the fields passed are written.
 */
export async function watchLot(insert: WatchlistInsert): Promise<WatchlistRow> {
  const { data, error } = await db()
    .from('watchlist')
    .upsert(insert, { onConflict: 'user_id,lot_id' })
    .select(WATCH_COLUMNS)
    .single();
  if (error) throw toDataError(error, 'watch lot');
  return data;
}

export async function updateWatch(watchId: number, patch: WatchlistUpdate): Promise<WatchlistRow> {
  const { data, error } = await db().from('watchlist').update(patch).eq('id', watchId).select(WATCH_COLUMNS).single();
  if (error) throw toDataError(error, 'update watch');
  return data;
}

export async function removeWatch(watchId: number): Promise<void> {
  const { error } = await db().from('watchlist').delete().eq('id', watchId);
  if (error) throw toDataError(error, 'remove watch');
}
