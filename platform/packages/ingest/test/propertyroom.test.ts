/**
 * PropertyRoom adapter tests.
 *
 * Every fixture is a byte-exact excerpt of a live page captured on 2026-09-30
 * through public.inspect_url (our crawler, Supabase egress), checked by MD5
 * against the stored response before it was saved. Line endings are the site's
 * own LF.
 *
 *   propertyroom-police-page1-tail-2026-09-30.html
 *     GET https://www.propertyroom.com/police-auctions?sort=closingsoon&page=1
 *     (151,316 bytes, 40 cards). Excerpt: the last five cards and the pager, whose
 *     "»" links to page 2 and whose last numbered page is 33.
 *   propertyroom-police-page33-tail-2026-09-30.html
 *     ...police-auctions?sort=closingsoon&page=33 (109,944 bytes, 26 cards).
 *     Excerpt: the last card (a pickup-only vehicle) and the pager, whose "»" is
 *     disabled: the end of the list.
 *   propertyroom-police-vehicles-2026-09-30.html
 *     ...police-auctions/vehicles (158,137 bytes, 32 cards, a single page).
 *     Excerpt: two BidToBeApproved vehicles with 22 and 52 bids.
 *   propertyroom-all-closingsoon-2026-09-30.html
 *     ...c/all?sort=closingsoon (118,569 bytes). Excerpt: eleven consecutive
 *     cards, including two FixedPrice listings marked Free Shipping. /c/all is not
 *     crawled (it is mostly ShopKeeper resellers); it is here because it holds the
 *     FixedPrice and tab-entity cases the police excerpts lack.
 *
 * The fixtures were read with ?sort=closingsoon. Since PropertyRoom's robots.txt
 * of 2026-10-01 disallows sort=, the adapter asks for ?page=N, which serves the
 * same soonest-closing order with the same card markup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parsePrCards,
  parsePrPager,
  parsePrLocation,
  parsePrEnd,
  normalizePrCard,
  planRotatingPages,
  pagesPerRun,
  prListUrl,
  scopeStates,
  spacingMs,
  runPropertyRoom,
  propertyroomAdapter,
  PR_BASE,
} from '../src/adapters/propertyroom.ts';
import { gateFetcher } from '../src/gate.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const PAGE1 = fixture('propertyroom-police-page1-tail-2026-09-30.html');
const PAGE33 = fixture('propertyroom-police-page33-tail-2026-09-30.html');
const VEHICLES = fixture('propertyroom-police-vehicles-2026-09-30.html');
const ALL = fixture('propertyroom-all-closingsoon-2026-09-30.html');

/** Roughly when the pages were captured. */
const NOW = new Date('2026-09-30T16:05:00Z');

const byId = (html: string) => {
  const { cards } = parsePrCards(html);
  return (id: string) => normalizePrCard(cards.find((c) => c.listingId === id)!, NOW);
};

// ------------------------------------------------------------------ titles

test('titles: entities decoded, a leading tab entity trimmed', () => {
  const { cards, found, warnings } = parsePrCards(ALL);
  assert.equal(found, 11);
  assert.equal(cards.length, 11);
  assert.deepEqual(warnings, []);
  const titles = new Map(cards.map((c) => [c.listingId, c.title]));
  assert.equal(titles.get('18961593'), '2026 Canada 10 Cents Dime W Mint Mark Winnipeg Collector Coin Bluenose');
  assert.equal(titles.get('18970440'), '6.00ctw Mystic Topaz & White Sapphire Ring sz 6');
  assert.equal(titles.get('18961596'), 'Lot of 11 U.S. Half Dollars – 10 Franklin Halves + 2011 Kennedy Half Dollar');
  assert.equal(titles.get('18955432'), "Versace Women's Fragrances Red Jeans Eau De Toilette Spray 75 Ml");
});

test('the listing id is the key: two cards with the same slug stay two lots', () => {
  const ids = parsePrCards(ALL).cards
    .filter((c) => c.slug === '2026-canada-5-cents-nickel-w-mint-mark-winnipeg-50th-anniversary-beaver-bu2026-c')
    .map((c) => c.listingId);
  assert.deepEqual(ids, ['18961594', '18961595']);
});

// ------------------------------------------------------------------ prices

test('prices in cents: a price with bids is the current bid', () => {
  const lot = byId(PAGE1)('18963000').lot; // Breville espresso machine, 46 bids
  assert.equal(lot.currentBidCents, 26301);
  assert.equal(lot.bidCount, 46);
  assert.equal(lot.startingBidCents, null);
  assert.equal(lot.nextBidCents, null, 'the increment table is not published; no guess');

  const car = byId(VEHICLES)('18939720').lot; // "$5,350.00", 22 bids
  assert.equal(car.currentBidCents, 535000);
  assert.equal(car.bidCount, 22);
  assert.equal(byId(VEHICLES)('18928735').lot.currentBidCents, 315000);
});

test('prices in cents: with no bids the price is the opening bid, not a current bid', () => {
  const belt = byId(ALL)('18946258').lot; // "$1,992.87", 0 bids
  assert.equal(belt.currentBidCents, null, '"no bids" and "$0" are different facts');
  assert.equal(belt.startingBidCents, 199287);
  assert.equal(belt.nextBidCents, 199287);
  assert.equal(belt.bidCount, 0);
});

test('prices in cents: "1 bid", singular, still counts', () => {
  const bow = byId(PAGE1)('18963065').lot; // PSE Archery Camo Bow, "$1.00", "1 bid"
  assert.equal(bow.bidCount, 1);
  assert.equal(bow.currentBidCents, 100);
});

test('FixedPrice listings: a buy-now price, no bidding, format fixed_price', () => {
  const { auction, lot } = byId(ALL)('18955432');
  assert.equal(auction.format, 'fixed_price');
  assert.equal(lot.bidCount, null);
  assert.equal(lot.currentBidCents, null);
  assert.equal(lot.startingBidCents, null);
  assert.equal(lot.nextBidCents, 2899);
  assert.equal((lot.raw as any)._meta.buyNowCents, 2899);
  assert.equal((lot.raw as any)._meta.freeShipping, true);
  assert.match(auction.shipsNote ?? '', /Free Shipping/);
});

test('BidToBeApproved is flagged: the seller approves the winning bid', () => {
  const { auction, lot } = byId(VEHICLES)('18939720');
  assert.equal(auction.format, 'online');
  assert.equal((lot.raw as any)._meta.bidNeedsApproval, true);
  assert.equal(lot.reserveMet, null);
});

// ------------------------------------------------------------------ close times

test('close times: the card’s UTC data-end, seven fractional digits and all', () => {
  assert.equal(byId(PAGE1)('18963065').lot.closesAt, '2026-09-30T22:09:00.000Z');
  assert.equal(byId(PAGE33)('18960052').lot.closesAt, '2026-10-07T21:26:00.000Z');
  assert.equal(byId(ALL)('18955432').lot.closesAt, '2026-09-30T16:31:59.000Z');
  assert.equal(byId(PAGE1)('18963065').auction.timezone, 'America/New_York');

  assert.equal(parsePrEnd('2026-09-30T16:15:00.0000000Z'), '2026-09-30T16:15:00.000Z');
  assert.equal(parsePrEnd('2026-09-30T11:15:00-05:00'), '2026-09-30T16:15:00.000Z');
  assert.equal(parsePrEnd('2026-02-30T16:15:00Z'), null);
  assert.equal(parsePrEnd('6h 2m'), null);
  assert.equal(parsePrEnd(null), null);
});

test('closed is derived from the close time against the injected clock', () => {
  const { cards } = parsePrCards(ALL);
  const dime = cards.find((c) => c.listingId === '18961593')!; // closes 16:15Z
  assert.equal(normalizePrCard(dime, new Date('2026-09-30T16:00:00Z')).lot.closed, false);
  assert.equal(normalizePrCard(dime, new Date('2026-09-30T16:15:00Z')).lot.closed, true);
});

// ------------------------------------------------------------------ location

test('pickup city, state and ZIP come from a location the title declares', () => {
  const { auction, lot } = byId(VEHICLES)('18939720'); // "2019 Chevrolet Cruze LS (Hartford, CT 06114)"
  assert.deepEqual(lot.pickup, { line1: null, city: 'Hartford', state: 'CT', postalCode: '06114', ambiguous: false });
  assert.equal(lot.ships, false);
  assert.equal(auction.pickupRequired, true);
  assert.equal((lot.raw as any)._meta.locationSource, 'title');
});

test('an item with no declared location ships, and no location is invented', () => {
  const { auction, lot } = byId(PAGE1)('18963214'); // "Mixed Watches, 5 Watches"
  assert.equal(lot.pickup, null);
  assert.equal(lot.ships, true);
  assert.equal(auction.pickupRequired, false);
  assert.equal(auction.sellerState, null, 'cards publish no agency or agency state');

  assert.equal(parsePrLocation('Mixed Watches, 5 Watches'), null);
  assert.equal(parsePrLocation('Lamp (Springfield, ZZ 12345)'), null, 'not a state code');
  assert.deepEqual(parsePrLocation('2015 Ford Explorer (Staten Island, NY 10309)')?.city, 'Staten Island');
});

// ------------------------------------------------------------------ links and images

test('deep links are absolute listing URLs', () => {
  const { auction, lot } = byId(PAGE1)('18963065');
  assert.equal(lot.url, 'https://www.propertyroom.com/l/pse-archery-camo-bow/18963065');
  assert.equal(auction.url, lot.url);
  assert.equal(lot.auctionExternalId, '18963065');
});

test('images: every full-size photo in the site’s order', () => {
  const savana = byId(PAGE33)('18960052').lot;
  assert.equal(savana.images.length, 20);
  assert.equal(
    savana.images[0].url,
    'https://content.propertyroom.com/listings/sellers/seller1/images/origimgs/2019-gmc-savana-hartford-ct-06114-1_229202610311433219621.jpg',
  );
  assert.deepEqual(savana.images.map((i) => i.position), [...Array(20).keys()]);
  assert.equal((savana.raw as any)._meta.sellerCode, 'seller1');

  const belt = byId(ALL)('18946258').lot;
  assert.deepEqual(belt.images.map((i) => i.url), [
    'https://content.propertyroom.com/listings/sellers/seller888889006/images/origimgs/888889006_1392026233933819618.webp',
    'https://content.propertyroom.com/listings/sellers/seller888889006/images/origimgs/888889006_1392026233925534618.webp',
  ]);
});

// ------------------------------------------------------------------ pagination

test('pagination: page 1 links to page 2 and knows the last page is 33', () => {
  assert.deepEqual(parsePrPager(PAGE1), { present: true, current: 1, maxPage: 33, nextPage: 2, hasNext: true });
});

test('termination: on page 33 "next" is disabled', () => {
  assert.deepEqual(parsePrPager(PAGE33), { present: true, current: 33, maxPage: 33, nextPage: null, hasNext: false });
  // A single-page list has no pager at all.
  assert.deepEqual(parsePrPager(VEHICLES), { present: false, current: null, maxPage: null, nextPage: null, hasNext: null });
});

test('page planning: sweep when it fits, rotate through the rest when it does not', () => {
  assert.equal(pagesPerRun(100_000, spacingMs(10)), 14);
  assert.equal(pagesPerRun(90_000, spacingMs(10)), 13, 'the default budget at 10 requests/minute');
  assert.equal(pagesPerRun(90_000, spacingMs(20)), 21);
  assert.deepEqual(planRotatingPages(5, 14, 0), [2, 3, 4, 5]);
  assert.deepEqual(planRotatingPages(1, 14, 0), []);

  // 33 pages, 14 per run: pages 2-7 always, plus 7 of pages 8-33 by slot.
  const seen = new Set<number>();
  for (let slot = 0; slot < 4; slot++) {
    const plan = planRotatingPages(33, 14, slot);
    assert.equal(plan.length, 13);
    assert.deepEqual(plan.slice(0, 6), [2, 3, 4, 5, 6, 7]);
    for (const p of plan) seen.add(p);
  }
  assert.equal(seen.size, 32, 'four consecutive runs cover pages 2..33');
});

// ------------------------------------------------------------------ malformed input

test('malformed input yields warnings, never a throw', () => {
  assert.deepEqual(parsePrCards('').cards, []);
  assert.equal(parsePrCards(undefined as unknown as string).warnings.length, 1);
  assert.deepEqual(parsePrPager('<div>no pager</div>').present, false);

  const broken = PAGE1
    .replace('data-listing-id="18963085"', 'data-listing-id=""') // no id: skipped
    .replace('data-end="2026-09-30T22:09:00.0000000Z"', 'data-end="soon"') // bad close: kept, null
    .replace('<span class="listing-price">$7.00</span>', '<span class="listing-price">Call</span>') // bad price
    .replace(/data-photos='\["https:\/\/content\.propertyroom\.com\/listings\/sellers\/seller1\/images\/origimgs\/cisno[^']*'/, "data-photos='[\"https://x\", '");
  const { cards, found, warnings } = parsePrCards(broken);
  assert.equal(found, 5);
  assert.equal(cards.length, 4);
  const text = warnings.join(' ');
  assert.match(text, /Skipped 1 of 5/);
  assert.match(text, /1 listing\(s\) had no parseable close time/);
  assert.match(text, /1 listing\(s\) had no parseable price/);
  assert.match(text, /unreadable data-photos/);

  const bow = cards.find((c) => c.listingId === '18963065')!;
  assert.equal(bow.closesAt, null);
  const flashlight = cards.find((c) => c.listingId === '18962995')!;
  assert.deepEqual(flashlight.photos, [], 'broken JSON is not half-read');
  assert.equal(
    normalizePrCard(flashlight, NOW).lot.images[0].url,
    'https://content.propertyroom.com/listings/sellers/seller1/images/ttlimgs/cisno-flashlight-with-mount--1_24920262033405450369.jpg',
  );

  // A page cut off mid-card keeps the complete cards before it.
  const cut = parsePrCards(PAGE1.slice(0, PAGE1.indexOf('Cisno Flashlight With Mount</div>')));
  assert.deepEqual(cut.cards.map((c) => c.listingId), ['18963065', '18963085', '18963214']);
});

// ------------------------------------------------------------------ run()

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'src-pr',
    slug: 'propertyroom',
    name: 'PropertyRoom',
    url: 'https://www.propertyroom.com',
    apiBase: null,
    tier: 'municipal',
    ingest: 'html',
    platform: 'propertyroom',
    states: ['WI'],
    rateLimitRpm: 10,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 60,
    consecutiveFailures: 0,
    ...over,
  };
}

function harness(pages: Record<number, { status: number; text: string }>, over: Partial<SourceConfig> = {}, clock?: () => Date) {
  const calls: string[] = [];
  const fetch: Fetcher = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const r = pages[page];
    return r ? { status: r.status, headers: {}, text: r.text } : { status: 404, headers: {}, text: 'Not Found' };
  };
  const ctx: AdapterContext = {
    source: source(over),
    fetch,
    now: clock ?? (() => NOW),
    log: () => {},
    secrets: {},
  };
  return { ctx, calls };
}

/**
 * Orchestration scaffolding, not listing data: the real cards from a fixture,
 * followed by a pager in the real markup's classes and attributes, renumbered to
 * say "page n of max". Only run() tests use it, to simulate catalogue lengths the
 * captured pages do not have; every parser test above reads the real pagers.
 */
function withPager(cardsHtml: string, n: number, max: number): string {
  const next = n < max
    ? `<a class="page-btn" href="/police-auctions?page=${n + 1}" data-page="${n + 1}">&raquo;</a>`
    : '<span class="page-btn disabled">&raquo;</span>';
  return `${cardsHtml}            </div>\n\n            <div class="pagination">\n` +
    `                <span class="page-btn active">${n}</span>\n` +
    `                <a class="page-btn" href="/police-auctions?page=${max}" data-page="${max}">${max}</a>\n` +
    `        ${next}\n</div>\n`;
}

const PAGE1_CARDS = PAGE1.slice(0, PAGE1.indexOf('            </div>\n\n            <div class="pagination">'));

test('run(): a sweep ends only on the page the site marks last: complete snapshot', async () => {
  const sleeps: number[] = [];
  const pages: Record<number, { status: number; text: string }> = {};
  for (let p = 1; p <= 32; p++) pages[p] = { status: 200, text: withPager(PAGE1_CARDS, p, 33) };
  pages[33] = { status: 200, text: PAGE33 }; // the real last page: "next" disabled
  const { ctx, calls } = harness(pages);
  // A budget that fits 33 pages at 10 requests/minute puts the run in sweep mode.
  const res = await runPropertyRoom(ctx, { budgetMs: 300_000, sleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(calls.length, 33);
  assert.equal(calls[0], 'https://www.propertyroom.com/police-auctions?page=1');
  assert.equal(calls[32], 'https://www.propertyroom.com/police-auctions?page=33');
  assert.ok(sleeps.every((ms) => ms === 6000), '10 requests/minute');
  assert.equal(sleeps.length, 32);
  assert.equal(res.completeSnapshot, true);
  assert.deepEqual(res.warnings, []);
  // Five police items, repeated on every page, are five lots. The Hartford, CT van
  // on page 33 is pickup-only outside the WI scope and is dropped.
  assert.deepEqual(res.lots.map((l) => l.externalId).sort(), ['18962995', '18963000', '18963065', '18963085', '18963214']);
  assert.equal(res.auctions.length, 5);
  assert.equal(res.stats.httpRequests, 33);
});

test('run(): a single-page list with no pager is complete after one request', async () => {
  const { ctx, calls } = harness({ 1: { status: 200, text: VEHICLES } }, { states: ['WI', 'CT'] });
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.equal(calls.length, 1);
  assert.equal(res.completeSnapshot, true);
  assert.deepEqual(res.lots.map((l) => l.pickup?.state), ['CT', 'CT']);
});

test('run(): pickup-only lots outside the configured states are dropped; shipped lots stay', async () => {
  const { ctx } = harness({
    1: { status: 200, text: withPager(PAGE1_CARDS, 1, 2) },
    2: { status: 200, text: withPager(VEHICLES, 2, 2) },
  }); // states: ['WI']
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  // The five shipped police items stay; both Hartford, CT cars go.
  assert.deepEqual(res.lots.map((l) => l.externalId).sort(), ['18962995', '18963000', '18963065', '18963085', '18963214']);
  assert.ok(res.lots.every((l) => l.ships === true));
  assert.equal(res.completeSnapshot, true);
});

test('run(): a middle page with no pager, or the wrong page, is never a complete snapshot', async () => {
  const noPager = harness({
    1: { status: 200, text: withPager(PAGE1_CARDS, 1, 3) },
    2: { status: 200, text: VEHICLES },
  }, { states: ['WI', 'CT'] });
  const a = await runPropertyRoom(noPager.ctx, { sleep: async () => {} });
  assert.equal(a.completeSnapshot, false);
  assert.match(a.warnings.join(' '), /did not say whether more pages follow/);

  const wrongPage = harness({
    1: { status: 200, text: withPager(PAGE1_CARDS, 1, 3) },
    2: { status: 200, text: withPager(PAGE1_CARDS, 1, 3) }, // page=2 ignored: page 1 again
  });
  const b = await runPropertyRoom(wrongPage.ctx, { sleep: async () => {} });
  assert.equal(b.completeSnapshot, false);
  assert.equal(wrongPage.calls.length, 2, 'no loop');
  assert.match(b.warnings.join(' '), /Asked for page 2 and got page 1/);

  // A FULL first page with no readable pager is not taken for a one-page list.
  const full = harness({ 1: { status: 200, text: ALL.repeat(4) } }); // 44 real cards, no pager
  const c = await runPropertyRoom(full.ctx, { sleep: async () => {} });
  assert.equal(c.completeSnapshot, false);
  assert.match(c.warnings.join(' '), /Page 1 did not say whether more pages follow/);
});

test('run(): a catalogue too big for one run rotates, and is never a complete snapshot', async () => {
  const pages: Record<number, { status: number; text: string }> = {};
  for (let p = 1; p <= 33; p++) pages[p] = { status: 200, text: withPager(PAGE1_CARDS, p, 33) };
  const { ctx, calls } = harness(pages);
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.equal(calls.length, 13, 'page 1, pages 2-7, and a rotating window of 6');
  assert.equal(res.completeSnapshot, false);
  assert.equal(res.lots.length, 5, 'the same five listings on every page are deduplicated');
});

test('run(): the time budget stops a run early with a warning', async () => {
  let t = NOW.getTime();
  const clock = () => new Date((t += 20_000)); // every read of the clock moves 20 s on
  const pages: Record<number, { status: number; text: string }> = {};
  for (let p = 1; p <= 5; p++) pages[p] = { status: 200, text: withPager(PAGE1_CARDS, p, 5) };
  const { ctx, calls } = harness(pages, {}, clock);
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.ok(calls.length < 5);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /time budget/);
});

test('run(): page 1 failing fails the run; a later page failing is a warning and no snapshot', async () => {
  await assert.rejects(runPropertyRoom(harness({ 1: { status: 429, text: 'Too Many Requests' } }).ctx, { sleep: async () => {} }), /HTTP 429/);

  const { ctx } = harness({
    1: { status: 200, text: withPager(PAGE1_CARDS, 1, 3) },
    2: { status: 500, text: 'Server Error' },
  });
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.equal(res.lots.length, 5);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /page 2: HTTP 500/);
});

/** What the crawl gate throws when it will not make a request (gate.ts). */
function refusal(reason: 'robots' | 'blocked' | 'budget'): Error {
  const e = new Error(`gate refused: ${reason}`);
  e.name = 'CrawlRefused';
  (e as any).reason = reason;
  return e;
}

test('run(): the gate running out of budget mid-run keeps the pages fetched, with no snapshot', async () => {
  const { ctx } = harness({ 1: { status: 200, text: withPager(PAGE1_CARDS, 1, 3) } });
  const inner = ctx.fetch;
  ctx.fetch = async (url, init) => {
    if (url.endsWith('page=2')) throw refusal('budget');
    return inner(url, init);
  };
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.equal(res.lots.length, 5);
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /budget ran out before page 2/);
});

test('run(): a gate refusal for robots or bot protection fails the run', async () => {
  for (const reason of ['blocked', 'robots'] as const) {
    const { ctx } = harness({ 1: { status: 200, text: withPager(PAGE1_CARDS, 1, 3) } });
    const inner = ctx.fetch;
    ctx.fetch = async (url, init) => {
      if (url.endsWith('page=2')) throw refusal(reason);
      return inner(url, init);
    };
    await assert.rejects(runPropertyRoom(ctx, { sleep: async () => {} }), new RegExp(`gate refused: ${reason}`));
  }
  // Out of budget before page 1 there is nothing to report: the run fails.
  const { ctx } = harness({});
  ctx.fetch = async () => { throw refusal('budget'); };
  await assert.rejects(runPropertyRoom(ctx, { sleep: async () => {} }), /gate refused: budget/);
});

test('run(): a challenge page is a block, reported and not retried', async () => {
  const { ctx, calls } = harness({ 1: { status: 405, text: '<title>Human Verification</title>' } });
  await assert.rejects(runPropertyRoom(ctx, { sleep: async () => {} }), /HTTP 405/);
  assert.equal(calls.length, 1);
});

test('run(): an empty first page is flagged and never a complete snapshot', async () => {
  const { ctx } = harness({ 1: { status: 200, text: '<div class="listing-grid"></div>' } });
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.equal(res.completeSnapshot, false);
  assert.match(res.warnings.join(' '), /no listing cards/);
});

/** www.propertyroom.com/robots.txt exactly as fetched on 2026-09-30 (119 bytes). */
const PR_ROBOTS = '# Global robots.txt as of 2022-04-17\r\n\r\nUser-agent: *\r\nDisallow: /account/\r\nDisallow: /watchlist/\r\nDisallow: /activity/';

test('run() behind the real crawl gate: robots allows the list, fixtures pass block detection', async () => {
  const served: string[] = [];
  const gated = gateFetcher({
    rawFetch: async (url) => {
      served.push(url);
      if (url === 'https://www.propertyroom.com/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, text: PR_ROBOTS };
      const page = Number(new URL(url).searchParams.get('page'));
      const text = page === 1 ? withPager(PAGE1_CARDS, 1, 2) : PAGE33.replace('<span class="page-btn active">33</span>', '<span class="page-btn active">2</span>');
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text };
    },
    rateLimitRpm: 10,
    sleep: async () => {},
    now: () => NOW.getTime(),
  });
  const { ctx } = harness({});
  ctx.fetch = gated;
  const res = await runPropertyRoom(ctx, { sleep: async () => {} });
  assert.deepEqual(served, [
    'https://www.propertyroom.com/robots.txt',
    'https://www.propertyroom.com/police-auctions?page=1',
    'https://www.propertyroom.com/police-auctions?page=2',
  ]);
  assert.deepEqual(gated.stats().refusals, []);
  assert.equal(res.lots.length, 5);
  assert.equal(res.completeSnapshot, true);
});

test('adapter identity, URL shape and scope defaults', () => {
  assert.equal(propertyroomAdapter.key, 'propertyroom');
  assert.equal(propertyroomAdapter.method, 'html');
  assert.equal(prListUrl(PR_BASE, 7), 'https://www.propertyroom.com/police-auctions?page=7');
  // robots.txt as of 2026-10-01 disallows "/*?*sort=": the list URL must never carry it.
  assert.ok(!/[?&]sort=/.test(prListUrl(PR_BASE, 1)));
  assert.deepEqual(scopeStates({ states: null }), ['WI']);
});
