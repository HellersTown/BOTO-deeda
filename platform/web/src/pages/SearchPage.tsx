import { parseQuery, type ParsedQuery } from '@platform/query';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { FilterPanel } from '../components/FilterPanel';
import { CloseIcon, FilterIcon, SearchIcon } from '../components/Icons';
import { LocationButton } from '../components/LocationDialog';
import { Wordmark } from '../components/Logo';
import { LotCard } from '../components/LotCard';
import { CardSkeletons, EmptyState, ErrorState } from '../components/States';
import type { SearchLotRow } from '../data/database.types';
import { fromSearchRow } from '../data/lotSummary';
import { lookupPostalCode, resolvePlace } from '../data/postal';
import {
  countSearchLots,
  explainSearch,
  fetchLotCloseInfo,
  listElsewhereSources,
  searchLots,
  SEARCH_LIMIT_MAX,
  type LotCloseInfo,
} from '../data/search';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { elsewhereLinks, elsewhereWords } from '../lib/elsewhere';
import { explainParts, groupByMatch, kindsText, truncatedGroup, type ExplainPart, type MatchGroupKey } from '../lib/matchTiers';
import { formatCentsShort } from '../lib/money';
import { tallyRows } from '../lib/sale';
import {
  defaultFilters,
  fartherArgs,
  fartherCount,
  filtersFromParse,
  saleSortNote,
  SORT_OPTIONS,
  sortChips,
  toSearchArgs,
  type SearchFilters,
} from '../lib/searchParams';
import { TIER_LABEL } from '../lib/tiers';
import { useHome } from '../providers/HomeProvider';

const PAGE_SIZE = 24;

interface Results {
  readonly rows: readonly SearchLotRow[];
  readonly info: ReadonlyMap<string, LotCloseInfo>;
}

/**
 * The design's "Read as generator · up to $800 · within 60 mi of 53202", and
 * under it what the database understood the words to mean (0045): "Looking for
 * Computers, including desktop computers, laptops and workstations & servers".
 */
function ReadAs({
  parse,
  filters,
  origin,
  meaning,
}: {
  parse: ParsedQuery;
  filters: SearchFilters;
  origin: string | null;
  meaning: readonly ExplainPart[] | null;
}) {
  const words = [
    ...parse.terms,
    ...parse.phrases.map((p) => `“${p}”`),
    ...parse.alternatives.map((g) => g.join(' or ')),
  ].join(' ');
  const parts: string[] = [];
  if (parse.excludeTerms.length) parts.push(`not ${parse.excludeTerms.join(', ')}`);
  if (filters.minCents !== null && filters.maxCents !== null) {
    parts.push(`${formatCentsShort(filters.minCents)} to ${formatCentsShort(filters.maxCents)}`);
  } else if (filters.maxCents !== null) parts.push(`up to ${formatCentsShort(filters.maxCents)}`);
  else if (filters.minCents !== null) parts.push(`at least ${formatCentsShort(filters.minCents)}`);
  if (filters.radius === 'anywhere' || (!origin && parse.location.states.length === 0)) parts.push('anywhere');
  else if (origin) parts.push(`within ${filters.radius} mi of ${origin}`);
  if (parse.location.states.length) parts.push(`in ${parse.location.states.join(', ')}`);
  if (filters.tiers !== null) parts.push(filters.tiers.map((t) => TIER_LABEL[t]).join(', ') || 'no seller type');
  if (!filters.includeShippable) parts.push('pickup nearby only');
  if (parse.timing.closingWithinHours !== null) parts.push(`closing within ${parse.timing.closingWithinHours} h`);
  return (
    <div className="read-as">
      <p className="read-as__line">
        Read as <strong>{words || 'everything'}</strong>
        {parts.map((p) => ` · ${p}`).join('')}
      </p>
      {meaning ? (
        <p className="read-as__meaning">
          {meaning.map((part, i) => (part.strong ? <strong key={i}>{part.text}</strong> : <span key={i}>{part.text}</span>))}
        </p>
      ) : null}
      {parse.explanation.length > 0 && parse.input.trim() !== '' ? (
        <details className="read-as__details">
          <summary>How your words were read</summary>
          <ul>
            {parse.explanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function FiltersSheet({
  open,
  onClose,
  filters,
  onChange,
  zip,
  countText,
}: {
  open: boolean;
  onClose: () => void;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
  zip: string | null;
  /** "12 lots and 3 sales", or null while the search loads. */
  countText: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={onClose}>
      <div className="sheet__body">
        <div className="sheet__head">
          <h2 id={titleId} className="sheet__title">
            Filters
          </h2>
          <button type="button" className="icon-btn" aria-label="Close filters" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <FilterPanel filters={filters} onChange={onChange} zip={zip} />
        <button type="button" className="btn btn--primary" onClick={onClose}>
          {countText === null ? 'Show results' : `Show ${countText}`}
        </button>
      </div>
    </dialog>
  );
}

/** router state from "Before you set out": how many hunts it started. */
interface SetOutState {
  readonly setOut?: { readonly hunts?: number };
}

/** The groups that start folded under the exact matches. */
type FoldKey = Exclude<MatchGroupKey, 'exact'>;

interface ViewState {
  /** The search (argsKey) this view belongs to; a new search starts a fresh view. */
  readonly key: string;
  /** Groups the buyer opened or closed. Absent: the default (see isOpen). */
  readonly open: Partial<Record<FoldKey, boolean>>;
  /** Cards shown per group. */
  readonly shown: Record<MatchGroupKey, number>;
}

function freshView(key: string): ViewState {
  return { key, open: {}, shown: { exact: PAGE_SIZE, close: PAGE_SIZE, mentions: PAGE_SIZE } };
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const setOutHunts = (location.state as SetOutState | null)?.setOut?.hunts ?? 0;
  const q = params.get('q') ?? '';
  const home = useHome();
  const now = useNow();
  const uid = useId();
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useDocumentTitle(q ? `“${q}”` : 'Search');

  const parse = useMemo(
    () => parseQuery(q, { homePostalCode: home.zip ?? undefined, defaultRadiusMiles: home.radiusMiles }),
    [q, home.zip, home.radiusMiles],
  );

  // Filters follow a newly submitted query; after that, clicks override the words.
  const [filterState, setFilterState] = useState(() => ({
    q,
    homeRadius: home.radiusMiles,
    filters: filtersFromParse(parse, defaultFilters(home.radiusMiles)),
  }));
  let filters = filterState.filters;
  if (filterState.q !== q || filterState.homeRadius !== home.radiusMiles) {
    const base = filterState.homeRadius !== home.radiusMiles ? { ...filters, radius: home.radiusMiles } : filters;
    filters = filtersFromParse(parse, base);
    setFilterState({ q, homeRadius: home.radiusMiles, filters });
  }
  const setFilters = (next: SearchFilters) => setFilterState({ q, homeRadius: home.radiusMiles, filters: next });

  // A place named without a ZIP ("near Beloit") is looked up in the gazetteer, never guessed.
  const place = parse.location.place?.needsResolution && parse.location.place.city ? parse.location.place : null;
  const placeKey = place ? `${place.city}|${place.state ?? ''}` : '';
  const places = useAsync(() => resolvePlace(place?.city ?? '', place?.state ?? null), [placeKey], place !== null);
  const [chosenZip, setChosenZip] = useState<{ key: string; zip: string } | null>(null);
  const candidates = place ? (places.data ?? []) : [];
  const resolvedZip =
    chosenZip && chosenZip.key === placeKey ? chosenZip.zip : candidates.length === 1 ? (candidates[0]?.zip ?? null) : null;

  const args = useMemo(
    () =>
      toSearchArgs(parse.searchParams, filters, {
        homeZip: place ? null : home.zip,
        resolvedZip,
        page: { limit: SEARCH_LIMIT_MAX, offset: 0 },
        // 0018: the parser's grouped query (synonyms, model variants) beside the plain one.
        tsquery: parse.tsquery,
      }),
    [parse, filters, place, home.zip, resolvedZip],
  );
  const argsKey = JSON.stringify(args);
  const origin = args?.p_postal_code ?? null;

  const search = useAsync<Results>(async () => {
    if (!args) return { rows: [], info: new Map() };
    const rows = await searchLots(args);
    // Close-time facts for the first cards the page opens with: the exact
    // group's, or the first group that has any when nothing is exact.
    const g = groupByMatch(rows);
    const first = [g.exact, g.close, g.mentions].find((list) => list.length > 0) ?? [];
    let info: ReadonlyMap<string, LotCloseInfo> = new Map();
    try {
      info = await fetchLotCloseInfo(first.slice(0, PAGE_SIZE).map((r) => r.lot_id));
    } catch (err) {
      console.warn(err); // precision unknown: cards show the date only, never a countdown
    }
    return { rows, info };
  }, [argsKey]);

  // The headline counts exact matches, so "N farther away" counts exact matches too.
  const farther = useAsync(async () => {
    const wider = args ? fartherArgs(args) : null;
    return wider ? countSearchLots({ ...wider, p_scope: 'exact' }) : null;
  }, [argsKey]);

  // What the words were understood to mean (search_explain, 0045).
  const pQuery = args?.p_query ?? null;
  const explained = useAsync(() => explainSearch(pQuery ?? ''), [pQuery], Boolean(pQuery));
  const meaning = pQuery && explained.data && !explained.loading ? explainParts(explained.data, q) : null;

  // The same search on sites Skeuos does not copy listings from.
  const elsewhere = useAsync(() => listElsewhereSources(), []);
  const originPlace = useAsync(() => lookupPostalCode(origin ?? ''), [origin], origin !== null);

  const [view, setView] = useState<ViewState>(() => freshView(argsKey));
  const current = view.key === argsKey ? view : freshView(argsKey);
  const updateView = (key: string, change: (v: ViewState) => ViewState) =>
    setView((v) => change(v.key === key ? v : freshView(key)));
  const [loadingMore, setLoadingMore] = useState<MatchGroupKey | null>(null);

  const rows = search.data?.rows ?? [];
  const groups = groupByMatch(rows);
  const exact = groups.exact;
  const truncated = truncatedGroup(rows, SEARCH_LIMIT_MAX);

  // A folded group opens by itself when nothing above it matched.
  const isOpen = (key: FoldKey): boolean =>
    current.open[key] ?? (key === 'close' ? exact.length === 0 : exact.length === 0 && groups.close.length === 0);

  /** Fetch close-time facts for the cards about to show, then show them. */
  async function reveal(group: MatchGroupKey, list: readonly SearchLotRow[], upTo: number, apply: () => void) {
    const data = search.data;
    if (!data) return;
    const missing = list.slice(0, upTo).map((r) => r.lot_id).filter((id) => !data.info.has(id));
    if (missing.length === 0) {
      apply();
      return;
    }
    setLoadingMore(group);
    try {
      const more = await fetchLotCloseInfo(missing);
      search.setData((cur) => ({ rows: cur?.rows ?? data.rows, info: new Map([...(cur?.info ?? data.info), ...more]) }));
    } catch (err) {
      console.warn(err);
    } finally {
      setLoadingMore(null);
      apply();
    }
  }

  function showMore(group: MatchGroupKey, list: readonly SearchLotRow[]) {
    const key = argsKey;
    const next = current.shown[group] + PAGE_SIZE;
    void reveal(group, list, next, () => updateView(key, (v) => ({ ...v, shown: { ...v.shown, [group]: next } })));
  }

  function toggle(group: FoldKey, list: readonly SearchLotRow[]) {
    const key = argsKey;
    if (isOpen(group)) {
      updateView(key, (v) => ({ ...v, open: { ...v.open, [group]: false } }));
      return;
    }
    void reveal(group, list, current.shown[group], () => updateView(key, (v) => ({ ...v, open: { ...v.open, [group]: true } })));
  }

  const [sheetOpen, setSheetOpen] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    const next = new URLSearchParams(params);
    if (value) next.set('q', value);
    else next.delete('q');
    setParams(next);
  }

  const radiusSearch = origin !== null && filters.radius !== 'anywhere';
  const nearbyRows = exact.filter((r) => r.match_basis === 'nearby');
  const shipping = exact.filter((r) => r.match_basis === 'ships_to_you').length;
  const inState = exact.filter((r) => r.match_basis === 'in_state').length;
  // 0023: under "Price" and "Worth the trip", sales (no price, no score) come after the lots; say so.
  const sortNote = search.loading || search.error ? null : saleSortNote(filters.sort, rows.some((r) => r.sale_level === true));
  const more = farther.data != null && search.data ? fartherCount(farther.data, exact.length, SEARCH_LIMIT_MAX) : null;

  // The design's "3 within 60 mi" on a phone, "3 lots within 60 mi" on the web,
  // which names sales apart: "3 lots and 2 sales within 60 mi". Exact matches only.
  let title: ReactNode;
  const extras: string[] = [];
  if (radiusSearch) {
    title = (
      <>
        <span className="mobile-only-inline">{nearbyRows.length}</span>
        <span className="desktop-only-inline">{tallyRows(nearbyRows)}</span> within {filters.radius} mi
      </>
    );
    if (shipping) extras.push(`${shipping} more ship to you`);
    if (inState) extras.push(`${inState} more in ${parse.location.states.join(', ')}`);
  } else if (parse.location.states.length && filters.radius !== 'anywhere') {
    title = `${tallyRows(exact)} in ${parse.location.states.join(', ')}`;
  } else {
    title = `${tallyRows(exact)} anywhere`;
  }
  if (truncated === 'exact') extras.push(`showing the top ${SEARCH_LIMIT_MAX}`);
  const fartherCountText = more ? `${more.count}${more.atLeast ? '+' : ''}` : null;
  const fartherText = more ? `${fartherCountText} more ${more.count === 1 ? 'match' : 'matches'} farther than ${filters.radius} mi` : null;
  const showFarther = fartherText !== null && !search.loading && !search.error;
  const widen = () => setFilters({ ...filters, radius: 'anywhere' });

  const hasWords = parse.websearchQuery.trim() !== '' || parse.brands.length > 0;
  const huntHref = `/hunts/new?q=${encodeURIComponent(q)}`;
  const others = [
    groups.close.length ? `${groups.close.length} close ${groups.close.length === 1 ? 'match' : 'matches'}` : null,
    groups.mentions.length ? `${groups.mentions.length} word ${groups.mentions.length === 1 ? 'match' : 'matches'}` : null,
  ].filter((x): x is string => x !== null);
  const status = !args
    ? 'Check at least one seller type to search.'
    : search.loading
      ? 'Searching…'
      : search.error
        ? 'The search did not load.'
        : `${tallyRows(exact)} found${others.length ? `, plus ${others.join(' and ')}` : ''}.`;

  const words = elsewhereWords(parse.websearchQuery);
  const links =
    hasWords && !search.loading
      ? elsewhereLinks(elsewhere.data ?? [], {
          words,
          maxCents: filters.maxCents,
          origin: originPlace.data ? { zip: originPlace.data.postalCode, lat: originPlace.data.lat, lon: originPlace.data.lon } : null,
          radiusMiles: radiusSearch ? (filters.radius as number) : null,
        })
      : [];

  const chooser =
    place && candidates.length > 1 && !resolvedZip ? (
      <div className="notice" role="group" aria-label="Which place do you mean?">
        <p>
          There is a {place.city} in more than one state. Which one do you mean? Until you pick, results are not limited by
          distance.
        </p>
        <div className="notice__actions">
          {candidates.map((c) => (
            <button key={c.state} type="button" className="chip" onClick={() => setChosenZip({ key: placeKey, zip: c.zip })}>
              {c.city}, {c.state}
            </button>
          ))}
        </div>
      </div>
    ) : place && places.data && candidates.length === 0 ? (
      <div className="notice" role="status">
        <p>
          We could not find {place.city}
          {place.state ? `, ${place.state}` : ''} in our ZIP list, so results are not limited by distance. Add a ZIP to your
          search to narrow them.
        </p>
      </div>
    ) : null;

  const cards = (list: readonly SearchLotRow[], group: MatchGroupKey, label: string, tile: ReactNode = null) => {
    const count = current.shown[group];
    const summaries = list.slice(0, count).map((r) => fromSearchRow(r, search.data?.info.get(r.lot_id)));
    return (
      <>
        <ul className="lot-grid" aria-label={label}>
          {summaries.map((lot) => (
            <li key={lot.id}>
              <LotCard lot={lot} now={now} from={`/?${params.toString()}`} />
            </li>
          ))}
          {tile}
        </ul>
        {count < list.length ? (
          <button type="button" className="btn btn--secondary btn--block" onClick={() => showMore(group, list)} disabled={loadingMore !== null}>
            {loadingMore === group ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, list.length - count)} more`}
          </button>
        ) : null}
      </>
    );
  };

  const fold = (group: FoldKey, list: readonly SearchLotRow[], heading: string, lead: string) => {
    if (list.length === 0) return null;
    const open = isOpen(group);
    const kinds = kindsText(list);
    const headId = `${uid}-${group}-head`;
    const bodyId = `${uid}-${group}-body`;
    return (
      <section className={`match-group match-group--${group}`} aria-labelledby={headId}>
        <h2 className="match-group__heading">
          <button
            type="button"
            id={headId}
            className="match-group__toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => toggle(group, list)}
            disabled={loadingMore === group}
          >
            <span className="match-group__title">
              {heading} <span className="match-group__count">{`${list.length}${truncated === group ? '+' : ''}`}</span>
            </span>
            <span className="match-group__kinds">
              {lead}
              {kinds ? `: ${kinds}` : ''}
            </span>
            <span className="match-group__cta" aria-hidden="true">
              {loadingMore === group ? 'Loading…' : open ? 'Hide' : 'Show'}
            </span>
          </button>
        </h2>
        <div id={bodyId} className="match-group__body" hidden={!open}>
          {open ? cards(list, group, heading) : null}
        </div>
      </section>
    );
  };

  const settled = Boolean(args) && !search.error && !(search.loading && !search.data);

  // When nothing open here is exactly what was asked for, the other sites are
  // the next place to look, so their links come straight after that notice
  // instead of below every fold.
  const leadElsewhere = settled && links.length > 0 && rows.length > 0 && exact.length === 0;
  const elsewhereSection = (
    <section className={`elsewhere${leadElsewhere ? ' elsewhere--lead' : ''}`} aria-labelledby={`${uid}-elsewhere`}>
      <h2 id={`${uid}-elsewhere`} className="elsewhere__title">
        Search other sites for “{words}”
      </h2>
      <p className="elsewhere__note">
        Skeuos copies listings only from sites that allow it. Each link opens the same search on one that does not
        {origin && radiusSearch ? `, within ${filters.radius} mi of ${origin} where the site can narrow by place` : ''}.
      </p>
      <ul className="elsewhere__links">
        {links.map((l) => (
          <li key={l.key}>
            <a className="chip" href={l.href} target="_blank" rel="noopener noreferrer">
              {l.name}
              {l.place ? ` · ${l.place}` : ''}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <div className="search-page">
      <header className="search-head mobile-only">
        <Wordmark size={24} markSize={26} />
        <LocationButton />
      </header>

      <form role="search" className="search-form mobile-only" onSubmit={submit}>
        <label htmlFor="q" className="search-form__label">
          What do you need?
        </label>
        <div className="search-form__row">
          <input
            id="q"
            type="search"
            className="input input--strong"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. generator under $800 within 60 miles"
            enterKeyHint="search"
          />
          <button type="submit" className="btn btn--primary btn--square" aria-label="Search">
            <SearchIcon size={20} strokeWidth={2.2} />
          </button>
        </div>
      </form>

      <div className="search-layout">
        <aside className="search-sidebar desktop-only" aria-label="Filters">
          <FilterPanel filters={filters} onChange={setFilters} zip={origin ?? home.zip} />
        </aside>

        <section className="search-results" aria-labelledby="results-title">
          <div className="search-read">
            {setOutHunts > 0 ? (
              <div className="notice notice--pine" role="status">
                <p>
                  {setOutHunts} {setOutHunts === 1 ? 'hunt is' : 'hunts are'} keeping watch. <Link to="/hunts">See them in Hunts</Link>
                </p>
              </div>
            ) : null}
            <ReadAs parse={parse} filters={filters} origin={origin} meaning={meaning} />
            {!home.zip && !place && parse.location.states.length === 0 && !parse.location.postalCode ? (
              <div className="notice" role="status">
                <p>Set your ZIP to rank lots by driving distance. Until then, results are not limited by distance.</p>
                <div className="notice__actions">
                  <LocationButton />
                </div>
              </div>
            ) : null}
            {chooser}
          </div>

          <div className="chip-row mobile-only" role="group" aria-label="Sort results">
            {sortChips(filters.sort).map((c) => (
              <button
                key={c.value}
                type="button"
                className="chip"
                aria-pressed={filters.sort === c.value}
                onClick={() => setFilters({ ...filters, sort: c.value })}
              >
                {c.label}
              </button>
            ))}
            <button type="button" className="chip chip--icon" onClick={() => setSheetOpen(true)}>
              <FilterIcon size={16} /> Filters
            </button>
          </div>

          <div className="results-head">
            <h1 id="results-title" className="results-head__title">
              {search.loading && !search.data ? 'Searching…' : search.error ? 'Results unavailable' : title}
              {!search.loading && !search.error && (extras.length || fartherText) ? (
                <span className="results-head__extra">
                  {extras.map((e) => ` · ${e}`).join('')}
                  <span className="desktop-only-inline">{fartherCountText ? ` · ${fartherCountText} more farther away` : ''}</span>
                </span>
              ) : null}
            </h1>
            {showFarther ? (
              <button type="button" className="link-btn link-btn--strong results-head__farther mobile-only" onClick={widen}>
                {fartherCountText} farther away
              </button>
            ) : null}
            <label className="sort-select desktop-only">
              Sort
              <select className="input input--compact" value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value as SearchFilters['sort'] })}>
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {sortNote ? <p className="results-note">{sortNote}</p> : null}
          <p className="visually-hidden" aria-live="polite">
            {status}
          </p>

          {!args ? (
            <EmptyState title="No seller type selected">
              <p>Check at least one seller type in the filters to search.</p>
            </EmptyState>
          ) : search.error ? (
            <ErrorState error={search.error} onRetry={search.reload} title="The search did not load" />
          ) : search.loading && !search.data ? (
            <CardSkeletons count={3} />
          ) : rows.length === 0 ? (
            <EmptyState title={q ? `Nothing open matches “${q}” yet.` : 'No open lots here right now.'}>
              <p>
                {radiusSearch
                  ? `Try a wider distance${filters.includeShippable ? '' : ', include lots that ship'}, or fewer words. `
                  : 'Try fewer words. '}
                {hasWords ? 'Or keep watch for it: save it as a hunt and Skeuos tells you when one is listed.' : ''}
              </p>
            </EmptyState>
          ) : exact.length === 0 ? (
            <div className="notice match-none" role="status">
              <p>
                Nothing open is exactly what you asked for{radiusSearch ? ` within ${filters.radius} mi` : ''} yet.
                {groups.close.length > 0 ? ' The close matches are below.' : ' Listings that use your words are below.'}
              </p>
              {hasWords && q ? (
                <div className="notice__actions">
                  <Link to={huntHref} className="btn btn--secondary btn--small">
                    Keep watch for it
                  </Link>
                </div>
              ) : null}
            </div>
          ) : (
            cards(
              exact,
              'exact',
              'Lots',
              hasWords && q ? (
                <li className="desktop-only">
                  <Link to={huntHref} className="hunt-tile">
                    <span className="hunt-tile__title">Keep watch for this</span>
                    <span className="hunt-tile__body">
                      Save it as a hunt. Skeuos checks every source each hour and tells you when a new one is listed
                      {origin ? ` near ${origin}` : ''}.
                    </span>
                    <span className="hunt-tile__cta">Save as a hunt</span>
                  </Link>
                </li>
              ) : null,
            )
          )}

          {showFarther ? (
            <button type="button" className="farther-row" onClick={widen}>
              <span>{fartherText}</span>
              <span className="farther-row__cta">Show them</span>
            </button>
          ) : null}

          {leadElsewhere ? elsewhereSection : null}

          {settled ? (
            <>
              {fold('close', groups.close, 'Close matches', 'Related kinds, or lots that include one')}
              {fold('mentions', groups.mentions, 'Word matches', 'Your words appear, but these are other things')}
            </>
          ) : null}

          {links.length > 0 && !leadElsewhere ? elsewhereSection : null}

          {hasWords && q ? (
            <Link to={huntHref} className="hunt-cta mobile-only">
              <span className="hunt-cta__title">Keep watch for this</span>
              <span className="hunt-cta__body">Skeuos checks every source each hour and tells you when a new one is listed.</span>
            </Link>
          ) : null}
        </section>
      </div>

      <FiltersSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={filters}
        onChange={setFilters}
        zip={origin ?? home.zip}
        countText={search.data && !search.loading && exact.length > 0 ? tallyRows(exact) : null}
      />
    </div>
  );
}
