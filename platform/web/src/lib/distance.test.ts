import { describe, expect, it } from 'vitest';
import { fromEmbeddedLot, fromSearchRow } from '../data/lotSummary';
import type { SearchLotRow } from '../data/database.types';
import { distanceFrom, distanceTag, distanceWords, formatMiles, isApproximateGeo } from './distance';

describe('distances measured to a city centroid are shown as approximate (0016, 0018)', () => {
  it('marks only pickup_geo_source "city" as approximate', () => {
    expect(isApproximateGeo('city')).toBe(true);
    expect(isApproximateGeo('postal_code')).toBe(false);
    expect(isApproximateGeo('source')).toBe(false);
    expect(isApproximateGeo(null)).toBe(false);
    expect(isApproximateGeo(undefined)).toBe(false);
  });

  it('writes the card tag in mono caps, with ≈ and whole miles when approximate', () => {
    expect(distanceTag(1.4)).toBe('1.4 MI');
    expect(distanceTag(18.3)).toBe('18 MI');
    expect(distanceTag(18.3, true)).toBe('≈ 18 MI');
    expect(distanceTag(1.4, true)).toBe('≈ 1 MI');
    expect(distanceTag(0.2, true)).toBe('≈ 1 MI');
    expect(distanceTag(1204.4, true)).toBe('≈ 1,204 MI');
  });

  it('says it in words on the lot page: "about 18 mi from 53202"', () => {
    expect(distanceFrom(18.3, true, '53202')).toBe('about 18 mi from 53202');
    expect(distanceFrom(1.4, false, '53202')).toBe('1.4 mi from 53202');
    expect(distanceWords(18.3, true)).toBe('about 18 mi');
    expect(distanceWords(18.3, false)).toBe(formatMiles(18.3));
  });

  it('carries the flag from search rows and hunt matches onto the card', () => {
    const row = {
      lot_id: 'l1',
      title: 'Chest freezer',
      lot_number: null,
      url: null,
      primary_image_url: null,
      image_count: 0,
      current_bid_cents: 6000,
      next_bid_cents: null,
      estimate_low_cents: null,
      bid_count: 2,
      closes_at: null,
      auction_title: null,
      auctioneer: null,
      source_name: 'Municibid',
      source_tier: 'municipal',
      pickup_city: 'Waukesha',
      pickup_state: 'WI',
      pickup_postal_code: null,
      ships: false,
      distance_miles: 18.3,
      sleeper_score: null,
      sleeper_reasons: null,
      relevance: 1,
      match_basis: 'nearby',
      pickup_geo_source: 'city',
    } satisfies SearchLotRow;
    expect(fromSearchRow(row, undefined).distanceApprox).toBe(true);
    expect(fromSearchRow({ ...row, pickup_geo_source: 'postal_code' }, undefined).distanceApprox).toBe(false);
    const { pickup_geo_source: _omitted, ...before0018 } = row;
    expect(fromSearchRow(before0018, undefined).distanceApprox).toBe(false);

    const embedded = {
      id: 'l1',
      title: 'Chest freezer',
      url: null,
      primary_image_url: null,
      current_bid_cents: 6000,
      next_bid_cents: null,
      bid_count: 2,
      closes_at: null,
      closed: false,
      pickup_city: 'Waukesha',
      pickup_state: 'WI',
      pickup_postal_code: null,
      ships: false,
      sleeper_score: null,
      precise: null,
      source: { name: 'Municibid', tier: 'municipal' as const },
      auction: null,
    };
    expect(fromEmbeddedLot({ ...embedded, pickup_geo_source: 'city' }, 18.3).distanceApprox).toBe(true);
    expect(fromEmbeddedLot(embedded, 18.3).distanceApprox).toBe(false);
  });
});
