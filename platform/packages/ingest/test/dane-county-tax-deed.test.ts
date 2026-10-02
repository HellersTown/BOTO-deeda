import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DANE_OFFERS_ID,
  daneCountyTaxDeedAdapter,
  danePhase,
  municipalityName,
  normalizeDaneRows,
  parseDaneDue,
  parseDaneTable,
  runDaneCountyTaxDeed,
} from '../src/adapters/dane-county-tax-deed.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

// https://treasurer.danecounty.gov/taxdeedauction read through inspect_url on
// 2026-10-01: the tab header with its count, the whole Available Parcels table
// and the first row of the Sold table, where the cut falls. Reassembled from
// two windows of one response and checked against it: md5
// e7b94da6729eef09a96263a1ae7653a4 over the same 19,370 characters.
const here = dirname(fileURLToPath(import.meta.url));
const LISTING = readFileSync(join(here, 'fixtures', 'dane-taxdeed-listing-2026-10-01.html'), 'utf8');

/** 1:00 PM CDT on capture day, five days before the bids are due. */
const NOW = new Date('2026-10-01T18:00:00Z');

test('the available table: 20 rows, the count it shows, and nothing from the sold history', () => {
  const t = parseDaneTable(LISTING);
  assert.equal(t.found, true);
  assert.equal(t.badge, 20);
  assert.equal(t.rows.length, 20);
  assert.equal(t.unreadable, 0);
  assert.ok(!t.rows.some((r) => r.parcel === '0506-312-8375-0'), 'the sold Perry parcel is not available');
  const first = t.rows[0];
  assert.deepEqual(
    { ...first, due: first.due },
    {
      municipality: 'BELLEVILLE',
      kind: 'VILLAGE',
      hasStreet: true,
      parcel: '0508-343-6145-4',
      due: { y: 2026, m: 10, d: 6, h: 13, mi: 0 },
      dueText: '10/6/2026 1:00 PM',
      minimumText: '$175000.00',
      minimumCents: 17_500_000,
      detailId: '181',
      detailUrl: 'https://treasurer.danecounty.gov/TaxDeedAuction/Detail/181',
      parcelUrl: 'https://accessdane.countyofdane.com/Parcel/Index/050834361454',
    },
  );
  // A town parcel with nothing after the <br />.
  assert.deepEqual([t.rows[1].municipality, t.rows[1].kind, t.rows[1].hasStreet], ['ALBION', 'TOWN', false]);
});

test('a missing table is reported as missing, not as an empty sale', () => {
  const t = parseDaneTable('<html><body>Down for maintenance</body></html>');
  assert.deepEqual(t, { found: false, badge: null, rows: [], unreadable: 0 });
});

test('bid-due times and municipality names', () => {
  assert.deepEqual(parseDaneDue('10/22/2024 1:30 PM'), { y: 2024, m: 10, d: 22, h: 13, mi: 30 });
  assert.deepEqual(parseDaneDue('6/2/2026 12:00 AM'), { y: 2026, m: 6, d: 2, h: 0, mi: 0 });
  assert.deepEqual(parseDaneDue('6/2/2026 12:15 PM'), { y: 2026, m: 6, d: 2, h: 12, mi: 15 });
  assert.equal(parseDaneDue('13/2/2026 1:00 PM'), null);
  assert.equal(parseDaneDue('soon'), null);
  assert.equal(municipalityName({ municipality: 'SUN PRAIRIE', kind: 'CITY' }), 'City of Sun Prairie');
  assert.equal(municipalityName({ municipality: 'COTTAGE GROVE', kind: 'TOWN' }), 'Town of Cottage Grove');
  assert.equal(municipalityName({ municipality: 'MAZOMANIE', kind: 'VILLAGE' }), 'Village of Mazomanie');
});

test('phases by the clock: sealed bid, awarding, then a standing offer', () => {
  const due = { y: 2026, m: 10, d: 6, h: 13, mi: 0 };
  assert.deepEqual(danePhase(due, NOW), { phase: 'sealed_bid', closesAt: '2026-10-06T13:00:00-05:00' });
  // Due at 1:00 PM Tuesday; opened Wednesday; offers from Thursday.
  assert.equal(danePhase(due, new Date('2026-10-06T18:00:00Z')).phase, 'awarding');
  assert.equal(danePhase(due, new Date('2026-10-08T04:59:00Z')).phase, 'awarding'); // 11:59 PM Wednesday CDT
  assert.equal(danePhase(due, new Date('2026-10-08T05:00:00Z')).phase, 'offers'); // midnight Thursday CDT
  // Month end: due Tuesday March 31, offers from Thursday April 2.
  assert.equal(danePhase({ y: 2026, m: 3, d: 31, h: 13, mi: 0 }, new Date('2026-04-02T04:59:00Z')).phase, 'awarding');
  assert.equal(danePhase({ y: 2026, m: 3, d: 31, h: 13, mi: 0 }, new Date('2026-04-02T05:00:00Z')).phase, 'offers');
});

test('the October 6 sale: 17 sealed-bid parcels, 2 standing offers, the re-offered parcel once', () => {
  const { auctions, lots, counts, warnings } = normalizeDaneRows(parseDaneTable(LISTING).rows, NOW);
  assert.deepEqual(counts, { sealedBid: 17, awarding: 0, offers: 2, superseded: 1, undated: 0, unpriced: 0 });
  assert.deepEqual(warnings, ['1 earlier listing(s) of a re-offered parcel were replaced by the latest.']);
  assert.equal(lots.length, 19);

  const sale = auctions.find((a) => a.externalId === 'sale:2026-10-06')!;
  assert.equal(sale.title, 'Dane County tax-deed sale: sealed bids due Oct 6, 2026, 1:00 PM');
  assert.equal(sale.format, 'sealed_bid');
  assert.equal(sale.endsAt, '2026-10-06T13:00:00-05:00');
  assert.equal(sale.timezone, 'America/Chicago');
  assert.equal(sale.lotCount, 17);
  assert.equal(sale.auctioneer, 'Dane County Treasurer');

  const offers = auctions.find((a) => a.externalId === DANE_OFFERS_ID)!;
  assert.equal(offers.format, 'fixed_price');
  assert.equal(offers.endsAt, null);
  assert.equal(offers.lotCount, 2);

  // DeForest was listed for 6/2/2026 at $335,700 and again for 10/6/2026 at
  // $260,000: only the current listing stands.
  const deforest = lots.filter((l) => l.lotNumber === '0910-182-2079-5');
  assert.equal(deforest.length, 1);
  assert.deepEqual([deforest[0].externalId, deforest[0].startingBidCents], ['bid:177', 26_000_000]);

  const belleville = lots.find((l) => l.externalId === 'bid:181')!;
  assert.equal(belleville.title, 'Tax-deeded parcel 0508-343-6145-4, Village of Belleville');
  assert.equal(belleville.auctionExternalId, 'sale:2026-10-06');
  assert.equal(belleville.closesAt, '2026-10-06T13:00:00-05:00');
  assert.equal(belleville.closed, false);
  assert.equal(belleville.nextBidCents, 17_500_000); // the app shows the minimum as "Opens at"
  assert.equal(belleville.url, 'https://treasurer.danecounty.gov/TaxDeedAuction/Detail/181');
  assert.deepEqual(belleville.pickup, { line1: null, city: 'Belleville', state: 'WI', postalCode: null, lat: null, lon: null, ambiguous: false });

  // Fitchburg (2024) and Madison (2022) went unsold: open offers at the minimum.
  const standing = lots.filter((l) => l.auctionExternalId === DANE_OFFERS_ID);
  assert.deepEqual(standing.map((l) => l.externalId).sort(), ['offer:124', 'offer:147']);
  assert.ok(standing.every((l) => l.closesAt === null && l.closed === false && l.startingBidCents === 10_000));
});

test('PRIVACY: no street address anywhere in what is emitted', () => {
  const { auctions, lots } = normalizeDaneRows(parseDaneTable(LISTING).rows, NOW);
  const emitted = JSON.stringify({ auctions, lots });
  for (const street of ['34 E CHURCH ST', 'CHURCH', '2302 PRAIRIE RD', 'BELIN', 'PFLAUM', 'FEMRITE', 'MARSH RD',
    'LIBERTY ST', '113 STATE ST', 'MANUFACTURERS', 'TALON', '122 W MAIN', 'TRAILSIDE']) {
    assert.ok(!emitted.includes(street), street);
  }
  assert.ok(lots.every((l) => l.pickup!.line1 === null));
});

test('after the due time the sale\'s lots close, and later become standing offers', () => {
  const rows = parseDaneTable(LISTING).rows;
  const awarding = normalizeDaneRows(rows, new Date('2026-10-07T15:00:00Z')); // Wednesday morning
  assert.equal(awarding.counts.awarding, 17);
  assert.ok(awarding.lots.filter((l) => l.auctionExternalId === 'sale:2026-10-06').every((l) => l.closed));
  const later = normalizeDaneRows(rows, new Date('2026-10-12T15:00:00Z'));
  assert.equal(later.counts.offers, 19);
  assert.deepEqual(later.auctions.map((a) => a.externalId), [DANE_OFFERS_ID]);
  assert.ok(later.lots.every((l) => l.externalId.startsWith('offer:')));
});

const SOURCE: SourceConfig = {
  id: 'src-dane',
  slug: 'dane-county-tax-deed',
  name: 'Dane County Tax Deed Auction',
  url: 'https://treasurer.danecounty.gov/taxdeedauction',
  apiBase: null,
  tier: 'county',
  ingest: 'html',
  platform: 'dane-county-tax-deed',
  states: ['WI'],
  rateLimitRpm: 10,
  ingestAllowed: true,
  robotsAllows: true,
  crawlCadenceMin: 60,
  consecutiveFailures: 0,
};

function ctxWith(fetch: Fetcher): AdapterContext {
  return { source: SOURCE, fetch, now: () => NOW, log: () => {}, secrets: {} };
}

test('run(): one request for the listing, a complete snapshot when every row is read', async () => {
  const urls: string[] = [];
  const res = await runDaneCountyTaxDeed(ctxWith(async (url) => {
    urls.push(url);
    return { status: 200, headers: {}, text: LISTING };
  }));
  assert.deepEqual(urls, ['https://treasurer.danecounty.gov/taxdeedauction']);
  assert.equal(res.lots.length, 19);
  assert.equal(res.completeSnapshot, true);
  assert.equal(res.stats.httpRequests, 1);
});

test('run(): a page without the table fails the run; a count mismatch is not a snapshot', async () => {
  await assert.rejects(
    runDaneCountyTaxDeed(ctxWith(async () => ({ status: 200, headers: {}, text: '<p>maintenance</p>' }))),
    /available-parcels table/,
  );
  await assert.rejects(
    runDaneCountyTaxDeed(ctxWith(async () => ({ status: 403, headers: {}, text: '' }))),
    /HTTP 403/,
  );
  const short = LISTING.replace('badge-primary">20<', 'badge-primary">21<');
  const res = await runDaneCountyTaxDeed(ctxWith(async () => ({ status: 200, headers: {}, text: short })));
  assert.equal(res.completeSnapshot, false);
  assert.ok(res.warnings.some((w) => /counts 21 available parcels/.test(w)));
});

test('adapter key is the sources.platform value', () => {
  assert.equal(daneCountyTaxDeedAdapter.key, 'dane-county-tax-deed');
  assert.equal(daneCountyTaxDeedAdapter.method, 'html');
});
