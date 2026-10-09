import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BackIcon, ExternalIcon } from '../components/Icons';
import { LocationButton } from '../components/LocationDialog';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { readLotMeta } from '../data/lots';
import { lookupPostalCodes, resolvePlace, type PostalPlace } from '../data/postal';
import { listMyWatchlist, type WatchedLot } from '../data/watchlist';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { distanceTag, distanceWords } from '../lib/distance';
import {
  checklistItems,
  checklistKey,
  groupStops,
  MAPS_MOBILE_WAYPOINTS,
  MAPS_WAYPOINTS,
  mapsDirectionsUrl,
  orderStops,
  pickupPlaceOf,
  placeLabel,
  type Located,
  type PickupStop,
  wonForPickup,
} from '../lib/pickup';
import { readStored, writeStored } from '../lib/storage';
import { useAuth } from '../providers/AuthProvider';
import { useHome } from '../providers/HomeProvider';

type Stop = PickupStop<WatchedLot>;

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Who to ask for at a stop: the seller the auction names, else the site it is listed on. */
function stopName(stop: Stop): string {
  const first = stop.lots[0];
  return first?.sellerName ?? first?.sourceName ?? 'Pickup';
}

/** "What to bring", remembered on this device for this set of lots. */
function Checklist({ lotIds }: { lotIds: readonly string[] }) {
  const key = checklistKey(lotIds);
  const items = checklistItems(lotIds.length);
  const [checked, setChecked] = useState<string[]>(() => readStored(key, isStringList) ?? []);
  useEffect(() => setChecked(readStored(key, isStringList) ?? []), [key]);
  function flip(id: string) {
    setChecked((cur) => {
      const nextList = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      writeStored(key, nextList);
      return nextList;
    });
  }
  return (
    <fieldset className="bring">
      <legend className="bring__legend">What to bring</legend>
      {items.map((item) => (
        <label key={item.id} className="bring__item">
          <input type="checkbox" checked={checked.includes(item.id)} onChange={() => flip(item.id)} />
          {item.label}
        </label>
      ))}
    </fieldset>
  );
}

function StopLots({ stop }: { stop: Stop }) {
  return (
    <ul className="run__lots">
      {stop.lots.map((lot) => {
        const terms = readLotMeta(lot.meta).terms;
        return (
          <li key={lot.id}>
            <Link to={`/lot/${lot.id}`} className="run__lot">
              {lot.title}
            </Link>
            {terms ? (
              <details className="run__terms">
                <summary>Inspection and removal, from the listing</summary>
                <p>{terms}</p>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The pickup run (Pickup.dc.html), from Bids → Won: the won lots' pickup
 * addresses, ordered nearest-neighbour from the home ZIP, a "what to bring"
 * checklist, and the whole route in Google Maps.
 */
export function PickupPage() {
  useDocumentTitle('Pickup run');
  const { user } = useAuth();
  const home = useHome();
  const list = useAsync(() => listMyWatchlist(user?.id ?? ''), [user?.id], Boolean(user));

  // Won lots only; a watched sale-level row (0023) joins the run only once it is marked won.
  const won = useMemo(() => wonForPickup(list.data ?? []), [list.data]);
  const { stops, unlocated } = useMemo(() => groupStops(won, pickupPlaceOf), [won]);

  // Where each stop is: its ZIP's centroid, or (no ZIP) its city's, through the gazetteer.
  const zips = useMemo(() => [...new Set(stops.map((s) => s.place.postalCode).filter((z): z is string => z !== null))].sort(), [stops]);
  const cities = useMemo(
    () =>
      [
        ...new Set(
          stops
            .filter((s) => s.place.postalCode === null && s.place.city !== null && s.place.state !== null)
            .map((s) => `${s.place.city}|${s.place.state}`),
        ),
      ].sort(),
    [stops],
  );
  const points = useAsync(
    async () => {
      const cityZip = new Map<string, string>();
      for (const key of cities) {
        const [city, state] = key.split('|') as [string, string];
        const found = await resolvePlace(city, state).catch(() => []);
        if (found.length === 1 && found[0]) cityZip.set(key, found[0].zip);
      }
      const centroids = await lookupPostalCodes([...zips, ...cityZip.values()]);
      return { centroids, cityZip };
    },
    [zips.join(','), cities.join(',')],
    stops.length > 0,
  );

  const locate = (stop: Stop): Located | null => {
    const data = points.data;
    if (!data) return null;
    const byZip = (zip: string | null | undefined): PostalPlace | undefined => (zip ? data.centroids.get(zip) : undefined);
    const exact = byZip(stop.place.postalCode);
    if (exact) return { point: exact, approximate: false };
    const city = stop.place.city && stop.place.state ? byZip(data.cityZip.get(`${stop.place.city}|${stop.place.state}`)) : undefined;
    return city ? { point: city, approximate: true } : null;
  };

  const run = home.place ? orderStops(home.place, stops, locate) : null;
  const ordered: { stop: Stop; miles: number | null; approximate: boolean }[] = run
    ? [...run.legs.map((l) => ({ stop: l.stop, miles: l.miles, approximate: l.approximate })), ...run.unordered.map((s) => ({ stop: s, miles: null, approximate: false }))]
    : stops.map((s) => ({ stop: s, miles: null, approximate: false }));
  const waypoints = ordered.map((o) => placeLabel(o.stop.place));
  const mapsUrl = home.zip && waypoints.length > 0 ? mapsDirectionsUrl(home.zip, waypoints) : null;
  const lotIds = won.map((l) => l.id);

  const header = (
    <header className="page-head page-head--detail">
      <Link to="/bids?tab=won" className="icon-btn" aria-label="Back to bids">
        <BackIcon />
      </Link>
      <span className="page-head__crumb">Won lots</span>
    </header>
  );

  if (list.loading && !list.data) return <LoadingState label="Loading your won lots" />;
  if (list.error) {
    return (
      <div className="page page--narrow">
        {header}
        <ErrorState error={list.error} onRetry={list.reload} title="Your won lots did not load" />
      </div>
    );
  }
  if (won.length === 0) {
    return (
      <div className="page page--narrow">
        {header}
        <h1 className="page-title">Pickup run</h1>
        <EmptyState
          title="Nothing to pick up yet"
          action={
            <Link to="/bids" className="btn btn--secondary">
              Open Bids
            </Link>
          }
        >
          <p>When a lot you watched closes, mark it Won in Bids. It shows up here with the route to collect it.</p>
        </EmptyState>
      </div>
    );
  }

  const stopCount = ordered.length;
  const stopsText = `${stopCount} ${stopCount === 1 ? 'stop' : 'stops'}`;
  const total = run?.totalMiles ?? null;
  const approximate = run?.approximate ?? false;

  return (
    <div className="page page--narrow">
      {header}
      <section className="run__head">
        <h1 className="page-title">Your pickup run</h1>
        <p className="run__summary">
          <span aria-hidden="true">
            {stopsText}
            {total !== null ? ` · ${distanceTag(total, approximate)} round trip, straight-line` : ''}
          </span>
          <span className="visually-hidden">
            {stopsText}
            {total !== null ? `, ${distanceWords(total, approximate)} round trip in a straight line` : ''}
          </span>
        </p>
      </section>

      {!home.zip ? (
        <div className="notice" role="status">
          <p>Set where you set out from to put the stops in order and open the route.</p>
          <div className="notice__actions">
            <LocationButton />
          </div>
        </div>
      ) : null}

      {stopCount > 0 ? (
        <ol className="run" aria-label="Stops">
          {home.zip ? (
            <li className="run__row run__row--home">
              <span className="run__rail" aria-hidden="true">
                <span className="run__ring" />
                <span className="run__line" />
              </span>
              <div className="run__home">
                <strong>Home</strong> · <span className="run__mono">{home.zip}</span>
              </div>
            </li>
          ) : null}
          {ordered.map(({ stop, miles, approximate }, i) => (
            <li key={stop.key} className="run__row">
              <span className="run__rail" aria-hidden="true">
                <span className="run__num">{i + 1}</span>
                <span className="run__line" />
              </span>
              <div className="run__stop">
                <h2 className="run__name">
                  <span className="visually-hidden">Stop {i + 1}: </span>
                  {stopName(stop)}
                </h2>
                <StopLots stop={stop} />
                <p className="run__address">{placeLabel(stop.place)}</p>
                {miles !== null ? (
                  <p className="run__leg">
                    <span aria-hidden="true">{distanceTag(miles, approximate)}</span>
                    <span className="visually-hidden">{distanceWords(miles, approximate)}</span>
                    {i === 0 ? ' from home' : ' from the stop before'}
                  </p>
                ) : run ? (
                  <p className="run__leg run__leg--unknown">Its place is not on our map, so it goes last. Maps can still find the address.</p>
                ) : null}
              </div>
            </li>
          ))}
          {home.zip ? (
            <li className="run__row run__row--end">
              <span className="run__rail" aria-hidden="true">
                <span className="run__dot" />
              </span>
              <div className="run__home">
                <strong>Home</strong>
                {run?.homeMiles !== null && run?.homeMiles !== undefined ? (
                  <>
                    {' '}
                    · <span aria-hidden="true" className="run__mono">{distanceTag(run.homeMiles, run.approximate)}</span>
                    <span className="visually-hidden">{distanceWords(run.homeMiles, run.approximate)}</span> back
                  </>
                ) : null}
              </div>
            </li>
          ) : null}
        </ol>
      ) : null}

      {unlocated.length > 0 ? (
        <section className="run__off" aria-labelledby="off-route">
          <h2 id="off-route" className="run__off-title">
            Not on the route
          </h2>
          <p className="small">
            {unlocated.length === 1 ? 'This listing gives' : 'These listings give'} no pickup location, so{' '}
            {unlocated.length === 1 ? 'it is' : 'they are'} left off the route. Check the listing before you go.
          </p>
          <ul className="run__lots">
            {unlocated.map((lot) => (
              <li key={lot.id}>
                <Link to={`/lot/${lot.id}`} className="run__lot">
                  {lot.title}
                </Link>
                {lot.ships ? <span className="small muted"> · the listing says it ships</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Checklist lotIds={lotIds} />

      <div className="run__actions">
        {mapsUrl ? (
          <a className="btn btn--primary btn--large btn--block" href={mapsUrl} target="_blank" rel="noopener noreferrer">
            Open the route in Maps
            <ExternalIcon size={16} strokeWidth={2.2} />
            <span className="visually-hidden"> (opens Google Maps in a new tab)</span>
          </a>
        ) : null}
        {mapsUrl && stopCount > MAPS_MOBILE_WAYPOINTS ? (
          <p className="run__note">
            {stopCount > MAPS_WAYPOINTS
              ? `Maps takes ${MAPS_WAYPOINTS} stops in one link; add the rest there.`
              : `On a phone’s browser Maps may open only the first ${MAPS_MOBILE_WAYPOINTS} stops; the Maps app takes them all.`}
          </p>
        ) : null}
        <p className="run__note">Windows come from each listing. Confirm with the seller before you drive.</p>
        {total !== null ? (
          <p className="run__note">
            Miles are straight-line between ZIP centers{approximate ? ', or a town’s center where the listing gives no ZIP (≈)' : ''}; the
            road is longer.
          </p>
        ) : null}
      </div>
    </div>
  );
}
