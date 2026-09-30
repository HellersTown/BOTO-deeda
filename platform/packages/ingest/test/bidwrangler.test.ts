import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auctionPageUrl,
  auctionWalkDone,
  bidwranglerAdapter,
  bwImages,
  bwLocation,
  declaredState,
  decodeEntities,
  isInformationalLot,
  itemPageUrl,
  itemWalkDone,
  normalizeBwAuction,
  normalizeBwItem,
  openFirstOrderHolds,
  parseAuctionsPage,
  parseBuyerPremium,
  parseCardFeePct,
  parseItemsPage,
  planAuctions,
  runBidwrangler,
  scopeStates,
  tenantApiBase,
  toIso,
  validTimeZone,
} from '../src/adapters/bidwrangler.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

// Every fixture is a real response captured 2026-09-30 from bid.hansenauctiongroup.com
// through inspect_url, trimmed (image arrays shortened, the high bidder's internal
// user_id/account_id removed), never edited.
const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => readFileSync(join(here, 'fixtures', f), 'utf8');
const ITEMS_P9 = load('bidwrangler-items-p9-2026-09-30.json'); // #5251 1955 Massey-Harris 33 Tractor
const ITEMS_P2 = load('bidwrangler-items-p2-2026-09-30.json'); // #1D-#1F informational pseudo-lots
const AUCTIONS_P1 = load('bidwrangler-auctions-2026-09-30.json'); // Belgium WI + Mosinee WI (pending)
const AUCTION_TJOFLAT = load('bidwrangler-auctions-p2-2026-09-30.json'); // Ettrick WI (accepting_bids)
const ITEM_PAGE = load('bidwrangler-item-page-2026-09-30.html');
const AUCTION_PAGE = load('bidwrangler-auction-page-2026-09-30.html');

const BASE = 'https://bid.hansenauctiongroup.com';
/** 1:00 PM CDT on capture day, five hours before Tjoflat's lots start closing. */
const NOW = new Date('2026-09-30T18:00:00Z');

const tractor = () => JSON.parse(ITEMS_P9).items[0];
const tjoflat = () => JSON.parse(AUCTION_TJOFLAT).auctions[0];
const [bichler, nitke] = JSON.parse(AUCTIONS_P1).auctions;
const og = (html: string, prop: string) =>
  decodeEntities(new RegExp(`property="og:${prop}" content="([^"]*)"`).exec(html)![1]);

// ------------------------------------------------------------------ tenancy

test('the tenant API host comes from api_base, never from the marketing site', () => {
  assert.equal(
    tenantApiBase({ apiBase: 'https://bid.hansenauctiongroup.com', url: 'https://www.hansenauctiongroup.com' }),
    BASE,
  );
  // www.hansenauctiongroup.com serves no /api: refusing it beats a silent 404 crawl.
  assert.equal(tenantApiBase({ apiBase: null, url: 'https://www.hansenauctiongroup.com' }), null);
  assert.equal(tenantApiBase({ apiBase: 'bid.hansenauctiongroup.com/', url: 'x' }), BASE);
  // The catalog host the page also advertises (window.bwCompany.catalog_url).
  assert.equal(
    tenantApiBase({ apiBase: null, url: 'https://hansenauctiongroup.bidwrangler.com' }),
    'https://hansenauctiongroup.bidwrangler.com',
  );
});

test('run() refuses to start without a bidding host', async () => {
  const ctx = makeCtx(async () => ({ status: 200, headers: {}, text: '{}' }), { apiBase: null, url: 'https://www.hansenauctiongroup.com' });
  await assert.rejects(() => bidwranglerAdapter.run(ctx), /api_base/);
});

// ----------------------------------------------------------- the real lot

test('the tractor lot: title, lot number and money in integer cents', () => {
  const lot = normalizeBwItem(tractor(), { base: BASE, now: NOW, auction: tjoflat() })!;
  assert.equal(lot.title, '1955 Massey-Harris 33 Tractor');
  assert.equal(lot.lotNumber, '5251');
  assert.equal(lot.externalId, '26044401');
  assert.equal(lot.auctionExternalId, '168337');
  assert.equal(lot.currentBidCents, 110000); // high.amount 1100.0
  assert.equal(lot.nextBidCents, 112500); // minimum_bid_amount 1125.0, the platform's own ask
  assert.equal(lot.startingBidCents, 100); // start_amount 1.0
  assert.equal(lot.quantity, 1);
  assert.match(lot.description!, /^SN: T67079M1, 5 speed, 540 pto/);
  assert.equal(lot.ships, false); // shippable: false
});

test('bidCount is the number of accepted bids, not bidders', () => {
  const lot = normalizeBwItem(tractor(), { base: BASE, now: NOW })!;
  assert.equal(lot.bidCount, 64); // api_bidding_state.accepted_bid_count
  assert.equal(lot.reserveMet, true); // $1,100 against a disclosed $1 reserve
});

test('closesAt is the lot\'s own staggered close, ISO with an explicit offset', () => {
  const lot = normalizeBwItem(tractor(), { base: BASE, now: NOW })!;
  // The auction ends 23:00Z; lots close one a minute after it. This one: 23:04Z
  // = 6:04 PM CDT. Using the auction's end would fire a snipe alert 4 minutes early.
  assert.equal(lot.closesAt, '2026-09-30T23:04:00.000Z');
  assert.match(lot.closesAt!, /(Z|[+-]\d{2}:\d{2})$/);
  assert.equal(lot.closed, false);
  const later = normalizeBwItem(tractor(), { base: BASE, now: new Date('2026-10-01T00:00:00Z') })!;
  assert.equal(later.closed, true);
});

test('a soft-close extension moves closesAt via actual_end_time', () => {
  // Test-local edit of the real record: what an extension looks like (the
  // captured lot had autoextensions 0). scheduled_end_time stays put.
  const extended = { ...tractor(), actual_end_time: '2026-09-30T23:14:00.000Z', autoextensions: 1 };
  const lot = normalizeBwItem(extended, { base: BASE, now: NOW })!;
  assert.equal(lot.closesAt, '2026-09-30T23:14:00.000Z');
});

test('hide_prices hides the money but keeps the lot', () => {
  const lot = normalizeBwItem({ ...tractor(), hide_prices: true }, { base: BASE, now: NOW })!;
  assert.equal(lot.currentBidCents, null);
  assert.equal(lot.nextBidCents, null);
  assert.equal(lot.startingBidCents, null);
  assert.equal(lot.title, '1955 Massey-Harris 33 Tractor');
});

// ------------------------------------------------------------- deep links

test('deep links are exactly what the server declares in og:url', () => {
  const lot = normalizeBwItem(tractor(), { base: BASE, now: NOW })!;
  assert.equal(lot.url, og(ITEM_PAGE, 'url')); // https://bid.hansenauctiongroup.com/ui/items/26044401
  assert.equal(og(ITEM_PAGE, 'title'), lot.title);
  assert.equal(itemPageUrl(BASE, 26044401), 'https://bid.hansenauctiongroup.com/ui/items/26044401');
  assert.equal(auctionPageUrl(BASE, 169950), og(AUCTION_PAGE, 'url'));
  const auction = normalizeBwAuction(tjoflat(), BASE)!;
  assert.equal(auction.url, 'https://bid.hansenauctiongroup.com/ui/auctions/168337');
});

// ------------------------------------------------------------------ images

test('images: the lg rendition, in source order, matching the page\'s og:image', () => {
  const lot = normalizeBwItem(tractor(), { base: BASE, now: NOW })!;
  assert.equal(lot.images.length, 2);
  assert.deepEqual(lot.images.map((i) => i.position), [0, 1]);
  // Two independent captures (items JSON and the item page) agree on the photo.
  assert.equal(lot.images[0].url, og(ITEM_PAGE, 'image'));
  assert.ok(lot.images.every((i) => i.url.startsWith('https://d37cbsn538t2ha.cloudfront.net/')));
  assert.deepEqual(bwImages('not an array'), []);
  assert.deepEqual(bwImages([null, { xs: 'javascript:alert(1)' }, { lg: 'https://a/b.jpg' }]), [
    { url: 'https://a/b.jpg', position: 0 },
  ]);
});

// ---------------------------------------------------------------- location

test('pickup is the auction\'s DECLARED location; the city never implies a state', () => {
  const lot = normalizeBwItem(tractor(), { base: BASE, now: NOW, auction: tjoflat() })!;
  assert.deepEqual(lot.pickup, {
    line1: 'N24454 Washington Coulee Road',
    city: 'Ettrick',
    state: 'WI',
    postalCode: '54627',
    lat: 44.1935676,
    lon: -91.1617798,
    ambiguous: false,
  });
  // The item itself declares no location (location: null) and no auction was given.
  assert.equal(normalizeBwItem(tractor(), { base: BASE, now: NOW })!.pickup, null);
});

test('DATA TRAP: Beloit is in Wisconsin AND Kansas, so a bare city stays stateless', () => {
  const beloit = bwLocation({ city: 'Beloit', state: null, zip: null });
  assert.equal(beloit!.state, null);
  assert.equal(beloit!.ambiguous, true);
  assert.equal(declaredState('Beloit'), null);
  assert.equal(declaredState('Wisconsin'), 'WI'); // a declared full name is still a declaration
  assert.equal(declaredState('ks'), 'KS');
  assert.equal(declaredState('-'), null);
});

test('scope defaults to Wisconsin when sources.states is null or empty', () => {
  assert.deepEqual(scopeStates(null), ['WI']);
  assert.deepEqual(scopeStates([]), ['WI']);
  assert.deepEqual(scopeStates(['wi', 'Minnesota', 'bogus']), ['WI', 'MN']);
});

// ------------------------------------------------------------ pseudo-lots

test('informational pseudo-lots are recognised by their whole name only', () => {
  const pseudo = JSON.parse(ITEMS_P2).items;
  assert.deepEqual(pseudo.map((i: any) => i.name), ['Inspection and Vehicles', 'Transfers', 'Shipping']);
  assert.ok(pseudo.every(isInformationalLot));
  assert.equal(isInformationalLot(tractor()), false);
  assert.equal(isInformationalLot({ name: 'Payment Information' }), true);
  assert.equal(isInformationalLot({ name: 'Open House' }), true);
  // Real merchandise that merely contains the words.
  assert.equal(isInformationalLot({ name: 'Pickup Truck' }), false);
  assert.equal(isInformationalLot({ name: 'Shipping Container' }), false);
});

// ---------------------------------------------------------------- auctions

test('auction: title, times with offset, IANA zone, declared pickup, lot count', () => {
  const a = normalizeBwAuction(tjoflat(), BASE)!;
  assert.equal(a.externalId, '168337');
  assert.equal(a.title, 'Kenneth H. Tjoflat - Tractors, Shop Tools, Household & More - Ettrick, WI');
  assert.equal(a.format, 'online');
  assert.equal(a.startsAt, '2026-09-09T20:00:00.000Z');
  assert.equal(a.endsAt, '2026-09-30T23:00:00.000Z'); // "Sep 30 2026 @ 6:00PM CDT"
  assert.equal(a.timezone, 'America/Chicago');
  assert.equal(a.pickup!.state, 'WI');
  assert.equal(a.pickup!.city, 'Ettrick');
  assert.equal(a.lotCount, 195); // published_items_count
  assert.equal(a.auctioneer, 'Hansen Auction Group');
  assert.equal(a.pickupRequired, true);
  assert.equal(a.currency, 'USD');
  // The megabyte of featured-image URLs does not ride along in raw.
  assert.equal((a.raw as any).featured_images, undefined);
  assert.equal((a.raw as any).featured_images_count, 1);
});

test('buyer\'s premium is carried on the auction, including the card fee', () => {
  const a = normalizeBwAuction(tjoflat(), BASE)!;
  assert.equal(a.buyerPremiumPct, 10); // "10% Buyer’s Fee" (curly apostrophe)
  assert.match(a.buyerPremiumNote!, /3\.75% credit card fee/);

  // Bichler: payment_cc_fee "3.99" is structured and wins over prose.
  const b = normalizeBwAuction(bichler, BASE)!;
  assert.equal(b.buyerPremiumPct, 10);
  assert.match(b.buyerPremiumNote!, /3\.99% credit card fee/);
});

test('a tiered premium reports its first tier and spells out the tiers', () => {
  const n = normalizeBwAuction(nitke, BASE)!;
  assert.equal(n.buyerPremiumPct, 10);
  assert.match(n.buyerPremiumNote!, /^Tiered: 10% on the first \$25,000, 6% on the remainder/);
  assert.equal(n.format, 'hybrid'); // LIVE/ONLINE simulcast: neither online_only nor offline_only
  // Nov 3 is after DST ends: 23:00Z is 5:00 PM CST, as the source's own string says.
  assert.equal(n.endsAt, '2026-11-03T23:00:00.000Z');
});

test('premium parsing on real HTML-escaped prose, and refusals', () => {
  const desc = og(AUCTION_PAGE, 'description'); // "10% Buyer&#39;s fee ... A 3.75% credit card convenience fee"
  assert.equal(parseBuyerPremium(desc)!.pct, 10);
  assert.equal(parseCardFeePct(null, desc), 3.75);
  assert.equal(parseBuyerPremium('No premium on this sale.'), null);
  assert.equal(parseBuyerPremium('150% buyer premium'), null); // not a plausible premium
  assert.equal(parseBuyerPremium(null), null);
});

test('time helpers refuse what they cannot trust', () => {
  assert.equal(toIso('2026-09-30T23:04:00.000Z'), '2026-09-30T23:04:00.000Z');
  assert.equal(toIso(1790809440), '2026-09-30T23:04:00.000Z'); // scheduled_end_time_unix
  assert.equal(toIso('not a date'), null);
  assert.equal(toIso(0), null);
  assert.equal(validTimeZone('America/Chicago'), 'America/Chicago');
  assert.equal(validTimeZone('CDT'), null);
});

// -------------------------------------------------- pagination/termination

test('the auction walk stops at the completed history, not after 69 pages', () => {
  // Real page: 2 open auctions, fewer than 50, so this is the last page.
  assert.equal(auctionWalkDone(parseAuctionsPage(JSON.parse(AUCTIONS_P1)), 1), true);
  // Real page=2&per_page=1: a full page of open auctions, total 3,420: keep going.
  const p2 = parseAuctionsPage(JSON.parse(AUCTION_TJOFLAT));
  assert.equal(p2.total, 3420);
  assert.equal(p2.page, 2);
  assert.equal(p2.perPage, 1);
  assert.equal(auctionWalkDone(p2, 2), false);
  // The same full page, but its record is from the completed history (open
  // auctions sort first), so every later page is history too.
  const history = { ...p2, records: [{ ...p2.records[0], complete: true }] };
  assert.equal(auctionWalkDone(history, 2), true);
  // If the sort ever changes (an open sale after a completed one), the early
  // stop is not trusted: a full page keeps the walk going.
  const shuffled = { ...p2, perPage: 2, records: [{ ...p2.records[0], complete: true }, p2.records[0]] };
  assert.equal(openFirstOrderHolds(shuffled.records), false);
  assert.equal(auctionWalkDone(shuffled, 2), false);
});

test('the item walk pages until the server\'s total is reached', () => {
  const p2 = parseItemsPage(JSON.parse(ITEMS_P2)); // page 2 of per_page 3, total 195
  assert.deepEqual([p2.page, p2.perPage, p2.total, p2.records.length], [2, 3, 195, 3]);
  assert.equal(itemWalkDone(p2, 2, 3), false);
  const p9 = parseItemsPage(JSON.parse(ITEMS_P9)); // page 9 of per_page 1
  assert.equal(itemWalkDone(p9, 9, 1), false);
  assert.equal(itemWalkDone({ ...p9, page: 195 }, 195, 1), true); // 195 x 1 >= 195
  assert.equal(itemWalkDone({ ...p9, records: [] }, 10, 1), true); // empty page ends it
  assert.equal(itemWalkDone(p9, 1, 100), true); // a short page is the last page
});

// ---------------------------------------------------------------- planning

test('planning scopes by declared state and puts lots closing today first', () => {
  const all = [nitke, tjoflat(), bichler];
  const plan = planAuctions(all, ['WI'], NOW);
  assert.equal(plan.inScope.length, 3);
  assert.equal(plan.queue[0].id, 168337); // closes in 5 hours: urgent
  assert.deepEqual(plan.queue.map((a) => a.id).sort(), [156558, 168337, 169893]);

  const mn = planAuctions(all, ['MN'], NOW);
  assert.equal(mn.inScope.length, 0);
  assert.equal(mn.outOfScope, 3);

  // A sale with no declared location is set aside, never placed by its name
  // ("... - Belgium, WI").
  const unplaced = planAuctions([{ ...bichler, location: null }], ['WI'], NOW);
  assert.equal(unplaced.inScope.length, 0);
  assert.equal(unplaced.undeclaredState.length, 1);

  // Completed and conventional-listing records are not auctions to crawl.
  assert.equal(planAuctions([{ ...bichler, complete: true }], ['WI'], NOW).notOpen, 1);
});

test('the non-urgent remainder rotates by the hour so every sale gets a turn', () => {
  const all = [nitke, bichler];
  const h0 = planAuctions(all, ['WI'], new Date('2026-09-30T18:00:00Z')).queue.map((a) => a.id);
  const h1 = planAuctions(all, ['WI'], new Date('2026-09-30T19:00:00Z')).queue.map((a) => a.id);
  assert.notDeepEqual(h0, h1);
  assert.deepEqual([...h0].sort(), [...h1].sort());
});

// ---------------------------------------------------------- raw hygiene

test('raw keeps the record but drops the image URLs and the bidder\'s identity', () => {
  const raw = normalizeBwItem(tractor(), { base: BASE, now: NOW })!.raw as any;
  assert.equal(raw.images, undefined);
  assert.equal(raw.images_count, 2);
  assert.equal(raw.api_bidding_state.high.amount, 1100);
  assert.equal(raw.api_bidding_state.high.bidder_number, undefined);
  assert.equal(raw.api_bidding_state.high.user_id, undefined);
  assert.equal(raw.stock_number, '5251');
});

// ------------------------------------------------------------ malformed input

test('malformed input yields warnings or nulls, never a throw', () => {
  assert.deepEqual(parseItemsPage('<html>maintenance</html>').records, []);
  assert.match(parseItemsPage('<html>maintenance</html>').warnings[0], /not a \{ items/);
  const mixed = parseItemsPage({ total: 3, items: [null, 5, tractor()] });
  assert.equal(mixed.records.length, 1);
  assert.match(mixed.warnings[0], /Skipped 2 non-object items/);
  assert.equal(normalizeBwItem({}, { base: BASE, now: NOW }), null);
  const weird = normalizeBwItem(
    { id: 1, name: 'Odd lot', api_bidding_state: 'x', images: 'y', scheduled_end_time: 'soon', location: 7 },
    { base: BASE, now: NOW },
  )!;
  assert.equal(weird.currentBidCents, null);
  assert.equal(weird.closesAt, null);
  assert.equal(weird.closed, false);
  assert.deepEqual(weird.images, []);
  assert.equal(normalizeBwAuction({ name: 'no id' }, BASE), null);
});

// ------------------------------------------------------------------- run()

function makeCtx(fetch: Fetcher, over: Partial<SourceConfig> = {}): AdapterContext {
  const source: SourceConfig = {
    id: 'src-hansen',
    slug: 'hansen-auction-group',
    name: 'Hansen Auction Group',
    url: 'https://www.hansenauctiongroup.com',
    apiBase: BASE,
    tier: 'private',
    ingest: 'internal_json',
    platform: 'bidwrangler',
    states: ['WI'],
    rateLimitRpm: 20,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 60,
    consecutiveFailures: 0,
    ...over,
  };
  return { source, fetch, now: () => NOW, log: () => {}, secrets: {} };
}

/** Serve captured bodies by URL; anything unexpected is a 404 and recorded. */
function routes(map: Record<string, string>) {
  const calls: string[] = [];
  const fetch: Fetcher = async (url) => {
    calls.push(url);
    const body = map[url];
    return body === undefined
      ? { status: 404, headers: {}, text: 'not found' }
      : { status: 200, headers: { 'content-type': 'application/json' }, text: body };
  };
  return { calls, fetch };
}

const noWait = { minIntervalMs: 0 };

test('run(): list, scope, fetch items, and report honestly', async () => {
  const { calls, fetch } = routes({
    [`${BASE}/api/auctions?page=1`]: AUCTION_TJOFLAT, // a full page (per_page 1): continue
    [`${BASE}/api/auctions?page=2`]: AUCTIONS_P1, // short page: stop
    [`${BASE}/api/auctions/168337/items?page=1&per_page=100`]: ITEMS_P9,
  });
  const res = await runBidwrangler(makeCtx(fetch), noWait);

  assert.deepEqual(res.auctions.map((a) => a.externalId), ['168337', '169893', '156558']);
  assert.equal(res.lots.length, 1);
  const lot = res.lots[0];
  assert.equal(lot.title, '1955 Massey-Harris 33 Tractor');
  assert.equal(lot.pickup!.state, 'WI'); // inherited from the sale's declared location
  assert.equal(lot.url, `${BASE}/ui/items/26044401`);

  // The captured page held 1 of 195 items, and the two pending sales 404 here:
  // this must NOT claim to be a complete snapshot.
  assert.equal(res.completeSnapshot, false);
  assert.ok(res.warnings.some((w) => /received 1 of 195 items/.test(w)));
  assert.ok(res.warnings.some((w) => /Items for auction 169893 page 1: HTTP 404/.test(w)));

  assert.equal(res.stats.httpRequests, calls.length);
  assert.ok(calls.every((u) => u.startsWith(`${BASE}/api/`)), 'only the allowed /api paths');
  assert.ok(!calls.some((u) => u.includes('/docs') || u.includes('/accounts')));
});

test('run(): a Minnesota-scoped source fetches no Wisconsin items', async () => {
  const { calls, fetch } = routes({
    [`${BASE}/api/auctions?page=1`]: AUCTIONS_P1,
  });
  const res = await runBidwrangler(makeCtx(fetch, { states: ['MN'] }), noWait);
  assert.equal(res.auctions.length, 0);
  assert.equal(res.lots.length, 0);
  assert.equal(calls.length, 1);
});

test('run(): pseudo-lots are dropped with a counted warning', async () => {
  const { fetch } = routes({
    [`${BASE}/api/auctions?page=1`]: AUCTION_TJOFLAT,
    [`${BASE}/api/auctions?page=2`]: '{"total":3420,"page":2,"per_page":50,"auctions":[]}',
    [`${BASE}/api/auctions/168337/items?page=1&per_page=100`]: ITEMS_P2,
  });
  const res = await runBidwrangler(makeCtx(fetch), noWait);
  assert.equal(res.lots.length, 0);
  assert.ok(res.warnings.some((w) => /Skipped 3 informational pseudo-lot/.test(w)));
});

test('run(): a non-JSON items page is a warning, not a crash', async () => {
  const { fetch } = routes({
    [`${BASE}/api/auctions?page=1`]: AUCTION_TJOFLAT,
    [`${BASE}/api/auctions?page=2`]: '{"auctions":[]}',
    [`${BASE}/api/auctions/168337/items?page=1&per_page=100`]: '<!DOCTYPE html><title>Just a moment...</title>',
  });
  const res = await runBidwrangler(makeCtx(fetch), noWait);
  assert.equal(res.lots.length, 0);
  assert.equal(res.completeSnapshot, false);
  assert.ok(res.warnings.some((w) => /were not JSON/.test(w)));
});

test('run(): the budget keeps the most urgent sale and defers the rest', async () => {
  const { calls, fetch } = routes({
    [`${BASE}/api/auctions?page=1`]: AUCTION_TJOFLAT,
    [`${BASE}/api/auctions?page=2`]: AUCTIONS_P1,
    [`${BASE}/api/auctions/168337/items?page=1&per_page=100`]: ITEMS_P9,
  });
  const res = await runBidwrangler(makeCtx(fetch), { ...noWait, maxBytes: 10 });
  // Tjoflat closes today and is always attempted; the two later sales wait.
  assert.equal(res.lots.length, 1);
  assert.ok(res.warnings.some((w) => /left 2 in-scope auction\(s\) for a later run/.test(w)));
  assert.equal(calls.filter((u) => u.includes('/items')).length, 1);
  assert.equal(res.completeSnapshot, false);
});

test('run(): HTTP 429 surfaces as a rate-limit error for the worker', async () => {
  const fetch: Fetcher = async () => ({ status: 429, headers: {}, text: '' });
  await assert.rejects(() => runBidwrangler(makeCtx(fetch), noWait), /rate limit/);
});

test('run(): requests are spaced by the configured interval', async () => {
  const { fetch } = routes({
    [`${BASE}/api/auctions?page=1`]: AUCTIONS_P1,
    [`${BASE}/api/auctions/169893/items?page=1&per_page=100`]: '{"total":0,"items":[]}',
    [`${BASE}/api/auctions/156558/items?page=1&per_page=100`]: '{"total":0,"items":[]}',
  });
  const waits: number[] = [];
  const res = await runBidwrangler(makeCtx(fetch), {
    minIntervalMs: 3000,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(res.stats.httpRequests, 3);
  assert.equal(waits.length, 2); // before the 2nd and 3rd request
  assert.ok(waits.every((ms) => ms > 2000 && ms <= 3000));
  assert.equal(res.completeSnapshot, true); // both in-scope sales fully read (0 published lots each)
});

test('adapter key is the sources.platform value', () => {
  assert.equal(bidwranglerAdapter.key, 'bidwrangler');
  assert.equal(bidwranglerAdapter.method, 'internal_json');
});
