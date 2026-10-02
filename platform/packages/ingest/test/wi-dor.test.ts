import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  itemsFromNotice,
  normalizeDorRows,
  parseDorDates,
  parseDorTable,
  parseDorTime,
  runWiDor,
  wiDorAdapter,
} from '../src/adapters/wi-dor.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

// The "UPCOMING PUBLIC AUCTIONS" table of
// https://www.revenue.wi.gov/Pages/PublicAuction/home.aspx read through
// inspect_url on 2026-10-01, byte for byte (md5 4f3d78cecb1ebbea3f6ee2889da3a231,
// 1,626 characters), SharePoint's &#58; colons and the hidden placeholder row included.
const here = dirname(fileURLToPath(import.meta.url));
const TABLE = readFileSync(join(here, 'fixtures', 'wi-dor-public-auctions-2026-10-01.html'), 'utf8');
const PAGE = `<html><body><p><strong>IMPORTANT&#58; Some auctions require payment in guaranteed funds.</strong></p>${TABLE}</body></html>`;
const NOW = new Date('2026-10-01T18:00:00Z');

test('the table: two sales, the hidden placeholder skipped, SharePoint colons decoded', () => {
  const t = parseDorTable(PAGE);
  assert.equal(t.found, true);
  assert.equal(t.unreadable, 0);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], {
    county: 'Brown',
    dateText: '9/23/2026 - 10/07/2026',
    start: { y: 2026, m: 9, d: 23 },
    end: { y: 2026, m: 10, d: 7 },
    time: 600,
    auctioneer: 'Hansen Auction Group',
    auctioneerUrl: 'https://www.hansenauctiongroup.com/',
    noticeUrl: 'https://www.revenue.wi.gov/Pages/PublicAuction/1994-Jeep-Wrangler-2021-Ford-Expedition.pdf',
    items: ['1994 Jeep Wrangler', '2021 Ford Expedition'],
  });
  assert.deepEqual(t.rows[1].items, ['2011 GMC Yukon XL Denali 4dr']);
});

test('no table is a changed page; only the placeholder is an empty list', () => {
  assert.deepEqual(parseDorTable('<p>Page moved</p>'), { found: false, rows: [], unreadable: 0 });
  const onlyPlaceholder = TABLE.replace(/<\/tr><tr><td data-title="County">Brown[\s\S]*<\/tr><\/tbody>/, '</tr></tbody>');
  assert.deepEqual(parseDorTable(onlyPlaceholder), { found: true, rows: [], unreadable: 0 });
});

test('dates, times and item names are read strictly', () => {
  assert.deepEqual(parseDorDates('10/14/2026'), { start: { y: 2026, m: 10, d: 14 }, end: { y: 2026, m: 10, d: 14 } });
  assert.equal(parseDorDates('10/07/2026 - 9/23/2026'), null); // backwards
  assert.equal(parseDorDates('No scheduled auctions at this time.'), null);
  assert.equal(parseDorTime('10:00 a.m.'), 600);
  assert.equal(parseDorTime('1:30 PM'), 810);
  assert.equal(parseDorTime('12:00 p.m.'), 720);
  assert.equal(parseDorTime('TBA'), null);
  // A file name that does not start with a model year is not read as items.
  assert.deepEqual(itemsFromNotice('/Pages/PublicAuction/Notice-of-Sale-Brown.pdf'), []);
  assert.deepEqual(itemsFromNotice(null), []);
});

test('sale rows: an online range closes at the end of its last day, time not claimed', () => {
  const { auctions, lots, past } = normalizeDorRows(parseDorTable(PAGE).rows, NOW);
  assert.equal(past, 0);
  assert.equal(lots.length, 2);
  const brown = lots[0];
  assert.equal(brown.externalId, 'sale:brown:2026-09-23');
  assert.equal(brown.saleLevel, true);
  assert.equal(brown.title, 'Wisconsin DOR seized-property sale, Brown County: 1994 Jeep Wrangler, 2021 Ford Expedition');
  assert.equal(brown.closesAt, '2026-10-07T23:59:59-05:00');
  assert.equal((brown.raw as any)._meta.closeTimePrecise, false);
  assert.equal(brown.url, 'https://www.revenue.wi.gov/Pages/PublicAuction/1994-Jeep-Wrangler-2021-Ford-Expedition.pdf');
  assert.deepEqual([brown.startingBidCents, brown.bidCount, brown.pickup!.state, brown.pickup!.city], [null, null, 'WI', null]);
  assert.match(brown.description!, /^Sold through Hansen Auction Group from 9\/23\/2026 to 10\/07\/2026\. /);
  const a = auctions[0];
  assert.deepEqual([a.format, a.startsAt, a.endsAt, a.auctioneer, a.sellerName],
    ['online', '2026-09-23T10:00:00-05:00', '2026-10-07T23:59:59-05:00', 'Hansen Auction Group', 'Wisconsin Department of Revenue']);
});

test('a closed sale is left out; a one-day sale is live at its listed time', () => {
  const rows = parseDorTable(PAGE).rows;
  assert.equal(normalizeDorRows(rows, new Date('2026-10-08T06:00:00Z')).past, 1); // Brown closed, Milwaukee open
  const oneDay = { ...rows[0], dateText: '10/14/2026', start: { y: 2026, m: 10, d: 14 }, end: { y: 2026, m: 10, d: 14 } };
  const { auctions, lots } = normalizeDorRows([oneDay], NOW);
  assert.equal(auctions[0].format, 'live');
  assert.equal(lots[0].closesAt, '2026-10-14T10:00:00-05:00');
  assert.equal((lots[0].raw as any)._meta.closeTimePrecise, true);
});

const SOURCE: SourceConfig = {
  id: 'src-dor',
  slug: 'wi-dor-auctions',
  name: 'Wisconsin Department of Revenue Public Auctions',
  url: 'https://www.revenue.wi.gov/Pages/PublicAuction/home.aspx',
  apiBase: null,
  tier: 'state',
  ingest: 'html',
  platform: 'wi-dor',
  states: ['WI'],
  rateLimitRpm: 10,
  ingestAllowed: true,
  robotsAllows: true,
  crawlCadenceMin: 60,
  consecutiveFailures: 0,
};
const ctxWith = (fetch: Fetcher): AdapterContext => ({ source: SOURCE, fetch, now: () => NOW, log: () => {}, secrets: {} });

test('run(): one request, a complete snapshot; a missing table fails the run', async () => {
  const urls: string[] = [];
  const res = await runWiDor(ctxWith(async (url) => {
    urls.push(url);
    return { status: 200, headers: {}, text: PAGE };
  }));
  assert.deepEqual(urls, ['https://www.revenue.wi.gov/Pages/PublicAuction/home.aspx']);
  assert.equal(res.lots.length, 2);
  assert.equal(res.completeSnapshot, true);
  await assert.rejects(runWiDor(ctxWith(async () => ({ status: 200, headers: {}, text: '<p>moved</p>' }))), /UPCOMING PUBLIC AUCTIONS/);
  await assert.rejects(runWiDor(ctxWith(async () => ({ status: 503, headers: {}, text: '' }))), /HTTP 503/);
});

test('adapter key is the sources.platform value', () => {
  assert.equal(wiDorAdapter.key, 'wi-dor');
  assert.equal(wiDorAdapter.method, 'html');
});
