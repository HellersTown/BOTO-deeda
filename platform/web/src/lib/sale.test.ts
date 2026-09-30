import { describe, expect, it } from 'vitest';
import type { SearchLotRow } from '../data/database.types';
import { fromEmbeddedLot, fromSearchRow } from '../data/lotSummary';
import { describeCloseLocal } from './dates';
import { wonForPickup } from './pickup';
import { watchlistFullMessage } from './plans';
import { resultsText, salePlace, saleLotsText, tallyRows } from './sale';
import { saleSortNote } from './searchParams';

const CHICAGO = 'America/Chicago';
// Wed 30 Sep 2026, 2:00 PM in Chicago (CDT, UTC-5).
const NOW = new Date('2026-09-30T19:00:00Z');

/** AuctionGuide's "Farm and tool auction, 421 lots, Greenleaf WI, ends today", as search_lots returns it (0023). */
const saleRow: SearchLotRow = {
  lot_id: 's1',
  title: 'Farm and tool auction',
  lot_number: null,
  url: 'https://www.auctionguide.com/auction/farm-and-tool-auction',
  primary_image_url: null,
  image_count: 0,
  current_bid_cents: null,
  next_bid_cents: null,
  estimate_low_cents: null,
  bid_count: null,
  closes_at: '2026-10-01T00:00:00+00:00',
  auction_title: 'Farm and tool auction',
  auctioneer: 'Greenleaf Auction Service',
  source_name: 'AuctionGuide',
  source_tier: 'private',
  pickup_city: 'Greenleaf',
  pickup_state: 'WI',
  pickup_postal_code: null,
  ships: false,
  distance_miles: 97.4,
  sleeper_score: null,
  sleeper_reasons: null,
  relevance: 1.1,
  match_basis: 'nearby',
  pickup_geo_source: 'city',
  sale_level: true,
  sale_lot_count: 421,
};

describe('sale-level rows (0023)', () => {
  it('say "Sale · {n} lots", and just "Sale" when the count is not known', () => {
    expect(saleLotsText(421)).toBe('Sale · 421 lots');
    expect(saleLotsText(1)).toBe('Sale · 1 lot');
    expect(saleLotsText(1204)).toBe('Sale · 1,204 lots');
    expect(saleLotsText(null)).toBe('Sale');
    expect(saleLotsText(undefined)).toBe('Sale');
    expect(saleLotsText(0)).toBe('Sale');
  });

  it('name the place from the row alone', () => {
    expect(salePlace('Greenleaf', 'WI')).toBe('Greenleaf, WI');
    expect(salePlace(null, 'WI')).toBe('WI');
    expect(salePlace(' ', null)).toBeNull();
  });

  it('carry sale_level, the lot count and the auctioneer onto the card', () => {
    const s = fromSearchRow(saleRow, { precise: true, timeZone: CHICAGO });
    expect(s).toMatchObject({
      saleLevel: true,
      saleLotCount: 421,
      auctioneer: 'Greenleaf Auction Service',
      currentBidCents: null,
      nextBidCents: null,
      bidCount: null,
      sleeperScore: null,
      distanceApprox: true,
    });
    // A normal lot's sale_lot_count is its auction's lot count; it stays a lot.
    expect(fromSearchRow({ ...saleRow, sale_level: false, current_bid_cents: 31000 }, undefined).saleLevel).toBe(false);
    // Rows shaped before 0023 have no sale_level: they are lots.
    const { sale_level: _s, sale_lot_count: _c, ...before0023 } = saleRow;
    expect(fromSearchRow(before0023 as SearchLotRow, undefined)).toMatchObject({ saleLevel: false, saleLotCount: null });
  });

  it('carry the same onto a hunt match', () => {
    const embedded = {
      id: 's1',
      title: 'Farm and tool auction',
      url: saleRow.url,
      primary_image_url: null,
      current_bid_cents: null,
      next_bid_cents: null,
      bid_count: null,
      closes_at: saleRow.closes_at,
      closed: false,
      pickup_city: 'Greenleaf',
      pickup_state: 'WI',
      pickup_postal_code: null,
      ships: false,
      sleeper_score: null,
      precise: null,
      source: { name: 'AuctionGuide', tier: 'private' as const },
    };
    const auction = { timezone: CHICAGO, pickup_postal_code: null, auctioneer: 'Greenleaf Auction Service', lot_count: 421 };
    expect(fromEmbeddedLot({ ...embedded, sale_level: true, auction }, 97.4)).toMatchObject({
      saleLevel: true,
      saleLotCount: 421,
      auctioneer: 'Greenleaf Auction Service',
    });
    expect(fromEmbeddedLot({ ...embedded, auction: null }).saleLevel).toBe(false);
  });
});

describe('a sale card states the close in local time, never counting down', () => {
  const at = (closesAt: string, precision: 'precise' | 'date_only' | 'unknown' = 'precise') =>
    describeCloseLocal({ closesAt, precision, timeZone: CHICAGO }, NOW, CHICAGO);

  it('today, tomorrow, then the weekday and date', () => {
    expect(at('2026-10-01T00:00:00Z')).toMatchObject({ text: 'Closes today, 7:00 PM', tone: 'normal', countdown: false });
    expect(at('2026-10-01T15:00:00Z').text).toBe('Closes tomorrow, 10:00 AM');
    expect(at('2026-10-02T23:00:00Z').text).toBe('Closes Fri, Oct 2, 6:00 PM');
  });

  it('marks the last hour, and a passed close', () => {
    expect(at('2026-09-30T19:40:00Z')).toMatchObject({ text: 'Closes today, 2:40 PM', tone: 'urgent' });
    expect(at('2026-09-30T18:00:00Z')).toMatchObject({ text: 'Close time has passed', tone: 'muted' });
  });

  it('keeps the date-only rule: no time of day, the date in the auction zone', () => {
    expect(at('2026-10-01T04:59:59Z', 'date_only')).toMatchObject({ text: 'Closes Sep 30 · time not published', tone: 'notice' });
    expect(at('2026-10-01T00:00:00Z', 'unknown').text).toBe('Closes Sep 30');
  });

  it('says "tomorrow" by the calendar, even the night the clocks go forward', () => {
    // Sat 7 Mar 2026, 11:30 PM in Chicago. Sunday is 23 hours long, so 24 hours on is already Monday.
    const late = new Date('2026-03-08T05:30:00Z');
    const label = describeCloseLocal({ closesAt: '2026-03-09T00:00:00Z', precision: 'precise', timeZone: CHICAGO }, late, CHICAGO);
    expect(label.text).toBe('Closes tomorrow, 7:00 PM');
  });
});

describe('what assumes a price leaves sales out', () => {
  it('says where sales go under the price and score sorts', () => {
    expect(saleSortNote('cheapest', true)).toBe('Sales have no price, so they come after the lots.');
    expect(saleSortNote('sleeper', true)).toBe('Sales have no score, so they come after the lots.');
    expect(saleSortNote('cheapest', false)).toBeNull();
    expect(saleSortNote('relevance', true)).toBeNull();
    expect(saleSortNote('closing', true)).toBeNull();
  });

  it('puts a sale on the pickup run only once it is marked won', () => {
    const entry = (outcome: string | null, lot: { id: string; saleLevel?: boolean } | null) => ({ watch: { outcome }, lot });
    const run = wonForPickup([
      entry(null, { id: 'sale-watched', saleLevel: true }),
      entry('won', { id: 'sale-won', saleLevel: true }),
      entry('passed', { id: 'sale-passed', saleLevel: true }),
      entry('won', { id: 'lot-won' }),
      entry(null, { id: 'lot-watched' }),
      entry('won', null),
    ]);
    expect(run.map((l) => l.id)).toEqual(['sale-won', 'lot-won']);
  });

  it('watching a sale meets the same plan cap, in its own words', () => {
    const full = { tier: 'free' as const, max_watchlist: 25, watchlist_count: 25 };
    expect(watchlistFullMessage(full, 'sale')).toBe(
      'Your Traveler plan holds 25 watched lots, and all are in use. Remove one in Bids to watch this sale.',
    );
    expect(watchlistFullMessage({ ...full, watchlist_count: 24 }, 'sale')).toBeNull();
    expect(watchlistFullMessage(null, 'lot')).toBeNull();
  });
});

describe('result counts name sales apart from lots', () => {
  it('says lots, sales, or both', () => {
    expect(resultsText(0, 0)).toBe('0 lots');
    expect(resultsText(1, 0)).toBe('1 lot');
    expect(resultsText(12, 0)).toBe('12 lots');
    expect(resultsText(0, 1)).toBe('1 sale');
    expect(resultsText(0, 31)).toBe('31 sales');
    expect(resultsText(12, 3)).toBe('12 lots and 3 sales');
    expect(resultsText(1, 1)).toBe('1 lot and 1 sale');
  });

  it('counts sale-level rows as sales', () => {
    const lot = { sale_level: false };
    const sale = { sale_level: true };
    expect(tallyRows([lot, lot, sale])).toBe('2 lots and 1 sale');
    expect(tallyRows([sale])).toBe('1 sale');
    expect(tallyRows([{ sale_level: null }, {}])).toBe('2 lots');
    expect(tallyRows([saleRow])).toBe('1 sale');
  });
});
