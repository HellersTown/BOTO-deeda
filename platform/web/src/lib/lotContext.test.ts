import { recommend } from '@platform/strategy';
import { describe, expect, it } from 'vitest';
import { readLotMeta, type LotDetail } from '../data/lots';
import type { WatchedLot } from '../data/watchlist';
import { buildLotContext, factsFromDetail, factsFromWatched, NO_INPUTS } from './lotContext';

const NOW = new Date('2026-09-29T17:00:00Z');

/** A GSA lot as getLotDetail() returns it: date-only close, 10-minute inactivity window, no premium row. */
const gsaLot: LotDetail = {
  id: 'lot-1',
  title: 'Dell Laptops',
  description: 'Qty 10 laptops',
  lotNumber: '001',
  brand: 'Dell',
  model: '5320',
  condition: null,
  url: 'https://www.gsaauctions.gov/auctions/preview/377882',
  startingBidCents: null,
  currentBidCents: 8500,
  nextBidCents: 9000,
  estimateLowCents: null,
  estimateHighCents: null,
  soldPriceCents: null,
  bidCount: 3,
  reserveMet: null,
  closesAt: '2026-10-03T03:59:59+00:00',
  closed: false,
  pickupCity: 'Milwaukee',
  pickupState: 'WI',
  pickupPostalCode: '53203',
  ships: false,
  imageUrls: ['https://example.gov/1.jpg'],
  imageCount: 1,
  descriptionWords: 8,
  sleeperScore: 2.9,
  sleeperReasons: [],
  meta: readLotMeta({ closeTimePrecise: false, inactivityMinutes: 10, hasReserve: false, feeNote: null }),
  auction: {
    id: 'auction-1',
    title: 'GSA sale 91QSCI26123001',
    auctioneer: 'GSA',
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
    sellerName: 'GSA',
    buyerPremiumPct: null,
    buyerPremiumNote: null,
    termsUrl: null,
  },
  source: { id: 'source-1', name: 'GSA Auctions', tier: 'federal', url: 'https://gsaauctions.gov', platform: 'gsa' },
  category: null,
};

describe('building the LotContext from database rows', () => {
  it('maps lot, auction, source and raw._meta onto the engine fields', () => {
    const ctx = buildLotContext(factsFromDetail(gsaLot), 1.4, { estimatedResaleCents: 30000, targetMarginPct: 30 });
    expect(ctx).toMatchObject({
      currentBidCents: 8500,
      nextBidCents: 9000,
      startingBidCents: null,
      bidCount: 3,
      closesAt: '2026-10-03T03:59:59+00:00',
      closeTimePrecise: false,
      softCloseMinutes: 10,
      hasReserve: false,
      buyerPremiumPct: null,
      imageCount: 1,
      descriptionWords: 8,
      sleeperScore: 2.9,
      brand: 'Dell',
      model: '5320',
      sourcePlatform: 'gsa',
      sourceTier: 'federal',
      auctionFormat: 'online',
      pickupRequired: true,
      distanceMiles: 1.4,
      ships: false,
      estimatedResaleCents: 30000,
      targetMarginPct: 30,
    });
  });

  it('gives the engine an input it accepts, and the engine refuses a countdown for a date-only close', () => {
    const ctx = buildLotContext(factsFromDetail(gsaLot), 1.4, { estimatedResaleCents: 30000, targetMarginPct: null });
    const rec = recommend(ctx, NOW);
    expect(rec.status).not.toBe('invalid_input');
    expect(rec.walkAway.errors).toEqual([]);
    expect(rec.timing?.countdown).toBe(false);
    expect(rec.walkAway.hammerCeilingCents).not.toBeNull();
    expect((rec.walkAway.hammerCeilingCents ?? 1) % 100).toBe(0); // whole dollars
    // GSA publishes no premium: the engine uses its platform default, not an assumption.
    expect(rec.walkAway.rates.buyerPremiumPct).toBe(0);
  });

  it('asks for a value instead of inventing a walk-away number', () => {
    const rec = recommend(buildLotContext(factsFromDetail(gsaLot), 1.4, NO_INPUTS), NOW);
    expect(rec.walkAway.status).toBe('insufficient_data');
    expect(rec.walkAway.hammerCeilingCents).toBeNull();
    expect(rec.walkAway.maxBidCents).toBeNull();
  });

  it('drops values the engine would reject, rather than failing the whole lot', () => {
    const ctx = buildLotContext(
      { ...factsFromDetail(gsaLot), currentBidCents: -5, buyerPremiumPct: 250, sleeperScore: 12, bidCount: 2.5 },
      Number.NaN,
      { estimatedResaleCents: 10.5, targetMarginPct: -1 },
    );
    expect(ctx.currentBidCents).toBeNull();
    expect(ctx.buyerPremiumPct).toBeNull();
    expect(ctx.sleeperScore).toBe(10);
    expect(ctx.bidCount).toBeNull();
    expect(ctx.distanceMiles).toBeNull();
    expect(ctx.estimatedResaleCents).toBeNull();
    expect(ctx.targetMarginPct).toBeNull();
    expect(recommend(ctx, NOW).status).not.toBe('invalid_input');
  });

  it('reads the same facts from a watchlist row', () => {
    const watched: WatchedLot = {
      id: 'lot-1',
      title: 'Dell Laptops',
      url: gsaLot.url,
      imageUrl: null,
      currentBidCents: 8500,
      nextBidCents: 9000,
      startingBidCents: null,
      bidCount: 3,
      soldPriceCents: null,
      reserveMet: null,
      closesAt: gsaLot.closesAt,
      closed: false,
      city: 'Milwaukee',
      state: 'WI',
      postalCode: '53203',
      ships: false,
      imageCount: 1,
      descriptionWords: 8,
      sleeperScore: 2.9,
      brand: 'Dell',
      model: '5320',
      condition: null,
      meta: { closeTimePrecise: 'false', inactivityMinutes: 10, hasReserve: false },
      sourceName: 'GSA Auctions',
      sourceTier: 'federal',
      sourcePlatform: 'gsa',
      categorySlug: null,
      auctionId: 'auction-1',
      timeZone: 'America/New_York',
      auctionFormat: 'online',
      pickupRequired: true,
      buyerPremiumPct: null,
    };
    expect(buildLotContext(factsFromWatched(watched), 1.4)).toEqual(buildLotContext(factsFromDetail(gsaLot), 1.4));
  });
});
