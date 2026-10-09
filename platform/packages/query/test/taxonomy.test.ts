import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATTRIBUTE_TERMS, CONCEPT_NAMES, TAXONOMY } from '../src/taxonomy.ts';
import type { TaxonomyTerm } from '../src/taxonomy.ts';
// The generator is plain JavaScript beside the migrations it writes.
import { latestVocabularyMigration, nameKey, render, vocabulary } from '../../../scripts/gen-search-taxonomy.mjs';

/** Lowercase words, as search_tokens() splits them before stemming. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

const textOf = (t: string | TaxonomyTerm) => (typeof t === 'string' ? t : t.text);

test('the latest vocabulary migration is exactly what the generator writes', () => {
  const { path, number } = latestVocabularyMigration();
  assert.equal(
    readFileSync(path, 'utf8'),
    render(number),
    `${path} is stale: run node platform/scripts/gen-search-taxonomy.mjs --next (or without --next if it is unapplied)`,
  );
});

test('concept ids are unique, and every parent and related concept exists', () => {
  const ids = new Set<string>();
  for (const c of TAXONOMY) {
    assert.ok(!ids.has(c.id), `duplicate concept ${c.id}`);
    ids.add(c.id);
  }
  for (const c of TAXONOMY) {
    if (c.parent) assert.ok(ids.has(c.parent), `${c.id}: unknown parent ${c.parent}`);
    for (const r of c.related ?? []) {
      assert.ok(ids.has(r), `${c.id}: unknown related ${r}`);
      assert.notEqual(r, c.id, `${c.id} is related to itself`);
    }
  }
});

test('no concept is its own ancestor', () => {
  const parent = new Map(TAXONOMY.map((c) => [c.id, c.parent]));
  for (const c of TAXONOMY) {
    const seen = new Set([c.id]);
    for (let p = c.parent; p; p = parent.get(p) ?? null) {
      assert.ok(!seen.has(p), `${c.id}: the parent chain loops at ${p}`);
      seen.add(p);
    }
  }
});

test('every term has words, and a fallback meaning has cues that can choose it', () => {
  for (const c of TAXONOMY) {
    assert.ok(c.terms.length > 0 || TAXONOMY.some((k) => k.parent === c.id), `${c.id} has no terms and no children`);
    for (const t of c.terms) {
      assert.ok(words(textOf(t)).length > 0, `${c.id}: a term with no words`);
      assert.ok(words(textOf(t)).length <= 5, `${c.id}: "${textOf(t)}" is longer than search_match's five-word window`);
      if (typeof t !== 'string' && t.fallback) {
        assert.ok((t.cues ?? []).length > 0, `${c.id}: fallback "${t.text}" has no cues, so it can never be chosen`);
      }
    }
  }
});

test('a cue word chooses a meaning on its own, so none is a word every title has', () => {
  // search_load_vocabulary splits a cue phrase into words and any one of them
  // chooses: the cue "box of" made "(7) Boxes of Sand Paper Rounds" ammunition.
  const stop = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or',
    'the', 'to', 'with']);
  for (const c of TAXONOMY) {
    for (const t of c.terms) {
      if (typeof t === 'string') continue;
      for (const cue of t.cues ?? []) {
        for (const w of words(cue)) assert.ok(!stop.has(w), `${c.id}: "${t.text}" has the cue word "${w}" (from "${cue}")`);
      }
    }
  }
});

test('ammunition is chosen by a calibre or a maker, not by a count or a box', () => {
  const ammo = TAXONOMY.find((c) => c.id === 'ammunition')!;
  const round = ammo.terms.find((t): t is Exclude<TaxonomyTerm, string> => typeof t !== 'string' && t.text === 'round')!;
  const cueWords = new Set((round.cues ?? []).flatMap(words));
  for (const w of ['box', 'of', 'long', 'brown', 'point', '30', '40', '45', 'mm', 'auto']) {
    assert.ok(!cueWords.has(w), `"${w}" beside "round" would make it ammunition`);
  }
  for (const w of ['22', 'lr', '9mm', '12ga', 'gauge', 'fmj', '62x39', 'winchester']) {
    assert.ok(cueWords.has(w), `"${w}" beside "round" should make it ammunition`);
  }
});

test('a phrase means one thing unless cues decide between its meanings', () => {
  // Spellings are compared before stemming here; the stemmed check runs where
  // the vocabulary is loaded (search_load_vocabulary merges what stems alike).
  const meanings = new Map<string, { concept: string; decided: boolean }[]>();
  for (const c of TAXONOMY) {
    for (const t of c.terms) {
      const key = words(textOf(t)).join(' ');
      const decided = typeof t !== 'string' && ((t.cues ?? []).length > 0 || Boolean(t.fallback));
      const list = meanings.get(key) ?? [];
      list.push({ concept: c.id, decided });
      meanings.set(key, list);
    }
  }
  for (const [key, list] of meanings) {
    const concepts = new Set(list.map((m) => m.concept));
    if (concepts.size < 2) continue;
    const plainDefaults = list.filter((m) => !m.decided);
    assert.ok(
      plainDefaults.length <= 1,
      `"${key}" means ${[...concepts].join(' and ')} with nothing to tell them apart: give one meaning cues or mark it the fallback`,
    );
  }
});

test('attributes never double as item names', () => {
  const items = new Set(TAXONOMY.flatMap((c) => c.terms.map((t) => words(textOf(t)).join(' '))));
  for (const a of ATTRIBUTE_TERMS) assert.ok(!items.has(words(a).join(' ')), `"${a}" is both an attribute and an item`);
});

test('a computer is understood the way a buyer means it', () => {
  // The search that started this: "computer" must reach laptops, desktops,
  // all-in-ones, MacBooks and Chromebooks, and never chairs or speakers.
  const v = vocabulary();
  const byId = new Map(v.concepts.map((c: [string, string, string | null, string[]]) => [c[0], c]));
  const descendants = (id: string): string[] => [
    id,
    ...v.concepts.filter((c: [string, string, string | null]) => c[2] === id).flatMap((c: [string]) => descendants(c[0])),
  ];
  const under = descendants('computers');
  for (const id of ['laptops', 'desktops', 'all-in-ones', 'macbooks', 'chromebooks', 'thinkpads', 'workstations']) {
    assert.ok(under.includes(id), `${id} is not a kind of computer`);
  }
  for (const id of ['office-chairs', 'home-audio', 'hand-tools', 'tablets', 'monitors']) {
    assert.ok(byId.has(id), `missing concept ${id}`);
    assert.ok(!under.includes(id), `${id} must not count as a computer`);
  }
  const text = (t: string | { t: string }) => (typeof t === 'string' ? t.replace(/^!/, '') : t.t);
  const chairs = (v.items['office-chairs'] as (string | { t: string })[]).map(text);
  assert.ok(chairs.includes('computer chair'), '"computer chair" is a chair');
  const speakers = (v.items['home-audio'] as (string | { t: string })[]).map(text);
  assert.ok(speakers.includes('computer speaker'), '"computer speaker" is a speaker');
});

test('every listed name is a term of its concept', () => {
  const byId = new Map(TAXONOMY.map((c) => [c.id, c]));
  for (const [id, names] of Object.entries(CONCEPT_NAMES)) {
    const c = byId.get(id);
    assert.ok(c, `CONCEPT_NAMES: unknown concept ${id}`);
    const terms = new Set(c.terms.map((t) => nameKey(textOf(t))));
    for (const n of names) assert.ok(terms.has(nameKey(n)), `${id}: name "${n}" is not one of its terms`);
  }
});

test('a name finds every kind; a narrower kind keeps its words', () => {
  const v = vocabulary();
  const spec = (id: string, term: string) => {
    const t = (v.items[id] as (string | { t: string; s?: boolean })[]).find(
      (x) => (typeof x === 'string' ? x.replace(/^!/, '') : x.t) === term,
    );
    assert.ok(t !== undefined, `${id}: no term ${term}`);
    return typeof t === 'string' ? t.startsWith('!') : Boolean(t.s);
  };
  for (const [id, term] of [['computers', 'computer'], ['phones', 'cell phone'], ['graphics-cards', 'gpu'],
    ['laptops', 'laptop'], ['tvs', 'television'], ['land', 'acres'], ['snow-blowers', 'snowblower']]) {
    assert.equal(spec(id, term), false, `${id}: "${term}" names the concept`);
  }
  for (const [id, term] of [['hand-tools', 'socket set'], ['laptops', 'gaming laptop'], ['phones', 'iphone'],
    ['trucks', 'f150'], ['hard-drives', 'ssd'], ['rifles', 'ar15']]) {
    assert.equal(spec(id, term), true, `${id}: "${term}" is narrower and keeps its words`);
  }
});
