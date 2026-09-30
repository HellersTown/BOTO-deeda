import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSearchPage,
  parsePagination,
  parseDetailPage,
  parseStatedTime,
  parseBuyerPremium,
  parsePickupAddress,
  normalizePublicSurplus,
  createPublicSurplusAdapter,
  publicSurplusAdapter,
  searchUrl,
  auctionUrl,
  scopeStates,
  stateTimezone,
  epochMsToIso,
  htmlToText,
  PUBLIC_SURPLUS_ORIGIN,
} from '../src/adapters/public-surplus.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

// All fixtures are real captures from 2026-09-30 (see the comment at the top of each).
const P0 = fx('public-surplus-search-wi-p0-2026-09-30.html');
const P1 = fx('public-surplus-search-wi-p1-2026-09-30.html');
const P2 = fx('public-surplus-search-wi-p2-2026-09-30.html');
const P3 = fx('public-surplus-search-wi-p3-2026-09-30.html');
const DETAIL = fx('public-surplus-detail-2026-09-30.html');
const DUTCH = fx('public-surplus-detail-dutch-2026-09-30.html');

// ------------------------------------------------------------- listing pages

test('listing: table rows give full titles, prices in cents and the declared state', () => {
  const { listings, warnings } = parseSearchPage(P0);
  assert.deepEqual(warnings, []);
  const byId = new Map(listings.map((l) => [l.id, l]));

  const trailer = byId.get('4090002')!;
  assert.equal(trailer.title, 'Firefighter Training Burn Trailer / Mobile Live-Fire Training Unit');
  assert.equal(trailer.priceCents, 25000);
  assert.equal(trailer.state, 'WI');
  assert.equal(trailer.source, 'table');

  // "$1.00" is 100 cents, and a trailing space in the source title is trimmed.
  assert.equal(byId.get('4095374')!.priceCents, 100);
  assert.equal(byId.get('4095375')!.title, 'Thieman Liftgate');
});

test('listing: grid cards use the full title attribute, not the truncated visible text', () => {
  const { listings } = parseSearchPage(P0);
  const skid = listings.find((l) => l.id === '4089922')!;
  // Visible card text is "#4089922 - 2002 New Holland LS150 Skid Steer wi...".
  assert.equal(skid.title, '2002 New Holland LS150 Skid Steer with 1998 Redihaul FSL12H+2S Trailer');
  assert.equal(skid.priceCents, 609500); // "$6,095.00"
  assert.equal(skid.source, 'grid');
});

test('listing: close times come from the page script as exact epoch ms, rendered ISO', () => {
  const { listings } = parseSearchPage(P0);
  const byId = new Map(listings.map((l) => [l.id, l]));
  // 1790866800000 = 2026-10-01T15:00:00Z = 10:00 AM CDT, a round local close.
  assert.equal(epochMsToIso(byId.get('4092693')!.endsAtMs), '2026-10-01T15:00:00.000Z');
  // 1790965800000 = 2026-10-02T18:30:00Z
  assert.equal(epochMsToIso(byId.get('4090002')!.endsAtMs), '2026-10-02T18:30:00.000Z');
  assert.equal(byId.get('4090002')!.serverNowMs, 1790783636051);
});

test('listing: deep links and thumbnails are absolute', () => {
  const { listings } = parseSearchPage(P0);
  const l = listings.find((x) => x.id === '4094389')!;
  assert.equal(l.url, 'https://www.publicsurplus.com/sms/all,wi/auction/view?auc=4094389');
  assert.equal(
    l.imageUrl,
    'https://d37qv0n5b4mbzm.cloudfront.net/sms/docviewer/cdnmainaucdoc/thumb-b/4094389/72063424',
  );
});

test('listing: Dutch and newly-listed flags stay on their own auction', () => {
  const { listings } = parseSearchPage(P0);
  const byId = new Map(listings.map((l) => [l.id, l]));
  assert.equal(byId.get('4093846')!.dutch, true);
  assert.equal(byId.get('4097452')!.dutch, true);
  assert.equal(byId.get('4097452')!.newlyListed, true);
  // The last grid card sits just above the table; its flags must not bleed in.
  assert.equal(byId.get('4089922')!.dutch, false);
  assert.equal(byId.get('4089922')!.newlyListed, false);
});

test('pagination: first page -> next is 1, last is 3; last page -> no next', () => {
  assert.deepEqual(parsePagination(P0), { current: 0, next: 1, last: 3 });
  assert.deepEqual(parsePagination(P1), { current: 1, next: 2, last: 3 });
  assert.deepEqual(parsePagination(P2), { current: 2, next: 3, last: 3 });
  // Page "4" of 4: Next is a disabled span with no srchPage() call.
  assert.deepEqual(parsePagination(P3), { current: 3, next: null, last: 3 });
  assert.deepEqual(parsePagination('<html></html>'), { current: null, next: null, last: null });
});

test('listing: a page with only grid cards still parses (view fallback)', () => {
  const { listings } = parseSearchPage(P1);
  assert.deepEqual(listings.map((l) => l.id), ['4095281', '4095282']);
  assert.equal(listings[0].title, 'Polycom Trio Conference Phone');
  assert.equal(listings[0].priceCents, 2500);
  assert.equal(listings[1].source, 'grid');
});

test('listing: malformed rows yield a warning, not a throw', () => {
  // A real row with its title link cut out, plus a truncated document.
  const row = P3.match(/<tr id="4094551searchList">[\s\S]*?<\/tr>/)![0];
  const broken = row.replace(/<a href="\/sms\/all,wi\/auction\/view\?auc=4094551">[^<]*<\/a>/, '');
  const r = parseSearchPage(`<table>${broken}</table>`);
  assert.equal(r.listings.length, 0);
  assert.match(r.warnings.join('\n'), /1 of 1 listing blocks had no parseable title\/link/);

  const cut = parseSearchPage(P0.slice(0, P0.indexOf('<tr id="4094389searchList">') + 60));
  assert.ok(Array.isArray(cut.listings));
  assert.doesNotThrow(() => parseSearchPage(''));
  assert.doesNotThrow(() => parseSearchPage('<<<>>>&&&;'));
});

// --------------------------------------------------------------- detail page

test('detail: seller, pickup address, bids, money and premium from a real page', () => {
  const { detail, warnings } = parseDetailPage(DETAIL, PUBLIC_SURPLUS_ORIGIN, '4089922');
  assert.deepEqual(warnings, []);
  const d = detail!;
  assert.equal(d.title, '2002 New Holland LS150 Skid Steer with 1998 Redihaul FSL12H+2S Trailer');
  assert.equal(d.agencyName, 'City of Milwaukee DPW Fleet Services');
  assert.equal(d.agencyOrgId, '1036892');
  assert.deepEqual(d.pickup, {
    line1: '1535 Mt Vernon Ave',
    city: 'Milwaukee',
    state: 'WI',
    postalCode: '53233',
    ambiguous: false,
  });
  assert.equal(d.region, 'WI');
  assert.equal(d.bidCount, 11);
  assert.equal(d.currentPriceCents, 609500);
  assert.equal(d.incrementCents, 10000);
  assert.equal(d.minBidCents, 619500);
  assert.equal(d.quantity, null);
  assert.equal(d.buyerPremiumPct, 8);
  assert.match(d.buyerPremiumNote!, /\$1 minimum charge/);
  assert.equal(d.shipping, 'Buyer must pickup item(s)');
  assert.equal(d.termsUrl, 'https://www.publicsurplus.com/sms/all,wi/docviewer/aucterms?auc=4089922');
  assert.equal(d.images.length, 14);
  assert.equal(d.images[0], 'https://d37qv0n5b4mbzm.cloudfront.net/sms/docviewer/cdnaucdoc/thumb-b/4089922/71936185');
  assert.equal(d.attachments.length, 3);
  assert.match(d.description!, /Engine HOURS - 3,795/);
  assert.match(d.description!, /sold AS IS, WHERE IS\./);
});

test('detail: times are stated in MDT, and the script epoch agrees with the text', () => {
  const d = parseDetailPage(DETAIL).detail!;
  assert.equal(d.statedZone, 'MDT');
  assert.equal(d.endsText, 'Oct 1, 2026 07:00 PM MDT');
  // 7:00 PM MDT (UTC-6) = 01:00Z next day = 8:00 PM in Milwaukee (CDT).
  assert.equal(d.endsAtIso, '2026-10-02T01:00:00.000Z');
  assert.equal(parseStatedTime(d.endsText)!.iso, d.endsAtIso);
  assert.equal(d.startsAtIso, '2026-09-18T16:47:00.000Z'); // Sep 18 10:47 AM MDT
  assert.equal(d.mightExtend, true);
});

test('detail: a partial Dutch-auction page still yields its bid box, with warnings', () => {
  const { detail, warnings } = parseDetailPage(DUTCH, PUBLIC_SURPLUS_ORIGIN, '4093846');
  const d = detail!;
  assert.match(warnings.join('\n'), /has no title/);
  assert.match(warnings.join('\n'), /names no selling agency/);
  assert.equal(d.title, null);
  assert.equal(d.agencyName, null);
  assert.equal(d.quantity, 3);
  assert.equal(d.bidCount, 1);
  assert.equal(d.currentPriceCents, 500);
  assert.equal(d.incrementCents, 50);
  assert.equal(d.condition, 'FAIR');
  assert.equal(d.bidDeposit, 'May Apply');
  assert.deepEqual(d.pickup, { line1: '1000 W CAMPUS DR', city: 'WAUSAU', state: 'WI', postalCode: '54401', ambiguous: false });
  // No script on this capture: the close comes from the stated "02:00 PM MDT".
  assert.equal(d.endsAtIso, '2026-10-01T20:00:00.000Z');
  // The disclaimer says "sales tax of 5.5%" before "Buyers Premium of 10%".
  assert.equal(d.buyerPremiumPct, 10);
});

test('detail: a page for another auction, or no auction at all, is refused', () => {
  const wrong = parseDetailPage(DETAIL, PUBLIC_SURPLUS_ORIGIN, '9999999');
  assert.equal(wrong.detail, null);
  assert.match(wrong.warnings[0], /asked for auction 9999999, page is auction 4089922/);
  const none = parseDetailPage('<html><body>Service unavailable</body></html>');
  assert.equal(none.detail, null);
  assert.match(none.warnings[0], /not an auction page/);
});

// ------------------------------------------------------------- small parsers

test('stated times: zone abbreviations map to offsets; unknown zones are refused', () => {
  assert.equal(parseStatedTime('Oct 1, 2026 07:00 PM MDT')!.iso, '2026-10-02T01:00:00.000Z');
  assert.equal(parseStatedTime('Dec 1, 2026 07:00 PM MST')!.iso, '2026-12-02T02:00:00.000Z');
  assert.equal(parseStatedTime('Oct 1, 2026 12:30 AM CDT')!.iso, '2026-10-01T05:30:00.000Z');
  assert.equal(parseStatedTime('Oct 1, 2026 12:30 PM CDT')!.iso, '2026-10-01T17:30:00.000Z');
  assert.equal(parseStatedTime('Oct 1, 2026 07:00 PM'), null); // no zone: ambiguous
  assert.equal(parseStatedTime('Oct 1, 2026 07:00 PM IST'), null); // not a US zone we know
  assert.equal(parseStatedTime('tomorrow at noon'), null);
});

test('buyer premium: tied to the words, not the first percentage in sight', () => {
  assert.equal(parseBuyerPremium('A Buyers Premium of 8% will be added')!.pct, 8);
  assert.equal(parseBuyerPremium("A 12.5% buyer's premium applies.")!.pct, 12.5);
  assert.equal(parseBuyerPremium("There is no buyer's premium on this sale.")!.pct, 0);
  assert.equal(parseBuyerPremium('NTC will charge a sales tax of 5.5%.'), null);
  assert.equal(parseBuyerPremium(''), null);
});

test('pickup address: city and state come only from a "City, ST 12345" line', () => {
  const loc = parsePickupAddress('<div>1535 Mt Vernon Ave</div><div>Milwaukee,\n WI\n 53233</div>');
  assert.equal(loc!.city, 'Milwaukee');
  assert.equal(loc!.state, 'WI');
  // No recognisable city/state/zip line: keep the text, declare no state.
  const vague = parsePickupAddress('<div>Behind the highway garage</div>');
  assert.equal(vague!.state, null);
  assert.equal(vague!.city, null);
});

test('scope and zones: Wisconsin by default; zones only for single-zone states', () => {
  assert.deepEqual(scopeStates(null), ['WI']);
  assert.deepEqual(scopeStates([]), ['WI']);
  assert.deepEqual(scopeStates(['wi', 'mn', 'WI', 'Wisconsin']), ['WI', 'MN']);
  assert.equal(stateTimezone('WI'), 'America/Chicago');
  assert.equal(stateTimezone('TX'), null); // El Paso is Mountain
  assert.equal(searchUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', 2),
    'https://www.publicsurplus.com/sms/all,wi/browse/search?posting=y&endHours=-1&startHours=-1&page=2');
  assert.equal(auctionUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', '4089922'),
    'https://www.publicsurplus.com/sms/all,wi/auction/view?auc=4089922');
});

test('htmlToText keeps paragraphs and does not space out inline tags', () => {
  assert.equal(htmlToText('<p>Sold <strong>AS IS</strong>.</p><p>A &amp; B</p>'), 'Sold AS IS.\nA & B');
});

// --------------------------------------------------------------- normalize

test('normalize: an enriched lot carries seller, premium, pickup and next bid', () => {
  const listing = parseSearchPage(P0).listings.find((l) => l.id === '4089922')!;
  const detail = parseDetailPage(DETAIL, PUBLIC_SURPLUS_ORIGIN, '4089922').detail!;
  const { auction, lot } = normalizePublicSurplus(listing, detail);

  assert.equal(auction.externalId, '4089922');
  assert.equal(auction.sellerName, 'City of Milwaukee DPW Fleet Services');
  assert.equal(auction.sellerState, 'WI');
  assert.equal(auction.buyerPremiumPct, 8);
  assert.equal(auction.timezone, 'America/Chicago');
  assert.equal(auction.auctioneer, 'Public Surplus');
  assert.equal(auction.ships, false);
  assert.equal(auction.endsAt, '2026-10-02T01:00:00.000Z');

  assert.equal(lot.auctionExternalId, '4089922');
  assert.equal(lot.title, '2002 New Holland LS150 Skid Steer with 1998 Redihaul FSL12H+2S Trailer');
  assert.equal(lot.currentBidCents, 609500);
  assert.equal(lot.nextBidCents, 619500);
  assert.equal(lot.startingBidCents, null);
  assert.equal(lot.bidCount, 11);
  assert.equal(lot.closesAt, '2026-10-02T01:00:00.000Z');
  assert.equal(lot.closed, false);
  assert.equal(lot.url, 'https://www.publicsurplus.com/sms/all,wi/auction/view?auc=4089922');
  assert.equal(lot.pickup!.city, 'Milwaukee');
  assert.equal(lot.pickup!.state, 'WI');
  assert.equal(lot.images.length, 14);
  assert.equal(lot.images[3].position, 3);
  assert.equal(lot.condition, null); // "SEE DESCRIPTION" is not a condition
  assert.equal((lot.raw as any)._meta.sourceStatedZone, 'MDT');
});

test('normalize: without a detail page, only the listing\'s declared state is used', () => {
  const listing = parseSearchPage(P0).listings.find((l) => l.id === '4094389')!;
  const { auction, lot } = normalizePublicSurplus(listing, null);
  assert.deepEqual(lot.pickup, { line1: null, city: null, state: 'WI', postalCode: null, ambiguous: false });
  assert.equal((lot.raw as any)._meta.pickupStateSource, 'listing-state');
  assert.equal(auction.sellerName, null);
  assert.equal(auction.buyerPremiumPct, null);
  assert.equal(lot.currentBidCents, 500);
  assert.equal(lot.bidCount, null);
  assert.equal(lot.images.length, 1);
});

test('normalize: zero bids means an opening price, not a current bid', () => {
  // Branch test: the real 4089922 detail with its bid count set to 0.
  const listing = parseSearchPage(P0).listings.find((l) => l.id === '4089922')!;
  const detail = { ...parseDetailPage(DETAIL).detail!, bidCount: 0 };
  const { lot } = normalizePublicSurplus(listing, detail);
  assert.equal(lot.currentBidCents, null);
  assert.equal(lot.startingBidCents, 609500);
  assert.equal(lot.bidCount, 0);
});

test('normalize: a close at or before the server clock is closed', () => {
  const listing = { ...parseSearchPage(P0).listings[0] };
  listing.serverNowMs = listing.endsAtMs! + 1;
  assert.equal(normalizePublicSurplus(listing, null).lot.closed, true);
});

// ----------------------------------------------------------------- run()

function ctxWith(fetch: Fetcher, overrides: Partial<SourceConfig> = {}): AdapterContext {
  const source: SourceConfig = {
    id: 'src-ps',
    slug: 'public-surplus',
    name: 'Public Surplus',
    url: 'https://www.publicsurplus.com',
    tier: 'school',
    ingest: 'html',
    platform: 'public-surplus',
    states: null,
    rateLimitRpm: 20,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 120,
    consecutiveFailures: 0,
    ...overrides,
  };
  return {
    source,
    fetch,
    now: () => new Date('2026-09-30T16:00:00Z'),
    log: () => {},
    secrets: {},
  };
}

const PAGES: Record<string, string> = {
  [searchUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', 0)]: P0,
  [searchUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', 1)]: P1,
  [searchUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', 2)]: P2,
  [searchUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', 3)]: P3,
  [auctionUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', '4089922')]: DETAIL,
};

function fixtureFetch(seen: string[], sleeps: number[] = []): Fetcher {
  return async (url) => {
    seen.push(url);
    const text = PAGES[url];
    return text ? { status: 200, headers: {}, text } : { status: 404, headers: {}, text: 'Not found' };
  };
}

test('run: paginates 0 -> 3 via the pages\' own links, then stops (complete snapshot)', async () => {
  const seen: string[] = [];
  const adapter = createPublicSurplusAdapter({ maxDetailPages: 0, sleep: async () => {} });
  const result = await adapter.run(ctxWith(fixtureFetch(seen)));
  assert.deepEqual(seen, [0, 1, 2, 3].map((p) => searchUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', p)));
  assert.equal(result.stats.httpRequests, 4);
  assert.equal(result.completeSnapshot, true);
  const expected = new Set([P0, P1, P2, P3].flatMap((h) => parseSearchPage(h).listings.map((l) => l.id)));
  assert.equal(result.lots.length, expected.size);
  assert.equal(result.auctions.length, expected.size);
  assert.ok(result.lots.every((l) => l.url && l.closesAt && l.pickup?.state === 'WI'));
  assert.deepEqual(result.warnings, []);
});

test('run: enriches the lowest auction ids first; a failed detail is withheld, not blanked', async () => {
  const seen: string[] = [];
  const adapter = createPublicSurplusAdapter({ maxDetailPages: 4, sleep: async () => {} });
  const result = await adapter.run(ctxWith(fixtureFetch(seen)));
  // The four lowest ids across all pages, in order. Only 4089922's detail page was
  // captured; the other three answer 404 from the fixture server.
  assert.deepEqual(seen.slice(4), ['4085485', '4085487', '4088990', '4089922']
    .map((id) => auctionUrl(PUBLIC_SURPLUS_ORIGIN, 'WI', id)));
  assert.equal(result.stats.httpRequests, 8);
  const skid = result.lots.find((l) => l.externalId === '4089922')!;
  assert.equal(skid.bidCount, 11);
  assert.equal(result.auctions.find((a) => a.externalId === '4089922')!.sellerName, 'City of Milwaukee DPW Fleet Services');
  // A failed detail is not emitted (its stored row stays as it was), and the run
  // no longer claims to be complete, so nothing is closed by absence.
  for (const id of ['4085485', '4085487', '4088990']) {
    assert.equal(result.lots.find((l) => l.externalId === id), undefined);
  }
  // Lots outside the enrichment budget are still emitted from the listing.
  assert.ok(result.lots.find((l) => l.externalId === '4094534'));
  assert.equal(result.completeSnapshot, false);
  assert.match(result.warnings.join('\n'), /auction 4088990 detail returned HTTP 404/);
});

test('run: paces requests to the source rate limit', async () => {
  const sleeps: number[] = [];
  let clock = Date.parse('2026-09-30T16:00:00Z');
  const adapter = createPublicSurplusAdapter({
    maxDetailPages: 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  const ctx = ctxWith(fixtureFetch([]), { rateLimitRpm: 20 });
  ctx.now = () => new Date(clock);
  await adapter.run(ctx);
  assert.deepEqual(sleeps, [3000, 3000, 3000]); // 20 rpm = one request per 3 s
});

test('run: a garbage page is a warning and an incomplete snapshot, not a throw', async () => {
  const fetch: Fetcher = async () => ({ status: 200, headers: {}, text: '<html><body>Maintenance</body></html>' });
  const result = await createPublicSurplusAdapter({ sleep: async () => {} }).run(ctxWith(fetch));
  assert.equal(result.lots.length, 0);
  assert.equal(result.completeSnapshot, false);
  assert.match(result.warnings.join('\n'), /no parseable auctions/);
});

test('run: a 5xx on the first page or a 429 anywhere fails the run loudly', async () => {
  const down: Fetcher = async () => ({ status: 503, headers: {}, text: '' });
  await assert.rejects(() => createPublicSurplusAdapter({ sleep: async () => {} }).run(ctxWith(down)), /HTTP 503/);
  const limited: Fetcher = async () => ({ status: 429, headers: {}, text: '' });
  await assert.rejects(() => createPublicSurplusAdapter({ sleep: async () => {} }).run(ctxWith(limited)), /rate limit/i);
});

test('the exported adapter is keyed by sources.platform', () => {
  assert.equal(publicSurplusAdapter.key, 'public-surplus');
  assert.equal(publicSurplusAdapter.method, 'html');
});
