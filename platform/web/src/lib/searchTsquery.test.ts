import { parseQuery } from '@platform/query';
import { describe, expect, it } from 'vitest';
import { defaultFilters, fartherArgs, filtersFromParse, SORT_OPTIONS, toSearchArgs } from './searchParams';

const HOME = { homePostalCode: '53202', defaultRadiusMiles: 60 };

describe('search_lots gets the parser’s grouped query as p_tsquery (0018)', () => {
  it('sends p_tsquery beside p_query, both from the same parse', () => {
    const parse = parseQuery('chevy pickup truck', HOME);
    expect(parse.tsquery).not.toBe('');
    const args = toSearchArgs(parse.searchParams, filtersFromParse(parse, defaultFilters(60)), { tsquery: parse.tsquery });
    expect(args?.p_query).toBe(parse.websearchQuery);
    expect(args?.p_tsquery).toBe(parse.tsquery);
  });

  it('keeps it on the "farther away" count, which is the same search with no origin', () => {
    const parse = parseQuery('generator or genset', HOME);
    const args = toSearchArgs(parse.searchParams, defaultFilters(60), { tsquery: parse.tsquery });
    expect(args).not.toBeNull();
    const farther = fartherArgs(args as NonNullable<typeof args>);
    expect(farther?.p_tsquery).toBe(parse.tsquery);
    expect(farther?.p_postal_code).toBeNull();
  });

  it('leaves the key out when there is nothing to send, so the SQL default applies', () => {
    const parse = parseQuery('', HOME);
    const empty = toSearchArgs(parse.searchParams, defaultFilters(60), { tsquery: parse.tsquery });
    expect(empty).not.toHaveProperty('p_tsquery');
    const none = toSearchArgs(parseQuery('laptop', HOME).searchParams, defaultFilters(60));
    expect(none).not.toHaveProperty('p_tsquery');
    const blank = toSearchArgs(parseQuery('laptop', HOME).searchParams, defaultFilters(60), { tsquery: '   ' });
    expect(blank).not.toHaveProperty('p_tsquery');
  });

  it('labels the sleeper sort "Worth the trip"', () => {
    expect(SORT_OPTIONS.find((o) => o.value === 'sleeper')?.label).toBe('Worth the trip');
  });
});
