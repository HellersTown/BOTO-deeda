/**
 * HiBid adapter tests. Every fixture is a byte-exact capture of a real HiBid
 * GraphQL response, taken on 2026-09-30 through inspect_url with our own
 * crawler identity (md5-verified against the stored response). Two are trimmed
 * by removing whole entries only: kansas-auction keeps 1 of the 2 auctions
 * returned, and national-lots keeps 3 of 5 lots.
 *
 *   hibid-wi-lots        portal lotSearch, state WI, OPEN, TIME_LEFT (6 lots)
 *   hibid-wi-auctions    portal auctionSearch, state WI, OPEN (3 of 82)
 *   hibid-tenant-auctions hameleauctions.hibid.com auctionSearch (2 of 2)
 *   hibid-tenant-lots    hameleauctions.hibid.com lotSearch, auction 778301 (8 of 69)
 *   hibid-lots-page1/2   lotSearch, auction 780179, pageLength 3 (3 + 2 of 5)
 *   hibid-national-lots  lotSearch, no state (closed and sold lots, CA/IA/ON)
 *   hibid-kansas-auction hansenonlineauction.hibid.com: Beloit, KANSAS
 *   hibid-empty-tenant   jonesauctionservice.hibid.com: no auctions at all
 *   hibid-graphql-error  a real GraphQL.NET validation error body
 *
 * Capture instants, recovered from timeLeftSeconds against the exact close
 * times: wi-lots 16:02:16Z, tenant-lots 16:17:26Z, national 15:59:27Z,
 * page1 16:18:13Z, page2 16:18:43Z (all 2026-09-30).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AUCTION_SEARCH_QUERY,
  LOT_SEARCH_QUERY,
  auctionSearchBody,
  buyerPremiumFor,
  catalogUrl,
  extractBuyerPremium,
  extractCardFee,
  formatIsoInZone,
  hibidAdapter,
  hibidNaiveToMs,
  hibidSlug,
  lotCloseInstant,
  lotSearchBody,
  lotUrl,
  normalizeHibidAuction,
  normalizeHibidLot,
  parseEstimate,
  parseGraphqlPage,
  parseTimeLeftTitle,
  resolveScope,
  runHibid,
  tenantFromUrl,
  zoneForState,
} from '../src/adapters/hibid.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';
import { CrawlRefused } from '../src/gate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8');

const WI_LOTS = fx('hibid-wi-lots-2026-09-30.json');
const WI_AUCTIONS = fx('hibid-wi-auctions-2026-09-30.json');
const TENANT_AUCTIONS = fx('hibid-tenant-auctions-2026-09-30.json');
const TENANT_LOTS = fx('hibid-tenant-lots-2026-09-30.json');
const PAGE1 = fx('hibid-lots-page1-2026-09-30.json');
const PAGE2 = fx('hibid-lots-page2-2026-09-30.json');
const NATIONAL = fx('hibid-national-lots-2026-09-30.json');
const KANSAS = fx('hibid-kansas-auction-2026-09-30.json');
const EMPTY_TENANT = fx('hibid-empty-tenant-2026-09-30.json');
const GQL_ERROR = fx('hibid-graphql-error-2026-09-30.json');

const T = (iso: string) => Date.parse(iso);

function lotsOf(body: string) {
  const { page } = parseGraphqlPage(body, 'lotSearch');
  assert.ok(page, 'fixture parses');
  return page!.results;
}
function auctionsOf(body: string) {
  const { page } = parseGraphqlPage(body, 'auctionSearch');
  assert.ok(page, 'fixture parses');
  return page!.results;
}

// ------------------------------------------------------------------ scoping

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'src-hibid', slug: 'hibid', name: 'HiBid', url: 'https://hibid.com', apiBase: null,
    tier: 'private', ingest: 'internal_json', platform: 'hibid', states: null,
    rateLimitRpm: 600_000, ingestAllowed: true, robotsAllows: true,
    crawlCadenceMin: 30, consecutiveFailures: 0, ...over,
  };
}

test('the portal row scopes to WI when states is null, and talks to hibid.com/graphql', () => {
  const { scope, error } = resolveScope(source());
  assert.equal(error, null);
  assert.equal(scope!.mode, 'portal');
  assert.equal(scope!.endpoint, 'https://hibid.com/graphql');
  assert.deepEqual(scope!.states, ['WI']);
  assert.deepEqual(resolveScope(source({ states: ['wi', 'MN', 'x', 'WI'] })).scope!.states, ['WI', 'MN']);
});

test('a tenant whose url is its marketing site needs api_base; a custom domain is never guessed', () => {
  // Hamele's registered url is www.hameleauctions.com; bidding is on hameleauctions.hibid.com.
  const bad = resolveScope(source({ url: 'https://www.hameleauctions.com', states: ['WI'] }));
  assert.equal(bad.scope, null);
  assert.match(bad.error!, /api_base/);

  const ok = resolveScope(source({ url: 'https://www.hameleauctions.com', apiBase: 'https://hameleauctions.hibid.com', states: ['WI'] }));
  assert.equal(ok.scope!.mode, 'tenant');
  assert.equal(ok.scope!.endpoint, 'https://hameleauctions.hibid.com/graphql');

  // bids.beloitauction.com is NOT HiBid (it answers "Cannot POST /graphql").
  // A url on a non-HiBid host is refused rather than POSTed at.
  assert.equal(resolveScope(source({ url: 'https://bids.beloitauction.com' })).scope, null);
});

test('tenantFromUrl handles subdomains, the portal and junk', () => {
  assert.equal(tenantFromUrl('smithauctions.hibid.com')!.slug, 'smithauctions');
  assert.equal(tenantFromUrl('https://www.hibid.com/wisconsin/lots')!.isPortal, true);
  assert.equal(tenantFromUrl('https://www.hibid.com')!.host, 'hibid.com');
  assert.equal(tenantFromUrl('not a url at all !!'), null);
  assert.equal(tenantFromUrl(''), null);
});

test('request bodies are the ones the fixtures were captured with', () => {
  const lots = JSON.parse(lotSearchBody({ pageNumber: 2, pageLength: 100, state: 'WI', status: 'OPEN', sortOrder: 'TIME_LEFT' }));
  assert.equal(lots.operationName, 'LotSearch');
  assert.deepEqual(lots.variables, {
    pageNumber: 2, pageLength: 100, state: 'WI', status: 'OPEN', sortOrder: 'TIME_LEFT', auctionId: null,
    countAsView: false, // keeps our reads out of HiBid's view counters
  });
  assert.ok(!/bidAmount/.test(LOT_SEARCH_QUERY), 'the 123.45 placeholder field is not even requested');
  const auctions = JSON.parse(auctionSearchBody({ pageNumber: 1, pageLength: 100, status: 'OPEN' }));
  assert.equal(auctions.operationName, 'AuctionSearch');
  assert.equal(auctions.variables.state, null);
  assert.match(AUCTION_SEARCH_QUERY, /termsAndConditions/);
});

// -------------------------------------------------------------------- lots

test('WI portal lots: titles, cents, no-bid semantics and the bidAmount placeholder', () => {
  const results = lotsOf(WI_LOTS);
  assert.equal(results.length, 6);
  const lots = results.map((r) => normalizeHibidLot(r, { fetchedAtMs: T('2026-09-30T16:02:16Z'), timezone: 'America/Chicago' }).lot!);

  const first = lots[0];
  assert.equal(first.externalId, '324250603');
  assert.equal(first.auctionExternalId, '781815');
  assert.equal(first.title, 'MYSTERY BAG TREASURE HUNT GOLD GEMSTONES COINS +++');
  assert.equal(first.lotNumber, '1');
  // No bids: there is no current bid (not $0), and minBid is the opening bid.
  assert.equal(first.bidCount, 0);
  assert.equal(first.currentBidCents, null);
  assert.equal(first.startingBidCents, 2000);
  assert.equal(first.nextBidCents, 2000);
  assert.equal(first.estimateLowCents, 3500);
  assert.equal(first.estimateHighCents, 35000);
  // Trap 1: every lot carries bidAmount 123.45. It must not become a price.
  assert.equal((first.raw as any).bidAmount, 123.45);
  for (const l of lots) {
    for (const v of [l.currentBidCents, l.nextBidCents, l.startingBidCents, l.soldPriceCents]) assert.notEqual(v, 12345);
  }
  assert.equal(first.ships, true);
  assert.equal(first.quantity, 1);
});

test('close times are per lot, exact to the second, with an explicit offset (staggered 2 minutes)', () => {
  const lots = lotsOf(WI_LOTS).map((r) =>
    normalizeHibidLot(r, { fetchedAtMs: T('2026-09-30T16:02:16Z'), timezone: 'America/Chicago' }).lot!);
  // Title "9/30/2026 12:04:00 PM EST" is 12:04 EDT, which is 11:04 in Green Bay.
  assert.deepEqual(lots.map((l) => l.closesAt), [
    '2026-09-30T11:04:00-05:00', '2026-09-30T11:06:00-05:00', '2026-09-30T11:08:00-05:00',
    '2026-09-30T11:10:00-05:00', '2026-09-30T11:12:00-05:00', '2026-09-30T11:14:00-05:00',
  ]);
  assert.ok(lots.every((l) => (l.raw as any)._meta.closeTimeSource === 'title'));
  assert.ok(lots.every((l) => l.closed === false));
});

test('Hamele tenant lots: live bids in cents, 9-second stagger, verified deep link, image', () => {
  const lots = lotsOf(TENANT_LOTS).map((r) =>
    normalizeHibidLot(r, { fetchedAtMs: T('2026-09-30T16:17:26Z'), timezone: 'America/Chicago' }).lot!);
  assert.equal(lots.length, 8);
  assert.deepEqual(lots.map((l) => l.lotNumber), ['1a', '1b', '1c', '1d', '2', '3', '4', '5']);

  const rifle = lots.find((l) => l.lotNumber === '2')!;
  assert.equal(rifle.title, 'Smith & Wesson M&P FPC 10MM Folding Rifle');
  assert.equal(rifle.description, '16.25" barrel, unfired');
  assert.equal(rifle.bidCount, 20); // bids, not bidders
  assert.equal(rifle.currentBidCents, 44000); // High Bid: 440.00 USD
  assert.equal(rifle.nextBidCents, 45000); // Bid 450.00 USD
  assert.equal(rifle.startingBidCents, null);
  // The canonical link printed on the live lot page, byte for byte.
  assert.equal(rifle.url, 'https://hibid.com/lot/322370934/smith-and-wesson-mandp-fpc-10mm-folding-rifle');
  assert.equal(rifle.images.length, 1);
  assert.match(rifle.images[0].url, /^https:\/\/cdn\.hibid\.com\/img\.axd\?id=8429203455&/);
  assert.equal(rifle.ships, false);

  // "Online bidding will start ending THURSDAY, October 1st 6:00 PM" (lot 1c's
  // own text, Central), then one lot every 9 seconds.
  assert.equal(lots[0].closesAt, '2026-10-01T18:00:00-05:00');
  assert.equal(lots[1].closesAt, '2026-10-01T18:00:09-05:00');
  assert.equal(rifle.closesAt, '2026-10-01T18:00:36-05:00');
  assert.equal((rifle.raw as any)._meta.softCloseMinutes, 2);
});

test('closed and sold lots: sold price only with bids; "PST" means PDT in September', () => {
  const [pasadena, iowa, toronto] = lotsOf(NATIONAL).map((r) =>
    normalizeHibidLot(r, { fetchedAtMs: T('2026-09-30T15:59:27Z') }).lot!);
  assert.equal(iowa.closed, true);
  assert.equal(iowa.bidCount, 6);
  assert.equal(iowa.currentBidCents, 1200);
  assert.equal(iowa.soldPriceCents, 1200);
  assert.equal(iowa.nextBidCents, null);
  // "closed at: 9/30/2026 8:58:30 AM PST" and "11:58:30 AM EST" are the SAME
  // instant, 57 s before the response: both labels mean daylight time.
  assert.equal(pasadena.closesAt, '2026-09-30T15:58:30Z');
  assert.equal(iowa.closesAt, '2026-09-30T15:58:30Z');
  assert.equal(pasadena.closed, true);
  assert.equal(pasadena.soldPriceCents, null); // closed with no bids is not a sale
  assert.equal(toronto.soldPriceCents, null);
});

test('a fractional quantity (76.85 acres, bid per acre) never reaches the integer column', () => {
  const [, land] = lotsOf(PAGE2);
  const n = normalizeHibidLot(land, { fetchedAtMs: T('2026-09-30T16:18:43Z'), timezone: 'America/Chicago' });
  assert.equal(n.lot!.title, 'Property 2: 5978 Portage Rd,. Deforest');
  assert.equal(n.lot!.quantity, null);
  assert.equal((n.lot!.raw as any)._meta.quantity, 76.85);
  assert.equal((n.lot!.raw as any)._meta.bidIsPerUnit, true);
  assert.equal(n.lot!.startingBidCents, 3000651); // $30,006.51 per acre
  assert.equal(n.fractionalQuantity, true);
  assert.match(n.issues[0], /76\.85/);
});

// -------------------------------------------------------------------- time

test('HiBid naive auction datetimes are US-Eastern wall clock (verified against the auctioneers\' own text)', () => {
  // Wilkinson: "Lots begin closing at 6pm Central"; HiBid sends 19:00.
  assert.equal(formatIsoInZone(hibidNaiveToMs('2026-09-30T19:00:00')!, 'America/Chicago'), '2026-09-30T18:00:00-05:00');
  // Mathies: "Absentee Bidding will be available until 4pm CST"; HiBid sends 17:00.
  assert.equal(formatIsoInZone(hibidNaiveToMs('2026-09-30T17:00:00')!, 'America/Chicago'), '2026-09-30T16:00:00-05:00');
  // After DST ends (Nov 1 2026) Eastern is -05:00.
  assert.equal(new Date(hibidNaiveToMs('2026-11-20T19:00:00')!).toISOString(), '2026-11-21T00:00:00.000Z');
  assert.equal(hibidNaiveToMs('not a date'), null);
});

test('timeLeftTitle is read as the zone family, never as the literal standard offset', () => {
  const t = parseTimeLeftTitle('Internet Bidding closes at: 9/30/2026 12:04:00 PM EST')!;
  assert.equal(new Date(t.ms).toISOString(), '2026-09-30T16:04:00.000Z'); // EDT, not EST
  assert.equal(parseTimeLeftTitle('Bidding Closed'), null);
  assert.equal(parseTimeLeftTitle('closes at: 9/30/2026 12:04:00 PM XYZ'), null);
});

test('when the title and timeLeftSeconds disagree, the zone-free relative time wins', () => {
  const lotState = (lotsOf(TENANT_LOTS)[4] as any).lotState;
  // Pretend our clock were an hour off: the title (exact) and the relative time
  // now disagree, so the adapter trusts neither blindly and says which it used.
  const ok = lotCloseInstant(lotState, T('2026-09-30T16:17:26Z'))!;
  assert.equal(ok.source, 'title');
  const skew = lotCloseInstant(lotState, T('2026-09-30T17:17:26Z'))!;
  assert.equal(skew.source, 'timeLeftSeconds');
  assert.ok(Math.abs(skew.disagreementMs! + 3_600_000) < 2000);
  assert.equal(lotCloseInstant({ timeLeftTitle: '', timeLeftSeconds: null }, null), null);
});

// ---------------------------------------------------------------- auctions

test('Treasure Vault: pickup exactly as declared, the auctioneer\'s MN street dropped, seller state kept apart', () => {
  const [tv] = auctionsOf(WI_AUCTIONS);
  const n = normalizeHibidAuction(tv);
  const a = n.auction!;
  assert.equal(a.externalId, '781815');
  assert.equal(a.auctioneer, 'Treasure Vault, Inc.');
  assert.deepEqual(a.pickup, { line1: null, city: 'Green Bay', state: 'WI', postalCode: '54302', ambiguous: false });
  assert.equal((a.raw as any)._meta.pickupLine1Dropped, '1560 Livingston Avenue Suite 104');
  assert.equal(a.sellerState, 'MN');
  assert.equal(a.timezone, 'America/Chicago');
  assert.equal(a.buyerPremiumPct, 20);
  assert.equal(a.buyerPremiumNote, '20% bp added');
  assert.equal(a.ships, true);
  assert.equal(a.pickupRequired, false); // "there is no pick up for any lots"
  assert.equal(a.endsAt, '2026-09-30T11:02:00-05:00');
  assert.equal(a.url, catalogUrl('781815', a.title));
});

test('Mathies and Wilkinson: premium plus card fee, never the sales tax; formats; local close times', () => {
  const [, mathies, wilkinson] = auctionsOf(WI_AUCTIONS).map((r) => normalizeHibidAuction(r).auction!);
  assert.equal(mathies.buyerPremiumPct, 5);
  assert.equal((mathies.raw as any)._meta.cardFeePct, 4); // not the 5.5% WI sales tax
  assert.equal(mathies.buyerPremiumNote, '5% Buyers Premium; +4% card fee');
  assert.equal(mathies.format, 'hybrid'); // ABSENTEE bids online, then a live sale
  assert.equal(mathies.endsAt, '2026-09-30T16:00:00-05:00');

  assert.equal(wilkinson.buyerPremiumPct, 10);
  assert.equal((wilkinson.raw as any)._meta.cardFeePct, 3);
  assert.equal(wilkinson.format, 'online');
  assert.equal(wilkinson.ships, false); // "LOCAL PICKUP ONLY. NO SHIPPING."
  assert.equal(wilkinson.pickupRequired, true);
  assert.deepEqual(wilkinson.pickup, { line1: 'E5535 Rainbow Road', city: 'Spring Green', state: 'WI', postalCode: '53588', ambiguous: false });
});

test('Hamele: 10% online premium plus 3.5% for cards, as its own terms state', () => {
  const [guns, comics] = auctionsOf(TENANT_AUCTIONS).map((r) => normalizeHibidAuction(r).auction!);
  assert.equal(guns.auctioneer, 'Hamele Auction Service LLC');
  assert.equal(guns.buyerPremiumPct, 10);
  assert.equal((guns.raw as any)._meta.cardFeePct, 3.5);
  // The terms also say "13.5% Buyer's Premium": that is 10 + 3.5, not a conflict.
  assert.deepEqual((guns.raw as any)._meta.premiumAlsoStated, []);
  assert.equal(guns.buyerPremiumNote, '10% Buyer Premium; +3.5% card fee');
  assert.deepEqual(guns.pickup, { line1: 'W9833 Hogan Rd', city: 'Portage', state: 'WI', postalCode: '53901', ambiguous: false });
  assert.equal(guns.endsAt, '2026-10-01T18:00:00-05:00'); // "starts ending Thursday 6:00 PM 10/1"
  assert.equal(guns.ships, false);
  assert.equal(guns.lotCount, 69);
  // "Buyer Premium- 10% Buyers Fee 13.5% if using a Credit Card" reads as +3.5%, not +13.5%.
  assert.equal((comics.raw as any)._meta.cardFeePct, 3.5);
  assert.equal(comics.ships, true); // "Shipping is now availabe through Hamele"
});

test('DATA TRAP: Beloit, KANSAS stays Kansas, and a 5% down payment is not a buyer\'s premium', () => {
  const [hansen] = auctionsOf(KANSAS);
  const a = normalizeHibidAuction(hansen).auction!;
  assert.equal(a.auctioneer, 'Hansen Auction & Realty');
  assert.equal(a.pickup!.city, 'Beloit');
  assert.equal(a.pickup!.state, 'KS');
  assert.equal(a.timezone, null); // Kansas spans two zones: no guess
  assert.equal(a.buyerPremiumPct, 0); // "NO BUYER'S PREMIUM", not the 5% down payment
  assert.equal((a.raw as any)._meta.cardFeePct, 3);
  // Without a zone, times are still exact, in UTC. "SOFT CLOSE ... 7 PM CST".
  assert.equal(a.endsAt, '2026-10-01T00:00:00Z');
});

test('the premium comes from HiBid\'s applied rate when shown; non-US states stay as declared', () => {
  const iowa = (lotsOf(NATIONAL)[1] as any).auction;
  const info = buyerPremiumFor({ ...iowa, termsAndConditions: null });
  assert.equal(info.pct, 15); // buyerPremiumRate 1.15, showBuyerPremium true
  assert.equal(info.source, 'rate');
  const toronto = normalizeHibidAuction({ auction: (lotsOf(NATIONAL)[2] as any).auction }).auction!;
  assert.equal(toronto.pickup!.state, 'ON');
  assert.equal(toronto.currency, 'CAD');
  assert.equal(toronto.buyerPremiumPct, 0); // "No Buyer's Premium Sale"
  assert.equal(zoneForState('ON'), null);
});

test('premium and card-fee extraction on the exact strings HiBid served', () => {
  assert.equal(extractBuyerPremium('20% bp added')!.pct, 20);
  assert.equal(extractBuyerPremium('10% Buyer  Premium')!.pct, 10);
  assert.equal(extractBuyerPremium('15 % Buyer Premium')!.pct, 15);
  assert.equal(extractBuyerPremium("10% Buyer's Premium On All Purchases")!.pct, 10);
  assert.equal(extractBuyerPremium("No Buyer's Premium Sale")!.pct, 0);
  assert.equal(extractBuyerPremium('TERMS: 5% of the purchase price as down payment'), null);
  assert.equal(extractBuyerPremium(''), null);

  assert.equal(extractCardFee('Use of Credit/Debit Cards will be charged a 4% convenience fee. WI Sales and CountyTax of 5.5% will be added to winning bid.')!.pct, 4);
  assert.equal(extractCardFee('A 10% online buyer\'s premium will be added to all sales via online auction conducted by Hamele Auction with a 3.5% additional fee for credit & debit cards.')!.pct, 3.5);
  assert.equal(extractCardFee('Buyer Premium- 10% Buyers Fee 13.5% if using a Credit Card', 10)!.pct, 3.5);
  assert.equal(extractCardFee('Cash, card, and paper check payments will be accepted during pickup on Thursday.'), null);
  assert.equal(extractCardFee('5.5% Sales Tax Applies to all purchases'), null);
});

test('estimates and slugs', () => {
  assert.deepEqual(parseEstimate('35.00 - 350.00 USD'), { low: 3500, high: 35000 });
  assert.deepEqual(parseEstimate(''), { low: null, high: null });
  assert.equal(hibidSlug('October Guns Online Only'), 'october-guns-online-only');
  // The catalogue link printed on the live lot page.
  assert.equal(catalogUrl(778301, 'October Guns Online Only'), 'https://hibid.com/catalog/778301/october-guns-online-only');
  assert.equal(lotUrl(1, ''), 'https://hibid.com/lot/1');
});

// ------------------------------------------------------------------ runs

function router(routes: { auctions: string[]; lots: string[] }) {
  const calls: { url: string; body: any }[] = [];
  const fetch: Fetcher = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push({ url, body });
    const list = body.operationName === 'AuctionSearch' ? routes.auctions : routes.lots;
    const text = list[Math.min(body.variables.pageNumber, list.length) - 1];
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, text };
  };
  return { fetch, calls };
}

function ctx(fetch: Fetcher, over: Partial<SourceConfig> = {}, now = '2026-09-30T16:18:30Z'): AdapterContext {
  return { source: source(over), fetch, now: () => new Date(now), log: () => {}, secrets: {} };
}

const fast = { sleep: async () => {} };

test('portal run: pages to the end, stops on the short page, links every lot to its auction', async () => {
  const { fetch, calls } = router({ auctions: [WI_AUCTIONS], lots: [PAGE1, PAGE2] });
  const r = await runHibid(ctx(fetch), { ...fast, lotPageLength: 3 });

  assert.equal(r.stats.httpRequests, 3); // 1 auction page + 2 lot pages
  assert.deepEqual(calls.map((c) => [c.url, c.body.operationName, c.body.variables.pageNumber]), [
    ['https://hibid.com/graphql', 'AuctionSearch', 1],
    ['https://hibid.com/graphql', 'LotSearch', 1],
    ['https://hibid.com/graphql', 'LotSearch', 2],
  ]);
  assert.equal(calls[1].body.variables.state, 'WI');
  assert.equal(calls[1].body.variables.sortOrder, 'TIME_LEFT'); // soonest-closing first
  assert.equal(r.lots.length, 5);
  assert.equal(new Set(r.lots.map((l) => l.externalId)).size, 5);
  // The lots' auction (780179) was not among the 3 auctions returned, so a
  // minimal auction is built from the lots' own declared fields.
  const shadow = r.auctions.find((a) => a.externalId === '780179')!;
  assert.deepEqual(shadow.pickup, { line1: null, city: 'DeForest', state: 'WI', postalCode: '53532', ambiguous: false });
  assert.ok(r.lots.every((l) => l.pickup?.state === 'WI' && l.auctionExternalId === '780179'));
  assert.equal(r.lots[0].closesAt, '2026-10-12T17:00:00-05:00');
  assert.equal(r.auctions.length, 4);
  // A portal pass is never a complete snapshot (moving sort key, 10,000 cap).
  assert.equal(r.completeSnapshot, false);
  assert.match(r.warnings.join('\n'), /WI: read 3 of 82 open auctions/);
  assert.match(r.warnings.join('\n'), /built minimal records from lot fields/);
  assert.match(r.warnings.join('\n'), /fractional quantity/);
});

test('portal run: a gate budget refusal keeps the lots already read', async () => {
  const { fetch: served, calls } = router({ auctions: [WI_AUCTIONS], lots: [WI_LOTS] });
  let n = 0;
  const fetch: Fetcher = async (url, init) => {
    // The auction page and the first lot page get through; then the run's time is up.
    if (++n > 2) throw new CrawlRefused('time budget for this run is used up', 'budget');
    return served(url, init);
  };
  const r = await runHibid(ctx(fetch, {}, '2026-09-30T16:02:16Z'), { ...fast, lotPageLength: 6 });
  assert.equal(calls.length, 2);
  assert.equal(r.lots.length, 6);
  assert.equal(r.completeSnapshot, false);
  assert.match(r.warnings.join('\n'), /stopped at the crawl gate's budget/);
});

test('portal run: a refusal that is not about budget still fails the run', async () => {
  const fetch: Fetcher = async () => {
    throw new CrawlRefused('robots.txt disallows WaystockBot on /graphql at hibid.com', 'robots');
  };
  await assert.rejects(runHibid(ctx(fetch), fast), /robots\.txt disallows/);
});

test("portal run: stops before the worker's deadline instead of running into it", async () => {
  const { fetch, calls } = router({ auctions: [WI_AUCTIONS], lots: [WI_LOTS] });
  const c = ctx(fetch, {}, '2026-09-30T16:02:16Z');
  // The worker's deadline has already passed when the run starts.
  c.deadline = Date.now() - 1;
  const r = await runHibid(c, { ...fast, lotPageLength: 6 });
  assert.equal(calls.length, 0);
  assert.equal(r.lots.length, 0);
  assert.match(r.warnings.join('\n'), /stopped at the worker's time budget/);
});

test('portal run: soonest-closing lots first, budget respected, the 10,000 cap reported', async () => {
  const { fetch, calls } = router({ auctions: [WI_AUCTIONS], lots: [WI_LOTS] });
  const r = await runHibid(ctx(fetch, {}, '2026-09-30T16:02:16Z'), { ...fast, lotPageLength: 6, maxRequests: 2 });
  assert.equal(calls.length, 2);
  assert.equal(r.lots.length, 6);
  assert.equal(r.completeSnapshot, false);
  const w = r.warnings.join('\n');
  assert.match(w, /its search maximum/);
  assert.match(w, /stopped at the request budget \(2\)/);
  // Every lot carries its auction's declared pickup and Central close times.
  const lot = r.lots[0];
  assert.deepEqual(lot.pickup, { line1: null, city: 'Green Bay', state: 'WI', postalCode: '54302', ambiguous: false });
  assert.equal(lot.closesAt, '2026-09-30T11:04:00-05:00');
  const tv = r.auctions.find((a) => a.externalId === '781815')!;
  assert.equal(tv.buyerPremiumPct, 20);
});

test('tenant run: host-scoped, auctions soonest-first, catalogue order, budget stops it', async () => {
  const { fetch, calls } = router({ auctions: [TENANT_AUCTIONS], lots: [TENANT_LOTS] });
  const r = await runHibid(
    ctx(fetch, { slug: 'hamele', url: 'https://www.hameleauctions.com', apiBase: 'https://hameleauctions.hibid.com', states: ['WI'] }, '2026-09-30T16:17:26Z'),
    { ...fast, lotPageLength: 8, maxRequests: 2 },
  );
  assert.ok(calls.every((c) => c.url === 'https://hameleauctions.hibid.com/graphql'));
  assert.equal(calls[0].body.variables.state, null); // the host scopes; no state filter
  assert.equal(calls[1].body.variables.auctionId, 778301); // closes Oct 1, before 780480 (Oct 8)
  assert.equal(calls[1].body.variables.status, null); // whole catalogue: a stable enumeration
  assert.equal(r.auctions.length, 2);
  assert.equal(r.lots.length, 8);
  assert.equal(r.completeSnapshot, false); // 61 more lots and a second auction unread
  assert.match(r.warnings.join('\n'), /stopped at the request budget/);
  const rifle = r.lots.find((l) => l.externalId === '322370934')!;
  assert.equal(rifle.pickup!.city, 'Portage');
  assert.equal(rifle.currentBidCents, 44000);
});

test('tenant run with nothing open is a complete (empty) snapshot', async () => {
  const { fetch, calls } = router({ auctions: [EMPTY_TENANT], lots: [EMPTY_TENANT] });
  const r = await hibidAdapter.run(ctx(fetch, { url: 'https://jonesauctionservice.hibid.com', states: ['WI'] }));
  assert.equal(calls.length, 1);
  assert.equal(r.lots.length, 0);
  assert.equal(r.completeSnapshot, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(hibidAdapter.key, 'hibid');
  assert.equal(hibidAdapter.method, 'internal_json');
});

test('a WI-scoped tenant run drops the Kansas auction instead of calling Beloit Wisconsin', async () => {
  const { fetch, calls } = router({ auctions: [KANSAS], lots: [EMPTY_TENANT] });
  const r = await runHibid(ctx(fetch, { url: 'https://hansenonlineauction.hibid.com', states: null }), { ...fast, auctionPageLength: 2 });
  assert.equal(r.auctions.length, 0);
  assert.equal(r.lots.length, 0);
  assert.equal(calls.length, 1); // no lot requests for an out-of-scope auction
  assert.match(r.warnings.join('\n'), /declared outside \[WI\]: KS×1/);
});

// ------------------------------------------------------------- malformed

test('malformed input yields warnings, not throws', async () => {
  // Not JSON (a proxy error page), and a real GraphQL validation error.
  const html = parseGraphqlPage('<html><title>Error</title></html>', 'lotSearch');
  assert.equal(html.page, null);
  assert.match(html.errors[0], /not JSON/);
  const gql = parseGraphqlPage(GQL_ERROR, 'auctionSearch');
  assert.equal(gql.page, null);
  assert.match(gql.errors[0], /Cannot query field 'matchingLotCount'/);

  // Garbage entries mixed into a real page are skipped and counted.
  const page = JSON.parse(TENANT_LOTS);
  page.data.lotSearch.pagedResults.results.push(null, { id: 'abc' }, { id: 7, lead: ' ', description: '' }, { id: 8, lead: 'No auction object' });
  assert.equal(normalizeHibidLot(null, { fetchedAtMs: null }).lot, null);
  assert.equal(normalizeHibidAuction({}).auction, null);

  // 8 real lots + 3 malformed objects = a full page of 11 (the null is dropped
  // while parsing), so the pager asks for page 2, which is an HTML error page:
  // keep what was read, warn, and do not claim completeness.
  const { fetch, calls } = router({ auctions: [TENANT_AUCTIONS], lots: [JSON.stringify(page), '<html>upstream error</html>'] });
  const r = await runHibid(
    ctx(fetch, { url: 'https://hameleauctions.hibid.com', states: ['WI'] }, '2026-09-30T16:17:26Z'),
    { ...fast, lotPageLength: 11, maxRequests: 3 },
  );
  assert.equal(calls.length, 3);
  assert.equal(r.lots.length, 8);
  assert.equal(r.completeSnapshot, false);
  const w = r.warnings.join('\n');
  assert.match(w, /auction 778301 lots page 2: response was not JSON/);
  assert.match(w, /3 lot\(s\) skipped: no numeric id or no title/);
  assert.match(w, /1 malformed search entr/);
});

test('an unreadable FIRST response fails the run loudly, and a 403 is treated as a block', async () => {
  const schemaDrift: Fetcher = async () => ({ status: 400, headers: {}, text: GQL_ERROR });
  await assert.rejects(runHibid(ctx(schemaDrift), fast), /Cannot query field/);
  const refused: Fetcher = async () => ({ status: 403, headers: { server: 'cloudflare' }, text: '<html>Attention Required! | Cloudflare</html>' });
  await assert.rejects(runHibid(ctx(refused), fast), /do not retry/);
  const limited: Fetcher = async () => ({ status: 429, headers: {}, text: '' });
  await assert.rejects(runHibid(ctx(limited), fast), /rate limit/);
});
