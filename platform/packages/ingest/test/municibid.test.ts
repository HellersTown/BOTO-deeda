import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseStatePage,
  parseListingPage,
  parseMapEntries,
  parseLocation,
  parseEtText,
  utcFieldToIso,
  premiumFromTiers,
  decodeNextFlight,
  jsonAfter,
  slugify,
  streetFromPickupDetails,
  normalizeMunicibid,
  createMunicibidAdapter,
  municibidAdapter,
  stateUrl,
  MUNICIBID_ORIGIN,
} from '../src/adapters/municibid.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

// Real captures from 2026-09-30; see the comment at the top of each fixture.
const WI = fx('municibid-state-wi-2026-09-30.html');
const MI = fx('municibid-state-mi-2026-09-30.html');
const LISTING = fx('municibid-listing-85963617-2026-09-30.html');
const LISTING_URL = 'https://municibid.com/listing/85963617/2016-chevrolet-silverado-2500-4wd-wt-dbl-cab';

// -------------------------------------------------------------- state pages

test('state page (WI): 0 live, 13 sold, 16 agencies; sold rows in cents', () => {
  const p = parseStatePage(WI);
  assert.deepEqual(p.warnings, []);
  assert.equal(p.liveCount, 0);
  assert.equal(p.soldCount, 13);
  assert.equal(p.agencyCount, 16);
  assert.deepEqual(p.live, []);
  assert.equal(p.sold.length, 12); // the table shows the 12 most recent
  assert.deepEqual(p.sold[1], {
    id: '68149383',
    url: 'https://municibid.com/listing/68149383/1967-kaiser-army-6-x-6-truck',
    title: '1967 Kaiser Army 6 x 6 Truck',
    sellerUserName: 'townofhull',
    agencyName: 'Town of Hull',
    bidCount: 31,
    soldPriceCents: 620000,
  });
  assert.equal(p.agencies.length, 16);
  assert.deepEqual(p.agencies[0], { userName: 'villageofhobart', name: 'Village of Hobart', city: 'Hobart', live: 0, sold: 4 });
  const alden = p.agencies.find((a) => a.userName === 'townofalden')!;
  assert.equal(alden.city, 'Star Prarie'); // sic, as the source spells it
  assert.equal(alden.sold, 0);
});

test('state page (MI): the "Live now" list gives titles, links, prices, bids, agency, city', () => {
  const p = parseStatePage(MI);
  assert.equal(p.liveCount, 3);
  assert.equal(p.live.length, 3);
  assert.deepEqual(p.live[1], {
    id: '85963617',
    url: LISTING_URL,
    title: '2016 Chevrolet Silverado 2500 4WD WT DBL CAB',
    priceCents: 810000,
    bidCount: 3,
    agencyName: 'City of Fenton',
    city: 'Fenton',
  });
  assert.equal(p.live[0].bidCount, 0);
  assert.equal(p.live[0].priceCents, 695000);
  // The agency list is capped at 24 of the 81 the stats report.
  assert.equal(p.agencies.length, 24);
  assert.equal(p.agencyCount, 81);
  assert.equal(p.agencies.find((a) => a.userName === 'sball@bridgman.org')!.name, 'City of Bridgman');
});

test('state page: garbage yields a warning, not a throw', () => {
  const p = parseStatePage('<html><body>Service Unavailable</body></html>');
  assert.equal(p.liveCount, null);
  assert.match(p.warnings.join('\n'), /no "live now" count/);
  assert.doesNotThrow(() => parseStatePage(''));
});

// ------------------------------------------------------------ listing page

test('listing page: RSC payload yields exact close, price, bids, reserve and fee tiers', () => {
  const { listing, warnings } = parseListingPage(LISTING, MUNICIBID_ORIGIN, '85963617');
  assert.deepEqual(warnings, []);
  const l = listing!;
  assert.equal(l.title, '2016 Chevrolet Silverado 2500 4WD WT DBL CAB');
  assert.equal(l.url, LISTING_URL);
  // endsAtUtc "2026-10-06T19:00:00" is UTC; the page states "3:00 PM ET".
  assert.equal(l.endsAt, '2026-10-06T19:00:00.000Z');
  assert.equal(l.endsText, 'Tuesday, October 6, 2026 3:00 PM ET');
  assert.equal(parseEtText(l.endsText), l.endsAt);
  assert.equal(l.startsAt, '2026-09-23T18:00:00.000Z');
  assert.equal(l.currentPriceCents, 810000);
  assert.equal(l.startingBidCents, 750000); // RSC "$$7,500.00"
  assert.equal(l.incrementCents, 10000);
  assert.equal(l.bidCount, 3);
  assert.equal(l.reserveMet, false);
  assert.equal(l.status, 'Active');
  assert.deepEqual(l.buyerFeeTiers, [{ from: 0, percent: 9 }, { from: 100000, percent: 6 }]);
  assert.equal(l.buyerFeeText, '9%');
});

test('listing page: seller, declared state, address, images, description, specs', () => {
  const l = parseListingPage(LISTING, MUNICIBID_ORIGIN, '85963617').listing!;
  assert.equal(l.agencyName, 'City of Fenton');
  assert.equal(l.sellerUserName, 'dbrisson');
  assert.equal(l.state, 'MI');
  assert.equal(l.city, 'Fenton');
  assert.equal(l.postalCode, '48430');
  assert.equal(l.pickupLine1, '200 N. Alloy Drive');
  assert.equal(l.images.length, 8);
  assert.match(l.images[7], /64c06754-e26b-ab88-c0a7-52bac0e6c6ca_largesize\.jpg$/);
  assert.match(l.description!, /^2016 Chevrolet 2500 4WD WT DBL CAB, 6\.0liter gas engine/);
  assert.ok(!l.description!.includes('&nbsp;'));
  assert.equal(l.specs['Make'], 'Chevrolet');
  assert.equal(l.specs['VIN'], '1GC2KUEG0GZ208501');
  assert.equal(l.ships, false); // "No. Pickup only."
});

test('listing page: the site-wide map payload is parsed with escapes intact', () => {
  const { others } = parseListingPage(LISTING, MUNICIBID_ORIGIN, '85963617');
  assert.equal(others.length, 17);
  const byId = new Map(others.map((o) => [o.id, o]));
  assert.equal(byId.get('85811628')!.title, 'AT&T Air Card'); // & in the page
  assert.equal(byId.get('85937811')!.title, 'Ariens 36" Walk-Behind Power Broom'); // escaped quote
  assert.equal(byId.get('85555326')!.state, 'CT'); // "Clinton, Connecticut"
  assert.equal(byId.get('78921657')!.endsAt, '2026-10-06T13:23:11.627Z');
  assert.equal(byId.get('85881573')!.currentPriceCents, 5000);
  assert.equal(byId.get('85963617')!.state, 'MI');
});

test('listing page: wrong listing or no listing is refused with a warning', () => {
  const wrong = parseListingPage(LISTING, MUNICIBID_ORIGIN, '85891170');
  assert.equal(wrong.listing, null);
  assert.match(wrong.warnings.join('\n'), /asked for listing 85891170, page is listing 85963617/);
  const none = parseListingPage('<html><body>Maintenance</body></html>');
  assert.equal(none.listing, null);
  assert.match(none.warnings.join('\n'), /not a listing page/);
  // A torn payload (truncated mid-script) must not throw.
  assert.doesNotThrow(() => parseListingPage(LISTING.slice(0, 5000), MUNICIBID_ORIGIN, '85963617'));
});

// ------------------------------------------------------------- small parsers

test('RSC decoding and balanced JSON slicing respect strings', () => {
  const flight = decodeNextFlight(LISTING);
  assert.ok(flight.includes('"buyerFeeTiers":[{"from":0,"percent":9}'));
  assert.deepEqual(jsonAfter(flight, '"buyerFeeTiers":'), [{ from: 0, percent: 9 }, { from: 100000, percent: 6 }]);
  assert.deepEqual(jsonAfter('{"a":"x]}","b":[1,"]",2]}', '"b":'), [1, ']', 2]);
  assert.equal(jsonAfter('{"a":1}', '"missing":'), undefined);
});

test('locations: the state must be written by the source', () => {
  assert.deepEqual(parseLocation('Fenton, MI'), { city: 'Fenton', state: 'MI' });
  assert.deepEqual(parseLocation('CATASAUQUA, PA'), { city: 'CATASAUQUA', state: 'PA' });
  assert.deepEqual(parseLocation('Clinton, Connecticut'), { city: 'Clinton', state: 'CT' });
  assert.deepEqual(parseLocation('Fenton, MI 48430'), { city: 'Fenton', state: 'MI' });
  assert.deepEqual(parseLocation('Fenton, MI US'), { city: 'Fenton', state: 'MI' });
  assert.deepEqual(parseLocation('Beloit'), { city: 'Beloit', state: null });
  assert.deepEqual(parseLocation('Springfield, ZZ'), { city: 'Springfield', state: null });
});

test('times: UTC fields get a Z; "ET" text resolves EDT vs EST by date', () => {
  assert.equal(utcFieldToIso('2026-10-06T19:00:00'), '2026-10-06T19:00:00.000Z');
  assert.equal(utcFieldToIso('2026-09-30T16:20:08.6622649Z'), '2026-09-30T16:20:08.662Z');
  assert.equal(utcFieldToIso('soon'), null);
  assert.equal(parseEtText('Wednesday, September 23, 2026 2:00 PM ET'), '2026-09-23T18:00:00.000Z');
  assert.equal(parseEtText('Tuesday, December 1, 2026 3:00 PM ET'), '2026-12-01T20:00:00.000Z'); // EST
  assert.equal(parseEtText('Tuesday, October 6, 2026 3:00 PM'), null); // no zone
});

test('buyer premium: the tier covering the current price, all tiers in the note', () => {
  const tiers = [{ from: 0, percent: 9 }, { from: 100000, percent: 6 }];
  assert.equal(premiumFromTiers(tiers, 810000)!.pct, 9);
  assert.equal(premiumFromTiers(tiers, 15000000)!.pct, 6);
  assert.equal(premiumFromTiers(tiers, 810000)!.note, "Municibid buyer's fee, as published on the listing: 9% from $0; 6% from $100,000.");
  assert.equal(premiumFromTiers([], 100), null);
});

test('slugs match every real listing link seen', () => {
  assert.equal(slugify('2016 Chevrolet Silverado 2500 4WD WT DBL CAB'), '2016-chevrolet-silverado-2500-4wd-wt-dbl-cab');
  assert.equal(slugify('2019 Rhino TS12 Brush Hog. Model #TS12-3'), '2019-rhino-ts12-brush-hog-model-ts12-3');
  assert.equal(slugify('John Deere Zero- Turn Mower Z830A'), 'john-deere-zero-turn-mower-z830a');
  assert.equal(slugify('2003 LB 75.B New Holland Backhoe'), '2003-lb-75-b-new-holland-backhoe');
  assert.equal(slugify('Frontier Flex Wing Grooming Mower.'), 'frontier-flex-wing-grooming-mower');
  assert.equal(slugify('2001 Volvo / Leach 25 Yard Rear Load Garbage Truck'), '2001-volvo-leach-25-yard-rear-load-garbage-truck');
});

test('pickup street is taken only when the text ends in the listing\'s city and state', () => {
  assert.equal(streetFromPickupDetails('City of Fenton DPW, 200 N. Alloy Drive, Fenton, MI 48430', 'Fenton', 'MI'), '200 N. Alloy Drive');
  assert.equal(streetFromPickupDetails('City of Fenton DPW, 200 N. Alloy Drive, Fenton, MI 48430', 'Holly', 'MI'), null);
  assert.equal(streetFromPickupDetails('Call the DPW to arrange pickup', 'Fenton', 'MI'), null);
});

// ------------------------------------------------------------------ normalize

test('normalize: an enriched listing becomes one auction and one lot', () => {
  const { listing, others } = parseListingPage(LISTING, MUNICIBID_ORIGIN, '85963617');
  const { auction, lot } = normalizeMunicibid('85963617', {
    detail: listing,
    map: others.find((o) => o.id === '85963617'),
    pageState: 'MI',
  })!;
  assert.equal(auction.sellerName, 'City of Fenton');
  assert.equal(auction.sellerState, 'MI');
  assert.equal(auction.buyerPremiumPct, 9);
  assert.match(auction.buyerPremiumNote!, /6% from \$100,000/);
  assert.equal(auction.endsAt, '2026-10-06T19:00:00.000Z');
  // MI spans two zones (four UP counties are Central), so the site's ET is used.
  assert.equal(auction.timezone, 'America/New_York');
  assert.equal(lot.url, LISTING_URL);
  assert.equal(lot.currentBidCents, 810000);
  assert.equal(lot.nextBidCents, 820000);
  assert.equal(lot.startingBidCents, 750000);
  assert.equal(lot.bidCount, 3);
  assert.equal(lot.reserveMet, false);
  assert.equal(lot.closed, false);
  assert.equal(lot.brand, 'Chevrolet');
  assert.equal(lot.model, '2016 Silverado 2500HD');
  assert.deepEqual(lot.pickup, {
    line1: '200 N. Alloy Drive', city: 'Fenton', state: 'MI', postalCode: '48430',
    lat: 42.78459, lon: -83.74074, ambiguous: false,
  });
  assert.equal(lot.images.length, 8);
});

test('normalize: a map-only entry with no bids carries an opening price, not a bid', () => {
  const { entries } = parseMapEntries(jsonAfter(decodeNextFlight(LISTING), '"others":'));
  const table = entries.find((e) => e.id === '85881573')!; // Mayline Drafting Table, 0 bids
  const { auction, lot } = normalizeMunicibid('85881573', { map: table, pageState: 'WA' })!;
  assert.equal(lot.currentBidCents, null);
  assert.equal(lot.startingBidCents, 5000);
  assert.equal(lot.bidCount, 0);
  assert.equal(lot.closesAt, '2026-09-30T17:00:00.000Z');
  assert.equal(lot.url, 'https://municibid.com/listing/85881573/mayline-drafting-table');
  assert.equal((lot.raw as any)._meta.urlSource, 'derived-slug');
  assert.equal(auction.buyerPremiumPct, null); // only listing pages publish the fee
  assert.equal(auction.timezone, 'America/Los_Angeles');
});

// ----------------------------------------------------------------------- run()

function ctxWith(fetch: Fetcher, overrides: Partial<SourceConfig> = {}): AdapterContext {
  const source: SourceConfig = {
    id: 'src-mb',
    slug: 'municibid',
    name: 'Municibid',
    url: 'https://municibid.com',
    tier: 'municipal',
    ingest: 'internal_json',
    platform: 'municibid',
    states: null,
    rateLimitRpm: 20,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 60,
    consecutiveFailures: 0,
    ...overrides,
  };
  return { source, fetch, now: () => new Date('2026-09-30T16:30:00Z'), log: () => {}, secrets: {} };
}

function serve(pages: Record<string, string>, seen: string[]): Fetcher {
  return async (url) => {
    seen.push(url);
    const text = pages[url];
    return text ? { status: 200, headers: {}, text } : { status: 404, headers: {}, text: 'Not found' };
  };
}

test('run (Wisconsin, default scope): one request, zero live, a complete snapshot', async () => {
  const seen: string[] = [];
  const result = await createMunicibidAdapter({ sleep: async () => {} })
    .run(ctxWith(serve({ [stateUrl(MUNICIBID_ORIGIN, 'WI')]: WI }, seen)));
  assert.deepEqual(seen, ['https://municibid.com/auctions/wi']);
  assert.equal(result.lots.length, 0);
  assert.equal(result.completeSnapshot, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.httpRequests, 1);
});

test('run (Michigan): enriches live listings lowest id first; a failed page is withheld', async () => {
  const seen: string[] = [];
  const result = await createMunicibidAdapter({ sleep: async () => {} }).run(ctxWith(serve({
    [stateUrl(MUNICIBID_ORIGIN, 'MI')]: MI,
    [LISTING_URL]: LISTING,
  }, seen), { states: ['MI'] }));
  assert.deepEqual(seen, [
    'https://municibid.com/auctions/mi',
    'https://municibid.com/listing/85891170/frontier-flex-wing-grooming-mower',
    'https://municibid.com/listing/85960997/2015-chevrolet-silverado-2500-4wd-dbl-cab',
    LISTING_URL,
  ]);
  assert.deepEqual(result.lots.map((l) => l.externalId), ['85963617']);
  assert.equal(result.auctions[0].sellerName, 'City of Fenton');
  assert.equal(result.completeSnapshot, false);
  assert.match(result.warnings.join('\n'), /listing 85891170 returned HTTP 404/);
});

test('run: a capped "Live now" list is checked against the map payload', async () => {
  // Branch test: the real MI page with two of its three live items cut out, so
  // it counts 3 live but lists 1. The map payload in the fixture knows no other
  // MI listing, so the run must say it is incomplete rather than claim 1 of 3.
  const capped = MI.replace(/<li><a href="\/listing\/85891170[\s\S]*?<\/li>/, '')
    .replace(/<li><a href="\/listing\/85960997[\s\S]*?<\/li>/, '');
  const seen: string[] = [];
  const result = await createMunicibidAdapter({ sleep: async () => {} }).run(ctxWith(serve({
    [stateUrl(MUNICIBID_ORIGIN, 'MI')]: capped,
    [LISTING_URL]: LISTING,
  }, seen), { states: ['MI'] }));
  assert.equal(seen.length, 2);
  assert.deepEqual(result.lots.map((l) => l.externalId), ['85963617']);
  assert.equal(result.completeSnapshot, false);
  assert.match(result.warnings.join('\n'), /MI: 3 live, found 1 after consulting the map payload/);
});

test('run: paces requests to the source rate limit, and 429 fails loudly', async () => {
  const sleeps: number[] = [];
  let clock = Date.parse('2026-09-30T16:30:00Z');
  const ctx = ctxWith(serve({ [stateUrl(MUNICIBID_ORIGIN, 'MI')]: MI, [LISTING_URL]: LISTING }, []), { states: ['MI'] });
  ctx.now = () => new Date(clock);
  await createMunicibidAdapter({ sleep: async (ms) => { sleeps.push(ms); clock += ms; } }).run(ctx);
  assert.deepEqual(sleeps, [3000, 3000, 3000]);

  const limited: Fetcher = async () => ({ status: 429, headers: {}, text: '' });
  await assert.rejects(() => createMunicibidAdapter({ sleep: async () => {} }).run(ctxWith(limited)), /rate limit/i);
});

test('run: a garbage state page is a warning and not a complete snapshot', async () => {
  const fetch: Fetcher = async () => ({ status: 200, headers: {}, text: '<html>oops</html>' });
  const result = await createMunicibidAdapter({ sleep: async () => {} }).run(ctxWith(fetch));
  assert.equal(result.lots.length, 0);
  assert.equal(result.completeSnapshot, false);
  assert.match(result.warnings.join('\n'), /no "live now" count/);
});

test('the exported adapter is keyed by sources.platform', () => {
  assert.equal(municibidAdapter.key, 'municibid');
  assert.equal(municibidAdapter.method, 'internal_json');
});
