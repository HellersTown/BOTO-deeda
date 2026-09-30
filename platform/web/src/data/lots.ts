/**
 * Lot detail: the lots row (public read, 0003), its auctions row, its sources
 * row and its lot_images, in one request through PostgREST embedding along the
 * foreign keys declared in 0002.
 */
import type { AuctionFormat, Json, PickupGeoSource, SourceTier } from './database.types';
import { toDataError } from './errors';
import { readClosePrecise } from './search';
import { db } from './supabase';

const LOT_DETAIL_SELECT = `id, title, description, lot_number, brand, model, condition, quantity, url,
  starting_bid_cents, current_bid_cents, next_bid_cents, estimate_low_cents, estimate_high_cents,
  sold_price_cents, bid_count, reserve_met, closes_at, closed, extended_count,
  pickup_city, pickup_state, pickup_postal_code, pickup_geo_source, ships,
  primary_image_url, image_urls, image_count, desc_richness, sleeper_score, sleeper_reasons,
  meta:raw->_meta,
  auction:auctions(id, title, auctioneer, url, format, timezone, pickup_line1, pickup_city, pickup_state,
    pickup_postal_code, pickup_geo_source, pickup_required, ships, ships_note, seller_name, buyer_premium_pct, buyer_premium_note, terms_url),
  source:sources(id, name, tier, url, platform),
  category:categories(slug, label),
  images:lot_images(url, position)` as const;

/** The parts of lots.raw->'_meta' the UI and the strategy engine use (see packages/ingest adapters). */
export interface LotMeta {
  readonly closeTimePrecise: boolean;
  /** GSA's InactivityTime: the soft-close window, in minutes. */
  readonly inactivityMinutes: number | null;
  readonly hasReserve: boolean | null;
  /** A disclosed extra cost the hammer does not include (removal fees). */
  readonly feeNote: string | null;
  readonly terms: string | null;
}

export interface LotAuction {
  readonly id: string;
  readonly title: string;
  readonly auctioneer: string | null;
  readonly url: string | null;
  readonly format: AuctionFormat | null;
  readonly timezone: string | null;
  readonly pickupLine1: string | null;
  readonly pickupCity: string | null;
  readonly pickupState: string | null;
  readonly pickupPostalCode: string | null;
  readonly pickupRequired: boolean | null;
  readonly ships: boolean | null;
  readonly shipsNote: string | null;
  readonly sellerName: string | null;
  readonly buyerPremiumPct: number | null;
  readonly buyerPremiumNote: string | null;
  readonly termsUrl: string | null;
}

export interface LotSource {
  readonly id: string;
  readonly name: string;
  readonly tier: SourceTier | null;
  readonly url: string;
  readonly platform: string | null;
}

export interface LotDetail {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly lotNumber: string | null;
  readonly brand: string | null;
  readonly model: string | null;
  readonly condition: string | null;
  readonly url: string | null;
  readonly startingBidCents: number | null;
  readonly currentBidCents: number | null;
  readonly nextBidCents: number | null;
  readonly estimateLowCents: number | null;
  readonly estimateHighCents: number | null;
  readonly soldPriceCents: number | null;
  readonly bidCount: number | null;
  readonly reserveMet: boolean | null;
  readonly closesAt: string | null;
  readonly closed: boolean;
  readonly pickupCity: string | null;
  readonly pickupState: string | null;
  readonly pickupPostalCode: string | null;
  /**
   * How the pickup point was found (0016); 'city' means distances to it are
   * approximate. Optional so LotDetail fixtures shaped before 0016 still type-check.
   */
  readonly pickupGeoSource?: PickupGeoSource | null;
  readonly ships: boolean;
  readonly imageUrls: readonly string[];
  readonly imageCount: number | null;
  readonly descriptionWords: number | null;
  readonly sleeperScore: number | null;
  readonly sleeperReasons: readonly SleeperReason[];
  readonly meta: LotMeta;
  readonly auction: LotAuction | null;
  readonly source: LotSource | null;
  readonly category: { readonly slug: string; readonly label: string } | null;
}

export interface SleeperReason {
  readonly code: string;
  readonly detail: string;
}

function obj(value: Json | null | undefined): Record<string, Json | undefined> | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function str(value: Json | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function readLotMeta(raw: Json | null | undefined): LotMeta {
  const meta = obj(raw);
  const inactivity = meta?.inactivityMinutes;
  const hasReserve = meta?.hasReserve;
  return {
    closeTimePrecise: readClosePrecise(meta?.closeTimePrecise),
    inactivityMinutes: typeof inactivity === 'number' && Number.isFinite(inactivity) && inactivity >= 0 ? inactivity : null,
    hasReserve: typeof hasReserve === 'boolean' ? hasReserve : null,
    feeNote: str(meta?.feeNote),
    terms: str(meta?.terms),
  };
}

/** lots.sleeper_reasons as written by compute_sleeper() (0006): [{code, detail, weight}]. */
export function readSleeperReasons(value: Json | null | undefined): SleeperReason[] {
  if (!Array.isArray(value)) return [];
  const out: SleeperReason[] = [];
  for (const item of value) {
    const o = obj(item);
    const code = str(o?.code);
    const detail = str(o?.detail);
    if (code && detail) out.push({ code, detail });
  }
  return out;
}

/** Listing photos in order: lot_images by position, then any urls only on the lot row. */
export function orderImages(
  images: readonly { url: string; position: number | null }[],
  imageUrls: readonly string[] | null,
  primary: string | null,
): string[] {
  const sorted = [...images].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((i) => i.url);
  const all = [...(primary ? [primary] : []), ...sorted, ...(imageUrls ?? [])];
  return [...new Set(all.filter((u) => /^https?:\/\//.test(u)))];
}

export async function getLotDetail(lotId: string): Promise<LotDetail | null> {
  const { data, error } = await db().from('lots').select(LOT_DETAIL_SELECT).eq('id', lotId).maybeSingle();
  if (error) throw toDataError(error, 'lot detail');
  if (!data) return null;
  const a = data.auction;
  const s = data.source;
  return {
    id: data.id,
    title: data.title,
    description: data.description,
    lotNumber: data.lot_number,
    brand: data.brand,
    model: data.model,
    condition: data.condition,
    url: data.url,
    startingBidCents: data.starting_bid_cents,
    currentBidCents: data.current_bid_cents,
    nextBidCents: data.next_bid_cents,
    estimateLowCents: data.estimate_low_cents,
    estimateHighCents: data.estimate_high_cents,
    soldPriceCents: data.sold_price_cents,
    bidCount: data.bid_count,
    reserveMet: data.reserve_met,
    closesAt: data.closes_at,
    closed: data.closed === true,
    pickupCity: data.pickup_city ?? a?.pickup_city ?? null,
    pickupState: data.pickup_state ?? a?.pickup_state ?? null,
    pickupPostalCode: data.pickup_postal_code ?? a?.pickup_postal_code ?? null,
    pickupGeoSource: data.pickup_geo_source ?? a?.pickup_geo_source ?? null,
    ships: data.ships === true,
    imageUrls: orderImages(data.images ?? [], data.image_urls, data.primary_image_url),
    imageCount: data.image_count,
    descriptionWords: data.desc_richness,
    sleeperScore: data.sleeper_score,
    sleeperReasons: readSleeperReasons(data.sleeper_reasons),
    meta: readLotMeta(data.meta),
    auction: a
      ? {
          id: a.id,
          title: a.title,
          auctioneer: a.auctioneer,
          url: a.url,
          format: a.format,
          timezone: a.timezone,
          pickupLine1: a.pickup_line1,
          pickupCity: a.pickup_city,
          pickupState: a.pickup_state,
          pickupPostalCode: a.pickup_postal_code,
          pickupRequired: a.pickup_required,
          ships: a.ships,
          shipsNote: a.ships_note,
          sellerName: a.seller_name,
          buyerPremiumPct: a.buyer_premium_pct === null ? null : Number(a.buyer_premium_pct),
          buyerPremiumNote: a.buyer_premium_note,
          termsUrl: a.terms_url,
        }
      : null,
    source: s ? { id: s.id, name: s.name, tier: s.tier, url: s.url, platform: s.platform } : null,
    category: data.category ? { slug: data.category.slug, label: data.category.label } : null,
  };
}
