/**
 * A hunt being created from plain language.
 *
 * parseQuery(text) (@platform/query) returns `hunt`, keyed exactly like the
 * hunts columns, and `explanation` for the "I read this as" panel. The draft
 * shows that reading as chips. Removing a chip edits the hunt fields, and keeps
 * `parsed.websearchQuery` in step, because 0013's run_hunt_matcher searches
 * with parsed->>'websearchQuery' before it falls back to the keywords.
 */
import {
  BRANDS,
  CATEGORIES,
  PG_ENGLISH_STOPWORDS,
  normalizeKey,
  type ParsedQuery,
} from '@platform/query';
import type { HuntInsert, Json, SourceTier } from '../data/database.types';
import { formatCentsShort } from './money';
import { TIER_LABEL } from './tiers';

/** The hunts columns the parser fills (HuntInsert from @platform/query, minus the audit fields). */
export interface HuntFields {
  readonly keywords: readonly string[];
  readonly exclude_keywords: readonly string[];
  readonly brands: readonly string[];
  readonly required_terms: readonly string[];
  readonly min_price_cents: number | null;
  readonly max_price_cents: number | null;
  readonly conditions: readonly string[];
  readonly postal_code: string | null;
  readonly radius_miles: number | null;
  readonly states: readonly string[];
  readonly include_shippable: boolean;
  readonly category_ids: readonly number[];
  readonly tiers_only: readonly SourceTier[];
  readonly min_sleeper_score: number | null;
}

export interface HuntDraft {
  readonly parse: ParsedQuery;
  readonly fields: HuntFields;
  /** Category slugs still in the reading (the parser's `categories`). */
  readonly categories: readonly string[];
  /** Either-or groups still in the reading. */
  readonly alternatives: readonly (readonly string[])[];
  /** The websearch string the matcher will use, rebuilt after any removal. */
  readonly websearchQuery: string;
  /** Labels of chips the user removed, stored in `parsed` for auditability. */
  readonly removed: readonly string[];
}

export function draftFromParse(parse: ParsedQuery): HuntDraft {
  const h = parse.hunt;
  return {
    parse,
    fields: {
      keywords: [...h.keywords],
      exclude_keywords: [...h.exclude_keywords],
      brands: [...h.brands],
      required_terms: [...h.required_terms],
      min_price_cents: h.min_price_cents,
      max_price_cents: h.max_price_cents,
      conditions: [...h.conditions],
      postal_code: h.postal_code,
      radius_miles: h.radius_miles,
      states: [...h.states],
      include_shippable: h.include_shippable,
      category_ids: [...h.category_ids],
      tiers_only: [...h.tiers_only],
      min_sleeper_score: h.min_sleeper_score,
    },
    categories: [...parse.categories],
    alternatives: parse.alternatives.map((g) => [...g]),
    websearchQuery: parse.websearchQuery,
    removed: [],
  };
}

// ------------------------------------------------------------ websearch rebuild

/** Mirrors the parser's sanitizeWord: only characters with no operator meaning survive. */
function sanitizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/([.-])[.-]+/g, '$1');
}

function isHyphenNumeric(word: string): boolean {
  return /[a-z]-\d|\d-[a-z]/.test(word);
}

/** One websearch atom (a word, or a quoted phrase), or null when Postgres would drop it all. */
function wsAtom(unit: string): string | null {
  const clean = unit.split(' ').map(sanitizeWord).filter(Boolean);
  if (clean.length === 0 || clean.every((w) => PG_ENGLISH_STOPWORDS.has(w))) return null;
  if (clean.length === 1 && !isHyphenNumeric(clean[0] as string)) return clean[0] as string;
  return `"${clean.join(' ')}"`;
}

const MAX_OR_CLAUSES = 16;

/**
 * The websearch_to_tsquery string for a set of units, in the parser's own
 * format: words and quoted phrases ANDed, exclusions as -atom, and either-or
 * groups spelled out as one clause per choice (websearch has no parentheses).
 */
export function rebuildWebsearch(
  keywords: readonly string[],
  alternatives: readonly (readonly string[])[],
  excludes: readonly string[],
): string {
  const atoms = keywords.map(wsAtom).filter((a): a is string => a !== null);
  const negs = excludes.map(wsAtom).filter((a): a is string => a !== null).map((a) => `-${a}`);
  const choices = alternatives
    .map((g) => [...new Set(g.map(wsAtom).filter((a): a is string => a !== null))])
    .filter((g) => g.length > 0);
  const size = choices.reduce((n, g) => n * g.length, 1);
  if (choices.length === 0 || size > MAX_OR_CLAUSES) return [...atoms, ...negs].join(' ');
  let clauses: string[][] = [[]];
  for (const g of choices) clauses = clauses.flatMap((c) => g.map((a) => [...c, a]));
  return clauses.map((c) => [...atoms, ...c, ...negs].join(' ')).join(' or ');
}

// ------------------------------------------------------------------- chips

export type ChipKind =
  | 'brand'
  | 'category'
  | 'feature'
  | 'word'
  | 'either'
  | 'exclude'
  | 'max_price'
  | 'min_price'
  | 'state'
  | 'condition'
  | 'tier'
  | 'sleeper';

export interface Chip {
  readonly id: string;
  readonly kind: ChipKind;
  /** "Brand", "Up to", "Must have". */
  readonly label: string;
  /** "DJI", "$1,500", "thermal". */
  readonly value: string;
  /** "Remove brand DJI". */
  readonly removeLabel: string;
}

function brandKeys(name: string): Set<string> {
  const entry = BRANDS.find((b) => b.name === name);
  const forms = [name, ...(entry?.aliases ?? []), ...(entry?.families ?? [])];
  const keys = new Set<string>();
  for (const f of forms) {
    const key = normalizeKey(f);
    keys.add(key);
    keys.add(key.replace(/ /g, ''));
    keys.add(key.replace(/ /g, '-'));
  }
  return keys;
}

function categoryFor(keyword: string, slugs: readonly string[]): { slug: string; label: string } | null {
  const singular = keyword.endsWith('s') ? keyword.slice(0, -1) : keyword;
  for (const slug of slugs) {
    const c = CATEGORIES.find((x) => x.slug === slug);
    if (!c) continue;
    const terms = [c.label, ...c.synonyms, ...(c.broad ?? [])].map(normalizeKey);
    if (terms.includes(keyword) || terms.includes(singular)) return { slug, label: c.label };
  }
  return null;
}

function categoryLabel(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}

const CONDITION_WORDS: Readonly<Record<string, string>> = {
  new: 'New',
  used: 'Used',
  refurbished: 'Refurbished',
  parts: 'For parts',
};

/** What each keyword stands for, so its chip can say "Brand DJI" instead of "dji". */
function keywordRoles(draft: HuntDraft): Map<string, { kind: 'brand' | 'category' | 'feature' | 'word'; value: string }> {
  const roles = new Map<string, { kind: 'brand' | 'category' | 'feature' | 'word'; value: string }>();
  const brandMap = draft.fields.brands.map((b) => ({ name: b, keys: brandKeys(b) }));
  for (const k of draft.fields.keywords) {
    const brand = brandMap.find((b) => b.keys.has(k));
    if (brand) roles.set(k, { kind: 'brand', value: brand.name });
    else if (draft.fields.required_terms.includes(k)) roles.set(k, { kind: 'feature', value: k });
    else {
      const cat = categoryFor(k, draft.categories);
      roles.set(k, cat ? { kind: 'category', value: cat.label } : { kind: 'word', value: k });
    }
  }
  return roles;
}

const CHIP_LABEL: Readonly<Record<'brand' | 'category' | 'feature' | 'word', string>> = {
  brand: 'Brand',
  category: 'Category',
  feature: 'Must have',
  word: 'Word',
};

export function chipsFor(draft: HuntDraft): Chip[] {
  const f = draft.fields;
  const chips: Chip[] = [];
  const roles = keywordRoles(draft);
  const brandsShown = new Set<string>();
  const categoriesShown = new Set<string>();

  for (const k of f.keywords) {
    const role = roles.get(k) ?? { kind: 'word' as const, value: k };
    if (role.kind === 'brand') brandsShown.add(role.value);
    if (role.kind === 'category') categoriesShown.add(role.value);
    chips.push({
      id: `kw:${k}`,
      kind: role.kind,
      label: CHIP_LABEL[role.kind],
      value: role.value,
      removeLabel: `Remove ${CHIP_LABEL[role.kind].toLowerCase()} ${role.value}`,
    });
  }
  for (const b of f.brands) {
    if (brandsShown.has(b)) continue;
    chips.push({ id: `brand:${b}`, kind: 'brand', label: 'Brand', value: b, removeLabel: `Remove brand ${b}` });
  }
  for (const slug of draft.categories) {
    const label = categoryLabel(slug);
    if (categoriesShown.has(label)) continue;
    chips.push({ id: `cat:${slug}`, kind: 'category', label: 'Category', value: label, removeLabel: `Remove category ${label}` });
  }
  for (const t of f.required_terms) {
    if (f.keywords.includes(t)) continue;
    chips.push({ id: `feat:${t}`, kind: 'feature', label: 'Must have', value: t, removeLabel: `Remove must-have ${t}` });
  }
  draft.alternatives.forEach((g, i) => {
    const value = g.join(' or ');
    chips.push({ id: `alt:${i}:${value}`, kind: 'either', label: 'Either', value, removeLabel: `Remove either ${value}` });
  });
  for (const x of f.exclude_keywords) {
    chips.push({ id: `not:${x}`, kind: 'exclude', label: 'Not', value: x, removeLabel: `Remove exclusion ${x}` });
  }
  if (f.min_price_cents !== null) {
    const v = formatCentsShort(f.min_price_cents);
    chips.push({ id: 'min', kind: 'min_price', label: 'At least', value: v, removeLabel: 'Remove minimum price' });
  }
  if (f.max_price_cents !== null) {
    const v = formatCentsShort(f.max_price_cents);
    chips.push({ id: 'max', kind: 'max_price', label: 'Up to', value: v, removeLabel: 'Remove maximum price' });
  }
  for (const s of f.states) chips.push({ id: `state:${s}`, kind: 'state', label: 'In', value: s, removeLabel: `Remove state ${s}` });
  for (const c of f.conditions) {
    const v = CONDITION_WORDS[c] ?? c;
    chips.push({ id: `cond:${c}`, kind: 'condition', label: 'Condition', value: v, removeLabel: `Remove condition ${v}` });
  }
  for (const t of f.tiers_only) {
    const v = TIER_LABEL[t];
    chips.push({ id: `tier:${t}`, kind: 'tier', label: 'Seller', value: v, removeLabel: `Remove seller type ${v}` });
  }
  if (f.min_sleeper_score !== null) {
    const v = `score ${f.min_sleeper_score}+`;
    chips.push({ id: 'sleeper', kind: 'sleeper', label: 'Worth the trip', value: v, removeLabel: 'Remove the Worth the trip filter' });
  }
  return chips;
}

function without<T>(list: readonly T[], item: T): T[] {
  return list.filter((x) => x !== item);
}

/** Remove one chip: edits the hunt fields and rebuilds the websearch string. */
export function removeChip(draft: HuntDraft, chipId: string): HuntDraft {
  const chip = chipsFor(draft).find((c) => c.id === chipId);
  if (!chip) return draft;
  let f: HuntFields = draft.fields;
  let categories = draft.categories;
  let alternatives = draft.alternatives;

  if (chipId.startsWith('kw:')) {
    const k = chipId.slice(3);
    f = { ...f, keywords: without(f.keywords, k) };
    if (chip.kind === 'brand') f = { ...f, brands: without(f.brands, chip.value) };
    if (chip.kind === 'feature') f = { ...f, required_terms: without(f.required_terms, k) };
    if (chip.kind === 'category') {
      const cat = categoryFor(k, categories);
      if (cat) categories = without(categories, cat.slug);
    }
  } else if (chipId.startsWith('brand:')) {
    f = { ...f, brands: without(f.brands, chipId.slice(6)) };
  } else if (chipId.startsWith('cat:')) {
    categories = without(categories, chipId.slice(4));
  } else if (chipId.startsWith('feat:')) {
    f = { ...f, required_terms: without(f.required_terms, chipId.slice(5)) };
  } else if (chipId.startsWith('alt:')) {
    const index = Number(chipId.split(':')[1]);
    alternatives = alternatives.filter((_, i) => i !== index);
  } else if (chipId.startsWith('not:')) {
    f = { ...f, exclude_keywords: without(f.exclude_keywords, chipId.slice(4)) };
  } else if (chipId === 'min') {
    f = { ...f, min_price_cents: null };
  } else if (chipId === 'max') {
    f = { ...f, max_price_cents: null };
  } else if (chipId.startsWith('state:')) {
    f = { ...f, states: without(f.states, chipId.slice(6)) };
  } else if (chipId.startsWith('cond:')) {
    f = { ...f, conditions: without(f.conditions, chipId.slice(5)) };
  } else if (chipId.startsWith('tier:')) {
    f = { ...f, tiers_only: without(f.tiers_only, chipId.slice(5) as SourceTier) };
  } else if (chipId === 'sleeper') {
    f = { ...f, min_sleeper_score: null };
  }

  return {
    ...draft,
    fields: f,
    categories,
    alternatives,
    websearchQuery: rebuildWebsearch(f.keywords, alternatives, f.exclude_keywords),
    removed: [...draft.removed, `${chip.label}: ${chip.value}`],
  };
}

export function setDraftRadius(draft: HuntDraft, radiusMiles: number): HuntDraft {
  return { ...draft, fields: { ...draft.fields, radius_miles: radiusMiles } };
}

/**
 * 0013 skips a hunt with no websearch words, no keywords, no brands and no
 * categories (it would match the whole catalogue). category_ids stay empty
 * (see toHuntInsert), so a saveable hunt needs words or a brand.
 */
export function huntHasCriteria(draft: HuntDraft): boolean {
  return draft.websearchQuery.trim() !== '' || draft.fields.keywords.length > 0 || draft.fields.brands.length > 0;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * The hunts insert payload: the parser's columns as edited, the verbatim text,
 * and the reading in `parsed` (with the rebuilt websearch string and the list
 * of removed chips). category_ids stay empty: the parser leaves ids to the
 * database, and lots.category_id is not populated by ingest yet, so a category
 * id would stop the hunt from matching anything. The slugs remain in `parsed`.
 *
 * run_hunt_matcher passes parsed.tsquery to search_lots as p_tsquery (0018),
 * falling back to websearchQuery when it is empty. An unedited draft keeps the
 * parser's tsquery. After a chip edit it cannot be rebuilt faithfully here:
 * each unit's to_tsquery form depends on parser state ParsedQuery does not
 * expose (which model designators get a ':*' prefix), so the edited hunt
 * stores '' and the matcher uses the rebuilt websearch string alone.
 */
export function toHuntInsert(
  draft: HuntDraft,
  options: { readonly userId: string; readonly name: string; readonly notifyImmediately: boolean },
): HuntInsert {
  const f = draft.fields;
  const edited = draft.removed.length > 0;
  const { hunt: _hunt, searchParams: _searchParams, ...snapshot } = draft.parse;
  const parsed = {
    ...snapshot,
    categories: [...draft.categories],
    alternatives: draft.alternatives.map((g) => [...g]),
    websearchQuery: draft.websearchQuery,
    // The full tsquery no longer matches the edited fields; better absent than wrong.
    tsquery: edited ? '' : snapshot.tsquery,
    edits: edited ? { removed: [...draft.removed] } : null,
  };
  return {
    user_id: options.userId,
    name: options.name.trim().slice(0, 120),
    query_text: draft.parse.input,
    parsed: toJson(parsed),
    keywords: [...f.keywords],
    exclude_keywords: [...f.exclude_keywords],
    brands: [...f.brands],
    required_terms: [...f.required_terms],
    min_price_cents: f.min_price_cents,
    max_price_cents: f.max_price_cents,
    conditions: [...f.conditions],
    postal_code: f.postal_code,
    radius_miles: f.radius_miles,
    states: [...f.states],
    include_shippable: f.include_shippable,
    category_ids: [],
    tiers_only: [...f.tiers_only],
    min_sleeper_score: f.min_sleeper_score,
    active: true,
    notify_immediately: options.notifyImmediately,
  };
}

const NAME_MAX = 48;

/** A short label for the hunt, from what it looks for: "DJI drone thermal", "Laptop near Milwaukee". */
export function deriveHuntName(draft: HuntDraft, placeName?: string | null): string {
  const f = draft.fields;
  const roles = keywordRoles(draft);
  const words = f.keywords.map((k) => {
    const role = roles.get(k);
    return role?.kind === 'brand' ? role.value : k;
  });
  const shownBrands = new Set(f.keywords.map((k) => roles.get(k)).filter((r) => r?.kind === 'brand').map((r) => r?.value));
  const extraBrands = f.brands.filter((b) => !shownBrands.has(b) && words.length === 0);
  let base = [...extraBrands, ...words].join(' ');
  if (draft.alternatives.length > 0) {
    const alts = draft.alternatives.map((g) => g.join(' or ')).join(', ');
    base = base ? `${base} ${alts}` : alts;
  }
  if (!base) base = draft.categories.map(categoryLabel).join(', ');
  if (!base) base = draft.parse.input.trim();
  if (!base) return 'My hunt';
  let name = base.charAt(0).toUpperCase() + base.slice(1);
  if (placeName) name = `${name} near ${placeName}`;
  if (name.length <= NAME_MAX) return name;
  const cut = name.slice(0, NAME_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

/** What summarizeHunt and manifestLine read from a hunts row. */
export interface HuntSummaryInput {
  readonly keywords: readonly string[];
  readonly brands: readonly string[];
  readonly exclude_keywords: readonly string[];
  readonly min_price_cents: number | null;
  readonly max_price_cents: number | null;
  readonly postal_code: string | null;
  readonly radius_miles: number | null;
  readonly states: readonly string[];
  readonly tiers_only: readonly SourceTier[];
  readonly include_shippable: boolean | null;
  /** The stored reading: either-or choices live only here (they are not required keywords). */
  readonly parsed?: Json | null;
}

/** parsed.alternatives from a stored hunt, read defensively: [["canner", "canning"], …]. */
export function readAlternatives(parsed: Json | null | undefined): string[][] {
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const alts = parsed.alternatives;
  if (!Array.isArray(alts)) return [];
  return alts
    .map((g) => (Array.isArray(g) ? g.filter((w): w is string => typeof w === 'string' && w.trim() !== '') : []))
    .filter((g) => g.length > 0);
}

/** The words a hunt looks for, brands in their own spelling, then its either-or choices. */
function lookedFor(hunt: HuntSummaryInput, shorten: boolean): string[] {
  const brandKeySets = hunt.brands.map((b) => ({ name: b, keys: brandKeys(b) }));
  const words = hunt.keywords.map((k) => brandKeySets.find((b) => b.keys.has(k))?.name ?? k);
  const listed = new Set(words);
  const choices = readAlternatives(hunt.parsed).map((g) =>
    shorten && g.length > 3 ? `${g.slice(0, 3).join(', ')} or ${g.length - 3} more` : g.join(' or '),
  );
  return [...words, ...hunt.brands.filter((b) => !listed.has(b)), ...choices];
}

function priceWords(hunt: HuntSummaryInput): string | null {
  if (hunt.min_price_cents !== null && hunt.max_price_cents !== null) {
    return `${formatCentsShort(hunt.min_price_cents)} to ${formatCentsShort(hunt.max_price_cents)}`;
  }
  if (hunt.max_price_cents !== null) return `up to ${formatCentsShort(hunt.max_price_cents)}`;
  if (hunt.min_price_cents !== null) return `at least ${formatCentsShort(hunt.min_price_cents)}`;
  return null;
}

/** "DJI · drone · thermal · up to $1,500 · within 50 mi of 53202 · every source type". */
export function summarizeHunt(hunt: HuntSummaryInput): string {
  const parts: string[] = [...lookedFor(hunt, false)];
  for (const x of hunt.exclude_keywords) parts.push(`not ${x}`);
  const price = priceWords(hunt);
  if (price) parts.push(price);
  if (hunt.postal_code) parts.push(`within ${hunt.radius_miles ?? 50} mi of ${hunt.postal_code}`);
  if (hunt.states.length) parts.push(`in ${hunt.states.join(', ')}`);
  if (!hunt.postal_code && hunt.states.length === 0) parts.push('near your home ZIP');
  parts.push(hunt.tiers_only.length ? hunt.tiers_only.map((t) => TIER_LABEL[t]).join(', ') : 'every source type');
  if (hunt.include_shippable === false) parts.push('pickup only');
  return parts.join(' · ');
}

/**
 * The Hunts manifest's one-line reading (Hunts.dc.html, shown in mono caps):
 * "generator · up to $800 · 60 mi". Shorter than summarizeHunt: long either-or
 * lists are cut to three, and the home ZIP is left to the Profile page.
 */
export function manifestLine(hunt: HuntSummaryInput): string {
  const parts: string[] = [...lookedFor(hunt, true)];
  for (const x of hunt.exclude_keywords) parts.push(`not ${x}`);
  const price = priceWords(hunt);
  if (price) parts.push(price);
  if (hunt.postal_code) parts.push(`${hunt.radius_miles ?? 50} mi`);
  else if (hunt.states.length) parts.push(`in ${hunt.states.join(', ')}`);
  if (hunt.tiers_only.length) parts.push(hunt.tiers_only.map((t) => TIER_LABEL[t]).join(', '));
  if (hunt.include_shippable === false) parts.push('pickup only');
  return parts.join(' · ');
}
