import { recommend } from '@platform/strategy';
import { describe, expect, it } from 'vitest';
import { buildLotContext, NO_INPUTS, type LotFacts } from './lotContext';

const NOW = new Date('2026-09-29T17:00:00Z');

/** A GSA-style generator lot: date-only close, no published premium, pickup only. */
const facts: LotFacts = {
  currentBidCents: 31000,
  nextBidCents: 32000,
  startingBidCents: null,
  bidCount: 6,
  closesAt: '2026-10-03T03:59:59+00:00',
  closeTimePrecise: false,
  softCloseMinutes: 10,
  hasReserve: false,
  reserveMet: null,
  buyerPremiumPct: null,
  sleeperScore: 6,
  imageCount: 3,
  descriptionWords: 12,
  categorySlug: null,
  brand: 'Generac',
  model: 'GP7500E',
  condition: null,
  sourcePlatform: 'gsa',
  sourceTier: 'federal',
  auctionFormat: 'online',
  pickupRequired: true,
  ships: false,
};

const worth = (valueCents: number | null, cushionPct: number | null) =>
  buildLotContext(facts, 1.4, { estimatedResaleCents: null, estimatedValueCents: valueCents, targetMarginPct: cushionPct, userGoal: 'use' });

describe('"Count the cost" runs the engine’s personal-use arm', () => {
  it('passes "Worth to you" as the fixed-price alternative, with the use goal', () => {
    const ctx = worth(65000, 15);
    expect(ctx).toMatchObject({ userGoal: 'use', estimatedValueCents: 65000, estimatedResaleCents: null, targetMarginPct: 15, distanceMiles: 1.4 });
  });

  it('charges no resale costs, and the cushion is the only margin', () => {
    const plain = recommend(worth(65000, null), NOW).walkAway;
    expect(plain.status).toBe('ok');
    expect(plain.breakdown.userGoal).toBe('use');
    expect(plain.breakdown.expectedResaleCents).toBe(65000);
    expect(plain.breakdown.sellFeesCents).toBe(0);
    expect(plain.breakdown.outboundShipCents).toBe(0);
    expect(plain.breakdown.profitTargetCents).toBe(0);
    expect(plain.breakdown.transportBasis).toBe('distance');
    expect((plain.hammerCeilingCents ?? 1) % 100).toBe(0); // "Walk away above" is whole dollars

    const cushioned = recommend(worth(65000, 15), NOW).walkAway;
    expect(cushioned.breakdown.profitTargetCents).toBe(9750);
    expect(cushioned.hammerCeilingCents ?? 0).toBeLessThan(plain.hammerCeilingCents ?? 0);
  });

  it('asks for the worth instead of inventing a number', () => {
    const rec = recommend(worth(null, null), NOW);
    expect(rec.walkAway.status).toBe('insufficient_data');
    expect(rec.walkAway.hammerCeilingCents).toBeNull();
  });

  it('leaves the resale path exactly as it was when no goal is given', () => {
    const ctx = buildLotContext(facts, 1.4, NO_INPUTS);
    expect(ctx).not.toHaveProperty('userGoal');
    expect(ctx).not.toHaveProperty('estimatedValueCents');
  });
});
