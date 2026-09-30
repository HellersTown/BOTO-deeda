/**
 * Wisconsin Surplus (Maxanet) adapter tests.
 *
 * Every fixture is a byte-exact excerpt of a live response captured on
 * 2026-09-30 through public.inspect_url (our crawler, Supabase egress), with its
 * CRLF line endings intact. Each excerpt was checked by MD5 against the stored
 * response before it was saved.
 *
 *   wisconsin-surplus-current-head-2026-09-30.html
 *     GET https://bid.wisconsinsurplus.com/Public/Auction/GetAuctions
 *         ?filter=Current&pageSize=1000&pageNumber=1   (X-Requested-With: XMLHttpRequest)
 *     827,606-byte fragment, 91 cards. Excerpt: the list wrapper and the first two
 *     cards (#26-1355 General Public, #26-771B Waushara County). 18,491 bytes.
 *   wisconsin-surplus-current-tail-2026-09-30.html
 *     The same request a minute later (827,367 bytes). Excerpt: the last card
 *     (#26-1418 City of Platteville) through the pager script, including the
 *     server clock (nowDate) and the disabled "next" button. 10,319 bytes.
 *   wisconsin-surplus-future-head-2026-09-30.html
 *     ...GetAuctions?filter=Future&pageSize=1000&pageNumber=1 (60,297 bytes, 5 cards).
 *     Excerpt: the wrapper and the first card (#26-1403 Village of French Island).
 *
 * No lot-level fixture exists: the item endpoint returns an empty fragment to an
 * anonymous client, and this adapter does not fetch lots (see the adapter header).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseWsAuctionList,
  parseWsCard,
  splitWsCards,
  parseWsTitle,
  parseWsFragmentMeta,
  parseMaxanetDate,
  parseMaxanetNow,
  checkServerClock,
  isUsDaylightTime,
  decodeEntities,
  scopeStates,
  spacingMs,
  wsListUrl,
  runWisconsinSurplus,
  wisconsinSurplusAdapter,
  WS_BASE,
} from '../src/adapters/wisconsin-surplus.ts';
import { gateFetcher } from '../src/gate.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');
const HEAD = fixture('wisconsin-surplus-current-head-2026-09-30.html');
const TAIL = fixture('wisconsin-surplus-current-tail-2026-09-30.html');
const FUTURE = fixture('wisconsin-surplus-future-head-2026-09-30.html');

/** The instant the tail fixture was captured: its nowDate read 11:08:38 AM CDT. */
const CAPTURED_AT = new Date('2026-09-30T16:08:38Z');

// ------------------------------------------------------------------ fixtures are real

test('fixtures keep the live CRLF line endings the Maxanet server sends', () => {
  for (const f of [HEAD, TAIL, FUTURE]) {
    assert.ok(f.includes('\r\n'));
    assert.equal(f.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  }
});

// ------------------------------------------------------------------ titles

test('titles: sale number, seller and location are split, status notes are dropped', () => {
  const t = parseWsTitle(
    '#26-771B - Waushara County Emergency Management - Wautoma, WI - AUCTION ENDING SOON - STARTING AT 10:20 AM CDT',
  );
  assert.equal(t.auctionNumber, '26-771B');
  assert.deepEqual(t.location, { city: 'Wautoma', state: 'WI' });
  assert.equal(t.lead, 'Waushara County Emergency Management');
  assert.deepEqual(t.notes, ['AUCTION ENDING SOON', 'STARTING AT 10:20 AM CDT']);
  // A title that changed every time a sale entered its closing hour would churn.
  assert.equal(t.displayTitle, '#26-771B - Waushara County Emergency Management - Wautoma, WI');
});

test('titles: an undashed sale number and a spelled-out state are handled', () => {
  const t = parseWsTitle('#26-1418 - City of Platteville, Wisconsin - Surplus Real Estate');
  assert.equal(t.auctionNumber, '26-1418');
  assert.equal(t.location, null, '"Wisconsin" belongs to the seller name, not a City, ST segment');
  assert.equal(t.lead, 'City of Platteville, Wisconsin');
  assert.equal(t.leadState, 'WI');

  assert.equal(parseWsTitle('#211025 - Wisconsin Department of Revenue').auctionNumber, '211025');
  // A two-letter tail that is not a state is not a location.
  assert.equal(parseWsTitle('#26-1 - Surplus - Springfield, ZZ').location, null);
});

test('parses the real current-list cards: titles and ids', () => {
  const { auctions, cardCount, warnings } = parseWsAuctionList(HEAD);
  assert.equal(cardCount, 2);
  assert.deepEqual(warnings, []);
  assert.deepEqual(auctions.map((a) => a.externalId), ['128265', '128274']);
  assert.equal(auctions[0].title, '#26-1355 - September General Public Equipment Auction - Mount Horeb, WI');
  assert.equal(auctions[1].title, '#26-771B - Waushara County Emergency Management - Wautoma, WI');
  assert.equal(auctions[0].description?.startsWith('126 Lots (2 Pages of Inventory) Including: Trailers'), true);
  assert.equal(auctions[1].description, "2020 Hawk 36' Triple Axle Enclosed Mobile Command Trailer");
  assert.equal(auctions[0].lotCount, 126);
  assert.equal(auctions[1].lotCount, 2);
  assert.equal(auctions[0].format, 'online');
  assert.equal(auctions[0].auctioneer, 'Wisconsin Surplus Online Auction');
});

// ------------------------------------------------------------------ times

test('close times carry an explicit Central offset, and DST ends between Oct and Nov', () => {
  const head = parseWsAuctionList(HEAD).auctions;
  assert.equal(head[0].startsAt, '2026-09-16T08:00:00-05:00');
  assert.equal(head[0].endsAt, '2026-09-30T10:00:00-05:00');
  assert.equal(head[1].endsAt, '2026-09-30T10:20:00-05:00');
  assert.equal(head[0].timezone, 'America/Chicago');

  // The title says "STARTING AT 10:20 AM CDT": the same instant.
  assert.equal(Date.parse(head[1].endsAt!), Date.parse('2026-09-30T15:20:00Z'));

  // Platteville closes Nov 2, the day after DST ends: CST, -06:00.
  const [platteville] = parseWsAuctionList(TAIL).auctions;
  assert.equal(platteville.startsAt, '2026-09-29T17:00:00-05:00');
  assert.equal(platteville.endsAt, '2026-11-02T10:00:00-06:00');
});

test('Maxanet dates: 24-hour wall clock in, ISO with offset out, garbage refused', () => {
  assert.equal(parseMaxanetDate('10/15/2026 10:00:00'), '2026-10-15T10:00:00-05:00');
  assert.equal(parseMaxanetDate('01/05/2027 09:30:00'), '2027-01-05T09:30:00-06:00');
  assert.equal(parseMaxanetDate('02/30/2026 10:00:00'), null);
  assert.equal(parseMaxanetDate('13/01/2026 10:00:00'), null);
  assert.equal(parseMaxanetDate('09/30/2026 25:00:00'), null);
  assert.equal(parseMaxanetDate('Sep 30, 2026 10:00 AM'), null);
  assert.equal(parseMaxanetDate(''), null);
  assert.equal(parseMaxanetDate(null), null);
});

test('US daylight time switches at 02:00 local on the 2026 transition days', () => {
  assert.equal(isUsDaylightTime(2026, 3, 8, 1), false);
  assert.equal(isUsDaylightTime(2026, 3, 8, 2), true);
  assert.equal(isUsDaylightTime(2026, 11, 1, 1), true);
  assert.equal(isUsDaylightTime(2026, 11, 1, 2), false);
  assert.equal(isUsDaylightTime(2026, 7, 4, 12), true);
  assert.equal(isUsDaylightTime(2026, 12, 25, 12), false);
});

test('the server clock proves the zone: nowDate read as Central equals the capture instant', () => {
  const meta = parseWsFragmentMeta(TAIL);
  assert.equal(meta.serverNow, '2026-09-30 11:08:38 AM');
  assert.equal(parseMaxanetNow(meta.serverNow), CAPTURED_AT.getTime());
  assert.equal(checkServerClock(meta.serverNow, CAPTURED_AT), null);
  // Had the tenant been on Eastern time, every close would be an hour off. Loud, not silent.
  const warning = checkServerClock(meta.serverNow, new Date('2026-09-30T15:08:38Z'));
  assert.match(warning ?? '', /60 min/);
  assert.equal(parseMaxanetNow('2026-09-30 12:00:00 PM'), Date.parse('2026-09-30T12:00:00-05:00'));
  assert.equal(parseMaxanetNow('2026-09-30 12:00:00 AM'), Date.parse('2026-09-30T00:00:00-05:00'));
});

// ------------------------------------------------------------------ location and seller

test('pickup city and state come only from a City, ST segment the title declares', () => {
  const head = parseWsAuctionList(HEAD).auctions;
  assert.deepEqual(head[0].pickup, { line1: null, city: 'Mount Horeb', state: 'WI', postalCode: null, ambiguous: false });
  assert.equal(head[1].pickup?.city, 'Wautoma');
  assert.equal(head[1].pickup?.state, 'WI');

  const [future] = parseWsAuctionList(FUTURE).auctions;
  assert.equal(future.pickup?.city, 'La Crosse');
  assert.equal(future.pickup?.state, 'WI');

  // Platteville's title names no City, ST segment. Its description does ("60 Ellen
  // St, Platteville, WI") but the adapter does not mine prose for a pickup.
  const [platteville] = parseWsAuctionList(TAIL).auctions;
  assert.equal(platteville.pickup, null);
});

test('the seller agency is carried; a General Public consignment sale has none', () => {
  const head = parseWsAuctionList(HEAD).auctions;
  assert.equal(head[0].sellerName, null, 'General Public: the segment is a sale name');
  assert.equal(head[1].sellerName, 'Waushara County Emergency Management');
  assert.equal(head[1].sellerState, null, 'no state in the seller name, and none is guessed');

  const [platteville] = parseWsAuctionList(TAIL).auctions;
  assert.equal(platteville.sellerName, 'City of Platteville, Wisconsin');
  assert.equal(platteville.sellerState, 'WI');
  assert.deepEqual((platteville.raw as any).categories, ['Municipal', 'Real Estate']);

  const [future] = parseWsAuctionList(FUTURE).auctions;
  assert.equal(future.sellerName, 'Village of French Island');
  assert.equal((future.raw as any)._meta.tense, 'future');
});

// ------------------------------------------------------------------ links and images

test('deep links are absolute, entity-decoded, and keep every query parameter', () => {
  const [first] = parseWsAuctionList(HEAD).auctions;
  assert.equal(
    first.url,
    'https://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyRMQmDiKaVx0BfcfbgCUQ%3d%3d' +
      '&pageNumber=pf6Q%2bhJtdeleDd9FfYpy9w%3d%3d&pagesize=b%2fjFUIqShXYgzmUM0U4trw%3d%3d' +
      '&filter=ITUHdU2DoqWvw89vAOs0Dw%3d%3d',
  );
  const raw = first.raw as any;
  assert.match(raw.itemsUrl, /^https:\/\/bid\.wisconsinsurplus\.com\/Public\/Auction\/AuctionItems\?AuctionId=HyRMQmDiKaVx0BfcfbgCUQ%3d%3d&Title=/);
  assert.ok(raw.itemsUrl.includes('&totalItems=6vmgf8pwkmTIXn2OcURWDg%3d%3d'));
  assert.equal(raw.itemsUrl.includes('&amp;'), false);
  assert.equal(
    raw.shareUrl,
    'http://bid.wisconsinsurplus.com/Public/Auction/AuctionDetails?AuctionId=HyRMQmDiKaVx0BfcfbgCUQ%3d%3d' +
      '&pageNumber=WddRnDis30ojx01x46RicQ%3d%3d&pagesize=WddRnDis30ojx01x46RicQ%3d%3d&filter=ITUHdU2DoqWvw89vAOs0Dw%3d%3d',
  );
});

test('images: the full-size S3 photo and its 350x350 thumbnail', () => {
  const [first, second] = parseWsAuctionList(HEAD).auctions;
  assert.equal(
    (first.raw as any).imageUrl,
    'https://s3.amazonaws.com/prod.maxanet.auction/Wis571/Inventory128265/GenOn-1086514e-fc71-4fb7-8530-92e1108d7db3.jpg',
  );
  assert.equal(
    (first.raw as any).thumbnailUrl,
    'https://s3.amazonaws.com/prod.maxanet.auction/Wis571/Inventory128265/GenOn-1086514e-fc71-4fb7-8530-92e1108d7db3-350x350.jpg',
  );
  // The numeric id is also the S3 folder, which is what makes it a stable key.
  assert.ok((second.raw as any).imageUrl.includes('/Inventory128274/'));
});

test('prices: the auction list publishes none, so no money field is invented', () => {
  for (const a of [...parseWsAuctionList(HEAD).auctions, ...parseWsAuctionList(TAIL).auctions]) {
    assert.equal(a.buyerPremiumPct, null);
    assert.match(a.buyerPremiumNote ?? '', /tiered/);
    assert.equal(a.currency, 'USD');
    assert.equal(a.ships, false);
    assert.equal(a.pickupRequired, true);
  }
});

// ------------------------------------------------------------------ pagination

test('pagination: the last page is recognised from the disabled "next" button', () => {
  assert.deepEqual(parseWsFragmentMeta(TAIL), {
    tense: null, // the tail excerpt starts after the wrapper that holds hdn_Tense
    serverNow: '2026-09-30 11:08:38 AM',
    lastPage: true,
  });
  // The head excerpt ends before the pager script: unknown, so the page-size rule decides.
  assert.equal(parseWsFragmentMeta(HEAD).lastPage, null);
  assert.equal(parseWsFragmentMeta(HEAD).tense, 'current');
  assert.equal(parseWsFragmentMeta(FUTURE).tense, 'future');
});

test('the list URL is the one verified live', () => {
  assert.equal(
    wsListUrl(WS_BASE, 'Current', 1),
    'https://bid.wisconsinsurplus.com/Public/Auction/GetAuctions?filter=Current&pageSize=1000&pageNumber=1',
  );
});

// ------------------------------------------------------------------ malformed input

test('malformed input yields warnings, never a throw', () => {
  assert.deepEqual(parseWsAuctionList('').auctions, []);
  assert.deepEqual(parseWsAuctionList('<html><body>Server Error</body></html>').auctions, []);
  assert.equal(parseWsAuctionList(undefined as unknown as string).warnings.length, 1);

  // A card with its title link and ids stripped is skipped and reported.
  const broken = HEAD.replace(/id="auctionHalt_128274"/, '')
    .replace(/'Facebook',128274,0/, "'Facebook',x,0")
    .replace(/Inventory128274/g, 'InventoryXYZ')
    .replace(/'Twitter',128274,0|'Linkedin',128274,0|'Pinterest',128274,0/g, "'x',x,0")
    .replace(/(<h4 class="auction-gridhead[^>]*>\s*)<a href="[^"]*SkfE3Tdbr3GIq7OEKrouhg[^"]*"[^>]*>/, '$1<span>');
  const r = parseWsAuctionList(broken);
  assert.deepEqual(r.auctions.map((a) => a.externalId), ['128265']);
  assert.match(r.warnings.join(' '), /Skipped 1 of 2/);

  // An unreadable end date is a warning and a null close, not a guessed one.
  const badDate = parseWsAuctionList(HEAD.replace('data-auc-date="09/30/2026 10:00:00"', 'data-auc-date="soon"'));
  assert.equal(badDate.auctions[0].endsAt, null);
  assert.match(badDate.warnings.join(' '), /no parseable end time/);

  // A response cut off mid-card still yields the complete card before it.
  const cut = parseWsAuctionList(HEAD.slice(0, HEAD.indexOf('Waushara County Emergency Management - Wautoma')));
  assert.equal(cut.auctions[0].externalId, '128265');
});

test('card splitting and entity decoding', () => {
  assert.equal(splitWsCards(HEAD).length, 2);
  assert.equal(splitWsCards('no cards here').length, 0);
  assert.equal(parseWsCard('<div class="row border auction-item-cardcolor mb-4"></div>'), null);
  assert.equal(decodeEntities('Tom &amp; Jerry&#39;s &#x2013; &laquo;x&raquo; &bogus;'), "Tom & Jerry's – «x» &bogus;");
});

// ------------------------------------------------------------------ run()

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'src-ws',
    slug: 'wisconsin-surplus',
    name: 'Wisconsin Surplus Online Auction',
    url: 'https://wisconsinsurplus.com',
    apiBase: 'https://bid.wisconsinsurplus.com',
    tier: 'state',
    ingest: 'html',
    platform: 'wisconsin-surplus',
    states: ['WI', 'IL', 'MI', 'IA', 'MN'],
    rateLimitRpm: 12,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 30,
    consecutiveFailures: 0,
    ...over,
  };
}

const HTML_HEADERS: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
const NO_HEADERS: Record<string, string> = {};

function ctxWith(
  responses: Record<string, { status: number; text: string }>,
  over: Partial<SourceConfig> = {},
): { ctx: AdapterContext; calls: { url: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const r = responses[url];
    if (!r) return { status: 404, headers: NO_HEADERS, text: 'not found' };
    return { status: r.status, headers: HTML_HEADERS, text: r.text };
  };
  const ctx: AdapterContext = {
    source: source(over),
    fetch,
    now: () => CAPTURED_AT,
    log: () => {},
    secrets: {},
  };
  return { ctx, calls };
}

const CURRENT_URL = wsListUrl(WS_BASE, 'Current', 1);
const FUTURE_URL = wsListUrl(WS_BASE, 'Future', 1);

test('run(): two XHR requests, auctions only, never a complete snapshot', async () => {
  const sleeps: number[] = [];
  const { ctx, calls } = ctxWith({
    [CURRENT_URL]: { status: 200, text: TAIL },
    [FUTURE_URL]: { status: 200, text: FUTURE },
  });
  const res = await runWisconsinSurplus(ctx, { sleep: async (ms) => { sleeps.push(ms); } });

  assert.deepEqual(calls.map((c) => c.url), [CURRENT_URL, FUTURE_URL]);
  assert.equal(calls[0].headers?.['X-Requested-With'], 'XMLHttpRequest');
  assert.deepEqual(sleeps, [5000], '12 requests/minute: 5 s between the two requests');
  assert.deepEqual(res.auctions.map((a) => a.externalId), ['128409', '128387']);
  assert.deepEqual(res.lots, []);
  assert.equal(res.stats.httpRequests, 2);
  assert.equal(res.stats.bytesIn, TAIL.length + FUTURE.length);
  assert.equal(res.completeSnapshot, false);
  assert.deepEqual(res.warnings, []);
});

test('run(): a page without a pager stops once it is shorter than the page size', async () => {
  const { ctx, calls } = ctxWith({
    [CURRENT_URL]: { status: 200, text: HEAD },
    [FUTURE_URL]: { status: 200, text: FUTURE },
  });
  const res = await runWisconsinSurplus(ctx, { sleep: async () => {} });
  assert.equal(calls.length, 2, 'no page 2 was requested');
  assert.equal(res.auctions.length, 3);
});

test('run(): scoping keeps declared in-scope states and sales with no declared location', async () => {
  const responses = {
    [CURRENT_URL]: { status: 200, text: HEAD + TAIL },
    [FUTURE_URL]: { status: 200, text: FUTURE },
  };
  const wi = await runWisconsinSurplus(ctxWith(responses).ctx, { sleep: async () => {} });
  assert.deepEqual(wi.auctions.map((a) => a.externalId).sort(), ['128265', '128274', '128387', '128409']);

  // Scoped to Illinois only: the three WI-declared sales go; Platteville, which
  // declares no location, stays.
  const il = await runWisconsinSurplus(ctxWith(responses, { states: ['IL'] }).ctx, { sleep: async () => {} });
  assert.deepEqual(il.auctions.map((a) => a.externalId), ['128409']);
});

test('run(): the current list failing fails the run; a missing future list is a warning', async () => {
  const down = ctxWith({ [CURRENT_URL]: { status: 503, text: 'Service Unavailable' } });
  await assert.rejects(runWisconsinSurplus(down.ctx, { sleep: async () => {} }), /HTTP 503/);

  const partial = ctxWith({
    [CURRENT_URL]: { status: 200, text: TAIL },
    [FUTURE_URL]: { status: 500, text: 'Server Error' },
  });
  const res = await runWisconsinSurplus(partial.ctx, { sleep: async () => {} });
  assert.equal(res.auctions.length, 1);
  assert.match(res.warnings.join(' '), /Future list page 1: HTTP 500/);
});

test('run(): a challenge page is reported as a block, not parsed', async () => {
  const { ctx } = ctxWith({
    [CURRENT_URL]: { status: 200, text: '<html><title>Human Verification</title>captcha</html>' },
  });
  await assert.rejects(runWisconsinSurplus(ctx, { sleep: async () => {} }), /bot-protection challenge/);
});

/** What the crawl gate throws when it will not make a request (gate.ts). */
function refusal(reason: 'robots' | 'blocked' | 'budget'): Error {
  const e = new Error(`gate refused: ${reason}`);
  e.name = 'CrawlRefused';
  (e as any).reason = reason;
  return e;
}

test('run(): the gate running out of budget before the future list keeps the current list', async () => {
  const { ctx } = ctxWith({ [CURRENT_URL]: { status: 200, text: TAIL } });
  const inner = ctx.fetch;
  ctx.fetch = async (url, init) => {
    if (url === FUTURE_URL) throw refusal('budget');
    return inner(url, init);
  };
  const res = await runWisconsinSurplus(ctx, { sleep: async () => {} });
  assert.deepEqual(res.auctions.map((a) => a.externalId), ['128409']);
  assert.match(res.warnings.join(' '), /budget ran out before the Future list/);
});

test('run(): a gate refusal for bot protection or robots fails the run', async () => {
  for (const reason of ['blocked', 'robots'] as const) {
    const { ctx } = ctxWith({ [CURRENT_URL]: { status: 200, text: TAIL } });
    const inner = ctx.fetch;
    ctx.fetch = async (url, init) => {
      if (url === FUTURE_URL) throw refusal(reason);
      return inner(url, init);
    };
    await assert.rejects(runWisconsinSurplus(ctx, { sleep: async () => {} }), new RegExp(`gate refused: ${reason}`));
  }
});

test('run(): an empty current list is flagged', async () => {
  const { ctx } = ctxWith({
    [CURRENT_URL]: { status: 200, text: '<div class="border-top-0"><input type="hidden" id="hdn_Tense" value="current" /></div>' },
    [FUTURE_URL]: { status: 200, text: FUTURE },
  });
  const res = await runWisconsinSurplus(ctx, { sleep: async () => {} });
  assert.match(res.warnings.join(' '), /held no auction cards/);
});

test('run() behind the real crawl gate: no robots.txt on the Maxanet host means allowed', async () => {
  const served: string[] = [];
  const gated = gateFetcher({
    rawFetch: async (url) => {
      served.push(url);
      // bid.wisconsinsurplus.com/robots.txt answered IIS "404 - File or directory not found."
      if (url.endsWith('/robots.txt')) return { status: 404, headers: HTML_HEADERS, text: '404 - File or directory not found.' };
      if (url === CURRENT_URL) return { status: 200, headers: HTML_HEADERS, text: TAIL };
      if (url === FUTURE_URL) return { status: 200, headers: HTML_HEADERS, text: FUTURE };
      return { status: 404, headers: NO_HEADERS, text: '' };
    },
    rateLimitRpm: 12,
    sleep: async () => {},
    now: () => CAPTURED_AT.getTime(),
  });
  const { ctx } = ctxWith({});
  ctx.fetch = gated;
  const res = await runWisconsinSurplus(ctx, { sleep: async () => {} });
  assert.deepEqual(served, ['https://bid.wisconsinsurplus.com/robots.txt', CURRENT_URL, FUTURE_URL]);
  assert.deepEqual(gated.stats().refusals, []);
  assert.deepEqual(res.auctions.map((a) => a.externalId), ['128409', '128387']);
});

test('adapter identity, scope defaults and pacing', () => {
  assert.equal(wisconsinSurplusAdapter.key, 'wisconsin-surplus');
  assert.equal(wisconsinSurplusAdapter.method, 'html');
  assert.deepEqual(scopeStates({ states: null }), ['WI']);
  assert.deepEqual(scopeStates({ states: [] }), ['WI']);
  assert.deepEqual(scopeStates({ states: ['wi', ' mn '] }), ['WI', 'MN']);
  assert.equal(spacingMs(12), 5000);
  assert.equal(spacingMs(0), 6000);
});
