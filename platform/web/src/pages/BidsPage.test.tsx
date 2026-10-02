import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import type { WatchlistRow } from '../data/database.types';
import type { WatchedLot } from '../data/watchlist';
import { WatchCard } from './BidsPage';

// Wed 30 Sep 2026, 2:00 PM in Chicago.
const NOW = new Date('2026-09-30T19:00:00Z');

const watchRow = (extra: Partial<WatchlistRow> = {}): WatchlistRow => ({
  id: 1,
  user_id: 'u1',
  lot_id: 's1',
  max_bid_cents: null,
  notes: null,
  remind_seconds_before: 600,
  reminded_at: null,
  placed_bid: false,
  placed_bid_cents: null,
  outcome: null,
  created_at: '2026-09-30T12:00:00Z',
  ...extra,
});

/** A watched sale-level row (0023): no price, no bids, no score. */
const sale: WatchedLot = {
  id: 's1',
  title: 'Farm and tool auction',
  url: 'https://www.auctionguide.com/auction/farm-and-tool-auction',
  imageUrl: null,
  currentBidCents: null,
  nextBidCents: null,
  startingBidCents: null,
  bidCount: null,
  soldPriceCents: null,
  reserveMet: null,
  closesAt: '2026-10-01T00:00:00+00:00',
  closed: false,
  city: 'Greenleaf',
  state: 'WI',
  postalCode: null,
  ships: false,
  imageCount: 0,
  descriptionWords: 14,
  sleeperScore: null,
  brand: null,
  model: null,
  condition: null,
  meta: { closeTimePrecise: true },
  sourceName: 'AuctionGuide',
  sourceTier: 'private',
  sourcePlatform: 'auctionguide',
  categorySlug: null,
  auctionId: 'au-s1',
  timeZone: 'America/Chicago',
  auctionFormat: 'online',
  pickupRequired: null,
  buyerPremiumPct: null,
  sellerName: 'Greenleaf Auction Service',
  saleLevel: true,
  saleLotCount: 421,
};

const lot: WatchedLot = {
  ...sale,
  id: 'a1',
  title: 'Generac 7,500 W portable generator',
  url: 'https://www.gsaauctions.gov/auctions/preview/377882',
  currentBidCents: 31000,
  bidCount: 6,
  sourceName: 'GSA Auctions',
  sourceTier: 'federal',
  sellerName: 'GSA, Chicago office',
  city: 'Milwaukee',
  saleLevel: false,
  saleLotCount: 12,
};

function card(watched: WatchedLot, watch: WatchlistRow): string {
  return renderToStaticMarkup(
    <StaticRouter location="/bids">
      <WatchCard entry={{ watch, lot: watched }} now={NOW} onUpdate={async () => {}} onRemove={async () => {}} />
    </StaticRouter>,
  );
}

const said = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('Bids shows a watched sale as a sale, not a bid', () => {
  it('has the sale’s tag, close and reminder, and no bid figures or bid buttons', () => {
    const html = card(sale, watchRow());
    const text = said(html);
    expect(text).toContain('Sale · 421 lots');
    expect(text).toContain('Greenleaf Auction Service · Greenleaf, WI');
    expect(text).toMatch(/Closes (today|tomorrow), \d{1,2}:\d{2} [AP]M/);
    expect(text).toContain('Reminder');
    expect(text).not.toMatch(/\bNow\b|Walk-away|Set it|Your bid|I placed my bid|\$\d|—/);
    expect(html).not.toContain('price-tag');
  });

  it('opens the sale on the source, safely and with an accessible name', () => {
    const html = card(sale, watchRow());
    const open = html.match(/<a class="btn btn--outline btn--block" href="([^"]+)" target="_blank" rel="noopener noreferrer">(.*?)<\/a>/);
    expect(open?.[1]).toBe(sale.url);
    expect(said(open?.[2] ?? '')).toBe('Open the sale on AuctionGuide (opens in a new tab)');
  });

  it('asks how it went once it closes, so a won sale can join the pickup run', () => {
    const text = said(card({ ...sale, closed: true }, watchRow()));
    expect(text).toContain('Closed. How did it go?');
    expect(text).toContain('Sale · 421 lots');
    expect(text).not.toMatch(/Final|Walk-away|Open the sale/);
  });

  it('leaves a watched lot as it was', () => {
    const text = said(card(lot, watchRow({ lot_id: 'a1', max_bid_cents: 47000 })));
    expect(text).toMatch(/Now \$310 Walk-away \$470 Reminder/);
    expect(text).toContain('I placed my bid');
    expect(text).toContain('GSA Auctions · Milwaukee, WI');
    expect(text).not.toMatch(/Sale ·|Open the sale/);
  });
});
