import { parseQuery } from '@platform/query';
import { describe, expect, it } from 'vitest';
import { chipsFor, draftFromParse, manifestLine, readAlternatives, summarizeHunt, toHuntInsert } from './huntDraft';

const HOME = { homePostalCode: '53202', defaultRadiusMiles: 60 };

function row(query: string) {
  const insert = toHuntInsert(draftFromParse(parseQuery(query, HOME)), { userId: 'u', name: 'n', notifyImmediately: true });
  return {
    keywords: insert.keywords ?? [],
    brands: insert.brands ?? [],
    exclude_keywords: insert.exclude_keywords ?? [],
    min_price_cents: insert.min_price_cents ?? null,
    max_price_cents: insert.max_price_cents ?? null,
    postal_code: insert.postal_code ?? null,
    radius_miles: insert.radius_miles ?? null,
    states: insert.states ?? [],
    tiers_only: insert.tiers_only ?? [],
    include_shippable: insert.include_shippable ?? true,
    parsed: insert.parsed ?? null,
  };
}

describe('the Hunts manifest line', () => {
  it('reads like the design: "generator · up to $800 · 60 mi"', () => {
    expect(manifestLine(row('generator under $800'))).toBe('generator · up to $800 · 60 mi');
  });

  it('shows either-or choices, which live only in parsed, cut to three', () => {
    expect(manifestLine(row('canner or canning or dehydrator or cast iron or dutch oven or stockpot'))).toBe(
      'canner, canning, dehydrator or 3 more · 60 mi',
    );
    expect(manifestLine(row('truck or trailer'))).toBe('truck or trailer · 60 mi');
  });

  it('names brands in their own spelling, and seller filters', () => {
    expect(manifestLine(row('DJI drone with thermal under $1,500 from federal auctions'))).toBe(
      'DJI · drone · thermal · up to $1,500 · 60 mi · Federal',
    );
  });
});

describe('the hunt summary now includes either-or choices', () => {
  it('lists every choice in full', () => {
    expect(summarizeHunt(row('truck or trailer'))).toBe('truck or trailer · within 60 mi of 53202 · every source type');
  });

  it('reads parsed.alternatives defensively', () => {
    expect(readAlternatives({ alternatives: [['a', 'b'], [], 'x', [1, 'c']] as never })).toEqual([['a', 'b'], ['c']]);
    expect(readAlternatives(null)).toEqual([]);
    expect(readAlternatives('text')).toEqual([]);
  });
});

describe('"Worth the trip" replaces "Treasure in plain sight"', () => {
  it('labels the sleeper chip in a hunt draft', () => {
    const draft = draftFromParse(parseQuery('generator', HOME));
    const withSleeper = { ...draft, fields: { ...draft.fields, min_sleeper_score: 6 } };
    const chip = chipsFor(withSleeper).find((c) => c.kind === 'sleeper');
    expect(chip?.label).toBe('Worth the trip');
    expect(chipsFor(withSleeper).some((c) => /treasure/i.test(`${c.label} ${c.removeLabel}`))).toBe(false);
  });
});
