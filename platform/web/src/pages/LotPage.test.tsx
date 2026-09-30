import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchlistRow } from '../data/database.types';
import { readLotMeta, type LotDetail } from '../data/lots';
import type { AsyncState } from '../hooks/useAsync';
import { LotDetailView } from './LotPage';

// Where the viewer sets out from; the page reads only the ZIP.
vi.mock('../providers/HomeProvider', () => ({
  useHome: () => ({ zip: '53202', radiusMiles: 60, place: null }),
}));

// Wed 30 Sep 2026, 2:00 PM in Chicago.
const NOW = new Date('2026-09-30T19:00:00Z');
const SALE_URL = 'https://www.auctionguide.com/auction/farm-and-tool-auction';

/** Not watched (or signed out): what LotPage passes before any watch exists. */
const notWatched: AsyncState<WatchlistRow | null> = { data: null, error: null, loading: false, reload: () => {}, setData: () => {} };

/** AuctionGuide's "Farm and tool auction, 421 lots, Greenleaf WI, ends today", as getLotDetail() returns it (0023). */
const sale: LotDetail = {
  id: 's1',
  title: 'Farm and tool auction',
  description: 'Snap-on and Matco tool boxes, woodworking.\nA Ford 8N tractor and a hay wagon.',
  lotNumber: null,
  brand: null,
  model: null,
  condition: null,
  url: SALE_URL,
  startingBidCents: null,
  currentBidCents: null,
  nextBidCents: null,
  estimateLowCents: null,
  estimateHighCents: null,
  soldPriceCents: null,
  bidCount: null,
  reserveMet: null,
  closesAt: '2026-10-01T00:00:00+00:00',
  closed: false,
  pickupCity: 'Greenleaf',
  pickupState: 'WI',
  pickupPostalCode: null,
  pickupGeoSource: 'city',
  ships: false,
  imageUrls: [],
  imageCount: 0,
  descriptionWords: 14,
  sleeperScore: null,
  sleeperReasons: [],
  meta: readLotMeta({ closeTimePrecise: true }),
  auction: {
    id: 'au-s1',
    title: 'Farm and tool auction',
    auctioneer: 'Greenleaf Auction Service',
    url: null,
    format: 'online',
    timezone: 'America/Chicago',
    pickupLine1: null,
    pickupCity: 'Greenleaf',
    pickupState: 'WI',
    pickupPostalCode: null,
    pickupRequired: null,
    ships: null,
    shipsNote: null,
    sellerName: null,
    buyerPremiumPct: null,
    buyerPremiumNote: null,
    termsUrl: null,
  },
  source: { id: 'src-ag', name: 'AuctionGuide', tier: 'private', url: 'https://www.auctionguide.com', platform: 'auctionguide' },
  category: null,
  saleLevel: true,
  saleLotCount: 421,
};

/** A GSA generator lot, shaped as before 0023 (no saleLevel): it is a lot. */
const lot: LotDetail = {
  id: 'a1',
  title: 'Generac 7,500 W portable generator',
  description: 'Generac GP7500E, runs, 7,500 running watts.',
  lotNumber: '012',
  brand: 'Generac',
  model: 'GP7500E',
  condition: null,
  url: 'https://www.gsaauctions.gov/auctions/preview/377882',
  startingBidCents: null,
  currentBidCents: 31000,
  nextBidCents: 32000,
  estimateLowCents: null,
  estimateHighCents: null,
  soldPriceCents: null,
  bidCount: 6,
  reserveMet: null,
  closesAt: '2026-10-03T03:59:59+00:00',
  closed: false,
  pickupCity: 'Milwaukee',
  pickupState: 'WI',
  pickupPostalCode: '53203',
  ships: false,
  imageUrls: ['https://img.example/gen.jpg'],
  imageCount: 1,
  descriptionWords: 12,
  sleeperScore: 6.2,
  sleeperReasons: [{ code: 'thin_description', detail: 'Only 12 words of description' }],
  meta: readLotMeta({ closeTimePrecise: false, inactivityMinutes: 10 }),
  auction: {
    id: 'au1',
    title: 'GSA sale 91QSCI26123001',
    auctioneer: 'GSA Region 5',
    url: null,
    format: 'online',
    timezone: 'America/New_York',
    pickupLine1: '310 W. Wisconsin Ave',
    pickupCity: 'Milwaukee',
    pickupState: 'WI',
    pickupPostalCode: '53203',
    pickupRequired: true,
    ships: false,
    shipsNote: null,
    sellerName: 'GSA, Chicago office',
    buyerPremiumPct: null,
    buyerPremiumNote: null,
    termsUrl: null,
  },
  source: { id: 's1', name: 'GSA Auctions', tier: 'federal', url: 'https://gsaauctions.gov', platform: 'gsa' },
  category: null,
};

function page(detail: LotDetail, distanceMiles: number | null, distanceApprox: boolean): string {
  return renderToStaticMarkup(
    <StaticRouter location={`/lot/${detail.id}`}>
      <LotDetailView detail={detail} distanceMiles={distanceMiles} distanceApprox={distanceApprox} from="/?q=tractor" watch={notWatched} />
    </StaticRouter>,
  );
}

/** What the page says, tags dropped. */
const said = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the lot page for a sale-level row', () => {
  it('opens the sale on the source: "Open the sale", new tab, noopener, with an accessible name', () => {
    const html = page(sale, 97.4, true);
    const open = html.match(/<a class="btn btn--primary btn--large" href="([^"]+)" target="_blank" rel="noopener noreferrer">(.*?)<\/a>/);
    expect(open).not.toBeNull();
    expect(open?.[1]).toBe(SALE_URL);
    // Visible "Open the sale"; read as "Open the sale on AuctionGuide (opens in a new tab)".
    expect(open?.[2]).toContain('<span>Open the sale</span>');
    expect(said(open?.[2] ?? '')).toBe('Open the sale on AuctionGuide (opens in a new tab)');
  });

  it('has no walk-away calculator, price, bid or plan', () => {
    const html = page(sale, 97.4, true);
    const text = said(html);
    expect(text).not.toMatch(/Count the cost|Worth to you|Cushion you keep|Walk away above|The plan for this lot/);
    expect(html).not.toMatch(/class="calc|class="plan|price-tag/);
    expect(text).not.toMatch(/\$\d|current bid|opening bid|No price listed|Bid on /);
  });

  it('shows the sale’s description, close, place and seller', () => {
    const text = said(page(sale, 97.4, true));
    expect(text).toContain('Farm and tool auction');
    expect(text).toContain('Sale · 421 lots');
    expect(text).toContain('In this sale');
    expect(text).toContain('Snap-on and Matco tool boxes, woodworking. A Ford 8N tractor and a hay wagon.');
    expect(text).toContain('From the listing on AuctionGuide.');
    expect(text).toMatch(/Closes \w+day, \w{3} \d{1,2} at \d{1,2}:\d{2} [AP]M/);
    expect(text).toContain('about 97 mi from 53202 · Greenleaf, WI');
    expect(text).toContain('Sold by Greenleaf Auction Service');
  });

  it('keeps Watch, which needs only the close', () => {
    const html = page(sale, 97.4, true);
    expect(html).toContain('href="/signin?next=%2Flot%2Fs1">Watch and remind me</a>');
    expect(said(html)).toContain('Watch it and we’ll remind you at');
  });

  it('says so when it has closed, or gives no description', () => {
    const text = said(page({ ...sale, closed: true, description: null }, null, false));
    expect(text).toContain('This sale has closed.');
    expect(text).toContain('The listing gives no description. Open the sale to see its lots.');
    expect(text).not.toContain('This lot has closed.');
  });
});

describe('the lot page for a normal lot is unchanged', () => {
  const html = () => page(lot, 1.4, false);

  it('keeps the price, the walk-away calculator, the plan and "Bid on"', () => {
    const text = said(html());
    expect(html()).toContain('<span class="price-tag price-tag--lg">$310</span>');
    expect(text).toContain('current bid · 6 bids');
    expect(text).toContain('Worth the trip');
    expect(text).toContain('Count the cost');
    expect(text).toContain('Worth to you');
    expect(text).toContain('The plan for this lot');
    expect(text).toContain('Bid on GSA Auctions (opens in a new tab)');
    expect(text).toContain('1.4 mi from 53202 · 310 W. Wisconsin Ave, Milwaukee, WI 53203');
    expect(text).toContain('Closes Friday, Oct 2. GSA Auctions publishes the date, not the hour, and a sale keeps extending while bids arrive.');
  });

  it('draws nothing of a sale', () => {
    expect(said(html())).not.toMatch(/Open the sale|In this sale|Sale ·/);
    expect(html()).not.toContain('sale-tag');
    expect(page({ ...lot, saleLevel: false, saleLotCount: 12 }, 1.4, false)).toBe(html());
  });
});
