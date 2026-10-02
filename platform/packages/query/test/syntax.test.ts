import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PG_ENGLISH_STOPWORDS, parseQuery } from '../src/index.ts';

/**
 * A strict checker for the to_tsquery syntax this package emits: quoted
 * operands (optionally ':*'), unary '!', binary '&', '|', '<->' and '<N>',
 * and parentheses. Returns a reason, or null when the string is valid.
 *
 * It is deliberately stricter than Postgres: every operand must be quoted and
 * contain only lowercase letters, digits, and inner '.', '-' or spaces, so an
 * operand can never smuggle in syntax of its own.
 */
function checkTsquery(q: string): string | null {
  if (q === '') return null;
  const re = /\s*(?:('(?:[^'\\]|\\.|'')*')(:\*)?|(<->|<\d+>)|([&|!()]))/y;
  let pos = 0;
  let expectOperand = true;
  let depth = 0;
  while (pos < q.length) {
    if (/^\s*$/.test(q.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(q);
    if (!m) return `unexpected text at ${pos}: ${q.slice(pos, pos + 12)}`;
    pos = re.lastIndex;
    const [, operand, , phraseOp, op] = m;
    if (operand !== undefined) {
      if (!expectOperand) return `operand where an operator belongs, at ${pos}`;
      if (!/^'[a-z0-9]+(?:(?:[ .-]|(?<=\d)\/(?=\d))[a-z0-9]+)*'$/.test(operand)) return `unsafe operand ${operand}`;
      expectOperand = false;
    } else if (phraseOp !== undefined || op === '&' || op === '|') {
      if (expectOperand) return `binary operator ${phraseOp ?? op} with no left operand, at ${pos}`;
      expectOperand = true;
    } else if (op === '!') {
      if (!expectOperand) return `! after an operand, at ${pos}`;
    } else if (op === '(') {
      if (!expectOperand) return `( after an operand, at ${pos}`;
      depth++;
    } else if (op === ')') {
      if (expectOperand) return `) where an operand belongs, at ${pos}`;
      depth--;
      if (depth < 0) return `unbalanced ) at ${pos}`;
    }
  }
  if (expectOperand) return 'ends without an operand';
  if (depth !== 0) return 'unbalanced (';
  return null;
}

/**
 * websearch_to_tsquery never throws, which is exactly why a bad string is
 * dangerous: it silently means something else. This checks that a string
 * uses only the structure we intend: bare words, balanced "phrases", "-"
 * exclusions and "or" between clauses. No parentheses (websearch ignores
 * them), no single quotes, no atom made only of stop words (it would vanish,
 * and an all-stop-word query matches NOTHING).
 */
function checkWebsearch(q: string): string | null {
  if (q === '') return null;
  if (!/^[a-z0-9 ."/-]+$/.test(q)) return `unsafe character in ${JSON.stringify(q)}`;
  if ((q.match(/"/g) ?? []).length % 2 !== 0) return 'unbalanced double quote';
  const atoms = q.match(/-?"[^"]*"|\S+/g) ?? [];
  let afterOr = true;
  for (const a of atoms) {
    if (a === 'or') {
      if (afterOr) return 'misplaced "or"';
      afterOr = true;
      continue;
    }
    afterOr = false;
    const body = a.startsWith('-') ? a.slice(1) : a;
    if (body.startsWith('-')) return `double dash in ${a}`;
    const words = body.startsWith('"') ? body.slice(1, -1).split(' ') : [body];
    // A slash only inside a fraction ("3/8"), which Postgres indexes as one lexeme.
    for (const w of words) if (!/^[a-z0-9]+(?:(?:[.-]|(?<=\d)\/(?=\d))[a-z0-9]+)*$/.test(w)) return `bad word ${JSON.stringify(w)} in ${a}`;
    if (words.every((w) => PG_ENGLISH_STOPWORDS.has(w))) return `atom ${a} is only stop words`;
  }
  if (afterOr) return 'trailing "or"';
  return null;
}

const HUNT_COLUMNS = [
  'brands', 'category_ids', 'conditions', 'exclude_keywords', 'include_shippable', 'keywords',
  'max_price_cents', 'min_price_cents', 'min_sleeper_score', 'parsed', 'postal_code', 'query_text',
  'radius_miles', 'required_terms', 'states', 'tiers_only',
];
const SEARCH_PARAMS = [
  'p_closing_within_hours', 'p_include_shippable', 'p_max_cents', 'p_min_cents', 'p_min_sleeper',
  'p_postal_code', 'p_query', 'p_radius_miles', 'p_sort', 'p_states', 'p_tiers',
];

const EXAMPLES = [
  'DJI drone with thermal under $1500 within 50 miles of 53202', 'Snap-on toolbox near Madison WI',
  'silver coins no replicas under 200', 'john deere lawn tractor ending today', 'estate sale furniture within 25 mi',
  '14k gold jewelry', 'Ford F-150 2015 or newer under 10k', 'pallet of laptops pickup only', 'mavic 3 thermal',
  'cheap welder near beloit', 'stickley chair', 'morgan silver dollar PCGS', '', "drone'); drop table lots;--",
  'f-150 or silverado', 'ford f-150 or silverado or tundra diesel', 'can-am outlander', 'can am', 'the', 'or',
  'and or not', '"mavic 3" -"mini"', '-replica', '"unbalanced quote', '"the who" records', 'dresser w/o mirror',
  '(drone | uav) & thermal & !toy', "o'reilly", 'drone -- thermal', '::::', "''''", '$$$', 'drone:* & (',
  'a b c d e f g', '1 2 3', 'or or or', 'no no no', '- - -', '"" "" ""', '\u0000\u0007drone', '\u{1F69C} tractor \u{1F69C}',
  'x'.repeat(2000), 'drone '.repeat(200), 'a or b or c or d or e or f or g or h or i or j',
  'ford or chevy or dodge truck diesel or gas 4x4 or 2wd',
];

/** Deterministic fuzz: the same "random" queries on every run. */
function fuzzCorpus(count: number): string[] {
  let seed = 7;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pieces = [
    'drone', 'or', 'and', 'not', 'no', '-', '"', "'", '(', ')', '|', '&', '!', ':*', '<->', 'f-150', 'can-am',
    'snap-on', 'under', '$50', '1.5k', 'within', '50', 'miles', 'of', '53202', 'near', 'beloit', 'wi', 'thermal',
    'the', 'mavic', '3', '14k', 'gold', 'replica', 'without', 'cat', 'case', 'ram', '1500', '\\', ';', '--',
    'ending', 'today', '.999', 'x-ray', 'OR', 'ME', 'in', '$', ',', 'pickup', 'only', 'estate', 'sale', 'new',
  ];
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const n = 1 + rand(10);
    const parts: string[] = [];
    for (let j = 0; j < n; j++) parts.push(pieces[rand(pieces.length)]);
    out.push(parts.join(rand(3) === 0 ? '' : ' '));
  }
  return out;
}

// ------------------------------------------------------ the validators work

test('the tsquery validator accepts what to_tsquery accepts', () => {
  for (const ok of [
    "'drone'",
    "'dji' & ( 'drone' | 'uav' ) & !( 'toy' )",
    "( 'mavic' <-> '3':* ) & 'thermal'",
    "'f-150' | 'f 150' | 'f150'",
    "!'replica'",
    "( ( 'a1' ) )",
    "'a' <2> 'b'",
  ]) assert.equal(checkTsquery(ok), null, ok);
});

test('the tsquery validator rejects broken parentheses and operator placement', () => {
  for (const bad of [
    "'a' &", "& 'a'", "( 'a'", "'a' )", "'a' 'b'", "'a' ! 'b'", "()", "'a' & | 'b'", "'a' <-> ", "'it''s'",
    "'DROP'", "'a;b'", "drone", "'a' (", "!", "'a' & !",
  ]) assert.notEqual(checkTsquery(bad), null, bad);
});

test('the websearch validator rejects what would silently change meaning', () => {
  for (const bad of [
    'or drone', 'drone or', 'drone or or uav', '(drone or uav) thermal', '"drone', "drone's",
    'drone --thermal', 'the', '"of the"', 'drone; drop', 'Drone', 'a/b', '3/', '/etc/passwd',
  ]) assert.notEqual(checkWebsearch(bad), null, bad);
  for (const ok of ['drone', 'dji drone -toy', '"mavic 3" thermal', 'a1 or b2', '"f-150" or silverado', '-replica', '0.999 silver']) {
    assert.equal(checkWebsearch(ok), null, ok);
  }
});

// ------------------------------------------- every output is safe to send

test('every generated query string is valid for its Postgres function', () => {
  for (const q of [...EXAMPLES, ...fuzzCorpus(1500)]) {
    const r = parseQuery(q);
    assert.equal(checkWebsearch(r.websearchQuery), null, `websearch for ${JSON.stringify(q)}: ${r.websearchQuery}`);
    assert.equal(checkTsquery(r.tsquery), null, `tsquery for ${JSON.stringify(q)}: ${r.tsquery}`);
  }
});

test('hunt and searchParams always carry exactly the database names', () => {
  for (const q of [...EXAMPLES, ...fuzzCorpus(300)]) {
    const r = parseQuery(q, { homePostalCode: '53202' });
    assert.deepEqual(Object.keys(r.hunt).sort(), HUNT_COLUMNS, q);
    assert.deepEqual(Object.keys(r.searchParams).sort(), SEARCH_PARAMS, q);
  }
});

test('values are always shaped the way search_lots needs them', () => {
  const sorts = new Set(['relevance', 'nearest', 'cheapest', 'closing', 'newest', 'sleeper']);
  for (const q of [...EXAMPLES, ...fuzzCorpus(600)]) {
    const r = parseQuery(q);
    const p = r.searchParams;
    for (const cents of [p.p_min_cents, p.p_max_cents, r.hunt.min_price_cents, r.hunt.max_price_cents]) {
      assert.ok(cents === null || (Number.isSafeInteger(cents) && cents >= 0), `${q}: cents ${cents}`);
    }
    assert.ok(Number.isInteger(p.p_radius_miles) && p.p_radius_miles >= 1, `${q}: radius`);
    // An empty array is not "no filter" in search_lots: `= any('{}')` is false.
    assert.ok(p.p_states === null || p.p_states.length > 0, `${q}: states`);
    assert.ok(p.p_tiers === null || p.p_tiers.length > 0, `${q}: tiers`);
    assert.equal(p.p_query === null, r.websearchQuery === '', `${q}: p_query`);
    assert.ok(p.p_query === null || p.p_query.trim().length > 0);
    assert.ok(sorts.has(p.p_sort));
    assert.ok(p.p_postal_code === null || /^\d{5}$/.test(p.p_postal_code));
    assert.ok(p.p_closing_within_hours === null || (Number.isInteger(p.p_closing_within_hours) && p.p_closing_within_hours >= 1));
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `${q}: confidence ${r.confidence}`);
    assert.equal(typeof r.hunt.include_shippable, 'boolean');
    assert.deepEqual(r.hunt.category_ids, []);
    assert.doesNotThrow(() => JSON.stringify(r.hunt));
    assert.ok(Array.isArray(r.explanation) && r.explanation.every((e) => typeof e === 'string' && e.length > 0));
  }
});

test('the parser never throws, whatever it is handed', () => {
  const junk: unknown[] = [undefined, null, 42, {}, [], 'x'.repeat(100000), '\uD800', '\u202E drone'];
  for (const j of junk) assert.doesNotThrow(() => parseQuery(j as string), String(j).slice(0, 20));
  assert.equal(parseQuery(null as unknown as string).websearchQuery, '');
});

test('overlong input is cut, and the explanation says so', () => {
  const r = parseQuery(`drone ${'x'.repeat(1000)}`);
  assert.ok(r.explanation.some((e) => e.includes('first 500 characters')));
});

// ---------------------------------------------------- injection and syntax

test('quotes, semicolons and comment markers never reach either string raw', () => {
  for (const q of [
    "drone'); drop table lots;--", "'; select pg_sleep(10); --", 'drone" or "1"="1', "drone\\'); --",
    'thermal $$ drone $$', 'drone /* comment */ uav', '(drone | uav) & thermal & !toy',
  ]) {
    const r = parseQuery(q);
    assert.ok(!/[';\\()/*$]/.test(r.websearchQuery), `websearch for ${q}: ${r.websearchQuery}`);
    const outsideOperands = r.tsquery.replace(/'[a-z0-9 .-]*'(:\*)?/g, '');
    assert.ok(!/[;\\/$"]/.test(outsideOperands), `tsquery for ${q}: ${r.tsquery}`);
    assert.equal(checkTsquery(r.tsquery), null);
  }
});

test('tsquery syntax typed by a user is read for meaning, not passed through', () => {
  // websearch_to_tsquery would silently turn "!toy" into a REQUIRED 'toy'.
  const r = parseQuery('(drone | uav) & thermal & !toy');
  assert.deepEqual(r.excludeTerms, ['toy']);
  assert.deepEqual(r.alternatives, [['drone', 'uav']]);
  assert.equal(r.websearchQuery, 'thermal drone -toy or thermal uav -toy');
});

test('an unbalanced quote is dropped rather than swallowing the rest of the query', () => {
  const r = parseQuery('"mavic 3 thermal under $500');
  assert.equal(r.maxPriceCents, 50000);
  assert.ok(!r.websearchQuery.includes('"') || (r.websearchQuery.match(/"/g) ?? []).length % 2 === 0);
});

test('a query of stop words produces no text search at all, not an empty one', () => {
  for (const q of ['the', 'and or not', 'of the', 'with a for']) {
    const r = parseQuery(q);
    assert.equal(r.searchParams.p_query, null, q);
    assert.equal(r.tsquery, '', q);
  }
});

test('either-or expansion is capped, and the tsquery keeps what websearch drops', () => {
  const r = parseQuery('a1 or b1 c1 or d1 e1 or f1 g1 or h1 i1 or j1');
  assert.equal(checkWebsearch(r.websearchQuery), null);
  assert.equal(checkTsquery(r.tsquery), null);
  assert.ok(r.alternatives.length >= 4);
  assert.ok(r.explanation.some((e) => e.includes('too many either-or choices')));
  assert.ok(!r.websearchQuery.includes(' or '));
});
