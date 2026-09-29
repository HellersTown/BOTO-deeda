/**
 * Natural-language search parsing.
 *
 * A buyer types "DJI drone with thermal under $1500 within 50 miles of 53202".
 * This file turns that into the columns of a hunt and the parameters of
 * search_lots. It follows the same rules as ingest/money.ts, for the same
 * reason: it decides what someone is shown, and a confident wrong reading costs
 * more trust than an honest "I could not tell".
 *
 * Three rules.
 *
 * 1. AMBIGUOUS INPUT IS REPORTED, NEVER GUESSED. "Beloit" is a city in Wisconsin
 *    and in Kansas; "$500" on its own could be a ceiling or a floor. Both come
 *    back flagged and explained, and neither becomes a filter. We never invent a
 *    ZIP: place names are resolved against postal_codes in the database.
 *
 * 2. MONEY IS INTEGER CENTS ASSEMBLED FROM DIGITS. No float ever touches an
 *    amount. Unlike money.ts, "1.5k" is accepted: a buyer typing their own budget
 *    is not ambiguous listing data, and "1.5k" can only mean $1,500.
 *
 * 3. WHAT WE HAND POSTGRES MUST MEAN WHAT WE THINK IT MEANS. websearchQuery is
 *    rebuilt from sanitised words, so websearch_to_tsquery reads exactly the
 *    structure we intended (it never throws, which is precisely why a bad string
 *    fails silently instead of loudly). tsquery is valid to_tsquery syntax with
 *    every operand quoted. Nothing the user typed reaches either string except
 *    as a sanitised word.
 */

import {
  AMBIGUOUS_STATE_NAMES,
  BRANDS,
  CATEGORIES,
  CONDITION_PHRASES,
  CONDITION_PREFERENCES,
  DEFECT_WORDS,
  FEATURES,
  FILLER_WORDS,
  FUNCTION_WORD_STATE_CODES,
  METAL_GRADES,
  NOT_PLACE_AFTER_IN,
  OVERLOADED_STATE_CODES,
  PG_ENGLISH_STOPWORDS,
  PLACE_PARTICLES,
  SORT_PHRASES,
  STATE_NAME_ALIASES,
  SYNONYM_GROUPS,
  TIER_PHRASES,
  TIMING_PHRASES,
  US_STATES,
} from './lexicon.ts';
import type {
  Brand,
  Category,
  Condition,
  Feature,
  SortKey,
  SourceTier,
  TimingWindow,
} from './lexicon.ts';

// ---------------------------------------------------------------- public API

export interface ParseOptions {
  /** Radius for "nearby", "local" and a bare ZIP. Defaults to 50, search_lots' own default. */
  defaultRadiusMiles?: number;
  /** The buyer's home ZIP: used for "near me", and when the query names no location at all. */
  homePostalCode?: string;
  /** Reference time for "ending today" and model-year bounds. Defaults to now; tests pin it. */
  now?: Date;
  /** IANA zone that "today", "tomorrow" and "this weekend" are read in. Defaults to America/Chicago. */
  timeZone?: string;
}

export interface PlaceRef {
  /** What was typed, lowercased. */
  raw: string;
  /** Title-cased city, or null when only a state was named. */
  city: string | null;
  /** USPS code, or null when the query did not say. */
  state: string | null;
  /** True when a city came without a state: the same name exists in more than one state. */
  ambiguous: boolean;
  /** True until the database turns the place into a ZIP. The parser never does. */
  needsResolution: boolean;
}

export interface ParsedLocation {
  postalCode: string | null;
  /** 'query' when typed, 'home' when taken from ParseOptions.homePostalCode. */
  postalCodeSource: 'query' | 'home' | null;
  place: PlaceRef | null;
  radiusMiles: number | null;
  /** True when radiusMiles was not typed but filled in from the default. */
  radiusIsDefault: boolean;
  states: string[];
  /** null when the query said nothing about shipping. */
  includeShippable: boolean | null;
}

export interface ParsedTiming {
  closingWithinHours: number | null;
  /** The words that set it, e.g. "ending today". */
  phrase: string | null;
}

/** A row for the hunts table: exactly its column names, ready to insert. */
export interface HuntInsert {
  query_text: string;
  parsed: ParsedSnapshot;
  keywords: string[];
  exclude_keywords: string[];
  brands: string[];
  required_terms: string[];
  min_price_cents: number | null;
  max_price_cents: number | null;
  conditions: Condition[];
  postal_code: string | null;
  radius_miles: number | null;
  states: string[];
  include_shippable: boolean;
  category_ids: number[];
  tiers_only: SourceTier[];
  min_sleeper_score: number | null;
}

/** Arguments for search_lots(): exactly its parameter names. */
export interface SearchLotsParams {
  p_query: string | null;
  p_postal_code: string | null;
  p_radius_miles: number;
  p_include_shippable: boolean;
  p_states: string[] | null;
  p_min_cents: number | null;
  p_max_cents: number | null;
  p_tiers: SourceTier[] | null;
  p_closing_within_hours: number | null;
  p_min_sleeper: number | null;
  p_sort: SortKey;
}

export interface ParsedQuery {
  /** Verbatim input. */
  input: string;
  /** Single words every match must contain, lowercased, filler removed. */
  terms: string[];
  /** Multi-word units kept together: "mavic 3", "f-150", "john deere". */
  phrases: string[];
  /** Canonical brand names. */
  brands: string[];
  /** Model designators read from the query. Never from a dictionary. */
  models: string[];
  /** Category slugs from lexicon.CATEGORIES. */
  categories: string[];
  /** Must-have attributes: thermal, 4x4, 14k. */
  features: string[];
  /** For each term or phrase, the other words that mean the same thing. */
  synonyms: Record<string, string[]>;
  excludeTerms: string[];
  /** Either-or choices the buyer typed with "or", e.g. [["f-150", "silverado"]]. */
  alternatives: string[][];
  minPriceCents: number | null;
  maxPriceCents: number | null;
  minYear: number | null;
  maxYear: number | null;
  location: ParsedLocation;
  conditions: Condition[];
  timing: ParsedTiming;
  sort: SortKey;
  tiers: SourceTier[];
  minSleeperScore: number | null;
  /** True when the query is for something PaddleUp does not list (real estate). */
  outOfScope: boolean;
  /** Safe for websearch_to_tsquery('english', ...): no synonym groups. Empty when there is nothing to match. */
  websearchQuery: string;
  /** Valid to_tsquery('english', ...) syntax with synonym groups. Empty when there is nothing to match. */
  tsquery: string;
  hunt: HuntInsert;
  searchParams: SearchLotsParams;
  /** Plain-English lines for the UI's "I read this as ..." panel. */
  explanation: string[];
  /** Tokens that were deliberately not used, each with a reason in the explanation. */
  unparsed: string[];
  /** 0 to 1: how much of the query was understood without ambiguity. */
  confidence: number;
}

/** What hunts.parsed stores: the whole interpretation, minus the two derived objects. */
export type ParsedSnapshot = Omit<ParsedQuery, 'hunt' | 'searchParams'>;

// ----------------------------------------------------------------- constants

/** search_lots' own default, so an unstated radius means the same thing everywhere. */
const DEFAULT_RADIUS_MILES = 50;
const MAX_RADIUS_MILES = 3000;
/**
 * A search box, not a document. Anything longer is almost certainly pasted
 * listing text, and every rule below is linear in tokens anyway.
 */
const MAX_INPUT_CHARS = 500;
/** "Closing soon" matches the sleeper score's own 12-hour "closes soon" window. */
const SOON_HOURS = 12;
/** Wisconsin first. */
const DEFAULT_TIME_ZONE = 'America/Chicago';
/**
 * The biggest either-or expansion we will spell out for websearch. Each "or"
 * group multiplies the clause count; past this the websearch form drops the
 * alternatives (the tsquery form keeps them) and says so.
 */
const MAX_OR_CLAUSES = 16;
const MIN_MODEL_YEAR = 1900;

// -------------------------------------------------------------- text helpers

/** Lowercase and strip accents, so "Pokémon" and "pokemon" are one word. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * The single normalisation every lexicon key and every query word goes
 * through, so they can be compared as plain strings: lowercase, accents gone,
 * apostrophes and abbreviation dots removed ("u.s." is "us", "levi's" is
 * "levis"), decimal points kept (".999"), "&" and "and" dropped ("black &
 * decker" and "black and decker" are the same key), any other punctuation a
 * word break.
 */
export function normalizeKey(s: string): string {
  return fold(s)
    .replace(/['\u2019]/g, '')
    .replace(/&/g, ' ')
    .replace(/(^|\D)\.(?=\d)/g, '$1\u0001')
    .replace(/(\d)\.(?=\d)/g, '$1\u0001')
    .replace(/\./g, '')
    .replace(/\u0001/g, '.')
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && w !== 'and')
    .join(' ');
}

function isStop(w: string): boolean {
  return PG_ENGLISH_STOPWORDS.has(w);
}

function isFiller(w: string): boolean {
  return FILLER_WORDS.has(w) || PG_ENGLISH_STOPWORDS.has(w);
}

/** "green bay" -> "Green Bay", keeping place particles lowercase inside a name. */
function titleCase(words: readonly string[]): string {
  return words
    .map((w, i) => (i > 0 && (w === 'du' || w === 'de' || w === 'la' || w === 'des' || w === 'le')
      ? w
      : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** "$1,500.00" for explanations. Integer arithmetic only. */
function formatCents(cents: number): string {
  const dollars = Math.trunc(cents / 100).toLocaleString('en-US');
  const rest = String(cents % 100).padStart(2, '0');
  return rest === '00' ? `$${dollars}` : `$${dollars}.${rest}`;
}

// ------------------------------------------------------------------ tokenizer

type Role =
  | 'quote' | 'exclude' | 'shipping' | 'sort' | 'sleeper' | 'timing' | 'year'
  | 'price' | 'radius' | 'nearby' | 'zip' | 'place' | 'state' | 'condition'
  | 'tier' | 'lexicon' | 'model' | 'quantity' | 'or' | 'term' | 'filler'
  | 'unparsed' | 'noise';

interface Token {
  /** As typed, case kept (the place rule looks at capitals). */
  raw: string;
  /** Folded: lowercase, no accents, no apostrophes, abbreviation dots gone. */
  text: string;
  /** normalizeKey(text) as words: what lexicon keys are compared against. */
  parts: string[];
  punct: boolean;
  /** Whitespace (or the start of input) directly before this token. */
  gapBefore: boolean;
  role: Role | null;
}

/** Characters that always end a word. A comma inside "1,500" does not. */
const BREAK_CHARS = new Set('"()[]{};:!?<>=|*^~\\`#@,'.split(''));

function isThousandsComma(s: string, i: number): boolean {
  return s[i] === ',' && /\d/.test(s[i - 1] ?? '') && /^\d{3}(?!\d)/.test(s.slice(i + 1));
}

function punctToken(sym: string, gapBefore: boolean): Token {
  return { raw: sym, text: sym, parts: [], punct: true, gapBefore, role: null };
}

function wordText(raw: string): string {
  let t = fold(raw).replace(/['\u2019]/g, '');
  if (t === 'w/o') return 'without';
  if (t === 'a/c') return 'ac';
  // Keep dots only where they are decimal points: "1.5k", ".999". Elsewhere a
  // dot is an abbreviation ("u.s.", "dr.") and would split one word into two.
  if (!/^\$?\.?\d/.test(t)) t = t.replace(/\./g, '');
  return t;
}

function wordToken(raw: string, gapBefore: boolean): Token {
  const text = wordText(raw);
  const parts = normalizeKey(text).split(' ').filter(Boolean);
  // "and" has no parts but is a real word: it joins "black and decker".
  const punct = parts.length === 0 && text !== 'and';
  return { raw, text, parts, punct, gapBefore, role: null };
}

function pushChunk(tokens: Token[], chunk: string, gapBefore: boolean): void {
  let c = chunk;
  let gap = gapBefore;
  // A leading dash is an exclusion marker ("-replica"), or a separator. Either
  // way it is its own token so the exclusion rule can see it.
  while (c.startsWith('-')) {
    tokens.push(punctToken('-', gap));
    gap = false;
    c = c.slice(1);
  }
  c = c.replace(/^(?:['+/&]|\.(?!\d))+/, '').replace(/['.\-/&]+$/, '');
  if (c === '') return;
  tokens.push(wordToken(c, gap));
}

/**
 * Split on whitespace and on characters that never belong inside a search
 * word. Quotes, parentheses and semicolons become their own tokens, which is
 * what makes an injection-shaped query harmless: "drone'); drop table lots;--"
 * is just the words drone, drop, table and lots, plus punctuation we ignore.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const isBreak = (k: number): boolean => BREAK_CHARS.has(input[k]) && !isThousandsComma(input, k);
  let gap = true;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      gap = true;
      i++;
      continue;
    }
    if (isBreak(i)) {
      const sym = (ch === '<' || ch === '>') && input[i + 1] === '=' ? `${ch}=` : ch;
      tokens.push(punctToken(sym, gap));
      gap = false;
      i += sym.length;
      continue;
    }
    let j = i;
    while (j < input.length && !/\s/.test(input[j]) && !isBreak(j)) j++;
    pushChunk(tokens, input.slice(i, j), gap);
    gap = false;
    i = j;
  }
  return tokens;
}

/** Curly quotes, dashes and odd spaces to plain ASCII, so rules see one form. */
function normalizeInput(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u0000-\u001F\u007F\u00A0\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, ' ');
}

// ------------------------------------------------------------ phrase indexes

interface IndexKey<T> {
  words: readonly string[];
  payloads: T[];
}

/**
 * Phrases grouped by first word, longest first, so every rule is a longest
 * match: "lawn tractor" beats "tractor", "new holland" beats "new", "art deco"
 * beats "art".
 */
class PhraseIndex<T> {
  private readonly byFirst = new Map<string, IndexKey<T>[]>();
  private sorted = true;

  add(phrase: string, payload: T): void {
    const words = normalizeKey(phrase).split(' ').filter(Boolean);
    if (words.length === 0) return;
    let list = this.byFirst.get(words[0]);
    if (!list) {
      list = [];
      this.byFirst.set(words[0], list);
    }
    const joined = words.join(' ');
    const existing = list.find((k) => k.words.join(' ') === joined);
    if (existing) existing.payloads.push(payload);
    else list.push({ words, payloads: [payload] });
    this.sorted = false;
  }

  candidates(first: string): readonly IndexKey<T>[] {
    if (!this.sorted) {
      for (const list of this.byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);
      this.sorted = true;
    }
    return this.byFirst.get(first) ?? [];
  }
}

type LexEntry =
  | { kind: 'brand'; brand: Brand; ambiguous: boolean }
  | { kind: 'family'; brand: Brand }
  | { kind: 'category'; category: Category }
  | { kind: 'feature'; feature: Feature }
  /** A multi-word synonym ("chest of drawers"): kept together, classifies nothing. */
  | { kind: 'segment' };

/** Plural of the last word, so "lawn tractors" matches "lawn tractor". */
function pluralForms(key: string): string[] {
  const words = key.split(' ');
  const last = words[words.length - 1];
  if (!/^[a-z]{3,}$/.test(last) || last.endsWith('s')) return [];
  let plural: string;
  if (/[^aeiou]y$/.test(last)) plural = `${last.slice(0, -1)}ies`;
  else if (/(x|ch|sh|z)$/.test(last)) plural = `${last}es`;
  else plural = `${last}s`;
  return [[...words.slice(0, -1), plural].join(' ')];
}

/**
 * Brands, product lines, categories, features and multi-word synonyms in ONE
 * index. It has to be one: matched in separate passes, "art deco" would lose
 * "art" to the art category before the style feature ever saw it.
 */
function buildLexicon(): PhraseIndex<LexEntry> {
  const idx = new PhraseIndex<LexEntry>();
  const addCompact = (key: string, entry: LexEntry): void => {
    idx.add(key, entry);
    // "snapon", "johndeere", "ezgo": multi-word names typed run together.
    const compact = key.replace(/ /g, '');
    if (compact !== key && compact.length >= 4) idx.add(compact, entry);
  };
  for (const brand of BRANDS) {
    const ambiguous = new Set((brand.ambiguous ?? []).map((f) => normalizeKey(f)));
    for (const form of [brand.name, ...(brand.aliases ?? [])]) {
      const key = normalizeKey(form);
      addCompact(key, { kind: 'brand', brand, ambiguous: ambiguous.has(key) });
    }
    for (const family of brand.families ?? []) addCompact(normalizeKey(family), { kind: 'family', brand });
  }
  for (const category of CATEGORIES) {
    for (const synonym of new Set([...category.synonyms, ...(category.broad ?? [])])) {
      const key = normalizeKey(synonym);
      idx.add(key, { kind: 'category', category });
      for (const plural of pluralForms(key)) idx.add(plural, { kind: 'category', category });
    }
  }
  for (const feature of FEATURES) {
    for (const form of feature.forms) idx.add(form, { kind: 'feature', feature });
  }
  for (const group of SYNONYM_GROUPS) {
    for (const member of group) {
      if (normalizeKey(member).includes(' ')) idx.add(member, { kind: 'segment' });
    }
  }
  return idx;
}

function buildIndex<T>(entries: Iterable<readonly [string, T]>): PhraseIndex<T> {
  const idx = new PhraseIndex<T>();
  for (const [phrase, payload] of entries) idx.add(phrase, payload);
  return idx;
}

const SHIPPING_NO = [
  'pickup only', 'pick up only', 'local pickup', 'local pickup only', 'local pick up',
  'no shipping', 'no ship', 'doesnt ship', 'does not ship', 'wont ship', 'will not ship',
  'not shipping', 'in person pickup', 'must pick up', 'must pickup', 'for pickup',
  'local only', 'pickup in person', 'pick up in person', 'no delivery',
];
const SHIPPING_YES = [
  'ships', 'shipping', 'will ship', 'can ship', 'free shipping', 'shipping available',
  'shippable', 'ship to me', 'ships to me', 'that ship', 'that ships', 'ships nationwide',
  'must ship', 'shipping only', 'ships only', 'ship only', 'delivery', 'delivered',
  'can be shipped', 'will be shipped',
];
const NEARBY_PHRASES = [
  'nearby', 'near me', 'close to me', 'around me', 'near here', 'around here', 'close by',
  'closeby', 'local', 'locally', 'in my area', 'my area', 'close to home', 'near home',
  'near my home', 'near my house', 'within driving distance', 'driving distance',
  'in the area', 'local area', 'in town', 'in my town',
];

interface Indexes {
  lexicon: PhraseIndex<LexEntry>;
  shipping: PhraseIndex<boolean>;
  sort: PhraseIndex<Exclude<SortKey, 'relevance'>>;
  timing: PhraseIndex<TimingWindow>;
  condition: PhraseIndex<Condition | 'preference'>;
  tier: PhraseIndex<readonly SourceTier[]>;
  nearby: PhraseIndex<true>;
  stateName: PhraseIndex<string>;
}

let indexes: Indexes | null = null;

/** Built once, on first use: parse.ts has no import-time cost. */
function getIndexes(): Indexes {
  if (indexes) return indexes;
  const stateNames: [string, string][] = US_STATES.map((s) => [s.name, s.code]);
  for (const [alias, code] of Object.entries(STATE_NAME_ALIASES)) stateNames.push([alias, code]);
  indexes = {
    lexicon: buildLexicon(),
    shipping: buildIndex([
      ...SHIPPING_NO.map((p) => [p, false] as const),
      ...SHIPPING_YES.map((p) => [p, true] as const),
    ]),
    sort: buildIndex(SORT_PHRASES.map((s) => [s.phrase, s.sort] as const)),
    timing: buildIndex(Object.entries(TIMING_PHRASES).flatMap(
      ([window, phrases]) => phrases.map((p) => [p, window as TimingWindow] as const),
    )),
    condition: buildIndex([
      ...Object.entries(CONDITION_PHRASES).flatMap(
        ([condition, phrases]) => phrases.map((p) => [p, condition as Condition] as const),
      ),
      ...CONDITION_PREFERENCES.map((p) => [p, 'preference'] as const),
    ]),
    tier: buildIndex(TIER_PHRASES.map((t) => [t.phrase, t.tiers] as const)),
    nearby: buildIndex(NEARBY_PHRASES.map((p) => [p, true] as const)),
    stateName: buildIndex(stateNames),
  };
  return indexes;
}

const STATE_CODES: ReadonlyMap<string, string> = new Map(US_STATES.map((s) => [s.code.toLowerCase(), s.code]));

/** Synonym lookup: every member of a group maps to the others. */
let synonymMap: Map<string, string[]> | null = null;
function synonymsOf(key: string): string[] {
  if (!synonymMap) {
    synonymMap = new Map();
    for (const group of SYNONYM_GROUPS) {
      const members = group.map((m) => normalizeKey(m));
      for (const m of members) {
        const others = members.filter((o) => o !== m);
        synonymMap.set(m, [...new Set([...(synonymMap.get(m) ?? []), ...others])]);
      }
    }
    for (const [grade, stamps] of Object.entries(METAL_GRADES)) {
      const g = normalizeKey(grade);
      synonymMap.set(g, [...new Set([...(synonymMap.get(g) ?? []), ...stamps.map((s) => normalizeKey(s))])]);
    }
  }
  const direct = synonymMap.get(key);
  if (direct) return direct;
  // "laptops" should find the "laptop" group. Only for the lookup: the word the
  // buyer typed is still the one searched for, Postgres stems it anyway.
  for (const singular of singularForms(key)) {
    const hit = synonymMap.get(singular);
    if (hit) return [singular, ...hit];
  }
  return [];
}

function singularForms(key: string): string[] {
  const out: string[] = [];
  if (/ies$/.test(key)) out.push(key.replace(/ies$/, 'y'));
  if (/(x|ch|sh|z)es$/.test(key)) out.push(key.replace(/es$/, ''));
  if (/[^s]s$/.test(key)) out.push(key.slice(0, -1));
  return out;
}

// ---------------------------------------------------------------- search units

type UnitSource =
  | 'brand' | 'family' | 'category' | 'feature' | 'segment' | 'model' | 'spec'
  | 'quoted' | 'year' | 'word';

/**
 * One thing the text search must find: a word ("drone"), or words that must be
 * adjacent ("john deere", "mavic 3"). Units are what both query strings and the
 * hunt's keyword columns are built from, so the three can never disagree.
 */
interface Unit {
  /** Normalised words; a hyphenated model like "f-150" stays one word. */
  words: string[];
  source: UnitSource;
  /** First token, for ordering units in the order they were typed. */
  at: number;
  /** Last token. */
  end: number;
  /** A category's generic label ("jewelry"): dropped when a specific word remains. */
  broad: boolean;
  /** Never dropped as a generic label: it disambiguates a brand ("lane furniture"). */
  pinned: boolean;
  /** Put ':*' on the last lexeme in the tsquery form (model designators only). */
  prefixLast: boolean;
  /** Other forms for the tsquery group: synonyms, brand spellings, model variants. */
  expansions: string[];
  brandEntries: { brand: Brand; ambiguous: boolean }[];
  familyOf: Brand[];
  categories: Category[];
  features: Feature[];
  /** Either-or group id, when the buyer typed "a or b". */
  alt: number | null;
}

function unitText(u: Unit): string {
  return u.words.join(' ');
}

/** A hyphen between a letter and a digit: Postgres reads "f-150" as 'f' then '-150'. */
function isHyphenNumeric(word: string): boolean {
  return /[a-z]-\d|\d-[a-z]/.test(word);
}

/** Phrase in the Postgres sense: more than one lexeme that must be adjacent. */
function isPhrase(u: Unit): boolean {
  return u.words.length > 1 || isHyphenNumeric(u.words[0] ?? '');
}

/**
 * Words for a token, the way Postgres will index them. Letter-digit hyphens
 * stay whole ("f-150"), because the parser reads "-150" as a signed number and
 * the same must happen on both sides. Letter-letter hyphens split ("mid-century"
 * becomes "mid century"), because the hyphenated form only matches listings
 * that also used the hyphen, while the phrase matches both.
 */
function tokenWords(tok: Token): string[] {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(tok.text) && isHyphenNumeric(tok.text)) return [tok.text];
  if (/^\d+\/\d+$/.test(tok.text)) return [tok.text];
  return tok.parts;
}

// ------------------------------------------------------------- money helpers

/**
 * Integer cents from the digits of an amount, the money.ts way: split on the
 * decimal point and assemble a digit string. No float ever touches the value.
 *
 * "k" multiplies by a thousand before the cents are appended, so "1.5k" is
 * "1" + "500" + "00" = 150000 cents. A plain amount with a three-digit fraction
 * ("1.500") is refused, exactly as in money.ts: it is $1,500 to a European
 * and $1.50 to a sloppy typist, and there is no reading we can defend.
 */
function amountToCents(intPart: string, frac: string | undefined, thousands: boolean): number | 'ambiguous' | null {
  const digits = intPart.replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return null;
  let assembled: string;
  if (thousands) {
    if (frac !== undefined && frac.length > 3) return 'ambiguous';
    assembled = digits + (frac ?? '').padEnd(3, '0') + '00';
  } else {
    if (frac !== undefined && frac.length > 2) return 'ambiguous';
    assembled = digits + (frac ?? '').padEnd(2, '0');
  }
  const n = Number(assembled.replace(/^0+(?=\d)/, ''));
  return Number.isSafeInteger(n) ? n : null;
}

const MONEY_RE = /^(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(k)?(\+)?$/;
const MONEY_RANGE_RE = /^(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(k)?-(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(k)?$/;

interface Amount {
  /** null when the digits were refused (see amountToCents). */
  cents: number | null;
  end: number;
  dollar: boolean;
  thousands: boolean;
  plus: boolean;
  text: string;
}

type Words = readonly (readonly string[])[];

const MAX_BEFORE: Words = [
  ['under'], ['below'], ['beneath'], ['less', 'than'], ['less', 'then'], ['lower', 'than'],
  ['cheaper', 'than'], ['no', 'more', 'than'], ['not', 'more', 'than'], ['not', 'over'],
  ['not', 'above'], ['no', 'higher', 'than'], ['not', 'to', 'exceed'], ['at', 'most'],
  ['up', 'to'], ['upto'], ['max'], ['maximum'], ['max', 'price'], ['maximum', 'price'],
  ['price', 'max'], ['max', 'of'], ['budget'], ['budget', 'of'], ['budget', 'is'],
  ['my', 'budget', 'is'], ['within'], ['<'], ['<='], ['spend', 'up', 'to'], ['pay', 'up', 'to'],
];
const MIN_BEFORE: Words = [
  ['over'], ['above'], ['more', 'than'], ['greater', 'than'], ['higher', 'than'], ['at', 'least'],
  ['min'], ['minimum'], ['min', 'price'], ['minimum', 'price'], ['no', 'less', 'than'],
  ['not', 'under'], ['>'], ['>='],
];
const APPROX_BEFORE: Words = [
  ['around'], ['about'], ['approximately'], ['approx'], ['roughly'], ['~'], ['ballpark'],
  ['close', 'to'], ['near'], ['like'],
];
const MAX_AFTER: Words = [
  ['or', 'less'], ['or', 'under'], ['or', 'below'], ['and', 'under'], ['and', 'below'], ['max'],
  ['maximum'], ['tops'], ['or', 'cheaper'], ['at', 'most'], ['or', 'lower'], ['and', 'less'],
];
const MIN_AFTER: Words = [
  ['or', 'more'], ['and', 'up'], ['and', 'above'], ['and', 'over'], ['or', 'higher'],
  ['or', 'above'], ['or', 'over'], ['minimum'], ['min'], ['plus'],
];
const RANGE_JOIN: Words = [['-'], ['to'], ['thru'], ['through']];

const DISTANCE_UNITS = new Set(['mi', 'mile', 'miles', 'km', 'kms', 'kilometer', 'kilometers', 'kilometre', 'kilometres']);
const TIME_UNITS = new Set(['hour', 'hours', 'hr', 'hrs', 'h', 'day', 'days', 'minute', 'minutes', 'mins', 'week', 'weeks']);
/** A number followed by one of these is a measurement, not a price or a ZIP. */
const MEASURE_UNITS = new Set([
  'v', 'volt', 'volts', 'w', 'watt', 'watts', 'hp', 'horsepower', 'amp', 'amps', 'gallon',
  'gallons', 'gal', 'ton', 'tons', 'lb', 'lbs', 'pound', 'pounds', 'ft', 'foot', 'feet',
  'inch', 'inches', 'cc', 'psi', 'btu', 'btus', 'kw', 'kva', 'gb', 'tb', 'mb', 'mp', 'megapixel',
  'cu', 'cubic', 'mm', 'cm', 'qt', 'quart', 'oz', 'ounce', 'ounces', 'cylinder', 'cyl',
  'speed', 'phase', 'pin', 'stroke', 'drawer', 'burner', 'door', 'seat', 'seater', 'person',
  'gauge', 'ga', 'caliber', 'cal', 'mah', 'ah', 'rpm', 'cfm', 'gpm', 'sq', 'acre', 'acres',
]);
const QUANTITY_UNITS = new Set(['pc', 'pcs', 'piece', 'pieces', 'count', 'ct', 'pk', 'pack', 'pair', 'pairs']);
/** "over 50 years old": an age, which no lot records as a field. */
const AGE_UNITS = new Set(['year', 'years', 'yr', 'yrs', 'yo']);
/** Words that turn a following number into a model designator: "model 3", "series 7". */
const MODEL_WORDS = new Set(['model', 'series', 'type', 'mark', 'mk', 'gen', 'generation', 'version', 'no', 'number', 'version']);
const EXTRA_FILLER = new Set(['obo', 'ono', 'thx', 'ty', 'lol', 'ok', 'okay', 'yes', 'yeah', 'hmm']);
const PLACE_SUFFIXES = new Set(['area', 'region', 'vicinity', 'metro', 'surrounding', 'areas']);

// ------------------------------------------------------------------ calendar

interface LocalTime { weekday: number; seconds: number }

function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const seconds = (Number(get('hour')) % 24) * 3600 + Number(get('minute')) * 60 + Number(get('second'));
  return { weekday: weekday < 0 ? 0 : weekday, seconds };
}

/**
 * p_closing_within_hours is relative to now, but "ending today" is a calendar
 * statement. At 10pm, "today" means within 2 hours, not within 24: reading it
 * as 24 would show tomorrow afternoon's lots under a label that says today.
 * Rounded up, so a lot closing at 11:59pm is never cut off.
 */
function hoursUntil(window: TimingWindow, now: Date, timeZone: string): number {
  if (window === 'soon') return SOON_HOURS;
  const local = localTime(now, timeZone);
  const leftToday = 86400 - local.seconds;
  let extraDays = 0;
  if (window === 'tomorrow') extraDays = 1;
  if (window === 'weekend' || window === 'week') extraDays = (7 - local.weekday) % 7;
  return Math.max(1, Math.ceil((leftToday + extraDays * 86400) / 3600));
}

const WINDOW_WORDS: Readonly<Record<TimingWindow, string>> = {
  today: 'before midnight today',
  soon: `within the next ${SOON_HOURS} hours (the same "closing soon" window the sleeper score uses)`,
  tomorrow: 'before midnight tomorrow',
  weekend: 'before the end of Sunday',
  week: 'before the end of Sunday',
};

// -------------------------------------------------------------------- parser

interface Bound { cents: number; text: string }

class Parser {
  readonly tokens: Token[];
  readonly idx = getIndexes();
  readonly notes: string[] = [];
  readonly unparsed: string[] = [];
  penalties = 0;

  units: Unit[] = [];
  excludes: Unit[] = [];
  models: string[] = [];
  /** Units that sit right before a model number: "ram 1500" confirms Ram. */
  readonly beforeModel = new Set<Unit>();

  minPrice: Bound | null = null;
  maxPrice: Bound | null = null;
  minYear: number | null = null;
  maxYear: number | null = null;
  yearText: string | null = null;

  zips: string[] = [];
  place: PlaceRef | null = null;
  radius: number | null = null;
  radiusText: string | null = null;
  states: string[] = [];
  statesOnly = false;
  nearbyText: string | null = null;
  originCueAt = -1;

  shipping: boolean | null = null;
  shippingText: string | null = null;
  conditions = new Set<Condition>();
  conditionTexts: string[] = [];
  preferences: string[] = [];
  closingHours: number | null = null;
  timingText: string | null = null;
  /** How a calendar phrase was read, e.g. "before midnight today". */
  windowWords: string | null = null;
  sort: SortKey = 'relevance';
  sortText: string | null = null;
  tiers = new Set<SourceTier>();
  tierTexts: string[] = [];
  minSleeper: number | null = null;
  quantityTexts: string[] = [];

  readonly now: Date;
  readonly timeZone: string;

  // Plain fields, not constructor parameter properties: Node's type stripping
  // runs this file directly and does not support that syntax.
  constructor(input: string, now: Date, timeZone: string) {
    this.tokens = tokenize(input);
    this.now = now;
    this.timeZone = timeZone;
  }

  // ---- token helpers

  free(i: number): boolean {
    const t = this.tokens[i];
    return t !== undefined && t.role === null;
  }

  text(i: number): string {
    return this.tokens[i]?.text ?? '';
  }

  consume(from: number, to: number, role: Role): void {
    for (let k = from; k <= to; k++) {
      const t = this.tokens[k];
      if (t && t.role === null) t.role = role;
    }
  }

  span(from: number, to: number): string {
    return this.tokens.slice(from, to + 1).map((t) => t.text).join(' ').replace(/ ([,;:!?)])/g, '$1');
  }

  note(message: string, penalty = false): void {
    this.notes.push(message);
    if (penalty) this.penalties++;
  }

  /** Set aside words we will not guess at, and say why. */
  reject(from: number, to: number, message: string): void {
    this.unparsed.push(this.span(from, to));
    this.consume(from, to, 'unparsed');
    this.note(message, true);
  }

  /** Exact token texts from i. Returns the last index used, or -1. */
  seq(i: number, texts: readonly string[]): number {
    let k = i;
    for (const t of texts) {
      if (!this.free(k) || this.tokens[k].text !== t) return -1;
      k++;
    }
    return k - 1;
  }

  seqAny(i: number, options: Words): number {
    let best = -1;
    for (const o of options) best = Math.max(best, this.seq(i, o));
    return best;
  }

  /**
   * Match normalised words from token i. Each token must be consumed whole
   * (a key never matches half of "snap-on"), and "and" is skipped between
   * words so "black and decker" matches the key "black decker".
   */
  matchAt(i: number, words: readonly string[]): number {
    let t = i;
    let w = 0;
    while (w < words.length) {
      while (w > 0 && this.free(t) && this.tokens[t].text === 'and') t++;
      const tok = this.tokens[t];
      if (!tok || tok.role !== null || tok.punct || tok.parts.length === 0) return -1;
      if (w + tok.parts.length > words.length) return -1;
      for (let k = 0; k < tok.parts.length; k++) if (tok.parts[k] !== words[w + k]) return -1;
      w += tok.parts.length;
      t++;
    }
    return t - 1;
  }

  longest<T>(index: PhraseIndex<T>, i: number): { end: number; payloads: T[] } | null {
    const tok = this.tokens[i];
    if (!tok || tok.role !== null || tok.punct || tok.parts.length === 0) return null;
    for (const key of index.candidates(tok.parts[0])) {
      const end = this.matchAt(i, key.words);
      if (end >= 0) return { end, payloads: key.payloads };
    }
    return null;
  }

  scan<T>(index: PhraseIndex<T>, onMatch: (start: number, end: number, payloads: T[]) => boolean): void {
    for (let i = 0; i < this.tokens.length; i++) {
      const m = this.longest(index, i);
      if (m && onMatch(i, m.end, m.payloads)) i = m.end;
    }
  }

  /** Is token i (alone) a brand or product-line name? Used to tell "ford 2000" from "2000 ford". */
  isBrandish(i: number): boolean {
    const m = this.longest(this.idx.lexicon, i);
    return m !== null && m.end === i && m.payloads.some((p) => p.kind === 'brand' || p.kind === 'family');
  }

  makeUnit(words: string[], source: UnitSource, at: number, end: number): Unit {
    return {
      words, source, at, end, broad: false, pinned: false, prefixLast: false, expansions: [],
      brandEntries: [], familyOf: [], categories: [], features: [], alt: null,
    };
  }

  wordsOf(from: number, to: number): string[] {
    const out: string[] = [];
    for (let k = from; k <= to; k++) {
      const t = this.tokens[k];
      if (t && !t.punct && t.text !== 'and') out.push(...tokenWords(t));
    }
    return out;
  }

  /** Brands, categories and features named inside tokens from..to, without consuming them. */
  classify(unit: Unit, from: number, to: number): void {
    for (let k = from; k <= to; k++) {
      const m = this.longest(this.idx.lexicon, k);
      if (!m || m.end > to) continue;
      this.attach(unit, m.payloads);
      k = m.end;
    }
  }

  attach(unit: Unit, payloads: readonly LexEntry[]): void {
    for (const p of payloads) {
      if (p.kind === 'brand') unit.brandEntries.push({ brand: p.brand, ambiguous: p.ambiguous });
      else if (p.kind === 'family') unit.familyOf.push(p.brand);
      else if (p.kind === 'category') unit.categories.push(p.category);
      else if (p.kind === 'feature') unit.features.push(p.feature);
    }
  }

  // ---- "quoted phrases" the buyer wants kept together

  readQuoted(): void {
    const t = this.tokens;
    // 65" is 65 inches, not the start of a phrase. A quote that closes an
    // open phrase is never an inch mark, even right after a digit: "mini 2".
    let open = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i].text !== '"') continue;
      if (open) {
        open = false;
      } else if (i > 0 && !t[i].gapBefore && t[i - 1].role === null && /^\d+(?:\.\d+)?$/.test(t[i - 1].text)) {
        this.units.push(inchUnit(this.makeUnit([t[i - 1].text], 'spec', i - 1, i)));
        this.consume(i - 1, i, 'model');
      } else {
        open = true;
      }
    }
    for (let i = 0; i < t.length; i++) {
      if (t[i].text !== '"' || t[i].role !== null) continue;
      let j = i + 1;
      while (j < t.length && t[j].text !== '"') j++;
      if (j >= t.length) {
        // An unbalanced quote is dropped, never passed through: in websearch
        // syntax it would silently turn the rest of the query into one phrase.
        t[i].role = 'noise';
        continue;
      }
      const negated = i > 0 && (t[i - 1].text === '-' || t[i - 1].text === '!') && t[i - 1].role === null && !t[i].gapBefore;
      const words = this.wordsOf(i + 1, j - 1);
      if (words.length > 0) {
        const unit = this.makeUnit(words, 'quoted', i, j);
        this.classify(unit, i + 1, j - 1);
        (negated ? this.excludes : this.units).push(unit);
      }
      this.consume(i, j, 'quote');
      if (negated) t[i - 1].role = 'exclude';
      i = j;
    }
  }

  // ---- "-replica" (and "!replica"), the search-box way of excluding a word

  readDashExclusions(): void {
    const t = this.tokens;
    for (let i = 0; i < t.length - 1; i++) {
      if ((t[i].text !== '-' && t[i].text !== '!') || t[i].role !== null) continue;
      const next = t[i + 1];
      const startsWord = i === 0 || t[i].gapBefore || t[i - 1].punct;
      if (!startsWord || next.gapBefore || next.punct || next.role !== null) continue;
      // "-150" and "- 2015" are numbers and ranges, not exclusions.
      if (/^\$?\d/.test(next.text)) continue;
      const words = tokenWords(next);
      if (words.length === 0) continue;
      this.excludes.push(this.makeUnit(words, 'word', i + 1, i + 1));
      this.consume(i, i + 1, 'exclude');
    }
  }

  // ---- shipping

  readShipping(): void {
    const ITEM_AFTER = new Set(['container', 'containers', 'crate', 'crates', 'box', 'boxes', 'supplies', 'scale', 'label', 'labels', 'tape', 'bags', 'envelopes', 'cart']);
    const ITEM_BEFORE = new Set(['model', 'toy', 'war', 'battle', 'sailing', 'tall', 'pirate', 'cruise', 'space', 'rocket']);
    this.scan(this.idx.shipping, (start, end, payloads) => {
      const value = payloads[0];
      // "shipping container" and "model ships" are things to buy, not delivery terms.
      if (value && (ITEM_AFTER.has(this.text(end + 1)) || ITEM_BEFORE.has(this.text(start - 1)))) return false;
      const phrase = this.span(start, end);
      if (this.shipping === null) {
        this.shipping = value;
        this.shippingText = phrase;
      } else if (this.shipping !== value) {
        this.reject(start, end, `“${phrase}” contradicts “${this.shippingText}”, so I kept the first.`);
        return true;
      }
      this.consume(start, end, 'shipping');
      return true;
    });
  }

  // ---- sort order

  readSort(): void {
    this.scan(this.idx.sort, (start, end, payloads) => {
      const phrase = this.span(start, end);
      if (this.sortText === null) {
        this.sort = payloads[0];
        this.sortText = phrase;
        this.consume(start, end, 'sort');
      } else if (this.sort !== payloads[0]) {
        this.reject(start, end, `“${phrase}” asks for a different order than “${this.sortText}”, so I kept the first.`);
      } else {
        this.consume(start, end, 'sort');
      }
      return true;
    });
  }

  // ---- "sleeper score 6+"

  readSleeperScore(): void {
    for (let i = 0; i < this.tokens.length; i++) {
      let e = this.seqAny(i, [['sleeper', 'score'], ['sleeper', 'rating'], ['min', 'sleeper'], ['minimum', 'sleeper'], ['min', 'sleeper', 'score'], ['minimum', 'sleeper', 'score']]);
      if (e < 0) continue;
      const q = this.seqAny(e + 1, [['over'], ['above'], ['at', 'least'], ['>='], ['>'], ['min'], ['minimum'], ['of'], ['of', 'at', 'least']]);
      if (q >= 0) e = q;
      const m = /^(\d{1,2})(?:\.(\d))?\+?$/.exec(this.text(e + 1));
      if (!m || !this.free(e + 1)) continue;
      const score = Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
      if (score > 10) {
        this.reject(i, e + 1, `A sleeper score runs from 0 to 10, so I could not use “${this.span(i, e + 1)}”.`);
        continue;
      }
      this.minSleeper = score;
      this.consume(i, e + 1, 'sleeper');
      i = e + 1;
    }
  }

  // ---- closing time

  readTiming(): void {
    const LEAD: Words = [
      ['ending', 'in'], ['ends', 'in'], ['closing', 'in'], ['closes', 'in'], ['ending', 'within'],
      ['ends', 'within'], ['closing', 'within'], ['closes', 'within'], ['within'], ['in', 'the', 'next'],
      ['over', 'the', 'next'], ['within', 'the', 'next'], ['next'], ['in'],
    ];
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      const lead = this.seqAny(i, LEAD);
      const at = lead >= 0 ? lead + 1 : i;
      let n: number | null = null;
      let unit = '';
      let end = -1;
      const compact = /^(\d{1,3})(h|hr|hrs|hours?|d|days?)$/.exec(this.text(at));
      if (compact && this.free(at)) {
        n = Number(compact[1]);
        unit = compact[2];
        end = at;
      } else if (this.free(at) && this.free(at + 1) && (/^\d{1,3}$/.test(this.text(at)) || ['a', 'an', 'one'].includes(this.text(at)))) {
        n = /^\d+$/.test(this.text(at)) ? Number(this.text(at)) : 1;
        unit = this.text(at + 1);
        end = at + 1;
      }
      if (n === null || !/^(h|hr|hrs|hours?|d|days?|minutes?|mins|weeks?)$/.test(unit)) continue;
      // Without a lead word, only "48 hours left" style reads as a deadline.
      if (lead < 0) {
        const tail = this.seqAny(end + 1, [['left'], ['remaining'], ['to', 'go']]);
        if (tail < 0) continue;
        end = tail;
      }
      let hours: number;
      if (/^(d|days?)$/.test(unit)) hours = n * 24;
      else if (/^(minute|minutes|mins)$/.test(unit)) hours = Math.max(1, Math.ceil(n / 60));
      else if (/^(week|weeks)$/.test(unit)) hours = n * 24 * 7;
      else hours = n;
      if (hours < 1) continue;
      this.setTiming(hours, this.span(i, end));
      this.consume(i, end, 'timing');
      i = end;
    }
    this.scan(this.idx.timing, (start, end, payloads) => {
      const window = payloads[0];
      this.setTiming(hoursUntil(window, this.now, this.timeZone), this.span(start, end), window);
      this.consume(start, end, 'timing');
      return true;
    });
  }

  setTiming(hours: number, phrase: string, window?: TimingWindow): void {
    if (this.timingText !== null) {
      this.unparsed.push(phrase);
      this.note(`“${phrase}” sets a second closing time after “${this.timingText}”, so I kept the first.`, true);
      return;
    }
    this.closingHours = hours;
    this.timingText = phrase;
    if (window) this.windowWords = WINDOW_WORDS[window];
  }

  // ---- model years ("2015 or newer", "1960s", "pre-1970")

  readYears(): void {
    const maxYear = this.nowYear() + 1;
    const year = (s: string): number | null => {
      if (!/^\d{4}$/.test(s)) return null;
      const y = Number(s);
      return y >= MIN_MODEL_YEAR && y <= maxYear ? y : null;
    };
    const NEWER_AFTER: Words = [
      ['or', 'newer'], ['or', 'later'], ['or', 'up'], ['or', 'above'], ['or', 'after'], ['or', 'higher'],
      ['or', 'more', 'recent'], ['and', 'newer'], ['and', 'up'], ['and', 'later'], ['and', 'above'],
      ['and', 'after'], ['and', 'higher'], ['newer'], ['up'], ['onward'], ['onwards'],
    ];
    const OLDER_AFTER: Words = [
      ['or', 'older'], ['or', 'earlier'], ['or', 'before'], ['and', 'older'], ['and', 'earlier'],
      ['and', 'before'], ['older'],
    ];
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      const t = this.text(i);
      let m: RegExpExecArray | null;
      // "2015-2020"
      if ((m = /^(\d{4})-(\d{4})$/.exec(t)) && year(m[1]) && year(m[2])) {
        this.setYears(Math.min(+m[1], +m[2]), Math.max(+m[1], +m[2]), i, i);
        continue;
      }
      // "2015+"
      if ((m = /^(\d{4})\+$/.exec(t)) && year(m[1])) {
        this.setYears(+m[1], null, i, i);
        continue;
      }
      // "pre-1970"
      if ((m = /^pre-?(\d{4})$/.exec(t)) && year(m[1])) {
        this.setYears(null, +m[1] - 1, i, i);
        continue;
      }
      // "1960s", "60s"
      if ((m = /^(\d{4})s$/.exec(t)) || (m = /^([3-9]0)s$/.exec(t))) {
        const start = m[1].length === 2 ? 1900 + Number(m[1]) : Number(m[1]);
        if (m[1].length === 4 && (start % 10 !== 0 || start % 100 === 0)) {
          // "1900s" is a decade to some and a century to others.
          this.reject(i, i, `“${t}” could mean a decade or a whole century, so I did not filter by year.`);
          continue;
        }
        if (start >= MIN_MODEL_YEAR && start <= maxYear) {
          this.setYears(start, Math.min(start + 9, maxYear), i, i);
          continue;
        }
      }
      // "between 1950 and 1960", "from 1950 to 1960", "1950 to 1960", "1950 - 1960"
      const opener = this.seqAny(i, [['between'], ['from']]);
      const at = opener >= 0 ? opener + 1 : i;
      const y1 = year(this.text(at));
      if (y1 !== null && this.free(at)) {
        const join = this.seqAny(at + 1, opener >= 0 && this.text(i) === 'between' ? [['and'], ['to'], ['-']] : [['to'], ['-'], ['thru'], ['through']]);
        const y2 = join >= 0 ? year(this.text(join + 1)) : null;
        if (y2 !== null && this.free(join + 1)) {
          this.setYears(Math.min(y1, y2), Math.max(y1, y2), i, join + 1);
          i = join + 1;
          continue;
        }
      }
      // "newer than 2015", "after 2015", "since 2015", "older than 1970", "before 1970", "pre 1970"
      const before = this.seqAny(i, [['newer', 'than'], ['after'], ['since'], ['from'], ['older', 'than'], ['before'], ['pre'], ['prior', 'to']]);
      if (before >= 0) {
        const y = year(this.text(before + 1));
        if (y !== null && this.free(before + 1) && !this.unitFollows(before + 1)) {
          const lead = this.span(i, before);
          if (lead === 'newer than' || lead === 'after') this.setYears(y + 1, null, i, before + 1);
          else if (lead === 'since' || lead === 'from') this.setYears(y, null, i, before + 1);
          else this.setYears(null, y - 1, i, before + 1);
          i = before + 1;
          continue;
        }
      }
      const y = year(t);
      if (y === null) continue;
      // "2015 or newer", "1970 or older"
      const newer = this.seqAny(i + 1, NEWER_AFTER);
      if (newer >= 0) {
        this.setYears(y, null, i, newer);
        i = newer;
        continue;
      }
      const older = this.seqAny(i + 1, OLDER_AFTER);
      if (older >= 0) {
        this.setYears(null, y, i, older);
        i = older;
        continue;
      }
      // A bare year is exact, and it is also kept as a search word: listings
      // put the year in the title. After a brand it is a model number instead
      // ("ford 2000" is a tractor), and before a unit it is a measurement.
      if (this.unitFollows(i) || this.isPriceContext(i) || (i > 0 && this.isBrandish(i - 1))) continue;
      if (this.minYear === null && this.maxYear === null) {
        this.minYear = y;
        this.maxYear = y;
        this.yearText = t;
      }
      this.units.push(this.makeUnit([t], 'year', i, i));
      this.consume(i, i, 'year');
    }
  }

  nowYear(): number {
    return this.now.getUTCFullYear();
  }

  setYears(min: number | null, max: number | null, from: number, to: number): void {
    const phrase = this.span(from, to);
    if (this.yearText !== null) {
      this.reject(from, to, `“${phrase}” is a second year range after “${this.yearText}”, so I kept the first.`);
      return;
    }
    this.minYear = min;
    this.maxYear = max;
    this.yearText = phrase;
    this.consume(from, to, 'year');
  }

  unitFollows(i: number): boolean {
    const next = this.text(i + 1);
    return DISTANCE_UNITS.has(next) || TIME_UNITS.has(next) || MEASURE_UNITS.has(next) || QUANTITY_UNITS.has(next) || AGE_UNITS.has(next)
      || ['dollars', 'dollar', 'bucks', 'usd', 'k', 'grand', 'thousand'].includes(next);
  }

  /**
   * Is the number at i introduced as money? "near" and "around" only count
   * with a "$": "near 53202" is a place, "near $500" a price.
   */
  isPriceContext(i: number): boolean {
    for (const words of [...MAX_BEFORE, ...MIN_BEFORE]) {
      const from = i - words.length;
      if (from >= 0 && words.every((w, k) => this.text(from + k) === w)) return true;
    }
    return this.text(i - 1) === '$';
  }

  // ---- radius ("within 50 miles", "25mi radius", "50-mile radius")

  readRadius(): void {
    const LEAD: Words = [
      ['within'], ['under'], ['less', 'than'], ['no', 'more', 'than'], ['not', 'more', 'than'],
      ['up', 'to'], ['inside'], ['max'], ['maximum'], ['no', 'farther', 'than'], ['no', 'further', 'than'],
      ['radius', 'of'], ['radius'], ['a', 'radius', 'of'], ['in', 'a'], ['in'], ['below'], ['fewer', 'than'],
    ];
    const TAIL: Words = [['radius'], ['away'], ['out'], ['or', 'less'], ['or', 'closer'], ['max'], ['drive']];
    const ORIGIN: Words = [['of'], ['from'], ['around'], ['near'], ['to']];
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      // Drive time is a real request we cannot serve: say so instead of guessing a distance.
      const drive = this.seqAny(i, [['within', 'an', 'hour'], ['within', 'a', 'hour'], ['an', 'hour', 'drive'], ['hour', 'drive'], ['hours', 'drive'], ['minute', 'drive'], ['minutes', 'drive'], ['minutes', 'away']]);
      if (drive >= 0) {
        const from = /^\d+$/.test(this.text(i - 1)) && this.free(i - 1) ? i - 1 : i;
        this.reject(from, drive, `I cannot search by drive time (“${this.span(from, drive)}”). Give a distance, like “within 30 miles”.`);
        i = drive;
        continue;
      }
      const lead = this.seqAny(i, LEAD);
      const at = lead >= 0 ? lead + 1 : i;
      if (!this.free(at)) continue;
      let digits: string | null = null;
      let unit = '';
      let k = false;
      let end = at;
      const t = this.text(at);
      let m: RegExpExecArray | null;
      if ((m = /^(\d{1,3}(?:,\d{3})*|\d+)(k)?(mi|miles?|km|kms)$/.exec(t))) {
        digits = m[1];
        k = m[2] === 'k';
        unit = m[3];
      } else if ((m = /^(\d{1,5})-(mile|mi|km)$/.exec(t))) {
        digits = m[1];
        unit = m[2];
      } else if ((m = /^(\d{1,3}(?:,\d{3})*|\d+)(k)?$/.exec(t)) && this.free(at + 1) && DISTANCE_UNITS.has(this.text(at + 1))) {
        digits = m[1];
        k = m[2] === 'k';
        unit = this.text(at + 1);
        end = at + 1;
      } else if (lead >= 0 && this.text(i) === 'radius' && /^\d{1,4}$/.test(t)) {
        // "radius 50": the word radius makes the unit miles.
        digits = t;
        unit = 'mi';
      }
      if (digits === null) continue;
      const leadText = lead >= 0 ? this.span(i, lead) : '';
      // "under 100k miles" is an odometer reading, not a search radius.
      const n = Number(digits.replace(/,/g, '')) * (k ? 1000 : 1);
      const odometerLead = ['under', 'less than', 'below', 'fewer than', 'no more than', 'not more than', 'up to', 'max', 'maximum'].includes(leadText);
      if (k || (odometerLead && n > 500) || (lead < 0 && n > 1000)) {
        this.reject(i, end, `“${this.span(i, end)}” reads as vehicle mileage, which lots do not record as a searchable field, so I left it out rather than treat it as a distance.`);
        i = end;
        continue;
      }
      const tail = this.seqAny(end + 1, TAIL);
      if (tail >= 0) end = tail;
      const km = /^k/.test(unit);
      // Integer maths for kilometres too: miles = km * 1000 / 1609.344, rounded.
      const miles = km ? Math.floor((n * 1_000_000 + 804_672) / 1_609_344) : n;
      if (miles < 1 || miles > MAX_RADIUS_MILES) {
        this.reject(i, end, `A radius of “${this.span(i, end)}” is outside the 1 to ${MAX_RADIUS_MILES} miles I can search.`);
        i = end;
        continue;
      }
      if (this.radius !== null) {
        this.reject(i, end, `“${this.span(i, end)}” is a second distance after “${this.radiusText}”, so I kept the first.`);
        i = end;
        continue;
      }
      this.radius = miles;
      this.radiusText = this.span(i, end);
      this.consume(i, end, 'radius');
      // "within 50 miles of 53202": the next word introduces the origin.
      const origin = this.seqAny(end + 1, ORIGIN);
      if (origin >= 0) this.originCueAt = origin;
      i = end;
    }
  }

  // ---- price

  readAmount(i: number): Amount | null {
    let k = i;
    let dollar = false;
    if (this.text(k) === '$' && this.free(k)) {
      dollar = true;
      k++;
    }
    if (!this.free(k)) return null;
    const m = MONEY_RE.exec(this.text(k));
    if (!m) return null;
    dollar ||= m[1] === '$';
    let thousands = m[4] === 'k';
    let end = k;
    if (!thousands && m[3] === undefined && this.free(end + 1) && ['k', 'thousand', 'grand'].includes(this.text(end + 1))) {
      thousands = true;
      end++;
    }
    if (this.free(end + 1) && ['dollars', 'dollar', 'bucks', 'buck', 'usd'].includes(this.text(end + 1))) {
      dollar = true;
      end++;
    }
    const cents = amountToCents(m[2], m[3], thousands);
    return {
      cents: typeof cents === 'number' ? cents : null,
      end, dollar, thousands, plus: m[5] === '+', text: this.span(i, end),
    };
  }

  setPrice(kind: 'min' | 'max', cents: number, from: number, to: number): void {
    const phrase = this.span(from, to);
    const current = kind === 'min' ? this.minPrice : this.maxPrice;
    if (current !== null && current.cents !== cents) {
      this.reject(from, to, `“${phrase}” sets a second ${kind === 'min' ? 'minimum' : 'maximum'} price after “${current.text}”, so I kept the first.`);
      return;
    }
    const bound = { cents, text: phrase };
    if (kind === 'min') this.minPrice = bound;
    else this.maxPrice = bound;
    this.consume(from, to, 'price');
  }

  refuseAmount(from: number, to: number): void {
    this.reject(from, to, `I could not read “${this.span(from, to)}” as an exact amount (a three-digit decimal like 1.500 could be $1,500 or $1.50), so I set no price.`);
  }

  readPrices(): void {
    const n = this.tokens.length;
    for (let i = 0; i < n; i++) {
      if (!this.free(i)) continue;

      // "between 50 and 100", "from $50 to $100"
      const opener = this.seqAny(i, [['between'], ['from']]);
      if (opener >= 0) {
        const a = this.readAmount(opener + 1);
        const join = a ? this.seqAny(a.end + 1, this.text(i) === 'between' ? [['and'], ['to'], ['-']] : [['to'], ['-']]) : -1;
        const b = join >= 0 ? this.readAmount(join + 1) : null;
        if (a && b && !this.unitFollows(b.end) && (this.text(i) === 'between' || a.dollar || b.dollar)) {
          if (a.cents === null || b.cents === null) this.refuseAmount(i, b.end);
          else this.setRange(a.cents, b.cents, i, b.end);
          i = b.end;
          continue;
        }
      }

      // Qualifier first: "under $1,500", "at most 2k", "budget 400".
      const max = this.seqAny(i, MAX_BEFORE);
      const min = max >= 0 ? -1 : this.seqAny(i, MIN_BEFORE);
      const approx = max >= 0 || min >= 0 ? -1 : this.seqAny(i, APPROX_BEFORE);
      const q = Math.max(max, min, approx);
      if (q >= 0) {
        const a = this.readAmount(q + 1);
        if (a) {
          const next = this.text(a.end + 1);
          if (TIME_UNITS.has(next)) {
            // "under 500 hours" is how tractors are sold: engine hours, not money.
            this.reject(i, a.end + 1, `“${this.span(i, a.end + 1)}” looks like equipment hours, which lots do not record as a searchable field, so I left it out.`);
            i = a.end + 1;
            continue;
          }
          if (DISTANCE_UNITS.has(next) || MEASURE_UNITS.has(next) || QUANTITY_UNITS.has(next) || AGE_UNITS.has(next)) continue;
          if (approx >= 0) {
            if (!a.dollar && !a.thousands) continue;
            this.reject(i, a.end, `“${this.span(i, a.end)}” has no firm limit, so I set no price. Try “under” or “over” an amount.`);
            i = a.end;
            continue;
          }
          if (a.cents === null) {
            this.refuseAmount(i, a.end);
          } else if (max >= 0) {
            this.setPrice('max', a.cents, i, a.end);
          } else {
            this.setPrice('min', a.cents, i, a.end);
          }
          i = a.end;
          continue;
        }
      }

      // Amount first.
      const single = MONEY_RANGE_RE.exec(this.text(i));
      if (single) {
        // "$50-$100" in one token. Without a $ it could be anything ("50-100 pcs").
        const moneyAfter = ['dollars', 'bucks', 'usd'].includes(this.text(i + 1));
        if (single[1] || single[5] || moneyAfter) {
          const a = amountToCents(single[2], single[3], single[4] === 'k');
          const b = amountToCents(single[6], single[7], single[8] === 'k' || (single[4] === 'k' && !single[8]));
          const end = moneyAfter ? i + 1 : i;
          if (typeof a === 'number' && typeof b === 'number') this.setRange(a, b, i, end);
          else this.refuseAmount(i, end);
          i = end;
        }
        continue;
      }
      const a = this.readAmount(i);
      if (!a) continue;
      // "$50 - $100", "$50 to $100"
      const join = this.seqAny(a.end + 1, RANGE_JOIN);
      const b = join >= 0 ? this.readAmount(join + 1) : null;
      if (b && (a.dollar || b.dollar) && !this.unitFollows(b.end)) {
        if (a.cents === null || b.cents === null) this.refuseAmount(i, b.end);
        else this.setRange(a.cents, b.cents, i, b.end);
        i = b.end;
        continue;
      }
      if (this.unitFollows(a.end)) continue;
      // Postfix: "$500 or less", "300 max", "$500+", "$500 and up"
      const maxAfter = this.seqAny(a.end + 1, MAX_AFTER);
      const minAfter = this.seqAny(a.end + 1, MIN_AFTER);
      if (maxAfter >= 0 || ((minAfter >= 0 || a.plus) && (a.dollar || a.thousands))) {
        const end = Math.max(maxAfter, minAfter, a.end);
        if (a.cents === null) this.refuseAmount(i, end);
        else this.setPrice(maxAfter >= 0 ? 'max' : 'min', a.cents, i, end);
        i = end;
        continue;
      }
      // A bare "$500" could be a ceiling or a floor. Rule 1: say so, do not guess.
      if (a.dollar) {
        this.reject(i, a.end, `I saw “${a.text}” but not whether it is a most or a least, so I set no price. Try “under ${a.text}” or “over ${a.text}”.`);
        i = a.end;
      }
    }
    if (this.minPrice && this.maxPrice && this.minPrice.cents > this.maxPrice.cents) {
      const low = this.maxPrice;
      this.maxPrice = this.minPrice;
      this.minPrice = low;
      this.note('The minimum price was above the maximum, so I swapped them.');
    }
  }

  setRange(a: number, b: number, from: number, to: number): void {
    if (this.minPrice !== null || this.maxPrice !== null) {
      this.reject(from, to, `“${this.span(from, to)}” is a second price range, so I kept the first.`);
      return;
    }
    const phrase = this.span(from, to);
    this.minPrice = { cents: Math.min(a, b), text: phrase };
    this.maxPrice = { cents: Math.max(a, b), text: phrase };
    this.consume(from, to, 'price');
  }

  // ---- "nearby", "near me", "local"

  readNearby(): void {
    this.scan(this.idx.nearby, (start, end) => {
      this.nearbyText ??= this.span(start, end);
      this.consume(start, end, 'nearby');
      return true;
    });
  }

  // ---- ZIP codes

  readZips(): void {
    const CUE: Words = [
      ['near'], ['of'], ['from'], ['around'], ['in'], ['zip'], ['zipcode'], ['zip', 'code'],
      ['postal', 'code'], ['postal'], ['at'], ['by'], ['close', 'to'], ['near', 'zip'], ['in', 'zip'],
      ['around', 'zip'], ['to'],
    ];
    const content = this.tokens.map((t, k) => (t.punct ? -1 : k)).filter((k) => k >= 0);
    const first = content[0];
    const last = content[content.length - 1];
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      const m = /^(\d{5})(?:-\d{4})?$/.exec(this.text(i));
      if (!m) continue;
      if (this.unitFollows(i) || this.isPriceContext(i)) continue;
      // Find a cue word ending right before the ZIP.
      let cueStart = -1;
      for (const cue of CUE) {
        const from = i - cue.length;
        const matches = from >= 0 && cue.every((w, k) => this.text(from + k) === w && this.free(from + k));
        if (matches && (cueStart < 0 || from < cueStart)) cueStart = from;
      }
      const cued = cueStart >= 0 || this.originCueAt === i - 1;
      const edge = i === first || i === last;
      if (!cued && !edge) continue;
      const n = Number(m[1]);
      if (n < 501 || n > 99950) {
        this.reject(i, i, `“${m[1]}” is not a US ZIP code, so I did not use it as a location.`);
        continue;
      }
      if (!this.zips.includes(m[1])) this.zips.push(m[1]);
      const from = cueStart >= 0 ? cueStart : this.originCueAt === i - 1 ? i - 1 : i;
      let to = i;
      if (['area', 'region', 'vicinity'].includes(this.text(i + 1))) to = i + 1;
      this.consume(from, to, 'zip');
    }
  }

  // ---- places ("near Madison WI", "in Green Bay, Wisconsin", "around Beloit")

  /**
   * A state named at token i: [code, last index] or null.
   *
   * 'alone'  - no context at all: ambiguous names and overloaded codes need
   *            capitals ("MI"), function-word codes never count.
   * 'suffix' - right after a town: overloaded codes are fine ("madison wi",
   *            "portland pa"), function-word codes still need capitals, and
   *            ambiguous names do not count ("george washington").
   * 'cue'    - after "in", "near", "only": everything counts, function-word
   *            codes still need capitals ("in IN").
   */
  stateAt(i: number, mode: 'alone' | 'suffix' | 'cue'): [string, number] | null {
    if (!this.free(i)) return null;
    const named = this.longest(this.idx.stateName, i);
    if (named) {
      const name = normalizeKey(this.span(i, named.end));
      if (mode === 'cue' || !AMBIGUOUS_STATE_NAMES.has(name)) return [named.payloads[0], named.end];
    }
    const t = this.text(i);
    const code = STATE_CODES.get(t);
    if (!code) return null;
    const upper = this.tokens[i].raw === code;
    if (FUNCTION_WORD_STATE_CODES.has(t) && !(mode !== 'alone' && upper)) return null;
    if (OVERLOADED_STATE_CODES.has(t) && mode === 'alone' && !upper) return null;
    return [code, i];
  }

  /** Could token i be part of a city name? */
  placeWord(i: number): boolean {
    const t = this.tokens[i];
    if (!t || t.role !== null || t.punct) return false;
    if (!/^[a-z][a-z'.-]*$/.test(t.text)) return false;
    if (PLACE_PARTICLES.has(t.text)) return true;
    // "the madison area": the suffix ends the name, it is not part of it.
    if (PLACE_SUFFIXES.has(t.text)) return false;
    if (isFiller(t.text) || EXTRA_FILLER.has(t.text)) return false;
    // Words the lexicon owns outright (a category, a feature, a brand that is
    // never anything else) end the place name. Ambiguous brands do not:
    // Milwaukee, Lincoln and Manitowoc are cities first.
    for (let j = Math.max(0, i - 3); j < i; j++) {
      const before = this.longest(this.idx.lexicon, j);
      // "bin" in "grain bin" is not a town word; "bend" in "south bend" is.
      if (before && before.end >= i && !before.payloads.every((p) => p.kind === 'brand' && p.ambiguous)) return false;
    }
    const m = this.longest(this.idx.lexicon, i);
    if (m && !m.payloads.every((p) => p.kind === 'brand' && p.ambiguous)) return false;
    const phraseTables: PhraseIndex<unknown>[] = [this.idx.condition, this.idx.tier, this.idx.sort, this.idx.timing];
    for (const table of phraseTables) {
      if (this.longest(table, i)) return false;
    }
    return !MAX_BEFORE.some((w) => w[0] === t.text) && !MIN_BEFORE.some((w) => w[0] === t.text);
  }

  readPlaces(): void {
    const CUES: Words = [
      ['near'], ['around'], ['close', 'to'], ['outside'], ['outside', 'of'], ['in'], ['near', 'to'],
      ['in', 'the'], ['around', 'the'], ['near', 'the'],
    ];
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      let cueEnd = this.seqAny(i, CUES);
      if (cueEnd < 0 && this.originCueAt === i) cueEnd = i;
      if (cueEnd < 0) continue;
      const cue = this.span(i, cueEnd);
      const isIn = cue === 'in' || cue === 'in the';
      const start = cueEnd + 1;
      // "near new", "near mint": condition words, not places. But "near new
      // glarus" is New Glarus: "new" followed by a town word starts the name.
      const newTown = this.text(start) === 'new' && this.free(start) && this.placeWord(start + 1)
        && !NOT_PLACE_AFTER_IN.has(this.text(start + 1));
      if (!newTown && ['new', 'mint', 'perfect', 'complete', 'flawless'].includes(this.text(start))) continue;

      // "in wisconsin", "near WI": a state and nothing more.
      const direct = this.stateAt(start, 'cue');
      if (direct && !this.placeWord(direct[1] + 1)) {
        this.addState(direct[0], i, direct[1]);
        i = direct[1];
        continue;
      }

      // Up to four words of a town name.
      const words: number[] = newTown ? [start] : [];
      let k = newTown ? start + 1 : start;
      while (words.length < 4 && this.placeWord(k)) {
        // A state after at least one town word ends the name: "madison wi".
        if (words.length > 0 && this.stateAt(k, 'suffix') && !this.placeWord(k + 1)) break;
        words.push(k);
        k++;
      }
      if (words.length === 0) continue;
      let end = words[words.length - 1];
      let state: string | null = null;
      const comma = this.text(end + 1) === ',' && this.free(end + 1);
      const after = this.stateAt(comma ? end + 2 : end + 1, comma ? 'cue' : 'suffix');
      if (after) {
        state = after[0];
        end = after[1];
      }
      const capitalised = words.every((w) => /^[A-Z]/.test(this.tokens[w].raw));
      // After "in", a lowercase word is only a town if it is plainly not an
      // item attribute ("in box", "in stock", "in black") or a state follows.
      if (isIn && state === null && !capitalised && words.some((w) => NOT_PLACE_AFTER_IN.has(this.text(w)))) continue;
      if (isIn && state === null && !capitalised && words.length > 2) continue;
      end = this.setPlace(i, start, words, state, end);
      i = end;
    }

    // "fond du lac wi", "Madison, WI": a town and its state with no cue word.
    // The state is what makes this safe to read as a place.
    for (let i = 0; i < this.tokens.length; i++) {
      const s = this.stateAt(i, 'suffix');
      if (!s) continue;
      let k = i - 1;
      if (this.text(k) === ',' && this.free(k)) k--;
      const words: number[] = [];
      while (k >= 0 && words.length < 3 && this.placeWord(k)) {
        words.unshift(k);
        k--;
      }
      // Wisconsin alone has New Berlin, New Glarus, New Richmond and New London.
      if (words.length > 0 && k >= 0 && this.text(k) === 'new' && this.free(k)
        && !['brand', 'like', 'near', 'almost', 'never', 'as'].includes(this.text(k - 1))) {
        words.unshift(k);
      }
      if (words.length === 0 || words.every((w) => PLACE_PARTICLES.has(this.text(w)))) continue;
      i = this.setPlace(words[0], words[0], words, s[0], s[1]);
    }
  }

  /** Record a town (with or without state). Returns the last token used. */
  setPlace(from: number, start: number, words: readonly number[], state: string | null, end: number): number {
    const cityRaw = words.map((w) => this.tokens[w].raw.replace(/[.']/g, ''));
    const capitalised = cityRaw.every((w) => /^[A-Z]/.test(w));
    const city = capitalised ? cityRaw.join(' ') : titleCase(words.map((w) => this.text(w).replace(/[.']/g, '')));
    let last = end;
    if (PLACE_SUFFIXES.has(this.text(last + 1))) last++;
    const raw = this.span(start, last);
    if (this.place !== null) {
      this.reject(from, last, `“${raw}” is a second place after “${this.place.raw}”. I can search around one place at a time, so I kept the first.`);
      return last;
    }
    this.place = { raw, city, state, ambiguous: state === null, needsResolution: true };
    if (state === null) this.penalties++;
    this.consume(from, last, 'place');
    // "near madison or milwaukee": the second town is not a search word.
    const or = this.seqAny(last + 1, [['or'], ['and'], [','], ['or', 'near'], ['and', 'near'], ['or', 'around']]);
    if (or >= 0 && this.placeWord(or + 1)) {
      let k = or + 1;
      while (this.placeWord(k + 1) && k - or < 3) k++;
      const st = this.stateAt(k + 1, 'suffix');
      if (st) k = st[1];
      this.reject(last + 1, k, `“${this.span(or + 1, k)}” is a second place after “${raw}”. I can search around one place at a time, so I kept the first.`);
      return k;
    }
    return last;
  }

  addState(code: string, from: number, to: number): void {
    if (!this.states.includes(code)) this.states.push(code);
    this.consume(from, to, 'state');
  }

  // ---- states on their own ("wisconsin", "WI only", "only in MN")

  readStates(): void {
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      // "only in wisconsin", "only wi"
      const only = this.seqAny(i, [['only', 'in'], ['only']]);
      if (only >= 0) {
        const s = this.stateAt(only + 1, 'cue');
        if (s) {
          this.addState(s[0], i, s[1]);
          this.statesOnly = true;
          i = s[1];
          continue;
        }
      }
      const s = this.stateAt(i, 'alone') ?? this.stateAt(i, 'cue');
      if (!s) continue;
      const tail = this.seqAny(s[1] + 1, [['only'], ['state'], ['state', 'only']]);
      const standalone = this.stateAt(i, 'alone') !== null;
      if (tail < 0 && !standalone) continue;
      // A state name at the front of a longer lexicon key belongs to that key:
      // "pennsylvania house" is a furniture maker.
      const lex = this.longest(this.idx.lexicon, i);
      if (lex && lex.end > s[1]) continue;
      // "12 ga", "10 ct", "5 mi": a code after a number is a unit.
      if (/^\d/.test(this.text(i - 1))) continue;
      this.addState(s[0], i, tail >= 0 ? tail : s[1]);
      if (tail >= 0 && this.span(s[1] + 1, tail).includes('only')) this.statesOnly = true;
      i = tail >= 0 ? tail : s[1];
    }
  }

  // ---- measurements ("5 hp", "12000 btu", "12 ga")
  //
  // Before the lexicon, which would otherwise read the "hp" of "5 hp" as the
  // brand HP, and before states, which would read the "ga" of "12 ga" as Georgia.

  readMeasures(): void {
    for (let i = 0; i < this.tokens.length - 1; i++) {
      const t = this.text(i);
      if (!this.free(i) || !this.free(i + 1) || !/^\d+(?:\.\d+|\/\d+)?$/.test(t) || !MEASURE_UNITS.has(this.text(i + 1))) continue;
      const unit = this.makeUnit([t, this.text(i + 1)], 'spec', i, i + 1);
      this.units.push(/^inch(es)?$/.test(this.text(i + 1)) ? inchUnit(unit) : unit);
      this.consume(i, i + 1, 'model');
      i++;
    }
  }

  // ---- condition

  readConditions(): void {
    const ALL: readonly Condition[] = ['new', 'used', 'refurbished', 'parts'];
    this.scan(this.idx.condition, (start, end, payloads) => {
      const value = payloads[0];
      const phrase = this.span(start, end);
      if (value === 'preference') {
        this.preferences.push(phrase);
        this.consume(start, end, 'condition');
        return true;
      }
      // "not broken", "no used": the complement of what follows.
      const negator = ['not', 'no', 'isnt', 'never'].includes(this.text(start - 1)) && this.free(start - 1)
        && !/^(not|non|doesnt|does)\b/.test(phrase);
      if (negator) {
        for (const c of ALL) if (c !== value) this.conditions.add(c);
        this.conditionTexts.push(this.span(start - 1, end));
        this.consume(start - 1, end, 'condition');
        return true;
      }
      this.conditions.add(value);
      this.conditionTexts.push(phrase);
      this.consume(start, end, 'condition');
      return true;
    });
  }

  // ---- seller type

  readTiers(): void {
    this.scan(this.idx.tier, (start, end, payloads) => {
      const phrase = this.span(start, end);
      // "estate jewelry" is a style of jewelry sold everywhere; "real estate" is land.
      if (phrase === 'estate' && (['jewelry', 'jewellery'].includes(this.text(end + 1)) || this.text(start - 1) === 'real')) return false;
      // "federal reserve note" is a banknote, "federal signal" a siren maker.
      if (phrase === 'federal' && ['reserve', 'signal'].includes(this.text(end + 1))) return false;
      if (phrase === 'private' && ['property', 'land', 'collection', 'road', 'label'].includes(this.text(end + 1))) return false;
      for (const tier of payloads[0]) this.tiers.add(tier);
      this.tierTexts.push(phrase);
      this.consume(start, end, 'tier');
      return true;
    });
  }

  // ---- "no replicas", "without thermal", "not X"

  readExclusions(): void {
    const NEGATORS: Words = [
      ['no'], ['not'], ['without'], ['exclude'], ['excludes'], ['excluding'], ['except'],
      ['but', 'not'], ['minus'], ['nothing'], ['avoid'], ['skip'], ['never'],
    ];
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      // "no reserve" is a selling format, the opposite of an exclusion.
      const reserve = this.seqAny(i, [['no', 'reserve'], ['no', 'reserve', 'price']]);
      if (reserve >= 0) {
        const unit = this.makeUnit(['no', 'reserve'], 'feature', i, reserve);
        unit.features.push(FEATURES.find((f) => f.name === 'no reserve') as Feature);
        this.units.push(unit);
        this.consume(i, reserve, 'lexicon');
        i = reserve;
        continue;
      }
      const neg = this.seqAny(i, NEGATORS);
      if (neg < 0) continue;
      let k = neg + 1;
      let end = neg;
      const targets: Unit[] = [];
      while (this.free(k) && !this.tokens[k].punct) {
        const t = this.text(k);
        // "no 5" is a number, "not the" a fragment: nothing to exclude.
        if (/^\d/.test(t) || isStop(t)) break;
        if (DEFECT_WORDS.has(t)) {
          this.reject(i, k, `I did not exclude “${t}”: listings that say “no ${t}” contain the word ${t}, so excluding it would hide the lots you want.`);
          end = -1;
          break;
        }
        const m = this.longest(this.idx.lexicon, k);
        const last = m ? m.end : k;
        const unit = this.makeUnit(this.wordsOf(k, last), 'word', k, last);
        if (m) this.attach(unit, m.payloads);
        targets.push(unit);
        end = last;
        // "no rockers or recliners", "no replicas, copies"
        const more = this.seqAny(last + 1, [['or'], ['nor'], [','], ['and'], ['or', 'any']]);
        if (more < 0 || !this.free(more + 1) || this.tokens[more + 1].punct || isStop(this.text(more + 1))) break;
        k = more + 1;
      }
      if (end < 0) continue;
      if (targets.length === 0) continue;
      this.excludes.push(...targets);
      this.consume(i, end, 'exclude');
      i = end;
    }
  }

  // ---- "a or b"

  markOr(): void {
    for (let i = 1; i < this.tokens.length - 1; i++) {
      // "|" is how people who know search syntax write "or".
      const or = this.text(i) === 'or' || this.text(i) === '|';
      if (this.free(i) && or && !this.tokens[i - 1].punct && !this.tokens[i + 1].punct) {
        this.tokens[i].role = 'or';
      }
    }
  }

  // ---- brands, product lines, categories, features

  /** Payloads of a lexicon key covering exactly tokens from..to, or null. */
  exactKey(from: number, to: number): LexEntry[] | null {
    const tok = this.tokens[from];
    if (!tok || tok.parts.length === 0) return null;
    for (const key of this.idx.lexicon.candidates(tok.parts[0])) {
      if (this.matchAt(from, key.words) === to) return key.payloads;
    }
    return null;
  }

  readLexicon(): void {
    this.scan(this.idx.lexicon, (start, end, payloads) => {
      // "indian motorcycle", "lane furniture": a brand name that ends in a
      // category word. As one phrase it would miss "Indian Chief Motorcycle",
      // so when the leading words are themselves a name of the same brand,
      // keep them as the brand and the category word as its own required
      // word. "mac tools" stays a phrase: "mac" alone is not Mac Tools.
      const brands = payloads.flatMap((p) => (p.kind === 'brand' ? [p.brand] : []));
      if (brands.length > 0 && end > start) {
        const head = this.exactKey(start, end - 1);
        const tail = this.exactKey(end, end);
        const same = head?.filter((p) => p.kind === 'brand' && brands.includes(p.brand)) ?? [];
        if (same.length > 0 && tail?.some((p) => p.kind === 'category')) {
          const brandUnit = this.makeUnit(this.wordsOf(start, end - 1), 'brand', start, end - 1);
          for (const p of same) if (p.kind === 'brand') brandUnit.brandEntries.push({ brand: p.brand, ambiguous: false });
          const tailUnit = this.makeUnit(this.wordsOf(end, end), 'category', end, end);
          this.attach(tailUnit, tail.filter((p) => p.kind !== 'brand'));
          tailUnit.pinned = true;
          this.units.push(brandUnit, tailUnit);
          this.consume(start, end, 'lexicon');
          return true;
        }
      }
      const kinds = new Set(payloads.map((p) => p.kind));
      const source: UnitSource = kinds.has('brand') ? 'brand' : kinds.has('family') ? 'family'
        : kinds.has('category') ? 'category' : kinds.has('feature') ? 'feature' : 'segment';
      let words = this.wordsOf(start, end);
      // Every word a stop word ("can am" typed apart): Postgres would drop the
      // whole unit, so use the hyphenated form it indexes as one lexeme.
      if (words.every(isStop)) words = [words.join('-')];
      // "Black & Decker" is also written "Black and Decker", and "and" is a
      // stop word that still occupies a position, so the phrase 'black' <->
      // 'decker' would miss it. Names with an ampersand become separate words.
      if (words.length > 1 && payloads.some((p) => p.kind === 'brand' && /&|\band\b/i.test(p.brand.name))) {
        const first = this.makeUnit([words[0]], 'brand', start, start);
        this.attach(first, payloads);
        this.units.push(first);
        words.slice(1).forEach((w, k) => this.units.push(this.makeUnit([w], 'word', start + k + 1, end)));
        this.consume(start, end, 'lexicon');
        return true;
      }
      const unit = this.makeUnit(words, source, start, end);
      this.attach(unit, payloads);
      this.units.push(unit);
      this.consume(start, end, 'lexicon');
      return true;
    });
  }

  // ---- model numbers, measurements, quantities

  readNumbers(): void {
    const byEnd = new Map<number, Unit>();
    for (const u of this.units) byEnd.set(u.end, u);
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.free(i)) continue;
      const t = this.text(i);

      // "lot of 10", "set of 4", "qty 5", "x10"
      const qty = this.seqAny(i, [['lot', 'of'], ['set', 'of'], ['pack', 'of'], ['box', 'of'], ['pallet', 'of'], ['case', 'of'], ['qty'], ['quantity'], ['x']]);
      if (qty >= 0 && /^\d{1,4}$/.test(this.text(qty + 1)) && this.free(qty + 1)) {
        this.quantityTexts.push(this.span(i, qty + 1));
        this.consume(i, qty + 1, 'quantity');
        i = qty + 1;
        continue;
      }
      if (/^x\d{1,4}$/.test(t)) {
        this.quantityTexts.push(t);
        this.consume(i, i, 'quantity');
        continue;
      }

      const isNum = /^\d{1,5}$/.test(t);
      const prev = byEnd.get(i - 1);

      // "over 50 years old", "10 yrs": an age. Lots do not record one, so say so.
      if (/^\d{1,3}$/.test(t) && this.free(i + 1) && AGE_UNITS.has(this.text(i + 1))) {
        const from = this.free(i - 1) && ['over', 'under', 'at', 'least', 'than', 'about', 'around'].includes(this.text(i - 1)) ? i - 1 : i;
        const to = this.free(i + 2) && this.text(i + 2) === 'old' ? i + 2 : i + 1;
        this.reject(from, to, `Age (“${this.span(from, to)}”) is not something lots record, so I left it out. “vintage” or a year range like “1960s” can be searched.`);
        i = to;
        continue;
      }
      // "2000 hours" on its own is engine hours or a deadline; we cannot tell.
      if (isNum && this.free(i + 1) && TIME_UNITS.has(this.text(i + 1))) {
        this.reject(i, i + 1, `“${this.span(i, i + 1)}” could be engine hours or a deadline, so I left it out. For a deadline, say “ending within 48 hours”.`);
        i++;
        continue;
      }
      // "3/8" (a socket drive), "12.9" (a screen): measurements, searched as typed.
      if (/^\d+\/\d+$/.test(t) || /^\d+\.\d+$/.test(t)) {
        this.units.push(this.makeUnit([t], 'spec', i, i));
        this.consume(i, i, 'model');
        continue;
      }

      // "mavic 3", "model 3": a product line or model word, then a number.
      if (isNum && t.length <= 4 && prev && (prev.source === 'family' || prev.source === 'segment') && prev.words.length === 1) {
        prev.words.push(t);
        prev.source = 'model';
        prev.prefixLast = true;
        prev.end = i;
        this.models.push(unitText(prev));
        this.consume(i, i, 'model');
        byEnd.set(i, prev);
        continue;
      }
      if (isNum && t.length <= 4 && MODEL_WORDS.has(this.text(i - 1)) && this.free(i - 1)) {
        const unit = this.makeUnit([this.text(i - 1), t], 'model', i - 1, i);
        unit.prefixLast = true;
        this.units.push(unit);
        this.models.push(unitText(unit));
        this.consume(i - 1, i, 'model');
        byEnd.set(i, unit);
        continue;
      }
      // "ram 1500", "cat 320", "deere 4020": a brand, then its model number.
      if ((isNum && t.length >= 3) || /^(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)) {
        if (prev && prev.source === 'brand') this.beforeModel.add(prev);
      }

      if (/^\d+(?:\.\d+)?$/.test(t) && this.free(i + 1) && QUANTITY_UNITS.has(this.text(i + 1))) {
        this.quantityTexts.push(this.span(i, i + 1));
        this.consume(i, i + 1, 'quantity');
        i++;
        continue;
      }

      // "5k" with no qualifier: a price we cannot place, or a 5k run.
      if (/^\$?\d+(?:\.\d+)?k\+?$/.test(t)) {
        this.reject(i, i, `I could not tell what “${t}” is (a price needs “under” or “over”), so I left it out.`);
        continue;
      }

      // Letters and digits together are a model designator: f-150, 3t, d6, s650.
      if (/^(?=.*[a-z])(?=.*\d)[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(t)) {
        const words = tokenWords(this.tokens[i]);
        const unit = this.makeUnit(words.length ? words : [t], /^\d+(v|w|gb|tb|mb|hp|mah|ah|cc|psi|btu|ft|in|mm|cm|oz|lbs?|gal|qt|kw|mp|st|nd|rd|th)$/.test(t) ? 'spec' : 'model', i, i);
        if (unit.source === 'model') {
          // A letter-led designator ending in a digit gets a prefix match:
          // manufacturers append variant letters (D6 -> D6T, S650 -> S650X).
          unit.prefixLast = /^[a-z]+\d+$/.test(t);
          unit.expansions = modelVariants(t);
          this.models.push(t);
        }
        this.units.push(unit);
        this.consume(i, i, 'model');
        byEnd.set(i, unit);
        continue;
      }

      // "three drones": a count, not something to search for.
      if (/^\d{1,3}$/.test(t) && this.tokens[i + 1]?.role === 'lexicon' && /s$/.test(this.text(i + 1))) {
        this.quantityTexts.push(this.span(i, i + 1));
        this.consume(i, i, 'quantity');
        continue;
      }
      // An unknown word then a number: "phantom 4", "ms 261".
      if (isNum && t.length <= 4 && i > 0 && this.free(i - 1) && /^[a-z]{2,}$/.test(this.text(i - 1))
        && !isFiller(this.text(i - 1)) && !MEASURE_UNITS.has(this.text(i - 1))) {
        const unit = this.makeUnit([this.text(i - 1), t], 'model', i - 1, i);
        unit.prefixLast = true;
        // "ms 261" is catalogued as "MS261" and "MS-261" too.
        const compact = `${this.text(i - 1)}${t}`;
        unit.expansions = [...new Set([compact, ...modelVariants(compact)])].filter((v) => v !== unitText(unit));
        this.units.push(unit);
        this.models.push(unitText(unit));
        this.consume(i - 1, i, 'model');
        byEnd.set(i, unit);
        continue;
      }
      if (isNum && t.length >= 3) {
        const unit = this.makeUnit([t], 'model', i, i);
        this.units.push(unit);
        this.models.push(t);
        this.consume(i, i, 'model');
        byEnd.set(i, unit);
        continue;
      }
      if (/^\d/.test(t)) {
        this.reject(i, i, `A lone number (“${t}”) says nothing I can search for, so I left it out.`);
      }
    }
  }

  // ---- everything left is a plain search word, or filler

  readWords(): void {
    for (let i = 0; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.role !== null) continue;
      if (tok.punct) {
        tok.role = 'noise';
        continue;
      }
      if (tok.parts.every((p) => isFiller(p) || EXTRA_FILLER.has(p))) {
        tok.role = 'filler';
        continue;
      }
      const words = tokenWords(tok).filter((w) => /[a-z0-9]/.test(w));
      if (words.length === 1 && /^[a-z]$/.test(words[0])) {
        this.reject(i, i, `A single letter (“${words[0]}”) is too short to search for, so I left it out.`);
        continue;
      }
      if (words.length === 0) {
        tok.role = 'noise';
        continue;
      }
      this.units.push(this.makeUnit(words, 'word', i, i));
      tok.role = 'term';
    }
  }
}

/**
 * Postgres does not index the inch mark, so 'Samsung 65" TV' is just '65' to
 * the search. An inch measurement is searched as the number, with "65 inch"
 * and "65in" as alternatives in the tsquery form.
 */
function inchUnit(unit: Unit): Unit {
  const n = unit.words[0];
  unit.words = [n];
  unit.expansions = [`${n} inch`, `${n}in`];
  return unit;
}

/**
 * The spellings a model number appears under. Postgres indexes "F-150" as
 * 'f' then '-150', "F150" as 'f150' and "F 150" as 'f' then '150': three
 * different things, so the tsquery form asks for all three.
 */
function modelVariants(token: string): string[] {
  const m = /^([a-z]{1,4})-?(\d{2,5})$/.exec(token);
  if (!m) return [];
  return [`${m[1]}${m[2]}`, `${m[1]}-${m[2]}`, `${m[1]} ${m[2]}`].filter((v) => v !== token);
}

// ------------------------------------------------------------ query builders

/** Only characters with no operator meaning in either syntax survive. */
function sanitizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[^a-z0-9./-]/g, '')
    // A slash survives only inside a fraction: Postgres indexes "3/8" as one
    // lexeme, and nowhere else does a slash mean anything to either syntax.
    .replace(/\/(?!\d)|(?<!\d)\//g, '')
    .replace(/^[./-]+|[./-]+$/g, '')
    .replace(/([./-])[./-]+/g, '$1');
}

function cleanWords(words: readonly string[]): string[] | null {
  const clean = words.map(sanitizeWord).filter(Boolean);
  // A unit Postgres would reduce to nothing is never emitted: an all-stop-word
  // tsquery is empty, and `search_tsv @@ <empty>` is false for every row.
  if (clean.length === 0 || clean.every(isStop)) return null;
  return clean;
}

/** One websearch atom: a bare word, or a quoted phrase. Never an operator. */
function wsAtom(words: readonly string[]): string | null {
  const clean = cleanWords(words);
  if (!clean) return null;
  if (clean.length === 1 && !isHyphenNumeric(clean[0])) return clean[0];
  return `"${clean.join(' ')}"`;
}

/**
 * websearch_to_tsquery has no grouping: parentheses are read as punctuation
 * and discarded, and AND binds tighter than "or". So "dji (drone or uav)
 * thermal" silently becomes (dji & drone) | (uav & thermal). This form
 * therefore carries no synonym groups at all.
 *
 * The buyer's own "or" is honoured the only way the syntax allows: spelled out
 * in full, one clause per choice ("ford f-150 or ford silverado"), with the
 * exclusions repeated in every clause. That is exact, and it is capped.
 */
function buildWebsearch(fixed: readonly Unit[], groups: readonly Unit[][], excludes: readonly Unit[]): { query: string; droppedGroups: boolean } {
  const atoms = fixed.map((u) => wsAtom(u.words)).filter((a): a is string => a !== null);
  const negs = excludes.map((u) => wsAtom(u.words)).filter((a): a is string => a !== null).map((a) => `-${a}`);
  const choices = groups
    .map((g) => [...new Set(g.map((u) => wsAtom(u.words)).filter((a): a is string => a !== null))])
    .filter((g) => g.length > 0);
  const size = choices.reduce((n, g) => n * g.length, 1);
  if (choices.length === 0 || size > MAX_OR_CLAUSES) {
    return { query: [...atoms, ...negs].join(' '), droppedGroups: choices.length > 0 };
  }
  let clauses: string[][] = [[]];
  for (const g of choices) clauses = clauses.flatMap((c) => g.map((a) => [...c, a]));
  return { query: clauses.map((c) => [...atoms, ...c, ...negs].join(' ')).join(' or '), droppedGroups: false };
}

/** One quoted to_tsquery operand (a quoted multi-word operand becomes a phrase). */
function tsOperand(words: readonly string[], prefixLast: boolean): string | null {
  const clean = cleanWords(words);
  if (!clean) return null;
  if (!prefixLast) return `'${clean.join(' ')}'`;
  if (clean.length === 1) return `'${clean[0]}':*`;
  // Spell the adjacency out so the prefix lands on the model number alone:
  // 'mavic' <-> '3':* matches "Mavic 3T" and "Mavic 3 Pro", not "Mavicxyz".
  if (clean.some(isStop)) return `'${clean.join(' ')}'`;
  return `( ${clean.map((w, k) => (k === clean.length - 1 ? `'${w}':*` : `'${w}'`)).join(' <-> ')} )`;
}

function tsUnit(u: Unit): string | null {
  const forms = [
    tsOperand(u.words, u.prefixLast),
    ...u.expansions.map((e) => tsOperand(e.split(' '), false)),
  ].filter((f): f is string => f !== null);
  const unique = [...new Set(forms)];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0] : `( ${unique.join(' | ')} )`;
}

/**
 * Full boolean form for to_tsquery('english', ...): every synonym, brand
 * spelling and model variant as an OR group, exclusions as !( ... ).
 * search_lots cannot take this string today (it calls websearch_to_tsquery,
 * which would read "|" and "&" as punctuation and "!" as nothing); it is for a
 * to_tsquery-based caller such as the hunt matcher.
 */
function buildTsquery(fixed: readonly Unit[], groups: readonly Unit[][], excludes: readonly Unit[]): string {
  const parts = fixed.map(tsUnit).filter((s): s is string => s !== null);
  for (const g of groups) {
    const alts = [...new Set(g.map(tsUnit).filter((s): s is string => s !== null))];
    if (alts.length === 1) parts.push(alts[0]);
    else if (alts.length > 1) parts.push(`( ${alts.join(' | ')} )`);
  }
  for (const u of excludes) {
    const e = tsUnit(u);
    if (e) parts.push(e.startsWith('(') ? `!${e}` : `!( ${e} )`);
  }
  return parts.join(' & ');
}

// ---------------------------------------------------------------- assembling

function brandForms(brand: Brand): string[] {
  const forms = new Set<string>();
  for (const f of [brand.name, ...(brand.aliases ?? [])]) {
    const key = normalizeKey(f);
    const words = key.split(' ');
    // "can am" is all stop words; Postgres indexes "Can-Am" as one lexeme.
    forms.add(words.every(isStop) ? words.join('-') : key);
    if (words.length > 1) forms.add(words.join(''));
  }
  return [...forms];
}

function containsWords(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (haystack[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

const TIER_WORDS: Readonly<Record<SourceTier, string>> = {
  federal: 'federal', state: 'state', county: 'county', municipal: 'municipal', school: 'school',
  private: 'private auction houses', estate: 'estate sales', wholesale: 'liquidators',
  marketplace: 'marketplaces', dealer: 'dealers',
};
const SORT_WORDS: Readonly<Record<SortKey, string>> = {
  relevance: 'best match', nearest: 'nearest first', cheapest: 'cheapest first',
  closing: 'closing soonest', newest: 'newest listings first', sleeper: 'sleeper score (likely hidden gems) first',
};
const CONDITION_WORDS: Readonly<Record<Condition, string>> = {
  new: 'new', used: 'used', refurbished: 'refurbished', parts: 'for parts, not working or as-is',
};

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function assemble(p: Parser, input: string, opts: ParseOptions, defaultRadius: number, setupNotes: string[]): ParsedQuery {
  const explanation: string[] = [];
  const unitsInOrder = [...p.units].sort((a, b) => a.at - b.at);

  // Dedupe by text, first one wins.
  const seen = new Set<string>();
  const units = unitsInOrder.filter((u) => {
    const key = unitText(u);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const exSeen = new Set<string>();
  const excludes = p.excludes.filter((u) => {
    const key = unitText(u);
    if (exSeen.has(key)) return false;
    exSeen.add(key);
    if (seen.has(key)) {
      p.note(`“${key}” was both wanted and excluded, so I kept it as wanted.`, true);
      return false;
    }
    return true;
  });

  // Either-or groups: units joined by an "or" token with nothing but filler between.
  let nextAlt = 0;
  const endOf = (u: Unit): number => u.end;
  const quiet = (from: number, to: number): boolean => {
    for (let k = from; k <= to; k++) {
      const t = p.tokens[k];
      if (t && !(t.punct || t.role === 'filler' || t.role === 'noise' || t.role === null)) return false;
    }
    return true;
  };
  p.tokens.forEach((tok, k) => {
    if (tok.role !== 'or') return;
    const left = units.filter((u) => endOf(u) < k).sort((a, b) => endOf(b) - endOf(a))[0];
    const right = units.filter((u) => u.at > k).sort((a, b) => a.at - b.at)[0];
    if (!left || !right || !quiet(endOf(left) + 1, k - 1) || !quiet(k + 1, right.at - 1)) {
      tok.role = 'filler'; // an "or" with nothing to choose between is just a word
      return;
    }
    const id = left.alt ?? right.alt ?? nextAlt++;
    const old = right.alt;
    left.alt = id;
    right.alt = id;
    if (old !== null && old !== id) for (const u of units) if (u.alt === old) u.alt = id;
  });

  // Every word in the query, for brand cue words.
  const allWords = new Set(p.tokens.flatMap((t) => [t.text, ...t.parts]));
  const allText = ` ${p.tokens.map((t) => t.text).join(' ')} `;

  // Categories named by units, before brands are settled.
  const categoriesOf = (except: Unit | null): Set<string> =>
    new Set(units.filter((u) => u !== except).flatMap((u) => u.categories.map((c) => c.slug)));

  // Resolve brands. Ambiguous names need a second opinion from the query.
  const brandNames: string[] = [];
  const brandObjects: Brand[] = [];
  const addBrand = (b: Brand): void => {
    if (!brandNames.includes(b.name)) {
      brandNames.push(b.name);
      brandObjects.push(b);
    }
  };
  for (const u of units) {
    const confirmed: Brand[] = [];
    const doubtful: Brand[] = [];
    const cats = categoriesOf(u);
    const own = new Set(u.words);
    for (const e of u.brandEntries) {
      if (!e.ambiguous) {
        if (!confirmed.includes(e.brand)) confirmed.push(e.brand);
        continue;
      }
      const b = e.brand;
      const byCategory = (b.context ?? [b.category]).some((c) => cats.has(c));
      const byCue = (b.cues ?? []).some((c) => {
        const cue = normalizeKey(c);
        return !own.has(cue) && (cue.includes(' ') ? allText.includes(` ${cue} `) : allWords.has(cue));
      });
      if (byCategory || byCue || p.beforeModel.has(u)) {
        if (!confirmed.includes(b)) confirmed.push(b);
      } else if (!doubtful.includes(b)) {
        doubtful.push(b);
      }
    }
    if (confirmed.length > 0) {
      // The word named a brand, so it is not also a category ("fossil watch").
      if (u.source === 'brand') u.categories = [];
      for (const b of confirmed) addBrand(b);
      u.expansions = [...new Set(confirmed.flatMap(brandForms))].filter((f) => f !== unitText(u));
    } else if (doubtful.length > 0) {
      p.note(`“${unitText(u)}” can be the brand ${listWords(doubtful.map((b) => b.name))} or an ordinary word. Nothing else in the search pointed to the brand, so I kept it as a plain word.`, true);
    }
    for (const b of u.familyOf) {
      addBrand(b);
      p.note(`${titleCase([u.words[0]])} is a ${b.name} product line, so I read the brand as ${b.name}.`);
    }
  }

  // Categories: named ones first; a brand's usual category only if none was named.
  const categoryList: Category[] = [];
  for (const u of units) for (const c of u.categories) if (!categoryList.includes(c)) categoryList.push(c);
  if (categoryList.length === 0) {
    for (const b of brandObjects) {
      const c = CATEGORIES.find((x) => x.slug === b.category);
      if (c && !categoryList.includes(c)) categoryList.push(c);
    }
  }
  const positiveWords = units.flatMap((u) => u.words);
  const categories = categoryList.filter((c) => !c.negativeTerms.some((n) => containsWords(positiveWords, normalizeKey(n).split(' '))));
  const outOfScope = categories.some((c) => c.outOfScope);

  // Generic labels ("jewelry") are dropped when something specific remains.
  for (const u of units) {
    const text = unitText(u);
    u.broad = !u.pinned && u.source === 'category' && u.categories.some((c) => (c.broad ?? []).some((b) => normalizeKey(b) === text));
  }
  const specific = units.some((u) => !u.broad);
  const droppedBroad = specific ? units.filter((u) => u.broad) : [];
  const active = units.filter((u) => !droppedBroad.includes(u));

  // Synonyms for everything that is not a brand (brands got their spellings above).
  for (const u of [...active, ...excludes]) {
    if (u.source === 'brand' && u.expansions.length > 0) continue;
    if (u.source === 'model') continue;
    const syn = synonymsOf(unitText(u)).filter((s) => s !== unitText(u));
    u.expansions = [...new Set([...u.expansions, ...syn])];
  }

  const fixed = active.filter((u) => u.alt === null);
  const groupIds = [...new Set(active.filter((u) => u.alt !== null).map((u) => u.alt as number))];
  const groups = groupIds.map((id) => active.filter((u) => u.alt === id));

  const ws = buildWebsearch(fixed, groups, excludes);
  const tsquery = buildTsquery(fixed, groups, excludes);
  if (ws.droppedGroups) {
    p.note(`There were too many either-or choices to spell out for the basic search, so it leaves them out and the full query keeps them.`, true);
  }

  const terms = fixed.filter((u) => !isPhrase(u)).map(unitText);
  const phrases = fixed.filter((u) => isPhrase(u)).map(unitText);
  const features: string[] = [];
  for (const u of fixed) for (const f of u.features) if (!features.includes(f.name)) features.push(f.name);
  const synonyms: Record<string, string[]> = {};
  for (const u of [...active, ...excludes]) if (u.expansions.length > 0) synonyms[unitText(u)] = [...u.expansions];
  const excludeTerms = excludes.map(unitText);
  const alternatives = groups.map((g) => g.map(unitText));
  const models = [...new Set(p.models)];

  // ---- location
  let postalCode: string | null = null;
  let postalCodeSource: 'query' | 'home' | null = null;
  if (p.zips.length === 1) {
    postalCode = p.zips[0];
    postalCodeSource = 'query';
  } else if (p.zips.length > 1) {
    p.note(`The search names more than one ZIP (${listWords(p.zips)}), so I used none of them. Pick one.`, true);
  }
  const home = typeof opts.homePostalCode === 'string' && /^\d{5}$/.test(opts.homePostalCode.trim()) ? opts.homePostalCode.trim() : null;
  if (opts.homePostalCode !== undefined && home === null) setupNotes.push('The home ZIP is not a 5-digit ZIP code, so I ignored it.');
  const place = p.place;
  if (place && postalCode) place.needsResolution = false;
  const named = postalCode !== null || place !== null || p.states.length > 0 || p.zips.length > 1;
  if (!named && home) {
    postalCode = home;
    postalCodeSource = 'home';
  }
  let radiusMiles = p.radius;
  let radiusIsDefault = false;
  if (radiusMiles === null && (postalCode !== null || place !== null || p.nearbyText !== null)) {
    radiusMiles = defaultRadius;
    radiusIsDefault = true;
  }
  let includeShippable = p.shipping;
  if (includeShippable === null && p.statesOnly) includeShippable = false;
  const location: ParsedLocation = {
    postalCode, postalCodeSource, place, radiusMiles, radiusIsDefault, states: [...p.states], includeShippable,
  };

  const conditions = (['new', 'used', 'refurbished', 'parts'] as const).filter((c) => p.conditions.has(c));
  const tiers = (['federal', 'state', 'county', 'municipal', 'school', 'private', 'estate', 'wholesale', 'marketplace', 'dealer'] as const)
    .filter((t) => p.tiers.has(t));

  // ---- explanation, in reading order
  const hasFilters = p.minPrice || p.maxPrice || p.minYear !== null || p.maxYear !== null || location.postalCode
    || location.place || location.states.length || conditions.length || tiers.length || p.closingHours !== null
    || p.minSleeper !== null || p.shipping !== null;
  const searched = [...fixed.map(unitText)];
  if (input.trim() === '') {
    explanation.push('The search is empty, so there is nothing to look for yet.');
  } else if (searched.length === 0 && groups.length === 0) {
    explanation.push(hasFilters || excludes.length
      ? 'No search words: this matches every lot that passes the filters below.'
      : 'I did not find anything to search for in this.');
  } else if (searched.length > 0) {
    const shown = fixed.map((u) => (isPhrase(u) ? `“${unitText(u)}” (as a phrase)` : `“${unitText(u)}”`));
    explanation.push(`Looking for lots that mention ${listWords(shown)}.`);
  }
  for (const g of alternatives) explanation.push(`Either ${g.map((a) => `“${a}”`).join(' or ')}.`);
  for (const u of droppedBroad) {
    explanation.push(`I did not require the word “${unitText(u)}”: sellers rarely put it in a title, so it is kept as the category instead.`);
  }
  if (brandNames.length) explanation.push(`Brand: ${listWords(brandNames)}.`);
  if (models.length) explanation.push(`Model: ${listWords(models.map((m) => `“${m}”`))}.`);
  if (categories.length) explanation.push(`Category: ${listWords(categories.map((c) => c.label))}.`);
  if (features.length) explanation.push(`Must have: ${listWords(features)}.`);
  if (excludeTerms.length) explanation.push(`Leaving out lots that mention ${listWords(excludeTerms.map((e) => `“${e}”`))}.`);
  const syn = Object.entries(synonyms).filter(([k]) => !brandNames.some((b) => normalizeKey(b) === k));
  if (syn.length) {
    explanation.push(`The full query also accepts ${syn.map(([k, v]) => `${v.map((s) => `“${s}”`).join(', ')} for “${k}”`).join('; ')}.`);
  }
  if (p.minPrice && p.maxPrice && p.minPrice.text === p.maxPrice.text) {
    explanation.push(`Price: between ${formatCents(p.minPrice.cents)} and ${formatCents(p.maxPrice.cents)} (from “${p.maxPrice.text}”).`);
  } else {
    if (p.maxPrice) explanation.push(`Price: at most ${formatCents(p.maxPrice.cents)} (from “${p.maxPrice.text}”).`);
    if (p.minPrice) explanation.push(`Price: at least ${formatCents(p.minPrice.cents)} (from “${p.minPrice.text}”).`);
  }
  if (p.minYear !== null || p.maxYear !== null) {
    const range = p.minYear === p.maxYear ? `${p.minYear}`
      : p.maxYear === null ? `${p.minYear} or newer`
        : p.minYear === null ? `${p.maxYear} or older` : `${p.minYear} to ${p.maxYear}`;
    explanation.push(`Model year: ${range}. search_lots has no year filter, so this is kept in the parsed hunt for follow-up filtering.`);
  }
  const radiusWords = (r: number, isDefault: boolean): string => `within ${r} miles${isDefault ? ` (the default radius)` : ''}`;
  if (location.postalCode && location.postalCodeSource === 'query') {
    explanation.push(`Location: ${radiusWords(location.radiusMiles ?? defaultRadius, location.radiusIsDefault)} of ZIP ${location.postalCode}.`);
  } else if (location.postalCode && location.postalCodeSource === 'home') {
    explanation.push(p.nearbyText || p.radius !== null
      ? `Location: “${p.nearbyText ?? p.radiusText}” read as ${radiusWords(location.radiusMiles ?? defaultRadius, location.radiusIsDefault)} of your home ZIP ${location.postalCode}.`
      : `Location: no place was named, so ${radiusWords(location.radiusMiles ?? defaultRadius, location.radiusIsDefault)} of your home ZIP ${location.postalCode}.`);
  }
  if (place) {
    const where = place.state ? `${place.city}, ${place.state}` : place.city;
    if (place.ambiguous) {
      explanation.push(`Place: “${place.raw}” has no state, and the same town name exists in more than one state, so it has to be matched against the postal code table (and you may need to pick one) before a radius can apply. I did not guess a ZIP.`);
    } else if (place.needsResolution) {
      explanation.push(`Place: ${where}. It has to be matched to a ZIP from the postal code table before the ${location.radiusMiles ?? defaultRadius}-mile radius can apply.`);
    } else {
      explanation.push(`Place: ${where} (the ZIP you typed is used for the distance).`);
    }
  }
  if (!location.postalCode && !place && (p.nearbyText !== null || p.radius !== null) && location.states.length === 0) {
    p.note(`“${p.nearbyText ?? p.radiusText}” needs a starting point: type a ZIP or a town, or set a home ZIP.`, true);
  }
  if (location.states.length) {
    explanation.push(p.statesOnly
      ? `Only lots located in ${listWords(location.states)}; lots that merely ship from elsewhere are left out.`
      : `State: lots located in ${listWords(location.states)}.`);
  }
  if (p.shipping === false) explanation.push(`Shipping: “${p.shippingText}”, so lots outside the area are left out even if they ship.`);
  if (p.shipping === true) explanation.push(`Shipping: “${p.shippingText}”, so lots that ship are included wherever they are.`);
  if (conditions.length) explanation.push(`Condition: ${listWords(conditions.map((c) => CONDITION_WORDS[c]))}.`);
  for (const pref of p.preferences) {
    explanation.push(`“${pref}” noted, but sellers describe condition too inconsistently to filter on it.`);
  }
  if (tiers.length) {
    const gov = ['federal', 'state', 'county', 'municipal', 'school'].every((t) => p.tiers.has(t as SourceTier));
    explanation.push(`Sellers: ${gov ? 'government (federal, state, county, municipal and school)' : listWords(tiers.map((t) => TIER_WORDS[t]))}.`);
  }
  if (p.closingHours !== null) {
    explanation.push(`Closing: within ${p.closingHours} hour${p.closingHours === 1 ? '' : 's'}${p.windowWords ? `, i.e. ${p.windowWords}` : ''} (from “${p.timingText}”${p.windowWords && p.windowWords.startsWith('before') ? `, ${p.timeZone} time` : ''}).`);
  }
  if (p.sort !== 'relevance') explanation.push(`Sorted by ${SORT_WORDS[p.sort]} (from “${p.sortText}”).`);
  if (p.minSleeper !== null) explanation.push(`Sleeper score at least ${p.minSleeper}.`);
  if (p.quantityTexts.length) explanation.push(`Quantity (${listWords(p.quantityTexts.map((q) => `“${q}”`))}) noted, but lots are not searchable by quantity.`);
  if (outOfScope) explanation.push('Real estate is out of scope: PaddleUp covers things sold at auction, not land or buildings.');
  const ignored = p.tokens.filter((t) => t.role === 'filler' && !/^\W+$/.test(t.text)).map((t) => t.text);
  if (ignored.length) explanation.push(`Ignored as filler: ${listWords([...new Set(ignored)].map((w) => `“${w}”`))}.`);
  explanation.push(...setupNotes, ...p.notes);
  // The same note for the same reason is one line, however many words hit it.
  const lines = [...new Set(explanation)];

  // ---- confidence: understood share of the words that meant something, discounted per ambiguity
  const meaningful = p.tokens.filter((t) => !t.punct && t.role !== 'filler' && t.role !== 'noise' && t.role !== 'or');
  const rejected = meaningful.filter((t) => t.role === 'unparsed').length;
  let confidence = meaningful.length === 0 ? 0 : (meaningful.length - rejected) / meaningful.length;
  confidence *= 0.85 ** p.penalties;
  if (outOfScope) confidence *= 0.5;
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

  const snapshot: ParsedSnapshot = {
    input,
    terms,
    phrases,
    brands: brandNames,
    models,
    categories: categories.map((c) => c.slug),
    features,
    synonyms,
    excludeTerms,
    alternatives,
    minPriceCents: p.minPrice?.cents ?? null,
    maxPriceCents: p.maxPrice?.cents ?? null,
    minYear: p.minYear,
    maxYear: p.maxYear,
    location,
    conditions: [...conditions],
    timing: { closingWithinHours: p.closingHours, phrase: p.timingText },
    sort: p.sort,
    tiers: [...tiers],
    minSleeperScore: p.minSleeper,
    outOfScope,
    websearchQuery: ws.query,
    tsquery,
    explanation: lines,
    unparsed: [...p.unparsed],
    confidence,
  };

  const hunt: HuntInsert = {
    query_text: input,
    parsed: snapshot,
    keywords: fixed.map(unitText),
    exclude_keywords: [...excludeTerms],
    brands: [...brandNames],
    required_terms: [...features],
    min_price_cents: snapshot.minPriceCents,
    max_price_cents: snapshot.maxPriceCents,
    conditions: [...conditions],
    postal_code: location.postalCode,
    radius_miles: location.radiusMiles,
    states: [...location.states],
    include_shippable: location.includeShippable ?? true,
    // Category ids are bigserials that only the database knows. The slugs are
    // in parsed.categories; see the README for resolving them at insert time.
    category_ids: [],
    tiers_only: [...tiers],
    min_sleeper_score: p.minSleeper,
  };

  const searchParams: SearchLotsParams = {
    p_query: ws.query === '' ? null : ws.query,
    p_postal_code: location.postalCode,
    // Never null: search_lots does arithmetic on it, and an explicit null
    // overrides the parameter default instead of falling back to it.
    p_radius_miles: location.radiusMiles ?? defaultRadius,
    p_include_shippable: location.includeShippable ?? true,
    // Never an empty array: `= any('{}')` is false, which would turn "no
    // filter" into "no results".
    p_states: location.states.length ? [...location.states] : null,
    p_min_cents: snapshot.minPriceCents,
    p_max_cents: snapshot.maxPriceCents,
    p_tiers: tiers.length ? [...tiers] : null,
    p_closing_within_hours: p.closingHours,
    p_min_sleeper: p.minSleeper,
    p_sort: p.sort,
  };

  return { ...snapshot, hunt, searchParams };
}

/**
 * Parse what a buyer typed into structured search filters.
 *
 * Never throws on any input. Anything it could not read with confidence comes
 * back in `unparsed`, with the reason in `explanation`.
 */
export function parseQuery(text: string, opts: ParseOptions = {}): ParsedQuery {
  const input = typeof text === 'string' ? text : '';
  const setupNotes: string[] = [];
  let working = normalizeInput(input);
  if (working.length > MAX_INPUT_CHARS) {
    working = working.slice(0, MAX_INPUT_CHARS);
    setupNotes.push(`Only the first ${MAX_INPUT_CHARS} characters were read.`);
  }
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  let timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
  } catch {
    setupNotes.push(`“${timeZone}” is not a time zone I know, so “today” is read in ${DEFAULT_TIME_ZONE}.`);
    timeZone = DEFAULT_TIME_ZONE;
  }
  let defaultRadius = DEFAULT_RADIUS_MILES;
  if (opts.defaultRadiusMiles !== undefined) {
    const r = opts.defaultRadiusMiles;
    if (Number.isInteger(r) && r >= 1 && r <= MAX_RADIUS_MILES) defaultRadius = r;
    else setupNotes.push(`The default radius must be a whole number of miles from 1 to ${MAX_RADIUS_MILES}, so I used ${DEFAULT_RADIUS_MILES}.`);
  }

  // The order is the design. Each pass consumes the words it understands, so
  // the most specific readings go first: "pickup only" before the truck
  // category claims "pickup", "ending soonest" (an order) before "ending soon"
  // (a deadline), miles before prices so "under 50 miles" is a distance,
  // measurements before brands so the "hp" in "5 hp" is not HP, places before
  // conditions so "near new glarus" keeps its "new", and exclusions before the
  // lexicon so "no replicas" never becomes a wanted word.
  const p = new Parser(working, now, timeZone);
  p.readQuoted();
  p.readDashExclusions();
  p.readShipping();
  p.readSort();
  p.readSleeperScore();
  p.readTiming();
  p.readYears();
  p.readRadius();
  p.readPrices();
  p.readMeasures();
  p.readNearby();
  p.readZips();
  p.readPlaces();
  p.readStates();
  p.readConditions();
  p.readTiers();
  p.readExclusions();
  p.markOr();
  p.readLexicon();
  p.readNumbers();
  p.readWords();
  return assemble(p, input, opts, defaultRadius, setupNotes);
}
