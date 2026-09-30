import { computeMaxBid, type LotContext } from '@platform/strategy';
import { describe, expect, it } from 'vitest';
import { summarizeExposure, walkAwayAtHammer, wholeDollarAtLeast } from './exposure';

/**
 * The strategy package's own fixture lot (test/fixtures.ts): a HiBid tool lot,
 * 15% premium, 5.5% tax, 3% card fee default, 5 miles away.
 * k = 1.2496475, T = 2 x 5 x 70 + 2500 = 3200.
 */
const hibidLot: LotContext = {
  sourcePlatform: 'hibid',
  category: 'tools',
  currentBidCents: 2000,
  bidCount: 3,
  closesAt: '2026-09-28T04:00:00Z',
  softCloseMinutes: 3,
  buyerPremiumPct: 15,
  imageCount: 6,
  descriptionWords: 40,
  distanceMiles: 5,
  pickupRequired: true,
  hasReserve: false,
};

describe('pricing a committed number with the engine', () => {
  it('reproduces the engine invoice at the same hammer', () => {
    // The engine's own S19 test: a $70 max bid invoices at $87.48.
    const fromResale = computeMaxBid({ ...hibidLot, estimatedResaleCents: 30000 });
    expect(fromResale.maxBidCents).toBe(7000);
    const atHammer = walkAwayAtHammer(hibidLot, 7000);
    expect(atHammer?.status).toBe('ok');
    expect(atHammer?.maxBidCents).toBe(7000);
    expect(atHammer?.invoiceAtMaxBid).toEqual(fromResale.invoiceAtMaxBid);
    expect(atHammer?.invoiceAtMaxBid?.totalCents).toBe(8748);
    expect(atHammer?.breakdown.transportCents).toBe(3200);
  });

  it('prices a bid with cents at the next whole dollar, never below it', () => {
    expect(wholeDollarAtLeast(8750)).toBe(8800);
    expect(wholeDollarAtLeast(8800)).toBe(8800);
    expect(walkAwayAtHammer(hibidLot, 8750)?.maxBidCents).toBe(8800);
  });

  it('finds a lot whose next bid is already above the number to be no live bid', () => {
    const r = walkAwayAtHammer({ ...hibidLot, currentBidCents: 9000 }, 7000);
    expect(r?.status).toBe('walk_away');
    expect(r?.invoiceAtMaxBid).toBeNull();
  });

  it('returns null for nothing to price', () => {
    expect(walkAwayAtHammer(hibidLot, 0)).toBeNull();
    expect(walkAwayAtHammer(hibidLot, -100)).toBeNull();
    expect(walkAwayAtHammer({ ...hibidLot, currentBidCents: -1 }, 7000)).toBeNull();
  });
});

describe('portfolio exposure', () => {
  it('sums the invoices and charges one trip per pickup site', () => {
    const shared = summarizeExposure([
      { lotId: 'a', context: hibidLot, hammerCents: 7000, siteKey: 'auction-1' },
      { lotId: 'b', context: hibidLot, hammerCents: 10000, siteKey: 'auction-1' },
      { lotId: 'c', context: { ...hibidLot, currentBidCents: 9000 }, hammerCents: 7000, siteKey: 'auction-2' },
    ]);
    // $87.48 + $124.96 and one $32 trip: the engine's own S19 figures.
    expect(shared.result.exposureCents).toBe(8748 + 12496 + 3200);
    expect(shared.result.sites).toBe(1);
    expect(shared.live).toBe(2);
    expect(shared.outbid).toBe(1);

    const apart = summarizeExposure([
      { lotId: 'a', context: hibidLot, hammerCents: 7000, siteKey: null },
      { lotId: 'b', context: hibidLot, hammerCents: 10000, siteKey: null },
    ]);
    expect(apart.result.exposureCents).toBe(8748 + 12496 + 6400);
  });

  it('counts lots priced without a trip because their distance is unknown', () => {
    const s = summarizeExposure([{ lotId: 'a', context: { ...hibidLot, distanceMiles: null }, hammerCents: 7000, siteKey: null }]);
    expect(s.noTrip).toBe(1);
    expect(s.result.transportCents).toBe(0);
    expect(s.result.exposureCents).toBe(8748);
  });

  it('is zero with nothing to price', () => {
    expect(summarizeExposure([]).result.exposureCents).toBe(0);
  });
});
