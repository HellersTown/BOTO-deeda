import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATTRIBUTE_TERMS, TAXONOMY } from '../src/taxonomy.ts';
import type { TaxonomyTerm } from '../src/taxonomy.ts';
// The generator is plain JavaScript beside the migrations it writes.
import { latestVocabularyMigration, render, vocabulary } from '../../../scripts/gen-search-taxonomy.mjs';

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
  const chairs = (v.items['office-chairs'] as (string | { t: string })[]).map((t) => (typeof t === 'string' ? t : t.t));
  assert.ok(chairs.includes('computer chair'), '"computer chair" is a chair');
  const speakers = (v.items['home-audio'] as (string | { t: string })[]).map((t) => (typeof t === 'string' ? t : t.t));
  assert.ok(speakers.includes('computer speaker'), '"computer speaker" is a speaker');
});
