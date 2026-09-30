/**
 * AuctionGuide adapter tests.
 *
 * Every fixture is a byte-exact excerpt of a live page captured on 2026-09-30
 * through public.inspect_url (our crawler, Supabase egress). Each raw slice was
 * checked by MD5 against the stored response, and slices were joined only where
 * their overlapping bytes matched. Each file's header comment gives its source
 * and byte range.
 *
 *   auctionguide-wi-2026-09-30.html
 *     GET https://www.auctionguide.com/dir/Locations/USA/Wisconsin/ (151,421
 *     bytes). Page bytes 30,510-131,006, unchanged: the map script (31 points),
 *     the "(31)" heading, all 31 sale cards with two ad slots among them, and the
 *     "Wisconsin Auctioneers" heading that follows the list.
 *   auctionguide-wi-trimmed-2026-09-30.html
 *     The same capture from the "(31)" heading on, with cards 3-6 and 8-30
 *     removed: four whole cards under a heading that still says 31. No map.
 *   auctionguide-mn-2026-09-30.html
 *     GET .../dir/Locations/USA/Minnesota/ (87,889 bytes). Page bytes
 *     40,632-74,903, unchanged: the "(13)" heading, all 13 cards and the list's
 *     end. No map, so no ZIPs; its last card is dated "24th Feb".
 *
 * AG_ROBOTS is www.auctionguide.com/robots.txt exactly as the 2026-09-30 probe
 * stored it (1,921 bytes, MD5 a603b6462f12c387e05398d9adade544).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AG_BASE,
  agStateUrl,
  auctionguideAdapter,
  normalizeAgCard,
  parseAgStatePage,
  parseAt,
  parseDateRange,
  parseDayMonth,
  parseMapPoints,
  parseRelative,
  resolveOnOrBefore,
  resolveYear,
  runAuctionGuide,
  scopeStates,
  shortExcerpt,
  spacingMs,
  zonedIso,
} from '../src/adapters/auctionguide.ts';
import type { AgCard } from '../src/adapters/auctionguide.ts';
import { gateFetcher } from '../src/gate.ts';
import type { AdapterContext, Fetcher, NormalizedLot, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const WI = fixture('auctionguide-wi-2026-09-30.html');
const WI_TRIMMED = fixture('auctionguide-wi-trimmed-2026-09-30.html');
const MN = fixture('auctionguide-mn-2026-09-30.html');

/** Between the captures: 19:40 UTC is 14:40 CDT on Wednesday 30 September 2026. */
const NOW = new Date('2026-09-30T19:40:00Z');
const WI_URL = 'https://www.auctionguide.com/dir/Locations/USA/Wisconsin/';
const MN_URL = 'https://www.auctionguide.com/dir/Locations/USA/Minnesota/';

const card = (html: string, id: string): AgCard => {
  const c = parseAgStatePage(html).cards.find((x) => x.id === id);
  assert.ok(c, `card ${id} is on the page`);
  return c;
};
const sale = (html: string, id: string, state = 'WI', now = NOW) => {
  const page = parseAgStatePage(html);
  return normalizeAgCard(card(html, id), { directoryState: state, now, point: page.mapPoints.get(id) ?? null });
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const meta = (lot: NormalizedLot): any => (lot.raw as { _meta: unknown })._meta;

// ------------------------------------------------------------------ the page

test('state page: the "(31)" heading, 31 sale cards, 31 map points, and the end of the list', () => {
  const page = parseAgStatePage(WI);
  assert.deepEqual(page.heading, { count: 31, stateName: 'Wisconsin', stateCode: 'WI' });
  assert.equal(page.found, 31);
  assert.equal(page.cards.length, 31);
  assert.equal(new Set(page.cards.map((c) => c.id)).size, 31);
  assert.equal(page.mapPoints.size, 31);
  assert.ok(page.cards.every((c) => page.mapPoints.has(c.id!)), 'every card has its map point');
  assert.equal(page.listEnded, true);
  assert.equal(page.hasNextPage, false);
  assert.deepEqual(page.warnings, []);
  // Two ad slots sit among the cards; they are list items, not sales.
  assert.equal((WI.match(/responsive_auction_list_gad_ctr"/g) ?? []).length, 2);
  // The list is in close-date order, soonest first.
  assert.deepEqual(page.cards.slice(0, 3).map((c) => c.id), ['221137', '221030', '220976']);
});

test('a card: title, link, id, summary, auctioneer, place, lot count, type and one thumbnail', () => {
  const c = card(WI, '221137');
  assert.equal(c.title, 'Antiques, Books, Jewelry, Holiday & Home Decor, Tools', 'double spaces collapsed');
  assert.equal(c.url, 'https://www.auctionguide.com/auction/antiques-books-jewelry-holiday-home-decor-2026-9-30-221137/');
  assert.equal(c.slug, 'antiques-books-jewelry-holiday-home-decor-2026-9-30-221137');
  assert.equal(
    c.summary,
    'Items Include The Following: Antiques, Wooden Wringer, Brass Fire Extinguisher, Wonder Rocking/Bouncing Horse, Jewelry,...',
  );
  assert.equal(c.auctioneer, 'Mathies Auction Services');
  assert.equal(c.auctioneerUrl, 'https://www.auctionguide.com/auctioneer/mathies-auction-services-1450/');
  assert.equal(c.atText, 'Greenleaf, WI, USA.');
  assert.deepEqual([c.city, c.state, c.postalCode, c.country], ['Greenleaf', 'WI', null, 'USA']);
  assert.equal(c.lotCount, 421);
  assert.equal(c.dateText, '30th Sep');
  assert.equal(c.dateIsEnd, false);
  assert.deepEqual(c.typeIcons, ['Live auction']);
  assert.deepEqual([c.statusLabel, c.statusNote], ['Live auction', 'today']);
  assert.equal(c.category, 'Tools and Plant');
  assert.equal(c.imageUrl, 'https://www.auctionguide.com/imagelots/prime/t221137.jpg');

  const online = card(WI, '221030');
  assert.equal(online.dateText, 'Ends 30th Sep');
  assert.equal(online.dateIsEnd, true);
  assert.deepEqual(online.typeIcons, ['Internet-only (timed) auction', 'Internet bidding']);
  assert.deepEqual([online.statusLabel, online.statusNote], ['Bidding online now', 'ends today']);
  assert.equal(card(WI, '219550').lotCount, 1, '"1 lot", singular');
  assert.equal(card(MN, '220466').city, 'North St. Paul', 'a period inside a city name is kept');
});

test('thumbnails: a protocol-relative CDN link becomes https; the no-image placeholder is no image', () => {
  assert.equal(
    card(WI, '221030').imageUrl,
    'https://cdn.hibid.com/img.axd?id=8432434242&wid=&rwl=false&p=&ext=&w=200&h=200&t=&lp=&c=true&wt=false&sz=MAX&checksum=3SdToxVzvuxUk6x3wLzxYjTekbEsdzs9',
  );
  assert.equal(card(WI, '216165').imageUrl, null);
  assert.deepEqual(sale(WI, '216165').lot.images, []);
  // Parsed for provenance, never emitted: most thumbnails are HiBid's.
  assert.deepEqual(sale(WI, '221137').lot.images, []);
  assert.deepEqual(sale(WI, '221030').lot.images, []);
  const all = parseAgStatePage(WI).cards;
  assert.equal(all.filter((c) => c.imageUrl === null).length, 4, 'four cards show the placeholder');
});

test('map points: city, declared state, ZIP, date range, lots and type; no street is kept', () => {
  const pts = parseAgStatePage(WI).mapPoints;
  assert.deepEqual(pts.get('221030'), {
    id: '221030',
    city: 'Hillsboro',
    state: 'WI',
    postalCode: '54634',
    dateText: '3rd Sep - 30th Sep',
    lotCount: 533,
    typeText: 'Internet-only (timed) auction',
    statusText: 'Online bidding now',
  });
  // A sale not yet live: no "Lots:" line and no status line.
  assert.deepEqual(pts.get('216165'), {
    id: '216165',
    city: 'walworth',
    state: 'WI',
    postalCode: '53184',
    dateText: '3rd Oct',
    lotCount: null,
    typeText: 'Live auction with webcast bidding',
    statusText: null,
  });
  assert.equal(pts.get('220239')!.city, 'Coleman', 'the popup line ", Coleman" has no street');
  assert.equal(pts.get('219550')!.city, 'Hillpoint', 'a street with its own comma and ellipsis');
  assert.ok(!JSON.stringify([...pts.values()]).includes('County Road'), 'street addresses are not kept');
  assert.equal(parseMapPoints('var addressPoints = [];').size, 0);
  assert.equal(parseMapPoints('<p>no map</p>').size, 0);
});

// ------------------------------------------------------------------ dates

test('dates: the site writes a day and a month, with an ordinal suffix and no year', () => {
  assert.deepEqual(parseDayMonth('30th Sep'), { day: 30, month: 9, year: null });
  assert.deepEqual(parseDayMonth('1st Oct'), { day: 1, month: 10, year: null });
  assert.deepEqual(parseDayMonth('22nd Oct'), { day: 22, month: 10, year: null });
  assert.deepEqual(parseDayMonth('3rd Sep'), { day: 3, month: 9, year: null });
  assert.deepEqual(parseDayMonth('24th Feb'), { day: 24, month: 2, year: null });
  assert.deepEqual(parseDayMonth('3rd Sep, 2026'), { day: 3, month: 9, year: 2026 }, 'the sale page adds a year');
  assert.equal(parseDayMonth('31st Sep'), null);
  assert.equal(parseDayMonth('29th Feb, 2027'), null);
  assert.equal(parseDayMonth('Ends 30th Sep'), null, 'the caller strips "Ends"');
  assert.equal(parseDayMonth('soon'), null);
  assert.deepEqual(parseDateRange('3rd Sep - 30th Sep'), {
    start: { day: 3, month: 9, year: null },
    end: { day: 30, month: 9, year: null },
  });
  assert.deepEqual(parseDateRange('30th Sep'), { start: { day: 30, month: 9, year: null }, end: null });
  assert.equal(parseDateRange('Date TBD'), null);
});

test('dates: the year is the one that puts the date in [today - 60 days, today + 305 days)', () => {
  const today = { y: 2026, m: 9, d: 30 };
  const dm = (day: number, month: number) => ({ day, month, year: null });
  assert.deepEqual(resolveYear(dm(30, 9), today), { y: 2026, m: 9, d: 30 });
  assert.deepEqual(resolveYear(dm(3, 9), today), { y: 2026, m: 9, d: 3 }, 'a start 27 days ago');
  assert.deepEqual(resolveYear(dm(24, 2), today), { y: 2027, m: 2, d: 24 }, 'next February, not last');
  assert.deepEqual(resolveYear(dm(3, 1), { y: 2026, m: 12, d: 28 }), { y: 2027, m: 1, d: 3 }, 'across New Year');
  assert.deepEqual(resolveYear(dm(30, 12), { y: 2027, m: 1, d: 10 }), { y: 2026, m: 12, d: 30 }, 'a lingering listing stays in the past');
  assert.equal(resolveYear(dm(29, 2), today), null, 'no 29 February within the window');
  assert.deepEqual(resolveYear({ day: 3, month: 9, year: 2025 }, today), { y: 2025, m: 9, d: 3 }, 'a stated year is kept');
  // A start date is the latest one on or before the close.
  assert.deepEqual(resolveOnOrBefore(dm(3, 9), { y: 2026, m: 9, d: 30 }), { y: 2026, m: 9, d: 3 });
  assert.deepEqual(resolveOnOrBefore(dm(20, 12), { y: 2027, m: 1, d: 5 }), { y: 2026, m: 12, d: 20 });
});

test('dates: a date-only close is 23:59:59 in the sale\'s zone, with that day\'s offset', () => {
  const chicago = 'America/Chicago';
  assert.equal(zonedIso({ y: 2026, m: 9, d: 30 }, 23, 59, 59, chicago), '2026-09-30T23:59:59-05:00');
  assert.equal(Date.parse('2026-09-30T23:59:59-05:00'), Date.parse('2026-10-01T04:59:59Z'));
  assert.equal(zonedIso({ y: 2027, m: 2, d: 24 }, 23, 59, 59, chicago), '2027-02-24T23:59:59-06:00');
  // DST ends at 02:00 on 1 November 2026: that day starts in CDT and ends in CST.
  assert.equal(zonedIso({ y: 2026, m: 11, d: 1 }, 0, 0, 0, chicago), '2026-11-01T00:00:00-05:00');
  assert.equal(zonedIso({ y: 2026, m: 11, d: 1 }, 23, 59, 59, chicago), '2026-11-01T23:59:59-06:00');
  // DST starts at 02:00 on 14 March 2027.
  assert.equal(zonedIso({ y: 2027, m: 3, d: 14 }, 0, 0, 0, chicago), '2027-03-14T00:00:00-06:00');
  assert.equal(zonedIso({ y: 2027, m: 3, d: 14 }, 23, 59, 59, chicago), '2027-03-14T23:59:59-05:00');
  assert.equal(zonedIso({ y: 2026, m: 9, d: 30 }, 23, 59, 59, 'America/New_York'), '2026-09-30T23:59:59-04:00');
});

test('sale dates by card type: a live sale day, an online close with the map\'s start, an online sale not yet open', () => {
  const live = sale(WI, '221137'); // "30th Sep", Live auction, (today)
  assert.equal(live.auction.format, 'live');
  assert.equal(live.auction.startsAt, '2026-09-30T00:00:00-05:00');
  assert.equal(live.lot.closesAt, '2026-09-30T23:59:59-05:00');
  assert.equal(live.auction.endsAt, live.lot.closesAt);
  assert.equal(live.auction.timezone, 'America/Chicago');

  const online = sale(WI, '221030'); // "Ends 30th Sep"; map "3rd Sep - 30th Sep"
  assert.equal(online.auction.format, 'online');
  assert.equal(online.auction.startsAt, '2026-09-03T00:00:00-05:00');
  assert.equal(online.lot.closesAt, '2026-09-30T23:59:59-05:00');
  const m = meta(online.lot);
  assert.equal(m.closeTimePrecise, false, 'the contract 0013 and the app read: no countdown');
  assert.equal(m.startTimePrecise, false);
  assert.deepEqual([m.startDate, m.endDate, m.startDateBasis, m.endDateBasis], ['2026-09-03', '2026-09-30', 'map', 'card']);
  assert.equal(m.yearInferred, true, 'the directory never states a year');
  assert.match(m.closeTimeNote, /no time \("Ends 30th Sep"\).*23:59:59 America\/Chicago on 2026-09-30/);

  // Not yet open: the card's day is the START; the close is the map range's end.
  const upcoming = sale(WI, '220897'); // "4th Oct", "(starts in 3 days)"; map "4th Oct - 18th Oct"
  assert.equal(upcoming.auction.format, 'online');
  assert.equal(upcoming.auction.startsAt, '2026-10-04T00:00:00-05:00');
  assert.equal(upcoming.lot.closesAt, '2026-10-18T23:59:59-05:00');
  assert.deepEqual([meta(upcoming.lot).startDateBasis, meta(upcoming.lot).endDateBasis], ['card', 'map']);

  // Live with webcast bidding: hybrid. No lot count is listed, and none is invented.
  const hybrid = sale(WI, '216165'); // "3rd Oct"; icons Live auction + Internet bidding
  assert.equal(hybrid.auction.format, 'hybrid');
  assert.equal(hybrid.auction.lotCount, null);
  assert.equal(hybrid.lot.closesAt, '2026-10-03T23:59:59-05:00');

  // Every Wisconsin sale: a close date, an imprecise close, and no date conflicts.
  const page = parseAgStatePage(WI);
  for (const c of page.cards) {
    const n = normalizeAgCard(c, { directoryState: 'WI', now: NOW, point: page.mapPoints.get(c.id!) ?? null });
    assert.ok(n.lot.closesAt?.endsWith('T23:59:59-05:00'), `${c.id} closes at the end of a CDT day`);
    assert.equal(meta(n.lot).closeTimePrecise, false);
    assert.equal(meta(n.lot).relativeCheck, 'agrees', `${c.id}: the site's own "N days" note agrees`);
    assert.equal(n.lot.closed, false);
    assert.deepEqual(n.flags, { noClose: false, conflict: false, relativeDisagrees: false, formatUnknown: false, zipConflict: false });
  }
  assert.deepEqual(
    page.cards.map((c) => normalizeAgCard(c, { directoryState: 'WI', now: NOW, point: page.mapPoints.get(c.id!) }).auction.format)
      .reduce<Record<string, number>>((acc, f) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {}),
    { live: 1, online: 28, hybrid: 2 },
  );
});

test('an online sale not yet open, without its map point, has a start date and no invented close', () => {
  const { auction, lot, flags } = sale(WI_TRIMMED, '221036'); // "8th Oct", "(starts in 7 days)"
  assert.equal(auction.startsAt, '2026-10-08T00:00:00-05:00');
  assert.equal(lot.closesAt, null);
  assert.equal(auction.endsAt, null);
  assert.equal(meta(lot).endDate, null);
  assert.match(meta(lot).closeTimeNote, /does not list this sale’s close date/);
  assert.equal(flags.noClose, true);
});

test('year rollover: Minnesota\'s "24th Feb" live sale, read on 30 Sep 2026, is 24 Feb 2027 in CST', () => {
  const { auction, lot } = sale(MN, '218367', 'MN'); // "Live auction (146 days to go)"
  assert.equal(auction.format, 'hybrid');
  assert.equal(auction.startsAt, '2027-02-24T00:00:00-06:00');
  assert.equal(lot.closesAt, '2027-02-24T23:59:59-06:00');
  assert.equal(meta(lot).relativeCheck, 'agrees', '146 days to go from 30 September is 24 February');
});

test('the site\'s own "N days" note is read, and a date it contradicts is reported', () => {
  assert.deepEqual(parseRelative('ends today'), { anchor: 'end', days: 0 });
  assert.deepEqual(parseRelative('1 day left'), { anchor: 'end', days: 1 });
  assert.deepEqual(parseRelative('12 days left'), { anchor: 'end', days: 12 });
  assert.deepEqual(parseRelative('today'), { anchor: 'start', days: 0 });
  assert.deepEqual(parseRelative('2 days to go'), { anchor: 'start', days: 2 });
  assert.deepEqual(parseRelative('starts in 28 days'), { anchor: 'start', days: 28 });
  assert.equal(parseRelative('whenever'), null);
  assert.equal(parseRelative(null), null);

  // The page says "(ends today)"; read five days later, the date no longer agrees.
  const late = sale(WI, '221030', 'WI', new Date('2026-10-05T17:00:00Z'));
  assert.equal(meta(late.lot).relativeCheck, 'disagrees');
  assert.equal(late.flags.relativeDisagrees, true);
  assert.equal(late.lot.closed, true, 'and its close date has passed');
});

test('closed follows the injected clock at the end of the close date', () => {
  const c = card(WI, '221137');
  const at = (iso: string) => normalizeAgCard(c, { directoryState: 'WI', now: new Date(iso), point: null }).lot.closed;
  assert.equal(at('2026-10-01T04:59:58Z'), false, '23:59:58 CDT on the sale day');
  assert.equal(at('2026-10-01T04:59:59Z'), true);
});

// ------------------------------------------------------------------ location

test('pickup: city and state as the card declares them, the ZIP from the sale\'s map point', () => {
  const { auction, lot } = sale(WI, '221137');
  assert.deepEqual(lot.pickup, { line1: null, city: 'Greenleaf', state: 'WI', postalCode: '54126', ambiguous: false });
  assert.deepEqual(auction.pickup, lot.pickup);
  assert.equal(meta(lot).postalCodeSource, 'map');
  assert.equal(meta(lot).timezoneBasis, 'state');
  assert.equal(sale(WI, '221411').lot.pickup?.city, 'nekoosa', 'kept as declared, not re-cased');
  assert.equal(sale(WI, '221279').lot.pickup?.postalCode, '54016');
});

test('a card with no ZIP: without a map point the ZIP stays null and nothing is inferred', () => {
  // The same Wisconsin sale, from the excerpt that starts after the map script.
  const t = sale(WI_TRIMMED, '221137');
  assert.deepEqual(t.lot.pickup, { line1: null, city: 'Greenleaf', state: 'WI', postalCode: null, ambiguous: false });
  assert.equal(meta(t.lot).postalCodeSource, null);
  assert.equal(meta(t.lot).mapPoint, false);
  const mn = sale(MN, '220715', 'MN');
  assert.deepEqual(mn.lot.pickup, { line1: null, city: 'Edina', state: 'MN', postalCode: null, ambiguous: false });

  assert.deepEqual(parseAt('Greenleaf, WI, USA.'), { city: 'Greenleaf', state: 'WI', postalCode: null, country: 'USA' });
  assert.deepEqual(parseAt('Greenleaf, WI 54126, USA.'), { city: 'Greenleaf', state: 'WI', postalCode: '54126', country: 'USA' });
  assert.deepEqual(parseAt('Beloit, USA.'), { city: 'Beloit', state: null, postalCode: null, country: 'USA' }, 'no state is guessed');
  assert.deepEqual(parseAt('Toronto, ON, Canada.'), { city: 'Toronto', state: null, postalCode: null, country: 'Canada' });
  assert.deepEqual(parseAt('Online, USA.'), { city: null, state: null, postalCode: null, country: 'USA' });

  // A sale that declares no state keeps a null state and is marked ambiguous.
  const noState = normalizeAgCard(
    { ...card(WI_TRIMMED, '221137'), atText: 'Greenleaf, USA.', state: null },
    { directoryState: 'WI', now: NOW, point: null },
  );
  assert.deepEqual(noState.lot.pickup, { line1: null, city: 'Greenleaf', state: null, postalCode: null, ambiguous: true });
  assert.equal(noState.auction.timezone, 'America/Chicago');
  assert.equal(meta(noState.lot).timezoneBasis, 'directory');
});

// ------------------------------------------------------------------ rows

test('sale-level rows: sale:{id}, the auction\'s id, the sale\'s AuctionGuide link, no prices', () => {
  const { auction, lot } = sale(WI, '221137');
  assert.equal(lot.saleLevel, true);
  assert.equal(lot.externalId, 'sale:221137');
  assert.equal(lot.auctionExternalId, '221137');
  assert.equal(auction.externalId, '221137');
  assert.equal(lot.url, 'https://www.auctionguide.com/auction/antiques-books-jewelry-holiday-home-decor-2026-9-30-221137/');
  assert.equal(auction.url, lot.url);
  assert.equal(lot.title, 'Antiques, Books, Jewelry, Holiday & Home Decor, Tools');
  for (const k of ['startingBidCents', 'currentBidCents', 'nextBidCents', 'estimateLowCents', 'estimateHighCents', 'soldPriceCents', 'bidCount'] as const) {
    assert.equal(lot[k], null, k);
  }
  assert.equal(auction.auctioneer, 'Mathies Auction Services');
  assert.equal(auction.lotCount, 421);
  assert.equal(auction.sellerName, null, 'the auctioneer is not the seller');
  assert.equal(auction.buyerPremiumPct, null);
  assert.match(auction.buyerPremiumNote ?? '', /auctioneer’s own terms/);
  assert.equal(meta(lot).saleLevel, true);
});

test('descriptions are short excerpts of the site\'s summary, never longer than 300 characters', () => {
  assert.equal(
    sale(WI, '221137').lot.description,
    'Items Include The Following: Antiques, Wooden Wringer, Brass Fire Extinguisher, Wonder Rocking/Bouncing Horse, Jewelry,...',
  );
  assert.equal(sale(WI, '221030').lot.description, null, 'a summary that only repeats the title ("Sept 30th") adds nothing');
  const page = parseAgStatePage(WI);
  for (const c of page.cards) {
    const d = normalizeAgCard(c, { directoryState: 'WI', now: NOW }).lot.description;
    assert.ok(d === null || d.length <= 300, `${c.id}`);
  }
  const long = shortExcerpt('Tools and more tools, '.repeat(40));
  assert.ok(long !== null && long.length <= 300 && long.endsWith('…'));
  assert.equal(shortExcerpt('  Short   one  '), 'Short one');
  assert.equal(shortExcerpt(''), null);
});

// ------------------------------------------------------------------ run()

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'src-ag',
    slug: 'auctionguide',
    name: 'AuctionGuide',
    url: 'https://www.auctionguide.com',
    apiBase: null,
    robotsUrl: 'https://www.auctionguide.com/robots.txt',
    tier: 'private',
    ingest: 'html',
    platform: 'auctionguide',
    states: ['WI'],
    rateLimitRpm: 10,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 60,
    consecutiveFailures: 0,
    ...over,
  };
}

function harness(pages: Record<string, { status: number; text: string }>, over: Partial<SourceConfig> = {}, clock?: () => Date) {
  const calls: string[] = [];
  const fetch: Fetcher = async (url) => {
    calls.push(url);
    const r = pages[url];
    return r ? { status: r.status, headers: {}, text: r.text } : { status: 404, headers: {}, text: 'Not Found' };
  };
  const ctx: AdapterContext = { source: source(over), fetch, now: clock ?? (() => NOW), log: () => {}, secrets: {} };
  return { ctx, calls };
}

const ok = (text: string) => ({ status: 200, text });
const noSleep = { sleep: async () => {} };

/** What the crawl gate throws when it will not make a request (gate.ts). */
function refusal(reason: 'robots' | 'blocked' | 'budget'): Error {
  const e = new Error(`gate refused: ${reason}`);
  e.name = 'CrawlRefused';
  (e as Error & { reason: string }).reason = reason;
  return e;
}

test('run(): the Wisconsin page read to its end, with 31 of its (31), is a complete snapshot', async () => {
  const { ctx, calls } = harness({ [WI_URL]: ok(WI) });
  const res = await runAuctionGuide(ctx, noSleep);
  assert.deepEqual(calls, [WI_URL], 'one request: the state page');
  assert.equal(res.completeSnapshot, true);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.lots.length, 31);
  assert.equal(res.auctions.length, 31);
  assert.deepEqual(res.bids, []);
  assert.equal(res.stats.httpRequests, 1);
  assert.ok(res.lots.every((l) => l.saleLevel === true && l.externalId === `sale:${l.auctionExternalId}`));
  assert.ok(res.lots.every((l) => l.pickup?.state === 'WI' && /^\d{5}$/.test(l.pickup.postalCode ?? '')));
});

test('run(): four cards under a "(31)" heading is not a complete snapshot (the count check)', async () => {
  const { ctx } = harness({ [WI_URL]: ok(WI_TRIMMED) });
  const res = await runAuctionGuide(ctx, noSleep);
  assert.equal(res.lots.length, 4);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /says \(31\) and lists 4 sale card/);
  assert.match(res.warnings.join(' '), /1 sale\(s\) list no close date yet/);
});

test('run(): a page cut off before its list ends, one with no count heading, or a card that cannot be read makes no claim', async () => {
  const cut = WI.slice(0, WI.indexOf('<h2>Wisconsin Auctioneers</h2>'));
  const a = await runAuctionGuide(harness({ [WI_URL]: ok(cut) }).ctx, noSleep);
  assert.equal(a.completeSnapshot, false);
  assert.equal(a.lots.length, 31);
  assert.match(a.warnings.join(' '), /ended before its list did/);

  const noHeading = WI.replace('<h2>(31)  Wisconsin WI auctions</h2>', '');
  const b = await runAuctionGuide(harness({ [WI_URL]: ok(noHeading) }).ctx, noSleep);
  assert.equal(b.completeSnapshot, false);
  assert.match(b.warnings.join(' '), /no "\(N\) \.\.\. auctions" heading/);

  // A card whose link is not an AuctionGuide sale page is skipped, and counted.
  const badLink = WI.replace(
    'href="https://www.auctionguide.com/auction/sept-30th-2026-9-30-221030/">Sept 30th</a>',
    'href="https://example.com/elsewhere/">Sept 30th</a>',
  );
  const page = parseAgStatePage(badLink);
  assert.equal(page.found, 31);
  assert.equal(page.cards.length, 30);
  const c = await runAuctionGuide(harness({ [WI_URL]: ok(badLink) }).ctx, noSleep);
  assert.equal(c.completeSnapshot, false);
  assert.match(c.warnings.join(' '), /Skipped 1 of 31 sale cards/);
});

test('run(): an out-of-scope state: sales located elsewhere are left out, and another state\'s page is not taken for Wisconsin\'s', async () => {
  // The Wisconsin URL answering with Minnesota's list (a redirect, a site change).
  const { ctx } = harness({ [WI_URL]: ok(MN) });
  const res = await runAuctionGuide(ctx, noSleep);
  assert.equal(res.lots.length, 0, 'thirteen Minnesota sales are not Wisconsin results');
  assert.equal(res.completeSnapshot, false);
  const text = res.warnings.join(' ');
  assert.match(text, /heading names Minnesota MN, not Wisconsin/);
  assert.match(text, /13 sale\(s\) located outside WI were left out/);
});

test('run(): scope comes from sources.states; every page complete is a complete snapshot', async () => {
  const both = harness({ [WI_URL]: ok(WI), [MN_URL]: ok(MN) }, { states: ['WI', 'MN'] });
  const res = await runAuctionGuide(both.ctx, noSleep);
  assert.deepEqual(both.calls, [WI_URL, MN_URL]);
  assert.equal(res.lots.length, 44);
  assert.equal(res.completeSnapshot, true);
  assert.match(res.warnings.join(' '), /Minnesota: 2 sale\(s\) list no close date yet/);
  assert.equal(res.lots.filter((l) => l.pickup?.state === 'MN').length, 13);

  // A code the site has no page for: nothing requested for it, and no snapshot.
  const pr = harness({ [WI_URL]: ok(WI) }, { states: ['WI', 'PR'] });
  const res2 = await runAuctionGuide(pr.ctx, noSleep);
  assert.deepEqual(pr.calls, [WI_URL]);
  assert.equal(res2.lots.length, 31);
  assert.equal(res2.completeSnapshot, false);
  assert.match(res2.warnings.join(' '), /no state page for "PR"/);
});

test('scope defaults to Wisconsin; state pages use the site\'s underscored names', () => {
  assert.deepEqual(scopeStates({ states: null }), ['WI']);
  assert.deepEqual(scopeStates({ states: [] }), ['WI']);
  assert.deepEqual(scopeStates({ states: ['wi', ' mn ', 'WI', 'Wisconsin'] }), ['WI', 'MN']);
  assert.equal(agStateUrl(AG_BASE, 'WI'), WI_URL);
  assert.equal(agStateUrl(AG_BASE, 'NY'), 'https://www.auctionguide.com/dir/Locations/USA/New_York/');
  assert.equal(agStateUrl(AG_BASE, 'DC'), 'https://www.auctionguide.com/dir/Locations/USA/Washington_DC/');
  assert.equal(agStateUrl(AG_BASE, 'ZZ'), null);
});

test('run(): paces request starts at 60000 / rateLimitRpm', async () => {
  for (const [rpm, gap] of [[10, 6000], [20, 3000]] as const) {
    const sleeps: number[] = [];
    const { ctx } = harness({ [WI_URL]: ok(WI), [MN_URL]: ok(MN) }, { states: ['WI', 'MN'], rateLimitRpm: rpm });
    await runAuctionGuide(ctx, { sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(sleeps, [gap]);
    assert.equal(spacingMs(rpm), gap);
  }
  assert.equal(spacingMs(0), 6000, 'an unset rate falls back to 10 per minute');
});

test('run(): a budget refusal keeps the pages already read and makes no snapshot claim', async () => {
  const { ctx } = harness({ [WI_URL]: ok(WI), [MN_URL]: ok(MN) }, { states: ['WI', 'MN'] });
  const inner = ctx.fetch;
  ctx.fetch = async (url, init) => {
    if (url === MN_URL) throw refusal('budget');
    return inner(url, init);
  };
  const res = await runAuctionGuide(ctx, noSleep);
  assert.equal(res.lots.length, 31);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /budget ran out before the Minnesota page; kept the pages already read/);
});

test('run(): a budget refusal before any page, or a robots or bot-protection refusal, fails the run', async () => {
  for (const reason of ['robots', 'blocked'] as const) {
    const { ctx } = harness({ [WI_URL]: ok(WI), [MN_URL]: ok(MN) }, { states: ['WI', 'MN'] });
    const inner = ctx.fetch;
    ctx.fetch = async (url, init) => {
      if (url === MN_URL) throw refusal(reason);
      return inner(url, init);
    };
    await assert.rejects(runAuctionGuide(ctx, noSleep), new RegExp(`gate refused: ${reason}`));
  }
  const { ctx } = harness({});
  ctx.fetch = async () => { throw refusal('budget'); };
  await assert.rejects(runAuctionGuide(ctx, noSleep), /gate refused: budget/);
});

test('run(): plans to ctx.deadline, never starting a page it cannot finish', async () => {
  const { ctx, calls } = harness({ [WI_URL]: ok(WI), [MN_URL]: ok(MN) }, { states: ['WI', 'MN'] });
  ctx.deadline = NOW.getTime() + 5_000; // room for Wisconsin now; not for a page 6 s later
  const res = await runAuctionGuide(ctx, noSleep);
  assert.deepEqual(calls, [WI_URL]);
  assert.equal(res.lots.length, 31);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /time budget reached before the Minnesota page/);

  const late = harness({ [WI_URL]: ok(WI) });
  late.ctx.deadline = NOW.getTime() + 1_000;
  const res2 = await runAuctionGuide(late.ctx, noSleep);
  assert.deepEqual(late.calls, []);
  assert.equal(res2.completeSnapshot, false);
});

test('run(): a refusal status fails the run; a missing state page is a warning while another was read', async () => {
  for (const status of [429, 403, 503]) {
    const { ctx, calls } = harness({ [WI_URL]: { status, text: 'Too Many Requests' } });
    await assert.rejects(runAuctionGuide(ctx, noSleep), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1, 'never retried');
  }
  const { ctx } = harness({ [WI_URL]: ok(WI) }, { states: ['WI', 'MN'] }); // Minnesota answers 404
  const res = await runAuctionGuide(ctx, noSleep);
  assert.equal(res.lots.length, 31);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /Minnesota page: HTTP 404/);

  await assert.rejects(runAuctionGuide(harness({}).ctx, noSleep), /no state page could be read \(Wisconsin: HTTP 404\)/);
});

/** www.auctionguide.com/robots.txt as stored by the 2026-09-30 probe (1,921 bytes). */
const AG_ROBOTS = [
  '# As a condition of accessing this website, you agree to abide by the following',
  '# content signals:',
  '',
  '# (a)  If a Content-Signal = yes, you may collect content for the corresponding',
  '#      use.',
  '# (b)  If a Content-Signal = no, you may not collect content for the',
  '#      corresponding use.',
  '# (c)  If the website operator does not include a Content-Signal for a',
  '#      corresponding use, the website operator neither grants nor restricts',
  '#      permission via Content-Signal with respect to the corresponding use.',
  '',
  '# The content signals and their meanings are:',
  '',
  '# search:   building a search index and providing search results (e.g., returning',
  "#           hyperlinks and short excerpts from your website's contents). Search does not",
  '#           include providing AI-generated search summaries.',
  '# ai-input: inputting content into one or more AI models (e.g., retrieval',
  '#           augmented generation, grounding, or other real-time taking of content for',
  '#           generative AI search answers).',
  '# ai-train: training or fine-tuning AI models.',
  '# use:      how AI systems may consume the content (immediate, reference, or full).',
  '',
  '# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF',
  '# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT',
  '# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.',
  '',
  '# BEGIN Cloudflare Managed content',
  '',
  'User-agent: *',
  'Content-Signal: search=yes,ai-train=no,use=reference',
  'Allow: /',
  '',
  ...['Amazonbot', 'Applebot-Extended', 'Bytespider', 'CCBot', 'ClaudeBot', 'CloudflareBrowserRenderingCrawler', 'Google-Extended', 'GPTBot', 'meta-externalagent']
    .flatMap((ua) => [`User-agent: ${ua}`, 'Disallow: /', '']),
  '# END Cloudflare Managed Content',
  '',
  'User-agent: *',
  'Disallow: /cb/',
  'Disallow: /fb/',
  'Disallow: /search/',
  'Disallow: /calendar/',
  ' ',
].join('\n');

test('run() behind the real crawl gate: robots.txt allows the state page, and the disallowed paths are refused', async () => {
  assert.equal(AG_ROBOTS.length, 1921, 'the file exactly as stored');
  const served: string[] = [];
  const gated = gateFetcher({
    rawFetch: async (url) => {
      served.push(url);
      if (url === 'https://www.auctionguide.com/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, text: AG_ROBOTS };
      if (url === WI_URL) return { status: 200, headers: { 'content-type': 'text/html', server: 'Apache' }, text: WI };
      return { status: 404, headers: {}, text: 'Not Found' };
    },
    rateLimitRpm: 10,
    sleep: async () => {},
    now: () => NOW.getTime(),
  });
  const { ctx } = harness({});
  ctx.fetch = gated;
  const res = await runAuctionGuide(ctx, noSleep);
  assert.deepEqual(served, ['https://www.auctionguide.com/robots.txt', WI_URL]);
  assert.deepEqual(gated.stats().refusals, [], 'the captured page passes bot-block detection');
  assert.equal(res.completeSnapshot, true);
  assert.equal(res.lots.length, 31);

  // The paths robots.txt disallows are refused by the gate, never fetched.
  for (const path of ['/search/?q=tractor', '/calendar/', '/cb/x', '/fb/x']) {
    await assert.rejects(gated(`https://www.auctionguide.com${path}`), /robots\.txt disallows/);
  }
  assert.deepEqual(served, ['https://www.auctionguide.com/robots.txt', WI_URL]);
});

test('malformed input yields warnings or empty results, never a throw', () => {
  const empty = parseAgStatePage('');
  assert.deepEqual([empty.heading, empty.found, empty.cards.length, empty.listEnded], [null, 0, 0, false]);
  assert.deepEqual(parseAgStatePage(undefined as unknown as string).warnings, ['Response body was not text.']);
  // A page cut off mid-card keeps the whole cards before it.
  const cut = parseAgStatePage(MN.slice(0, MN.indexOf('Large Moving Auction</a>')));
  assert.deepEqual(cut.cards.map((c) => c.id), ['220715', '220657', '220691', '220466']);
  assert.equal(cut.found, 5);
  assert.equal(cut.listEnded, false);
});

test('adapter identity', () => {
  assert.equal(auctionguideAdapter.key, 'auctionguide');
  assert.equal(auctionguideAdapter.method, 'html');
});
