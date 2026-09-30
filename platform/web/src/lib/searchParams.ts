/**
 * From what the user typed and clicked to search_lots() arguments.
 *
 * The parser (@platform/query) reads the words into `searchParams`, keyed like
 * search_lots. The sort chips and the desktop sidebar are a view over the same
 * filters: when a new query is submitted the filters are set from the parse
 * (anything the words did not say keeps the user's setting), and a click on a
 * filter overrides the parse from then on.
 */
import type { ParsedQuery, SearchLotsParams } from '@platform/query';
import type { SearchLotsArgs, SearchSort, SourceTier } from '../data/database.types';
import { SELLER_GROUPS, type SellerGroupKey } from './tiers';

export type RadiusChoice = number | 'anywhere';

export interface SearchFilters {
  readonly radius: RadiusChoice;
  readonly includeShippable: boolean;
  /** null: no seller filter (every tier, including dealers, wholesale and marketplaces). */
  readonly tiers: readonly SourceTier[] | null;
  readonly minCents: number | null;
  readonly maxCents: number | null;
  readonly sort: SearchSort;
}

/** The sidebar's distance choices (the design's 25 / 50 / 100 / anywhere). */
export const RADIUS_CHOICES: readonly number[] = [25, 50, 100];

export function defaultFilters(homeRadiusMiles: number | null | undefined): SearchFilters {
  return {
    radius: homeRadiusMiles && homeRadiusMiles > 0 ? homeRadiusMiles : 50,
    includeShippable: true,
    tiers: null,
    minCents: null,
    maxCents: null,
    sort: 'relevance',
  };
}

/** Filters for a freshly submitted query: what the words said, else the current setting. */
export function filtersFromParse(parse: Pick<ParsedQuery, 'location' | 'tiers' | 'minPriceCents' | 'maxPriceCents' | 'sort'>, base: SearchFilters): SearchFilters {
  const typedRadius = parse.location.radiusMiles !== null && !parse.location.radiusIsDefault;
  return {
    radius: typedRadius ? (parse.location.radiusMiles as number) : base.radius,
    includeShippable: parse.location.includeShippable ?? base.includeShippable,
    tiers: parse.tiers.length > 0 ? [...parse.tiers] : null,
    minCents: parse.minPriceCents,
    maxCents: parse.maxPriceCents,
    sort: parse.sort !== 'relevance' ? parse.sort : base.sort,
  };
}

/** Whether a seller checkbox shows as checked. */
export function isSellerChecked(tiers: readonly SourceTier[] | null, key: SellerGroupKey): boolean {
  if (tiers === null) return true;
  const group = SELLER_GROUPS.find((g) => g.key === key);
  return group !== undefined && group.tiers.some((t) => tiers.includes(t));
}

/**
 * Toggle one seller checkbox. All six checked is "no filter" (null); anything
 * else is exactly the checked groups' tiers.
 */
export function toggleSeller(tiers: readonly SourceTier[] | null, key: SellerGroupKey): readonly SourceTier[] | null {
  const checked = new Set<SellerGroupKey>(SELLER_GROUPS.filter((g) => isSellerChecked(tiers, g.key)).map((g) => g.key));
  if (checked.has(key)) checked.delete(key);
  else checked.add(key);
  if (checked.size === SELLER_GROUPS.length) return null;
  return SELLER_GROUPS.filter((g) => checked.has(g.key)).flatMap((g) => g.tiers);
}

/** Tiers in the filter that no checkbox shows (a query like "dealer auctions" can set these). */
export function ungroupedTiers(tiers: readonly SourceTier[] | null): SourceTier[] {
  if (tiers === null) return [];
  const grouped = new Set<SourceTier>(SELLER_GROUPS.flatMap((g) => g.tiers));
  return tiers.filter((t) => !grouped.has(t));
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

/**
 * search_lots() arguments. `homeZip` is the fallback origin when the query
 * named no place (the parser already fills it when it was given one).
 * `resolvedZip` is a ZIP the app looked up for a place name the parser could
 * not turn into one. Returns null when the filters cannot match anything (every
 * seller type unchecked), so the caller skips the request.
 */
export function toSearchArgs(
  params: SearchLotsParams,
  filters: SearchFilters,
  options: { readonly homeZip?: string | null; readonly resolvedZip?: string | null; readonly page?: PageRequest } = {},
): SearchLotsArgs | null {
  if (filters.tiers !== null && filters.tiers.length === 0) return null;
  const origin = params.p_postal_code ?? options.resolvedZip ?? options.homeZip ?? null;
  const anywhere = filters.radius === 'anywhere';
  return {
    p_query: params.p_query,
    p_postal_code: anywhere ? null : origin,
    p_radius_miles: anywhere ? params.p_radius_miles : (filters.radius as number),
    p_include_shippable: filters.includeShippable,
    p_states: params.p_states,
    p_min_cents: filters.minCents,
    p_max_cents: filters.maxCents,
    // lots.category_id is not filled by ingest yet, and the parser leaves ids to
    // the database; a category filter today would hide every lot.
    p_category_ids: null,
    p_tiers: filters.tiers === null ? null : [...filters.tiers],
    p_closing_within_hours: params.p_closing_within_hours,
    p_min_sleeper: params.p_min_sleeper,
    p_sort: filters.sort,
    p_limit: options.page?.limit ?? 50,
    p_offset: options.page?.offset ?? 0,
  };
}

/**
 * The "N more matches farther than X mi" search: the same query and filters
 * with no origin, so the location disjunction in search_lots admits every lot.
 * Null when the search already has no distance limit.
 */
export function fartherArgs(args: SearchLotsArgs): SearchLotsArgs | null {
  if (!args.p_postal_code) return null;
  return { ...args, p_postal_code: null };
}

/** The count row, or null when there is nothing farther. `cap` is search_lots' 200-row limit. */
export function fartherCount(allCount: number, nearCount: number, cap: number): { count: number; atLeast: boolean } | null {
  const count = allCount - nearCount;
  if (count <= 0) return null;
  return { count, atLeast: allCount >= cap };
}

export const SORT_OPTIONS: readonly { readonly value: SearchSort; readonly label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'closing', label: 'Closing soon' },
  { value: 'nearest', label: 'Nearest' },
  { value: 'cheapest', label: 'Price' },
  { value: 'newest', label: 'Newest' },
  { value: 'sleeper', label: 'Treasure in plain sight' },
];

/** The four chips the design shows, plus the active sort when the words picked another one. */
export function sortChips(active: SearchSort): { value: SearchSort; label: string }[] {
  const base = SORT_OPTIONS.slice(0, 4);
  const extra = base.some((o) => o.value === active) ? [] : SORT_OPTIONS.filter((o) => o.value === active);
  return [...base, ...extra];
}
