import { describe, expect, it } from 'vitest';
import { classify, describeError, DataError, toDataError } from './errors';
import { fromEmbeddedLot, fromSearchRow } from './lotSummary';
import { orderImages, readLotMeta, readSleeperReasons } from './lots';
import { normalizeZip } from './postal';
import { summarizeCoverage } from './profile';
import { readClosePrecise } from './search';
import type { SearchLotRow } from './database.types';

describe('raw._meta', () => {
  it('reads closeTimePrecise the way 0013 does: only false means date-only', () => {
    expect(readClosePrecise(false)).toBe(false);
    expect(readClosePrecise('false')).toBe(false);
    expect(readClosePrecise(true)).toBe(true);
    expect(readClosePrecise(null)).toBe(true);
    expect(readClosePrecise(undefined)).toBe(true);
  });

  it('reads the GSA meta fields and ignores junk', () => {
    expect(readLotMeta({ closeTimePrecise: false, inactivityMinutes: 10, hasReserve: true, feeNote: 'Removal $500', terms: ' ' })).toEqual({
      closeTimePrecise: false,
      inactivityMinutes: 10,
      hasReserve: true,
      feeNote: 'Removal $500',
      terms: null,
    });
    expect(readLotMeta(null).closeTimePrecise).toBe(true);
    expect(readLotMeta({ inactivityMinutes: 'ten' }).inactivityMinutes).toBeNull();
  });

  it('keeps explainable sleeper reasons only', () => {
    expect(
      readSleeperReasons([
        { code: 'thin_description', detail: 'Only 4 words of description', weight: 0.6 },
        { code: 'broken' },
        'nonsense',
      ]),
    ).toEqual([{ code: 'thin_description', detail: 'Only 4 words of description' }]);
  });

  it('orders photos and drops duplicates and non-http urls', () => {
    expect(
      orderImages(
        [
          { url: 'https://x/2.jpg', position: 2 },
          { url: 'https://x/1.jpg', position: 1 },
        ],
        ['https://x/1.jpg', 'data:image/png;base64,AAAA'],
        'https://x/1.jpg',
      ),
    ).toEqual(['https://x/1.jpg', 'https://x/2.jpg']);
  });
});

describe('lot summaries', () => {
  const row: SearchLotRow = {
    lot_id: 'l1',
    title: 'Dell Laptops',
    lot_number: '7',
    url: 'https://example.gov/7',
    primary_image_url: null,
    image_count: 0,
    current_bid_cents: 8500,
    next_bid_cents: 9000,
    estimate_low_cents: null,
    bid_count: 3,
    closes_at: '2026-10-03T03:59:59+00:00',
    auction_title: null,
    auctioneer: null,
    source_name: 'GSA Auctions',
    source_tier: 'federal',
    pickup_city: 'Milwaukee',
    pickup_state: 'WI',
    pickup_postal_code: '53203',
    ships: false,
    distance_miles: 1.4,
    sleeper_score: 2.9,
    sleeper_reasons: null,
    relevance: 1.2,
    match_basis: 'nearby',
  };

  it('marks precision unknown until the close-info lookup answers', () => {
    expect(fromSearchRow(row, undefined).closePrecision).toBe('unknown');
    expect(fromSearchRow(row, { precise: false, timeZone: 'America/New_York' })).toMatchObject({
      closePrecision: 'date_only',
      timeZone: 'America/New_York',
      distanceMiles: 1.4,
      sourceTier: 'federal',
    });
  });

  it('maps an embedded lot', () => {
    const s = fromEmbeddedLot(
      {
        id: 'l1',
        title: 'Bus',
        url: null,
        primary_image_url: null,
        current_bid_cents: 100000,
        next_bid_cents: null,
        bid_count: 2,
        closes_at: null,
        closed: true,
        pickup_city: null,
        pickup_state: null,
        pickup_postal_code: null,
        ships: null,
        sleeper_score: null,
        precise: 'false',
        source: { name: 'GSA Auctions', tier: 'federal' },
        auction: { timezone: 'America/Chicago', pickup_postal_code: '53295' },
      },
      12.5,
      'nearby',
    );
    expect(s).toMatchObject({ closed: true, closePrecision: 'date_only', postalCode: '53295', distanceMiles: 12.5, ships: false });
  });
});

describe('small mappings', () => {
  it('normalizes ZIPs', () => {
    expect(normalizeZip(' 53202 ')).toBe('53202');
    expect(normalizeZip('53202-1234')).toBe('53202');
    expect(normalizeZip('5320')).toBeNull();
    expect(normalizeZip('abcde')).toBeNull();
  });

  it('counts source coverage from v_source_status', () => {
    const rows = [
      { access_status: 'open' as const },
      { access_status: 'open' as const },
      { access_status: 'blocked' as const },
      { access_status: null },
      { access_status: 'robots_disallowed' as const },
    ];
    expect(summarizeCoverage(rows)).toEqual({ total: 5, open: 2, blocked: 1, other: 2 });
  });

  it('classifies backend errors', () => {
    expect(classify({ code: '23514', message: 'Hunt limit reached for the free tier (3 active hunts). Pause one, or upgrade.' })).toBe(
      'hunt_limit',
    );
    expect(classify({ message: 'TypeError: Failed to fetch' })).toBe('network');
    expect(classify({ code: 'PGRST301', message: 'JWT expired' })).toBe('auth');
    expect(classify({ code: 'P0002', message: 'hunt not found' })).toBe('not_found');
    const err = toDataError({ code: '23514', message: 'Hunt limit reached for the free tier (3 active hunts). Pause one, or upgrade.' }, 'create hunt');
    expect(err).toBeInstanceOf(DataError);
    expect(describeError(err)).toBe('Hunt limit reached for the free tier (3 active hunts). Pause one, or upgrade.');
    expect(describeError(new Error('x'))).toMatch(/went wrong/);
  });
});
