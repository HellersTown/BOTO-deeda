import { parseQuery } from '@platform/query';
import { describe, expect, it } from 'vitest';
import {
  chipsFor,
  deriveHuntName,
  draftFromParse,
  huntHasCriteria,
  rebuildWebsearch,
  removeChip,
  setDraftRadius,
  summarizeHunt,
  toHuntInsert,
} from './huntDraft';

const HOME = { homePostalCode: '53202', defaultRadiusMiles: 50 };
const DRONE = 'DJI drone with thermal under $1,500 within 50 miles of 53202';

describe('parseQuery output to the hunts insert payload', () => {
  it('copies the parser columns, adds user and name, and keeps the reading in parsed', () => {
    const parse = parseQuery(DRONE, HOME);
    const insert = toHuntInsert(draftFromParse(parse), { userId: 'user-1', name: '  Thermal drone ', notifyImmediately: true });
    expect(insert).toMatchObject({
      user_id: 'user-1',
      name: 'Thermal drone',
      query_text: DRONE,
      keywords: ['dji', 'drone', 'thermal'],
      exclude_keywords: [],
      brands: ['DJI'],
      required_terms: ['thermal'],
      min_price_cents: null,
      max_price_cents: 150000,
      conditions: [],
      postal_code: '53202',
      radius_miles: 50,
      states: [],
      include_shippable: true,
      category_ids: [],
      tiers_only: [],
      min_sleeper_score: null,
      active: true,
      notify_immediately: true,
    });
    const parsed = insert.parsed as Record<string, unknown>;
    // run_hunt_matcher (0013) searches with parsed->>'websearchQuery' first.
    expect(parsed.websearchQuery).toBe('dji drone thermal');
    expect(parsed.categories).toEqual(['drones']);
    expect(parsed.edits).toBeNull();
    expect(parsed).not.toHaveProperty('hunt');
    expect(parsed).not.toHaveProperty('searchParams');
  });

  it('matches every hunts column the parser fills, and nothing the runner owns', () => {
    const insert = toHuntInsert(draftFromParse(parseQuery('laptop', HOME)), { userId: 'u', name: 'Laptop', notifyImmediately: false });
    for (const column of Object.keys(parseQuery('laptop', HOME).hunt)) expect(insert).toHaveProperty(column);
    expect(insert).not.toHaveProperty('match_count');
    expect(insert).not.toHaveProperty('last_run_at');
    expect(insert.postal_code).toBe('53202'); // "no place named" reads as the home ZIP
    expect(insert.notify_immediately).toBe(false);
  });
});

describe('the websearch string the hunt matcher uses', () => {
  it('rebuilds exactly what the parser produced, for plain words, phrases, either-or and exclusions', () => {
    for (const q of [DRONE, 'laptop', 'ford f-150 or silverado -parts in WI', '14k gold jewelry near me', 'john deere 4x4 tractor -toy', '"mavic 3" drone']) {
      const p = parseQuery(q, HOME);
      expect(rebuildWebsearch(p.hunt.keywords, p.alternatives, p.excludeTerms), q).toBe(p.websearchQuery);
    }
  });
});

describe('chips: each one removable, and removing one edits the hunt fields', () => {
  const draft = draftFromParse(parseQuery(DRONE, HOME));

  it('reads the drone query the way the design shows it', () => {
    const chips = chipsFor(draft).map((c) => `${c.label} ${c.value}`);
    expect(chips).toEqual(['Brand DJI', 'Category Drones', 'Must have thermal', 'Up to $1,500']);
    expect(chipsFor(draft).find((c) => c.kind === 'brand')?.removeLabel).toBe('Remove brand DJI');
  });

  it('removing the brand drops it from brands, keywords and the websearch string', () => {
    const next = removeChip(draft, 'kw:dji');
    expect(next.fields.brands).toEqual([]);
    expect(next.fields.keywords).toEqual(['drone', 'thermal']);
    expect(next.websearchQuery).toBe('drone thermal');
    expect(next.removed).toEqual(['Brand: DJI']);
    const insert = toHuntInsert(next, { userId: 'u', name: 'x', notifyImmediately: true });
    const parsed = insert.parsed as Record<string, unknown>;
    expect(parsed.websearchQuery).toBe('drone thermal');
    expect(parsed.tsquery).toBe('');
    expect(parsed.edits).toEqual({ removed: ['Brand: DJI'] });
  });

  it('removing a must-have drops the required term, and a category drops its slug', () => {
    const noThermal = removeChip(draft, 'kw:thermal');
    expect(noThermal.fields.required_terms).toEqual([]);
    expect(noThermal.websearchQuery).toBe('dji drone');
    const noCategory = removeChip(draft, 'kw:drone');
    expect(noCategory.categories).toEqual([]);
    expect(noCategory.fields.keywords).toEqual(['dji', 'thermal']);
  });

  it('removing the price clears max_price_cents', () => {
    expect(removeChip(draft, 'max').fields.max_price_cents).toBeNull();
  });

  it('removes either-or groups, exclusions and states', () => {
    const d = draftFromParse(parseQuery('ford f-150 or silverado -parts in WI', HOME));
    const ids = chipsFor(d).map((c) => c.id);
    expect(ids).toContain('not:parts');
    expect(ids).toContain('state:WI');
    const alt = ids.find((id) => id.startsWith('alt:'));
    expect(alt).toBeDefined();
    const noAlt = removeChip(d, alt as string);
    expect(noAlt.alternatives).toEqual([]);
    expect(noAlt.websearchQuery).toBe('ford -parts');
    expect(removeChip(d, 'not:parts').websearchQuery).toBe('ford "f-150" or ford silverado');
    expect(removeChip(d, 'state:WI').fields.states).toEqual([]);
  });

  it('refuses to save a hunt with nothing to look for (0013 would skip it)', () => {
    let d = draftFromParse(parseQuery('laptop', HOME));
    expect(huntHasCriteria(d)).toBe(true);
    d = removeChip(d, 'kw:laptop');
    expect(huntHasCriteria(d)).toBe(false);
  });

  it('changes the radius', () => {
    expect(setDraftRadius(draft, 100).fields.radius_miles).toBe(100);
  });
});

describe('names and summaries', () => {
  it('derives a short editable name from what the hunt looks for', () => {
    expect(deriveHuntName(draftFromParse(parseQuery(DRONE, HOME)))).toBe('DJI drone thermal');
    expect(deriveHuntName(draftFromParse(parseQuery('laptop', HOME)), 'Milwaukee')).toBe('Laptop near Milwaukee');
    expect(deriveHuntName(draftFromParse(parseQuery('', HOME)))).toBe('My hunt');
  });

  it('summarizes a hunt row in one line', () => {
    const insert = toHuntInsert(draftFromParse(parseQuery(DRONE, HOME)), { userId: 'u', name: 'n', notifyImmediately: true });
    expect(
      summarizeHunt({
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
      }),
    ).toBe('DJI · drone · thermal · up to $1,500 · within 50 mi of 53202 · every source type');
  });
});
