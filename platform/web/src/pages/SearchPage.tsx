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
import { resolvePlace } from '../data/postal';
import { countSearchLots, fetchLotCloseInfo, searchLots, SEARCH_LIMIT_MAX, type LotCloseInfo } from '../data/search';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useNow } from '../hooks/useNow';
import { formatCentsShort } from '../lib/money';
import {
  defaultFilters,
  fartherArgs,
  fartherCount,
  filtersFromParse,
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

/** The design's "Read as generator · up to $800 · within 60 mi of 53202". */
function ReadAs({ parse, filters, origin }: { parse: ParsedQuery; filters: SearchFilters; origin: string | null }) {
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
  count,
}: {
  open: boolean;
  onClose: () => void;
  filters: SearchFilters;
  onChange: (f: SearchFilters) => void;
  zip: string | null;
  count: number | null;
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
          {count === null ? 'Show results' : `Show ${count} ${count === 1 ? 'lot' : 'lots'}`}
        </button>
      </div>
    </dialog>
  );
}

/** router state from "Before you set out": how many hunts it started. */
interface SetOutState {
  readonly setOut?: { readonly hunts?: number };
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const setOutHunts = (location.state as SetOutState | null)?.setOut?.hunts ?? 0;
  const q = params.get('q') ?? '';
  const home = useHome();
  const now = useNow();
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
    let info: ReadonlyMap<string, LotCloseInfo> = new Map();
    try {
      info = await fetchLotCloseInfo(rows.slice(0, PAGE_SIZE).map((r) => r.lot_id));
    } catch (err) {
      console.warn(err); // precision unknown: cards show the date only, never a countdown
    }
    return { rows, info };
  }, [argsKey]);

  const farther = useAsync(async () => {
    const wider = args ? fartherArgs(args) : null;
    return wider ? countSearchLots(wider) : null;
  }, [argsKey]);

  const [visible, setVisible] = useState(PAGE_SIZE);
  useEffect(() => setVisible(PAGE_SIZE), [argsKey]);
  const [loadingMore, setLoadingMore] = useState(false);

  async function showMore() {
    const data = search.data;
    if (!data) return;
    const next = visible + PAGE_SIZE;
    const missing = data.rows.slice(visible, next).map((r) => r.lot_id).filter((id) => !data.info.has(id));
    setLoadingMore(true);
    try {
      if (missing.length) {
        const more = await fetchLotCloseInfo(missing);
        search.setData((cur) => ({ rows: cur?.rows ?? data.rows, info: new Map([...(cur?.info ?? data.info), ...more]) }));
      }
    } catch (err) {
      console.warn(err);
    } finally {
      setLoadingMore(false);
      setVisible(next);
    }
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

  const rows = search.data?.rows ?? [];
  const summaries = rows.slice(0, visible).map((r) => fromSearchRow(r, search.data?.info.get(r.lot_id)));
  const capped = rows.length >= SEARCH_LIMIT_MAX;
  const radiusSearch = origin !== null && filters.radius !== 'anywhere';
  const nearby = rows.filter((r) => r.match_basis === 'nearby').length;
  const shipping = rows.filter((r) => r.match_basis === 'ships_to_you').length;
  const inState = rows.filter((r) => r.match_basis === 'in_state').length;
  const more = farther.data != null && search.data ? fartherCount(farther.data, rows.length, SEARCH_LIMIT_MAX) : null;
  const lots = (n: number) => `${n} ${n === 1 ? 'lot' : 'lots'}`;

  // The design's "3 within 60 mi" on a phone, "3 lots within 60 mi" on the web.
  let title: ReactNode;
  const extras: string[] = [];
  if (radiusSearch) {
    title = (
      <>
        {nearby}
        <span className="desktop-only-inline"> {nearby === 1 ? 'lot' : 'lots'}</span> within {filters.radius} mi
      </>
    );
    if (shipping) extras.push(`${shipping} more ship to you`);
    if (inState) extras.push(`${inState} more in ${parse.location.states.join(', ')}`);
  } else if (parse.location.states.length && filters.radius !== 'anywhere') {
    title = `${lots(rows.length)} in ${parse.location.states.join(', ')}`;
  } else {
    title = `${lots(rows.length)} anywhere`;
  }
  if (capped) extras.push(`showing the top ${SEARCH_LIMIT_MAX}`);
  const fartherCountText = more ? `${more.count}${more.atLeast ? '+' : ''}` : null;
  const fartherText = more ? `${fartherCountText} more ${more.count === 1 ? 'match' : 'matches'} farther than ${filters.radius} mi` : null;
  const showFarther = fartherText !== null && !search.loading && !search.error;
  const widen = () => setFilters({ ...filters, radius: 'anywhere' });

  const hasWords = parse.websearchQuery.trim() !== '' || parse.brands.length > 0;
  const huntHref = `/hunts/new?q=${encodeURIComponent(q)}`;
  const status = !args
    ? 'Check at least one seller type to search.'
    : search.loading
      ? 'Searching…'
      : search.error
        ? 'The search did not load.'
        : `${lots(rows.length)} found.`;

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
            <ReadAs parse={parse} filters={filters} origin={origin} />
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
          ) : (
            <>
              <ul className="lot-grid" aria-label="Lots">
                {summaries.map((lot) => (
                  <li key={lot.id}>
                    <LotCard lot={lot} now={now} from={`/?${params.toString()}`} />
                  </li>
                ))}
                {hasWords && q ? (
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
                ) : null}
              </ul>
              {visible < rows.length ? (
                <button type="button" className="btn btn--secondary btn--block" onClick={showMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, rows.length - visible)} more`}
                </button>
              ) : null}
            </>
          )}

          {showFarther ? (
            <button type="button" className="farther-row" onClick={widen}>
              <span>{fartherText}</span>
              <span className="farther-row__cta">Show them</span>
            </button>
          ) : null}

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
        count={search.data && !search.loading ? rows.length : null}
      />
    </div>
  );
}
