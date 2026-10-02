import { describe, expect, it } from 'vitest';
import type { SearchExplanation } from '../data/database.types';
import { explainParts, explainText, groupByMatch, inSentence, kindsIn, kindsText, tierOf, truncatedGroup, typedWord } from './matchTiers';

const row = (id: string, match_tier: number | null | undefined, match_label: string | null = null) =>
  ({ id, match_tier, match_label }) as { id: string; match_tier: 1 | 2 | 3 | null | undefined; match_label: string | null };

describe('match groups', () => {
  it('splits rows by tier and keeps the server order inside each group', () => {
    const rows = [row('a', 1), row('b', 1), row('c', 2), row('d', 3), row('e', 2)];
    const g = groupByMatch(rows);
    expect(g.exact.map((r) => r.id)).toEqual(['a', 'b']);
    expect(g.close.map((r) => r.id)).toEqual(['c', 'e']);
    expect(g.mentions.map((r) => r.id)).toEqual(['d']);
  });

  it('treats a row without a tier as exact, as every row was before tiers existed', () => {
    expect(tierOf(row('a', undefined))).toBe(1);
    expect(tierOf(row('a', null))).toBe(1);
    expect(groupByMatch([row('a', undefined)]).exact).toHaveLength(1);
  });

  it('names the group the row cap cut short', () => {
    expect(truncatedGroup([row('a', 1), row('b', 2)], 200)).toBeNull();
    expect(truncatedGroup([row('a', 1), row('b', 2)], 2)).toBe('close');
    expect(truncatedGroup([row('a', 1), row('b', 1)], 2)).toBe('exact');
    expect(truncatedGroup([], 0)).toBeNull();
  });

  it('counts the kinds a group holds, commonest first, and leaves unnamed rows out', () => {
    const rows = [row('a', 2, 'Monitors'), row('b', 2, 'Computer parts & storage'), row('c', 2, 'Monitors'), row('d', 2, null)];
    expect(kindsIn(rows)).toEqual([
      { label: 'Monitors', count: 2 },
      { label: 'Computer parts & storage', count: 1 },
    ]);
    expect(kindsText(rows)).toBe('Monitors · Computer parts & storage');
    const many = ['A', 'B', 'C', 'D', 'E'].map((l, i) => row(String(i), 2, l));
    expect(kindsText(many)).toBe('A · B · C · 2 more kinds');
    expect(kindsText(many.slice(0, 4))).toBe('A · B · C · 1 more kind');
    expect(kindsText([row('x', 3, null)])).toBeNull();
  });
});

describe('the words the buyer typed', () => {
  it('quotes the typed word, not the stem the index keeps', () => {
    expect(typedWord('batteri', 'happy batteries charger')).toBe('batteries');
    expect(typedWord('happi', 'happy batteries charger')).toBe('happy');
    expect(typedWord('deer', 'John Deere 3032E')).toBe('Deere');
    expect(typedWord('3032e', 'John Deere 3032E')).toBe('3032E');
    expect(typedWord('run', 'running boards')).toBe('running');
  });

  it('matches a model number however it was typed', () => {
    expect(typedWord('f150', 'ford F-150 xlt')).toBe('F-150');
    expect(typedWord('f150', 'ford f150')).toBe('f150');
    // Typed apart ("f 150"), no one word holds it: the joined form is shown.
    expect(typedWord('f150', 'ford f 150')).toBe('f150');
  });

  it('never takes an excluded word, and strips quotes and punctuation', () => {
    expect(typedWord('set', 'socket -settings set')).toBe('set');
    expect(typedWord('thermal', '"thermal" drone,')).toBe('thermal');
    expect(typedWord('zzz', 'computer')).toBe('zzz');
  });
});

describe('what the search looks for', () => {
  const computers: SearchExplanation = {
    concepts: [{ id: 'computers', label: 'Computers', includes: ['Desktop computers', 'Laptops', 'Workstations & servers'] }],
    related: ['Monitors'],
    required: [],
    brand_only: false,
  };

  it('names the kind and what it includes', () => {
    const parts = explainParts(computers, 'computer');
    expect(explainText(parts)).toBe('Looking for Computers, including desktop computers, laptops and workstations & servers');
    expect(parts?.filter((p) => p.strong).map((p) => p.text)).toEqual(['Computers']);
  });

  it('adds the words a match must also contain, as typed', () => {
    const laptops: SearchExplanation = {
      concepts: [{ id: 'laptops', label: 'Laptops', includes: ['Chromebooks', 'MacBooks', 'ThinkPads'] }],
      related: [],
      required: ['dell'],
      brand_only: false,
    };
    expect(explainText(explainParts(laptops, 'Dell laptop'))).toBe(
      'Looking for Laptops, including Chromebooks, MacBooks and ThinkPads, that mention “Dell”',
    );
    const drones: SearchExplanation = {
      concepts: [{ id: 'drones', label: 'Drones', includes: [] }],
      related: [],
      required: ['thermal'],
      brand_only: false,
    };
    expect(explainText(explainParts(drones, 'thermal drone'))).toBe('Looking for Drones that mention “thermal”');
    const tools: SearchExplanation = { ...drones, concepts: [{ id: 'hand-tools', label: 'Hand tools', includes: [] }], required: ['socket', 'set'] };
    expect(explainText(explainParts(tools, 'socket set'))).toBe('Looking for Hand tools that mention “socket” and “set”');
  });

  it('joins several kinds with "or"', () => {
    const two: SearchExplanation = {
      concepts: [
        { id: 'generators', label: 'Generators', includes: [] },
        { id: 'pressure-washers', label: 'Pressure washers', includes: [] },
      ],
      related: [],
      required: [],
      brand_only: false,
    };
    expect(explainText(explainParts(two, 'generator or pressure washer'))).toBe('Looking for Generators or Pressure washers');
  });

  it('reads a brand-only search and a search of names and model numbers', () => {
    const brand: SearchExplanation = { concepts: [], related: [], required: ['dewalt'], brand_only: true };
    expect(explainText(explainParts(brand, 'DeWalt'))).toBe('Looking for anything by “DeWalt”');
    const ids: SearchExplanation = { concepts: [], related: [], required: ['kubota', 'l3800'], brand_only: false };
    expect(explainText(explainParts(ids, 'kubota L3800'))).toBe('Looking for listings that name “kubota” and “L3800”');
  });

  it('says nothing when nothing was understood', () => {
    expect(explainParts(null, '')).toBeNull();
    expect(explainParts({ concepts: [], related: [], required: [], brand_only: false }, 'the')).toBeNull();
  });

  it('lowercases a kind mid-sentence unless its first word is a name', () => {
    expect(inSentence('Desktop computers')).toBe('desktop computers');
    expect(inSentence('MacBooks')).toBe('MacBooks');
    expect(inSentence('SUVs')).toBe('SUVs');
    expect(inSentence('3D printers')).toBe('3D printers');
    expect(inSentence('Chromebooks')).toBe('Chromebooks');
    expect(inSentence('GPS units')).toBe('GPS units');
  });
});
