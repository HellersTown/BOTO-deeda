import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it } from 'vitest';
import type { SearchLotRow } from '../data/database.types';
import { fromEmbeddedLot, fromSearchRow, type LotSummary } from '../data/lotSummary';
import { LotCard } from './LotCard';

// Wed 30 Sep 2026, 2:00 PM in Chicago.
const NOW = new Date('2026-09-30T19:00:00Z');

function render(lot: LotSummary, footer?: ReactElement): string {
  return renderToStaticMarkup(
    <StaticRouter location="/?q=tractor">
      <LotCard lot={lot} now={NOW} from="/?q=tractor" footer={footer} />
    </StaticRouter>,
  );
}

/** What the card says, tags dropped. */
const said = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** AuctionGuide's "Farm and tool auction, 421 lots, Greenleaf WI, ends today" (0023). */
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

/** A GSA generator lot: a price, bids, a sleeper score and a date-only close. */
const lotRow: SearchLotRow = {
  lot_id: 'a1',
  title: 'Generac 7,500 W portable generator',
  lot_number: '012',
  url: 'https://www.gsaauctions.gov/auctions/preview/377882',
  primary_image_url: 'https://img.example/gen.jpg',
  image_count: 3,
  current_bid_cents: 31000,
  next_bid_cents: 32000,
  estimate_low_cents: null,
  bid_count: 6,
  closes_at: '2026-10-03T03:59:59+00:00',
  auction_title: 'GSA sale',
  auctioneer: 'GSA',
  source_name: 'GSA Auctions',
  source_tier: 'federal',
  pickup_city: 'Milwaukee',
  pickup_state: 'WI',
  pickup_postal_code: '53203',
  ships: false,
  distance_miles: 1.4,
  sleeper_score: 6.2,
  sleeper_reasons: [],
  relevance: 1.9,
  match_basis: 'nearby',
  pickup_geo_source: 'postal_code',
  sale_level: false,
  sale_lot_count: 12,
};

describe('a sale-level row in search is a sale card', () => {
  const html = render(fromSearchRow(saleRow, { precise: true, timeZone: 'America/Chicago' }));
  const text = said(html);

  it('says "Sale · 421 lots" and shows no price tag, bid count or "count the cost"', () => {
    expect(html).toContain('lot-card--sale');
    expect(text).toContain('Sale · 421 lots');
    expect(html).not.toContain('price-tag');
    expect(text).not.toMatch(/\$\d|\bbids?\b|Opens at|No price listed|Worth the trip|count the cost/i);
  });

  it('gives the title, the close in local time, the place and distance, and the auctioneer', () => {
    expect(html).toContain('<h2 class="lot-card__title">Farm and tool auction</h2>');
    // A time of day in the viewer's zone ("Closes today, 7:00 PM" in Chicago), never a countdown.
    expect(text).toMatch(/Closes (today|tomorrow), \d{1,2}:\d{2} [AP]M/);
    expect(text).not.toContain('Closes in');
    // Measured to Greenleaf's centre (0016), so approximate: "≈ 97 MI" on the tag, "about 97 mi" when read aloud.
    expect(text).toContain('≈ 97 MI');
    expect(text).toContain('about 97 mi');
    expect(text).toContain('Greenleaf, WI');
    expect(text).not.toContain('pickup');
    expect(text).toContain('Greenleaf Auction Service');
  });

  it('opens the lot page from the whole card, as other cards do', () => {
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<article class="lot-card lot-card--sale lot-card--auto"><a class="lot-card__link" href="\/lot\/s1">/);
    expect(html).toMatch(/<\/div><\/a><\/article>$/);
  });

  it('says just "Sale" when the lot count is not known, and names the source when the auctioneer is not', () => {
    const t = said(render(fromSearchRow({ ...saleRow, sale_lot_count: null, auctioneer: null }, undefined)));
    expect(t).toMatch(/\bSale\b/);
    expect(t).not.toMatch(/Sale ·|\blots?\b/);
    expect(t).toContain('AuctionGuide');
  });

  it('is the same card among a hunt’s matches, with the match’s own actions', () => {
    const match = fromEmbeddedLot(
      {
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
        pickup_geo_source: 'city',
        sale_level: true,
        precise: null,
        source: { name: 'AuctionGuide', tier: 'private' },
        auction: { timezone: 'America/Chicago', pickup_postal_code: null, auctioneer: 'Greenleaf Auction Service', lot_count: 421 },
      },
      97.4,
      'nearby',
    );
    const html = render(match, <button type="button">Dismiss</button>);
    expect(said(html)).toContain('Sale · 421 lots');
    expect(html).not.toContain('price-tag');
    expect(html).toContain('<div class="lot-card__actions"><button type="button">Dismiss</button></div>');
  });
});

describe('a normal lot card is unchanged', () => {
  const html = render(fromSearchRow(lotRow, { precise: false, timeZone: 'America/New_York' }));
  const text = said(html);

  it('keeps its price tag, "Worth the trip", pickup line and date-only close', () => {
    expect(html).toContain('<span class="price-tag price-tag--md">$310</span>');
    expect(text).toContain('Worth the trip');
    expect(text).toContain('Milwaukee, WI · pickup');
    expect(text).toContain('1.4 MI');
    expect(text).toContain('Closes Oct 2 · time not published');
    expect(text).toContain('GSA Auctions');
    expect(html).toMatch(/^<article class="lot-card lot-card--auto"><a class="lot-card__link" href="\/lot\/a1">/);
  });

  it('draws nothing of a sale, whatever its auction’s lot count', () => {
    expect(html).not.toMatch(/sale-tag|lot-card--sale/);
    expect(text).not.toContain('Sale');
    expect(render(fromSearchRow({ ...lotRow, sale_lot_count: null }, { precise: false, timeZone: 'America/New_York' }))).toBe(html);
  });

  it('still shows the opening bid, or says there is no price', () => {
    expect(said(render(fromSearchRow({ ...lotRow, current_bid_cents: null }, undefined)))).toContain('Opens at $320');
    expect(said(render(fromSearchRow({ ...lotRow, current_bid_cents: null, next_bid_cents: null }, undefined)))).toContain('No price listed');
  });
});
