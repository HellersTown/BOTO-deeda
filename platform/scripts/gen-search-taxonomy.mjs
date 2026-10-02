#!/usr/bin/env node
// Write the item vocabulary (packages/query/src/taxonomy.ts) into the database
// as a migration: every concept, every term, the brand names from
// lexicon.BRANDS and the attribute words, as one JSON document that
// search_load_vocabulary() (0045) loads. classify_listing() and
// search_resolve() read the tables it fills, so search, hunts and the app all
// use one vocabulary. packages/query/test/taxonomy.test.ts fails if the latest
// NNNN_search_vocabulary.sql differs from what this script writes.
//
// After editing taxonomy.ts or the brand list, write a new migration and
// apply it (loading re-classifies every lot in the background):
//
//   node platform/scripts/gen-search-taxonomy.mjs --next
//
// Without --next the script rewrites the latest vocabulary migration, which is
// only right while that one has not been applied anywhere.
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTE_TERMS, BRAND_PHRASES, PRODUCT_LINE_WORDS, TAXONOMY } from '../packages/query/src/taxonomy.ts';
import { BRANDS } from '../packages/query/src/lexicon.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS = join(root, 'supabase/migrations');
const VOCABULARY_FILE = /^(\d{4})_search_vocabulary\.sql$/;

/** The newest NNNN_search_vocabulary.sql: the vocabulary production runs. */
export function latestVocabularyMigration() {
  const files = readdirSync(MIGRATIONS).filter((f) => VOCABULARY_FILE.test(f)).sort();
  if (!files.length) throw new Error(`no NNNN_search_vocabulary.sql in ${MIGRATIONS}`);
  const file = files[files.length - 1];
  return { path: join(MIGRATIONS, file), number: file.slice(0, 4) };
}

/** The next free migration number, for --next. */
function nextMigrationNumber() {
  const numbers = readdirSync(MIGRATIONS).map((f) => /^(\d{4})_/.exec(f)?.[1]).filter(Boolean).map(Number);
  return String(Math.max(0, ...numbers) + 1).padStart(4, '0');
}

/** Lowercase words, the way search_tokens() splits them before stemming. */
function words(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function lit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function arr(xs) {
  return xs.length ? `array[${xs.map(lit).join(', ')}]` : `'{}'::text[]`;
}

/**
 * Brand names that are safe as brand terms: every unambiguous form of every
 * lexicon brand, plus the phrases taxonomy.ts lists. Words a brand shares with
 * ordinary English ("case", "apple", "ram") are left out; they are brands only
 * in context, and the item vocabulary decides them.
 */
export function brandTerms() {
  const out = new Set();
  for (const b of BRANDS) {
    const ambiguous = new Set((b.ambiguous ?? []).map((a) => words(a).join(' ')));
    for (const form of [b.name, ...(b.aliases ?? [])]) {
      const w = words(form).join(' ');
      if (w && !ambiguous.has(w)) out.add(w);
    }
  }
  for (const p of BRAND_PHRASES) out.add(words(p).join(' '));
  return [...out].sort();
}

/**
 * Words that make a term a specific product rather than a kind of thing: brand
 * names (ambiguous ones included) and product lines. A query naming one
 * ("iphone", "rolex", "dell latitude") must find that word in a listing; a
 * generic term ("phone", "watch") need not.
 */
export function specificWords() {
  // Whole brand names and product lines, as word sequences. "GearWrench" and
  // "Liberty Safe" are brands; "wrench" and "safe" are not.
  const firm = new Set();
  const loose = new Set();
  for (const b of BRANDS) {
    const ambiguous = new Set((b.ambiguous ?? []).map((a) => words(a).join(' ')));
    for (const form of [b.name, ...(b.aliases ?? [])]) {
      const w = words(form).join(' ');
      if (w) (ambiguous.has(w) ? loose : firm).add(w);
    }
    for (const f of b.families ?? []) firm.add(words(f).join(' '));
  }
  for (const p of BRAND_PHRASES) firm.add(words(p).join(' '));
  for (const p of PRODUCT_LINE_WORDS) firm.add(words(p).join(' '));
  for (const w of firm) loose.delete(w);
  return { firm, loose };
}

/** Plain words that appear in product names but never make one specific on their own. */
const GENERIC_WORDS = new Set(['laptop', 'computer', 'phone', 'watch', 'tablet', 'tv', 'camera', 'drone', 'truck', 'tractor',
  'mower', 'saw', 'drill', 'chair', 'table', 'desk', 'bed', 'boat', 'trailer', 'car', 'bike', 'rifle', 'pistol', 'shotgun',
  'knife', 'ring', 'necklace', 'speaker', 'speakers', 'monitor', 'printer', 'router', 'console', 'controller', 'game',
  'pro', 'air', 'mini', 'max', 'plus', 'ultra', 'lite', 'one', 'series', 'model', 'sport', 'classic', 'deluxe', 'tools',
  'tool', 'the', 'and', 'of', 'co', 'company', 'inc', 'electric', 'power', 'home', 'house', 'shop', 'case', 'mac',
  'box', 'super', 'duty', 'big', 'little', 'king', 'star', 'gold', 'silver', 'safe', 'wrench', 'land', 'deer', 'turn']);

/**
 * A term names a specific product when it contains a whole brand name or
 * product line ("iphone", "rolex", "dell latitude", "john deere gator"), or an
 * ambiguous brand word in the brand's place at the front ("apple watch",
 * "ram 1500", never "phone case").
 */
export function isSpecific(term, sw) {
  const all = words(term);
  for (let i = 0; i < all.length; i++) {
    for (let j = all.length; j > i; j--) {
      const seq = all.slice(i, j).join(' ');
      if (sw.firm.has(seq) && !(j - i === 1 && GENERIC_WORDS.has(seq))) return true;
    }
  }
  return all.length >= 2 && sw.loose.has(all[0]) && !GENERIC_WORDS.has(all[0]);
}

export function orderedConcepts() {
  const byId = new Map(TAXONOMY.map((c) => [c.id, c]));
  const done = new Set();
  const out = [];
  const visit = (c) => {
    if (done.has(c.id)) return;
    if (c.parent) {
      const p = byId.get(c.parent);
      if (!p) throw new Error(`${c.id}: unknown parent ${c.parent}`);
      visit(p);
    }
    done.add(c.id);
    out.push(c);
  };
  TAXONOMY.forEach(visit);
  return out;
}

/**
 * The document search_load_vocabulary() takes. A term is a string ("!" in
 * front when it names a specific product) or, when it carries cues or is a
 * fallback meaning, an object.
 */
export function vocabulary() {
  const sw = specificWords();
  const concepts = orderedConcepts();
  const items = {};
  for (const c of concepts) {
    items[c.id] = c.terms.map((t) => {
      const text = typeof t === 'string' ? t : t.text;
      const specific = isSpecific(text, sw);
      const cues = typeof t === 'string' ? [] : (t.cues ?? []);
      const fallback = typeof t !== 'string' && Boolean(t.fallback);
      if (!cues.length && !fallback) return specific ? `!${text}` : text;
      return { t: text, ...(cues.length ? { c: cues } : {}), ...(fallback ? { f: true } : {}), ...(specific ? { s: true } : {}) };
    });
  }
  return {
    concepts: concepts.map((c) => [c.id, c.label, c.parent ?? null, c.related ?? []]),
    items,
    brands: brandTerms(),
    attrs: [...ATTRIBUTE_TERMS],
  };
}

/** A JSON array of plain values, wrapped at about 110 columns. */
function wrapped(values, indent) {
  const lines = [];
  let line = '';
  for (const v of values.map((x) => JSON.stringify(x))) {
    if (line && line.length + v.length + 2 > 110 - indent.length) {
      lines.push(line + ',');
      line = '';
    }
    line += (line ? ', ' : '') + v;
  }
  if (line) lines.push(line);
  return `[\n${lines.map((l) => indent + '  ' + l).join('\n')}\n${indent}]`;
}

export function render(number) {
  const v = vocabulary();
  const nTerms = Object.values(v.items).reduce((n, ts) => n + ts.length, 0) + v.brands.length + v.attrs.length;
  const concepts = v.concepts.map((c) => `  ${JSON.stringify(c)}`).join(',\n');
  const items = Object.entries(v.items)
    .map(([id, terms]) => `  ${JSON.stringify(id)}: ${wrapped(terms, '  ')}`)
    .join(',\n');
  const doc = `{\n"concepts": [\n${concepts}\n],\n"items": {\n${items}\n},\n"brands": ${wrapped(v.brands, '')},\n"attrs": ${wrapped(v.attrs, '')}\n}`;
  if (doc.includes('$vocab$')) throw new Error('the vocabulary contains the quote tag $vocab$');

  return `-- ${number}: the item vocabulary search reads (0045).
--
-- GENERATED by platform/scripts/gen-search-taxonomy.mjs from
-- platform/packages/query/src/taxonomy.ts and the brand list in lexicon.ts.
-- Do not edit by hand: edit taxonomy.ts and run the script.
-- packages/query/test/taxonomy.test.ts fails when this file is stale.
--
-- ${v.concepts.length} concepts, ${nTerms} terms. Loading replaces the whole vocabulary and moves
-- its version on, so every lot is re-classified in the background
-- (reclassify_lots, every minute; lots_classify for lots ingest rewrites).

select public.search_load_vocabulary($vocab$${doc}$vocab$::jsonb);
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv.includes('--next')
    ? (() => {
        const number = nextMigrationNumber();
        return { path: join(MIGRATIONS, `${number}_search_vocabulary.sql`), number };
      })()
    : latestVocabularyMigration();
  writeFileSync(target.path, render(target.number));
  console.log(`wrote ${target.path}`);
}
