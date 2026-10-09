// GENERATED from packages/ingest/src/known.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * What the database already holds for one source, as public.crawl_known_state
 * (0055) returns it, read into the KnownState an adapter plans with.
 *
 * The function answers compact rows to keep the payload small (Hansen Auction
 * Group: ~4,800 open lots, ~190 KB):
 *
 *   { "lots":     [[external_id, auction_external_id, last_seen_ms, closes_ms], ...],
 *     "auctions": [[external_id, items_read_ms, items_read_count], ...] }
 *
 * Times are milliseconds since the epoch; a missing value is null. A row that
 * does not have this shape is dropped, never guessed at: an adapter missing a
 * lot only refreshes it later, while a wrong lot would be refreshed wrongly.
 */
import type { KnownAuction, KnownLot, KnownState } from './types.ts';

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const ms = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseKnownState(data: unknown): KnownState | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const { lots, auctions } = data as { lots?: unknown; auctions?: unknown };
  if (!Array.isArray(lots) || !Array.isArray(auctions)) return null;

  const outLots: KnownLot[] = [];
  for (const row of lots) {
    if (!Array.isArray(row)) continue;
    const externalId = text(row[0]);
    const lastSeenAt = ms(row[2]);
    if (!externalId || lastSeenAt === null) continue;
    outLots.push({ externalId, auctionExternalId: text(row[1]), lastSeenAt, closesAt: ms(row[3]) });
  }

  const outAuctions: KnownAuction[] = [];
  for (const row of auctions) {
    if (!Array.isArray(row)) continue;
    const externalId = text(row[0]);
    if (!externalId) continue;
    const count = ms(row[2]);
    outAuctions.push({
      externalId,
      itemsReadAt: ms(row[1]),
      itemsReadCount: count === null ? null : Math.trunc(count),
    });
  }
  return { lots: outLots, auctions: outAuctions };
}
