import { parseQuery } from '@platform/query';
import { describe, expect, it } from 'vitest';
import {
  defaultFilters,
  fartherArgs,
  fartherCount,
  filtersFromParse,
  isSellerChecked,
  sortChips,
  toSearchArgs,
  toggleSeller,
  ungroupedTiers,
  type SearchFilters,
} from './searchParams';

const HOME = { homePostalCode: '53202', defaultRadiusMiles: 50 };

describe('sidebar filters to search_lots parameters', () => {
  it('sends the parse with the default filters', () => {
    const parse = parseQuery('laptop', HOME);
    const args = toSearchArgs(parse.searchParams, filtersFromParse(parse, defaultFilters(50)), { page: { limit: 24, offset: 0 } });
    expect(args).toEqual({
      p_query: 'laptop',
      p_postal_code: '53202',
      p_radius_miles: 50,
      p_include_shippable: true,
      p_states: null,
      p_min_cents: null,
      p_max_cents: null,
      p_category_ids: null,
      p_tiers: null,
      p_closing_within_hours: null,
      p_min_sleeper: null,
      p_sort: 'relevance',
      p_limit: 24,
      p_offset: 0,
    });
  });

  it('maps distance, shipping, price and sort from the sidebar', () => {
    const parse = parseQuery('laptop', HOME);
    const filters: SearchFilters = { radius: 25, includeShippable: false, tiers: null, minCents: 1000, maxCents: 50000, sort: 'cheapest' };
    expect(toSearchArgs(parse.searchParams, filters)).toMatchObject({
      p_postal_code: '53202',
      p_radius_miles: 25,
      p_include_shippable: false,
      p_min_cents: 1000,
      p_max_cents: 50000,
      p_sort: 'cheapest',
    });
  });

  it('reads "anywhere" as no origin, which search_lots treats as no distance limit', () => {
    const parse = parseQuery('laptop', HOME);
    const args = toSearchArgs(parse.searchParams, { ...defaultFilters(50), radius: 'anywhere' });
    expect(args?.p_postal_code).toBeNull();
    expect(args?.p_radius_miles).toBe(50);
  });

  it('uses the home ZIP, or a ZIP looked up for a place name, when the words give none', () => {
    const parse = parseQuery('laptop', {});
    expect(toSearchArgs(parse.searchParams, defaultFilters(50))?.p_postal_code).toBeNull();
    expect(toSearchArgs(parse.searchParams, defaultFilters(50), { homeZip: '60601' })?.p_postal_code).toBe('60601');
    expect(toSearchArgs(parse.searchParams, defaultFilters(50), { resolvedZip: '53703', homeZip: '60601' })?.p_postal_code).toBe('53703');
  });

  it('never sends a category filter (lots.category_id is not populated yet)', () => {
    const parse = parseQuery('DJI drone', HOME);
    expect(toSearchArgs(parse.searchParams, defaultFilters(50))?.p_category_ids).toBeNull();
  });

  it('sets the filters from what the words said, keeping the user settings otherwise', () => {
    const base: SearchFilters = { ...defaultFilters(100), sort: 'nearest', includeShippable: false };
    const typed = filtersFromParse(parseQuery('generator under $500 within 25 miles, ending soonest', HOME), base);
    expect(typed.radius).toBe(25);
    expect(typed.maxCents).toBe(50000);
    expect(typed.sort).toBe('closing');
    expect(typed.includeShippable).toBe(false);
    const plain = filtersFromParse(parseQuery('generator', HOME), base);
    expect(plain.radius).toBe(100); // the default radius from the parse is not "typed"
    expect(plain.sort).toBe('nearest');
    expect(plain.maxCents).toBeNull();
  });
});

describe('seller checkboxes to p_tiers', () => {
  it('all six checked means no tier filter at all', () => {
    expect(toSearchArgs(parseQuery('x', HOME).searchParams, defaultFilters(50))?.p_tiers).toBeNull();
    expect(isSellerChecked(null, 'estate')).toBe(true);
  });

  it('unchecking one sends exactly the checked groups, with county and city together', () => {
    const tiers = toggleSeller(null, 'estate');
    expect(tiers).toEqual(['federal', 'state', 'county', 'municipal', 'school', 'private']);
    expect(isSellerChecked(tiers, 'estate')).toBe(false);
    expect(toggleSeller(tiers, 'estate')).toBeNull(); // back to all six
    expect(toggleSeller(['federal'], 'county')).toEqual(['federal', 'county', 'municipal']);
  });

  it('with nothing checked there is nothing to search', () => {
    const none = toggleSeller(['federal'], 'federal');
    expect(none).toEqual([]);
    expect(toSearchArgs(parseQuery('x', HOME).searchParams, { ...defaultFilters(50), tiers: none })).toBeNull();
  });

  it('keeps tiers the words named even when no checkbox shows them', () => {
    const filters = filtersFromParse(parseQuery('government trucks', HOME), defaultFilters(50));
    expect(filters.tiers).toEqual(['federal', 'state', 'county', 'municipal', 'school']);
    expect(isSellerChecked(filters.tiers, 'private')).toBe(false);
    expect(ungroupedTiers(['dealer', 'federal'])).toEqual(['dealer']);
  });
});

describe('the "more matches farther away" row', () => {
  it('searches again with no origin and subtracts', () => {
    const args = toSearchArgs(parseQuery('laptop', HOME).searchParams, defaultFilters(50));
    expect(args).not.toBeNull();
    const farther = fartherArgs(args as NonNullable<typeof args>);
    expect(farther?.p_postal_code).toBeNull();
    expect(farther?.p_query).toBe('laptop');
    expect(fartherArgs({ ...(args as NonNullable<typeof args>), p_postal_code: null })).toBeNull();
    expect(fartherCount(31, 2, 200)).toEqual({ count: 29, atLeast: false });
    expect(fartherCount(200, 12, 200)).toEqual({ count: 188, atLeast: true });
    expect(fartherCount(2, 2, 200)).toBeNull();
  });

  it('shows the design sort chips, plus the active one when the words chose another', () => {
    expect(sortChips('relevance').map((c) => c.label)).toEqual(['Best match', 'Closing soon', 'Nearest', 'Price']);
    expect(sortChips('sleeper').map((c) => c.value)).toContain('sleeper');
  });
});
