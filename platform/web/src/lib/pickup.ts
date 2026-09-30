/**
 * The pickup run (Pickup.dc.html): won lots grouped into stops by where they
 * are collected, ordered nearest-neighbour from the home ZIP's centroid, and
 * handed to Google Maps as one route that leaves home and comes back.
 *
 * Nothing here is invented: a stop is only what the lot and auction rows say,
 * and a stop's point is a gazetteer centroid (its ZIP's, or, with no ZIP, its
 * city's, which makes the distances to it approximate).
 */
import { haversineMiles, type LatLon } from './distance';

/**
 * What goes on the run: the watched lots marked won. A sale-level row (0023)
 * stands for a whole sale; it goes on the run the same way, only once it is
 * marked won (something was won there), never for being watched.
 */
export function wonForPickup<L>(entries: readonly { readonly watch: { readonly outcome: string | null }; readonly lot: L | null }[]): L[] {
  const out: L[] = [];
  for (const e of entries) if (e.watch.outcome === 'won' && e.lot !== null) out.push(e.lot);
  return out;
}

/** A pickup address, as the lot and auction rows state it. */
export interface PickupPlace {
  readonly line1: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}

/** What a watched lot says about where it is collected (see data/watchlist.ts). */
export interface PickupSource {
  /** lots.pickup_city / pickup_state / pickup_postal_code. */
  readonly city: string | null;
  readonly state: string | null;
  readonly ownPostalCode?: string | null;
  /** auctions.pickup_line1 / pickup_city / pickup_state / pickup_postal_code. */
  readonly auctionPickup?: PickupPlace | null;
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function zip5(v: string | null | undefined): string | null {
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(v ?? '');
  return m ? (m[1] as string) : null;
}

const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Where a lot is collected. The lot's own city, state and ZIP win (one auction
 * can span several sites). The auction's street line and missing parts are
 * used only when the auction's place agrees with the lot's (the same ZIP, or
 * the same city in the same state), so a street is never paired with another
 * site's town. A state alone is not a place to drive to: without a city or a
 * ZIP the lot has no pickup location, and the result is null.
 */
export function pickupPlaceOf(lot: PickupSource): PickupPlace | null {
  const own = { city: clean(lot.city), state: clean(lot.state)?.toUpperCase() ?? null, postalCode: zip5(lot.ownPostalCode) };
  const a = lot.auctionPickup ?? null;
  const auction: PickupPlace | null = a
    ? { line1: clean(a.line1), city: clean(a.city), state: clean(a.state)?.toUpperCase() ?? null, postalCode: zip5(a.postalCode) }
    : null;
  const placeable = (p: { city: string | null; postalCode: string | null }): boolean => p.city !== null || p.postalCode !== null;

  if (!placeable(own)) return auction && placeable(auction) ? auction : null;
  const agrees =
    auction !== null &&
    (own.postalCode !== null && auction.postalCode !== null
      ? own.postalCode === auction.postalCode
      : same(own.city, auction.city) && (own.state === null || auction.state === null || own.state === auction.state));
  if (!agrees || auction === null) return { line1: null, ...own };
  return {
    line1: auction.line1,
    city: own.city ?? auction.city,
    state: own.state ?? auction.state,
    postalCode: own.postalCode ?? auction.postalCode,
  };
}

/** "310 W. Wisconsin Ave, Milwaukee, WI 53203": also what Maps is given for the stop. */
export function placeLabel(place: PickupPlace): string {
  const region = [place.state, place.postalCode].filter(Boolean).join(' ');
  return [place.line1, place.city, region].filter((part) => part !== null && part !== '').join(', ');
}

export interface PickupStop<L> {
  readonly key: string;
  readonly place: PickupPlace;
  readonly lots: readonly L[];
}

/** Lots collected at the same place share a stop, in the order they first appear. */
export function groupStops<L>(lots: readonly L[], placeOf: (lot: L) => PickupPlace | null): { stops: PickupStop<L>[]; unlocated: L[] } {
  const stops: { key: string; place: PickupPlace; lots: L[] }[] = [];
  const unlocated: L[] = [];
  for (const lot of lots) {
    const place = placeOf(lot);
    if (!place) {
      unlocated.push(lot);
      continue;
    }
    const key = [place.line1, place.city, place.state, place.postalCode].map((v) => (v ?? '').toLowerCase().replace(/\s+/g, ' ')).join('|');
    const found = stops.find((s) => s.key === key);
    if (found) found.lots.push(lot);
    else stops.push({ key, place, lots: [lot] });
  }
  return { stops, unlocated };
}

/** A stop's point, and whether it is only approximate (a city's centroid). */
export interface Located {
  readonly point: LatLon;
  readonly approximate: boolean;
}

export interface RouteLeg<S> {
  readonly stop: S;
  /** Miles from the previous point (home, for the first stop), straight-line. */
  readonly miles: number;
  readonly approximate: boolean;
}

export interface OrderedRun<S> {
  /** The stops in driving order. */
  readonly legs: readonly RouteLeg<S>[];
  /** Stops with an address but no point on the map: they go last, in their listed order. */
  readonly unordered: readonly S[];
  /** From the last placed stop back home; null when no stop is placed. */
  readonly homeMiles: number | null;
  /** Every leg plus the way home, straight-line; null when no stop is placed. */
  readonly totalMiles: number | null;
  /** True when any placed stop is only approximately located. */
  readonly approximate: boolean;
}

/**
 * Nearest neighbour from home: go to the closest unvisited stop, then the
 * closest to that, and so on. Ties go to the stop listed first, so the order
 * is stable. It is not the shortest possible route, only a sensible one.
 */
export function orderStops<S>(home: LatLon, stops: readonly S[], locate: (stop: S) => Located | null): OrderedRun<S> {
  const pool = stops.map((stop, index) => ({ stop, index, at: locate(stop) })).filter((s) => s.at !== null) as {
    stop: S;
    index: number;
    at: Located;
  }[];
  const unordered = stops.filter((s) => locate(s) === null);
  const legs: RouteLeg<S>[] = [];
  let here: Located = { point: home, approximate: false };
  while (pool.length > 0) {
    let best = 0;
    let bestMiles = Infinity;
    pool.forEach((candidate, i) => {
      const miles = haversineMiles(here.point, candidate.at.point);
      const bestIndex = (pool[best] as (typeof pool)[number]).index;
      if (miles < bestMiles || (miles === bestMiles && candidate.index < bestIndex)) {
        best = i;
        bestMiles = miles;
      }
    });
    const [next] = pool.splice(best, 1) as [(typeof pool)[number]];
    legs.push({ stop: next.stop, miles: bestMiles, approximate: here.approximate || next.at.approximate });
    here = next.at;
  }
  if (legs.length === 0) return { legs, unordered, homeMiles: null, totalMiles: null, approximate: false };
  const homeMiles = haversineMiles(here.point, home);
  const total = legs.reduce((sum, leg) => sum + leg.miles, homeMiles);
  return {
    legs,
    unordered,
    homeMiles,
    totalMiles: Math.round(total * 10) / 10,
    approximate: legs.some((leg) => leg.approximate),
  };
}

/**
 * A Google Maps directions link (the Maps URLs API): from the home ZIP, through
 * each stop in order, back to the home ZIP. Maps opens it in the app on a phone.
 */
export function mapsDirectionsUrl(homeZip: string, stops: readonly string[]): string {
  const params = new URLSearchParams({ api: '1', origin: homeZip, destination: homeZip, travelmode: 'driving' });
  if (stops.length > 0) params.set('waypoints', stops.join('|'));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Maps' documented waypoint limits: three in a mobile browser, nine elsewhere. */
export const MAPS_MOBILE_WAYPOINTS = 3;
export const MAPS_WAYPOINTS = 9;

export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
}

/** "What to bring": general to any pickup, with nothing claimed about the lots themselves. */
export function checklistItems(lotCount: number): ChecklistItem[] {
  const invoices = lotCount <= 1 ? 'The paid invoice' : lotCount === 2 ? 'Both paid invoices' : `All ${lotCount} paid invoices`;
  return [
    { id: 'invoices', label: invoices },
    { id: 'id', label: 'Photo ID' },
    { id: 'straps', label: 'Ratchet straps, blankets and a tarp' },
    { id: 'help', label: 'A hand truck, or a second person to help load' },
  ];
}

/**
 * The localStorage key for one run's checklist: the set of lots, so the same
 * lots always find their ticks again and a different set starts clean.
 */
export function checklistKey(lotIds: readonly string[]): string {
  return `pickup-checklist:${[...new Set(lotIds)].sort().join(',')}`;
}
