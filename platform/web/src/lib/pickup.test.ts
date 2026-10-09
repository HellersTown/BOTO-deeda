import { describe, expect, it } from 'vitest';
import { haversineMiles } from './distance';
import {
  checklistItems,
  checklistKey,
  groupStops,
  mapsDirectionsUrl,
  orderStops,
  pickupPlaceOf,
  placeLabel,
  type Located,
} from './pickup';

// ZIP centroids from the gazetteer (postal_codes).
const HOME = { lat: 43.0453, lon: -87.8987 }; // 53202, Milwaukee
const P = {
  milwaukee: { lat: 43.0387, lon: -87.9165 }, // 53203
  waukesha: { lat: 43.0022, lon: -88.2179 }, // 53186
  racine: { lat: 42.7261, lon: -87.7829 }, // 53403
  madison: { lat: 43.0747, lon: -89.3843 }, // 53703
};

const at = (point: { lat: number; lon: number }, approximate = false): Located => ({ point, approximate });

describe('ordering the stops nearest-neighbour from the home ZIP', () => {
  it('goes to the closest stop first, then the closest to that', () => {
    const stops = ['madison', 'racine', 'waukesha', 'milwaukee'] as const;
    const run = orderStops(HOME, stops, (s) => at(P[s]));
    // 1 mi to Milwaukee, then Waukesha (15.4), then Racine (29.1 from Waukesha, nearer than Madison's 59.1).
    expect(run.legs.map((l) => l.stop)).toEqual(['milwaukee', 'waukesha', 'racine', 'madison']);
    expect(run.legs[0]?.miles).toBe(haversineMiles(HOME, P.milwaukee));
    expect(run.legs[1]?.miles).toBe(haversineMiles(P.milwaukee, P.waukesha));
    expect(run.legs[2]?.miles).toBe(haversineMiles(P.waukesha, P.racine));
    expect(run.homeMiles).toBe(haversineMiles(P.madison, HOME));
    const sum = run.legs.reduce((t, l) => t + l.miles, run.homeMiles ?? 0);
    expect(run.totalMiles).toBe(Math.round(sum * 10) / 10);
    expect(run.approximate).toBe(false);
  });

  it('breaks ties by the order the stops were listed, so the route is stable', () => {
    const same = { lat: 43.1, lon: -87.9 };
    const run = orderStops(HOME, ['b', 'a', 'c'], () => at(same));
    expect(run.legs.map((l) => l.stop)).toEqual(['b', 'a', 'c']);
  });

  it('puts stops it cannot place last, and marks legs to a city centroid approximate', () => {
    const run = orderStops(HOME, ['nowhere', 'waukesha', 'racine'], (s) =>
      s === 'nowhere' ? null : s === 'waukesha' ? at(P.waukesha, true) : at(P.racine),
    );
    expect(run.legs.map((l) => l.stop)).toEqual(['waukesha', 'racine']);
    expect(run.legs.map((l) => l.approximate)).toEqual([true, true]);
    expect(run.unordered).toEqual(['nowhere']);
    expect(run.approximate).toBe(true);
  });

  it('has no miles when nothing can be placed', () => {
    const run = orderStops(HOME, ['x'], () => null);
    expect(run).toEqual({ legs: [], unordered: ['x'], homeMiles: null, totalMiles: null, approximate: false });
  });
});

describe('the "Open the route in Maps" link', () => {
  it('starts and ends at the home ZIP and passes the stops in order as waypoints', () => {
    const url = mapsDirectionsUrl('53202', ['310 W. Wisconsin Ave, Milwaukee, WI 53203', 'Waukesha, WI 53186']);
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://www.google.com/maps/dir/');
    expect(parsed.searchParams.get('api')).toBe('1');
    expect(parsed.searchParams.get('origin')).toBe('53202');
    expect(parsed.searchParams.get('destination')).toBe('53202');
    expect(parsed.searchParams.get('travelmode')).toBe('driving');
    expect(parsed.searchParams.get('waypoints')).toBe('310 W. Wisconsin Ave, Milwaukee, WI 53203|Waukesha, WI 53186');
    // Encoded, so an address with "&" or "#" cannot break the link.
    expect(url).toContain('waypoints=310+W.+Wisconsin+Ave%2C+Milwaukee%2C+WI+53203%7CWaukesha%2C+WI+53186');
  });

  it('leaves waypoints out when there are none', () => {
    expect(new URL(mapsDirectionsUrl('53202', [])).searchParams.has('waypoints')).toBe(false);
  });
});

describe('where a won lot is collected', () => {
  const auction = { line1: '310 W. Wisconsin Ave', city: 'Milwaukee', state: 'WI', postalCode: '53203' };

  it('takes the auction’s street when its place agrees with the lot’s', () => {
    expect(pickupPlaceOf({ city: 'Milwaukee', state: 'WI', ownPostalCode: '53203', auctionPickup: auction })).toEqual(auction);
    expect(pickupPlaceOf({ city: 'milwaukee', state: 'wi', ownPostalCode: null, auctionPickup: auction })).toEqual({
      line1: '310 W. Wisconsin Ave',
      city: 'milwaukee',
      state: 'WI',
      postalCode: '53203',
    });
  });

  it('never pairs a street with another site’s town', () => {
    expect(pickupPlaceOf({ city: 'Waukesha', state: 'WI', ownPostalCode: '53186', auctionPickup: auction })).toEqual({
      line1: null,
      city: 'Waukesha',
      state: 'WI',
      postalCode: '53186',
    });
  });

  it('uses the auction’s place when the lot has none, and has no place without a city or a ZIP', () => {
    expect(pickupPlaceOf({ city: null, state: null, auctionPickup: auction })).toEqual(auction);
    expect(pickupPlaceOf({ city: null, state: 'WI', ownPostalCode: null, auctionPickup: null })).toBeNull();
    expect(pickupPlaceOf({ city: ' ', state: null, auctionPickup: { line1: null, city: null, state: 'WI', postalCode: null } })).toBeNull();
    expect(pickupPlaceOf({ city: null, state: null, ownPostalCode: '53186-1234' })).toEqual({ line1: null, city: null, state: null, postalCode: '53186' });
  });

  it('labels a place the way Maps reads it', () => {
    expect(placeLabel(auction)).toBe('310 W. Wisconsin Ave, Milwaukee, WI 53203');
    expect(placeLabel({ line1: null, city: 'Waukesha', state: 'WI', postalCode: null })).toBe('Waukesha, WI');
    expect(placeLabel({ line1: null, city: null, state: null, postalCode: '53186' })).toBe('53186');
  });

  it('groups lots at the same place into one stop and lists the rest separately', () => {
    const lots = [
      { id: 'a', place: auction },
      { id: 'b', place: null },
      { id: 'c', place: { ...auction, city: 'MILWAUKEE' } },
      { id: 'd', place: { line1: null, city: 'Waukesha', state: 'WI', postalCode: '53186' } },
    ];
    const { stops, unlocated } = groupStops(lots, (l) => l.place);
    expect(stops.map((s) => s.lots.map((l) => l.id))).toEqual([['a', 'c'], ['d']]);
    expect(unlocated.map((l) => l.id)).toEqual(['b']);
  });
});

describe('what to bring', () => {
  it('keys the checklist by the set of lots, whatever their order', () => {
    expect(checklistKey(['b', 'a', 'a'])).toBe('pickup-checklist:a,b');
    expect(checklistKey(['a', 'b'])).toBe(checklistKey(['b', 'a']));
    expect(checklistKey(['a'])).not.toBe(checklistKey(['a', 'c']));
  });

  it('counts the invoices', () => {
    expect(checklistItems(1)[0]?.label).toBe('The paid invoice');
    expect(checklistItems(2)[0]?.label).toBe('Both paid invoices');
    expect(checklistItems(4)[0]?.label).toBe('All 4 paid invoices');
    expect(new Set(checklistItems(3).map((i) => i.id)).size).toBe(4);
  });
});
