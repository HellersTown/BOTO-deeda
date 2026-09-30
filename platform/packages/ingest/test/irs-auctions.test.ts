import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  cleanTitle,
  irsAuctionsAdapter,
  normalizeIrsCard,
  normalizeIrsIndex,
  parseIrsDate,
  parseIrsLocation,
  placeFromNotice,
  runIrsAuctions,
  saleKind,
  skipReason,
} from '../src/adapters/irs-auctions.ts';
import type { IrsCard } from '../src/adapters/irs-auctions.ts';
import { zonedIso } from '../src/usTime.ts';
import { gateFetcher } from '../src/gate.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

// Twelve cards of https://www.irsauctions.gov/index.json read through inspect_url
// on 2026-09-30, key order kept; `content` (the notice of sale) is cut to its
// first 400 characters, which hold everything this adapter reads from it.
const here = dirname(fileURLToPath(import.meta.url));
const CARDS = JSON.parse(readFileSync(join(here, 'fixtures', 'irsauctions-index-sample-2026-09-30.json'), 'utf8')) as IrsCard[];
const card = (slug: string) => {
  const c = CARDS.find((x) => x.url === `/ad/${slug}/`);
  assert.ok(c, slug);
  return c;
};

// Before the September sales in the sample, so all but the cancelled one are current.
const EARLY = new Date('2026-09-10T12:00:00Z');
// The day the sample was read: only the October sale is still ahead.
const READ_DAY = new Date('2026-09-30T19:00:00Z');

// --------------------------------------------------------------- parsing

test('dates: the site\'s "Oct 28, 2026 12:00 PM", read as a local wall-clock time', () => {
  assert.deepEqual(parseIrsDate('Oct 28, 2026 12:00 PM'), { y: 2026, m: 10, d: 28, h: 12, mi: 0, timeGiven: true });
  assert.deepEqual(parseIrsDate('Sep 24, 2026 10:00 AM'), { y: 2026, m: 9, d: 24, h: 10, mi: 0, timeGiven: true });
  assert.equal(parseIrsDate('Sep 9, 2026 12:30 AM')?.h, 0, '12:30 AM is half past midnight');
  assert.equal(parseIrsDate('Sep 9, 2026 1:05 PM')?.h, 13);
  assert.deepEqual(parseIrsDate('Sept 9, 2026'), { y: 2026, m: 9, d: 9, h: 12, mi: 0, timeGiven: false });
  for (const bad of ['', 'TBD', '2026-10-28', 'Foo 28, 2026 12:00 PM', 'Oct 28, 2026 12:75 PM', 'Oct 40, 2026']) {
    assert.equal(parseIrsDate(bad), null, bad);
  }
  assert.equal(parseIrsDate(undefined), null);
});

test('locations: "City ST, ZIP", with only real state codes', () => {
  assert.deepEqual(parseIrsLocation('Pembroke NH, 03275'), { city: 'Pembroke', state: 'NH', postalCode: '03275' });
  assert.deepEqual(parseIrsLocation('South Charleston OH, 45368'), { city: 'South Charleston', state: 'OH', postalCode: '45368' });
  assert.deepEqual(parseIrsLocation('Houston TX, 77045-1234'), { city: 'Houston', state: 'TX', postalCode: '77045' });
  assert.deepEqual(parseIrsLocation('Sparta WI'), { city: 'Sparta', state: 'WI', postalCode: null });
  assert.equal(parseIrsLocation(''), null);
  assert.equal(parseIrsLocation('Somewhere XX, 12345'), null, 'XX is not a state');
});

test('a card with no location is placed from the notice: the property, never the sale place or the IRS office', () => {
  // "... 340 Cedar Grove Dr. Henderson NC 27537 United States 81480.00 Paul Reed, ... Atlanta GA 30341 ..."
  const half = card('half-interest-house-acreage');
  assert.deepEqual(placeFromNotice(half.content, half.title!, half.minimumBid!), { state: 'NC', postalCode: '27537' });
  // No minimum bid: the IRS contact block (Atlanta GA 30341) bounds the search.
  const bentley = card('2016-bentley-continental-gt-convertible-brand-new');
  assert.deepEqual(placeFromNotice(bentley.content, bentley.title!, null), { state: 'TX', postalCode: '77045' });
  // The property (South Charleston OH 45368) comes before the courtroom (Springfield OH 45502).
  const ohio = card('agricultural-land-about-100420-acres-south-charleston-oh');
  assert.deepEqual(placeFromNotice(ohio.content, ohio.title!, ohio.minimumBid!), { state: 'OH', postalCode: '45368' });
  assert.equal(placeFromNotice('A lot somewhere. Paul Reed Internal Revenue Service Atlanta GA 30341', 'A lot somewhere.', null), null);
  assert.equal(placeFromNotice(null, 'x', null), null);
});

test('which cards are current sales', () => {
  assert.equal(skipReason({ url: '/' }), 'not_a_sale', 'the front page is a card too');
  assert.equal(skipReason({ url: '/frequently-asked-questions/' }), 'not_a_sale');
  assert.equal(skipReason(card('canceled-commercial-building-goddard-ks')), 'cancelled');
  const ad = (title: string) => ({ url: '/ad/x/', title, date: 'Oct 28, 2026 12:00 PM' });
  assert.equal(skipReason(ad('Sale Canceled until further notice: fixer-upper near Jacksonville, FL')), 'cancelled');
  assert.equal(skipReason(ad('Auction adjourned/canceled: picturesque property, Block Island RI coast')), 'cancelled');
  assert.equal(skipReason(ad('Notice of public auction sale: redeemed property')), 'cancelled', 'redeemed: the taxpayer paid');
  assert.equal(skipReason(ad('Single family residence: sale adjourned, new sale date announced')), null);
  assert.equal(skipReason(ad('GSA sale: 2019 Lamborghini Urus 4 dr SUV AWD')), 'gsa', 'GSA Auctions, crawled directly, lists it');
  assert.equal(skipReason({ url: '/ad/x/', title: 'A house', date: '' }), 'no_date');
  assert.equal(skipReason(ad('Seeking guaranteed bidder: Lakeville, MN home')), null);
});

test('titles lose their decoration; sale kinds come from the title', () => {
  const fire = String.fromCodePoint(0x1f525);
  assert.equal(cleanTitle(`${fire}RARE RIVERFRONT!!! VACANT LOT${fire}  `), 'RARE RIVERFRONT!!! VACANT LOT');
  assert.equal(cleanTitle('2016 Bentley Continental GT convertible!'), '2016 Bentley Continental GT convertible!');
  assert.equal(saleKind('Judicial Sale: log home with a view of the Allegheny River'), 'judicial');
  assert.equal(saleKind('Sealed bid sale: acquired property, approx. 2 acres'), 'acquired');
  assert.equal(saleKind('Half interest in a house and acreage!!!'), 'seized');
});

// ------------------------------------------------------------- normalizing

test('a sale placed from its notice: minimum bid, local time, city-less place, no personal details', () => {
  const n = normalizeIrsCard(card('half-interest-house-acreage'), READ_DAY)!;
  const { lot, auction } = n;
  assert.equal(n.placed, 'notice');
  assert.equal(lot.externalId, 'half-interest-house-acreage');
  assert.equal(lot.title, 'Half interest in a house and acreage!!!');
  assert.equal(lot.url, 'https://www.irsauctions.gov/ad/half-interest-house-acreage/');
  assert.equal(lot.startingBidCents, 8_148_000);
  assert.equal(lot.currentBidCents, null);
  assert.equal(lot.closesAt, '2026-10-28T12:00:00-04:00', 'noon in North Carolina, still on daylight time');
  assert.equal(lot.closed, false);
  assert.deepEqual(lot.pickup, { line1: null, city: null, state: 'NC', postalCode: '27537', ambiguous: false });
  assert.equal(lot.saleLevel, undefined, 'one property: a lot, not a sale-level row');
  assert.equal(lot.images.length, 1);
  assert.match(lot.images[0].url, /^https:\/\/www\.irsauctions\.gov\/sites\/default\/files\//);
  assert.equal(auction.auctioneer, 'Internal Revenue Service');
  assert.equal(auction.format, 'live');
  assert.equal(auction.timezone, 'America/New_York');
  assert.equal(auction.lotCount, 1);
  assert.equal(auction.ships, false);

  // The notice names the taxpayer and the IRS officer; neither is kept anywhere.
  const kept = JSON.stringify({ lot, auction });
  for (const personal of ['Paul Reed', 'paul.reed', '@irs.gov', '(770)', 'Cedar Grove Dr.', 'Woodcock']) {
    assert.ok(!kept.includes(personal), `stored rows contain "${personal}"`);
  }
  assert.equal((lot.raw as Record<string, unknown>).content, undefined);
  assert.match(lot.description!, /^IRS sale of seized property/);
  const meta = (lot.raw as { _meta: Record<string, unknown> })._meta;
  assert.deepEqual([meta.closeTimePrecise, meta.timezoneBasis, meta.locationSource], [true, 'state', 'notice']);
});

test('sales placed from their cards, in their own states\' zones', () => {
  const pembroke = normalizeIrsCard(card('rare-riverfront-vacant-lot-pembroke-nhwhittemore-rd'), EARLY)!.lot;
  assert.equal(pembroke.title, 'RARE RIVERFRONT!!! VACANT LOT IN PEMBROKE, NH(WHITTEMORE RD)');
  assert.deepEqual(pembroke.pickup, { line1: null, city: 'Pembroke', state: 'NH', postalCode: '03275', ambiguous: false });
  assert.equal(pembroke.closesAt, '2026-09-24T10:00:00-04:00');
  assert.equal(pembroke.startingBidCents, 9_000_000);

  const bentley = normalizeIrsCard(card('2016-bentley-continental-gt-convertible-brand-new'), EARLY)!.lot;
  assert.equal(bentley.startingBidCents, null, 'the card gives no minimum bid');
  assert.equal(bentley.closesAt, '2026-09-15T11:00:00-05:00', 'Houston: central daylight time');
  const meta = (bentley.raw as { _meta: Record<string, unknown> })._meta;
  assert.deepEqual([meta.closeTimePrecise, meta.timezoneBasis], [false, 'state-primary'], 'Texas spans two zones');

  const abbeville = normalizeIrsCard(card('7863-acres-more-or-less-seized-agricultural-land-sale-abbeville-louisiana'), EARLY)!.lot;
  assert.equal(abbeville.closesAt, '2026-09-22T11:30:00-05:00');
  assert.equal(abbeville.startingBidCents, 1_887_000);
  assert.equal(abbeville.pickup?.city, 'Abbeville');

  const ohio = normalizeIrsCard(card('agricultural-land-about-100420-acres-south-charleston-oh'), EARLY)!.lot;
  assert.equal(ohio.startingBidCents, 57_000_000);
  assert.equal(ohio.pickup?.postalCode, '45368', 'the land, not the courtroom where it is sold');
});

test('the sample, before the September sales: five current, one cancelled, six pages that are not sales', () => {
  const r = normalizeIrsIndex(CARDS, EARLY);
  assert.deepEqual(r.counts, { kept: 5, not_a_sale: 6, cancelled: 1, gsa: 0, no_date: 0, past: 0, unplaced: 0, placedFromNotice: 1, malformed: 0 });
  assert.equal(r.lots.length, 5);
  assert.equal(r.auctions.length, 5);
  assert.deepEqual(r.warnings, []);
  for (const lot of r.lots) assert.ok(lot.pickup?.state && lot.pickup.postalCode, lot.externalId);
});

test('the sample on the day it was read: only the October sale is still ahead', () => {
  const r = normalizeIrsIndex(CARDS, READ_DAY);
  assert.equal(r.counts.kept, 1);
  assert.equal(r.counts.past, 4);
  assert.deepEqual(r.lots.map((l) => l.externalId), ['half-interest-house-acreage']);
});

test('a sale whose hour has passed today is past, not current', () => {
  const pembroke = card('rare-riverfront-vacant-lot-pembroke-nhwhittemore-rd');
  const before = new Date(Date.parse(zonedIso(2026, 9, 24, 9, 59, 'America/New_York')));
  const after = new Date(Date.parse(zonedIso(2026, 9, 24, 10, 1, 'America/New_York')));
  assert.equal(normalizeIrsIndex([pembroke], before).counts.kept, 1);
  assert.equal(normalizeIrsIndex([pembroke], after).counts.past, 1);
});

test('odd input yields counts and warnings, never a throw', () => {
  assert.deepEqual(normalizeIrsIndex({ not: 'an array' }, READ_DAY).warnings, ['index.json is not an array of cards.']);
  const r = normalizeIrsIndex([null, 7, { url: '/ad/x/', title: '', date: 'Oct 28, 2026 12:00 PM' }], READ_DAY);
  assert.equal(r.counts.malformed, 3);
  assert.equal(r.lots.length, 0);
  const noPlace = normalizeIrsIndex([{ url: '/ad/y/', title: 'A lot', date: 'Oct 28, 2026 12:00 PM', content: 'A lot' }], READ_DAY);
  assert.equal(noPlace.counts.unplaced, 1);
  assert.equal(noPlace.lots[0].pickup, null);
  assert.deepEqual(noPlace.warnings, ['1 current sale(s) name no state or ZIP; kept without a place.']);
});

// -------------------------------------------------------------------- run()

function source(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'src-irs',
    slug: 'irs-auctions',
    name: 'IRS Auctions',
    url: 'https://www.irsauctions.gov',
    apiBase: null,
    robotsUrl: 'https://www.irsauctions.gov/robots.txt',
    tier: 'federal',
    ingest: 'internal_json',
    platform: 'irs-auctions',
    states: null,
    rateLimitRpm: 10,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 60,
    consecutiveFailures: 0,
    ...over,
  };
}

const INDEX_URL = 'https://www.irsauctions.gov/index.json';
const ROBOTS = 'User-agent: *\nAllow: /\n\nSitemap: https://irsauctions.gov/sitemap.xml\n';

test('run(): one request for index.json, a complete snapshot of the current sales', async () => {
  const calls: string[] = [];
  const fetch: Fetcher = async (url) => {
    calls.push(url);
    return url === INDEX_URL ? { status: 200, headers: {}, text: JSON.stringify(CARDS) } : { status: 404, headers: {}, text: '' };
  };
  const ctx: AdapterContext = { source: source(), fetch, now: () => EARLY, log: () => {}, secrets: {} };
  const res = await runIrsAuctions(ctx);
  assert.deepEqual(calls, [INDEX_URL]);
  assert.equal(res.lots.length, 5);
  assert.equal(res.completeSnapshot, true);
  assert.equal(res.stats.httpRequests, 1);
});

test('run(): a refusal or an unreadable body fails the run', async () => {
  const at = (status: number, text: string) => {
    const fetch: Fetcher = async () => ({ status, headers: {}, text });
    return { source: source(), fetch, now: () => EARLY, log: () => {}, secrets: {} } as AdapterContext;
  };
  await assert.rejects(runIrsAuctions(at(403, 'Access Denied')), /HTTP 403\. Not retried/);
  await assert.rejects(runIrsAuctions(at(500, 'oops')), /HTTP 500/);
  await assert.rejects(runIrsAuctions(at(200, '<html>not json</html>')), /not valid JSON/);
});

test('run() behind the real crawl gate: robots.txt allows index.json', async () => {
  const served: string[] = [];
  const gated = gateFetcher({
    rawFetch: async (url) => {
      served.push(url);
      if (url === 'https://www.irsauctions.gov/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, text: ROBOTS };
      if (url === INDEX_URL) return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(CARDS) };
      return { status: 404, headers: {}, text: '' };
    },
    rateLimitRpm: 10,
    sleep: async () => {},
    now: () => EARLY.getTime(),
  });
  const ctx: AdapterContext = { source: source(), fetch: gated, now: () => EARLY, log: () => {}, secrets: {} };
  const res = await runIrsAuctions(ctx);
  assert.deepEqual(served, ['https://www.irsauctions.gov/robots.txt', INDEX_URL]);
  assert.deepEqual(gated.stats().refusals, []);
  assert.equal(res.lots.length, 5);
});

test('adapter identity', () => {
  assert.equal(irsAuctionsAdapter.key, 'irs-auctions');
  assert.equal(irsAuctionsAdapter.method, 'internal_json');
});
