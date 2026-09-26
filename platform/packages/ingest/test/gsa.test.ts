import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeGsaResponse,
  normalizeGsaRecord,
  decodeStatus,
  parseGsaDate,
  gsaCloseInstant,
  isUsEasternDst,
  propertyLocation,
  gsaAdapter,
  GSA_API_BASE,
} from '../src/adapters/gsa.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(here, 'fixtures', 'gsa-auctions.json'), 'utf8');
const fixture = JSON.parse(fixtureText);

// ---------------------------------------------------------------- status codes

test('AuctionStatus decodes without trimming away the Scheduled signal', () => {
  // Per fields.html: 'A'=Active, 'P'=Preview, Space=Scheduled.
  // A naive .trim() turns ' ' into '' and loses Scheduled entirely.
  assert.equal(decodeStatus('A'), 'active');
  assert.equal(decodeStatus('P'), 'preview');
  assert.equal(decodeStatus(' '), 'scheduled');
  assert.equal(decodeStatus(''), 'scheduled');
  assert.equal(decodeStatus('a'), 'active');
  assert.equal(decodeStatus(undefined), 'unknown');
  assert.equal(decodeStatus('Z'), 'unknown');
});

// ----------------------------------------------------------------- date parsing

test('parses both 10-character date formats found in US government feeds', () => {
  assert.deepEqual(parseGsaDate('10/04/2026'), { y: 2026, m: 10, d: 4 });
  assert.deepEqual(parseGsaDate('2026-10-04'), { y: 2026, m: 10, d: 4 });
  assert.deepEqual(parseGsaDate('1/4/2026'), { y: 2026, m: 1, d: 4 });
  assert.equal(parseGsaDate('04-10-2026'), null); // ambiguous: refuse
  assert.equal(parseGsaDate('next Tuesday'), null);
  assert.equal(parseGsaDate(undefined), null);
});

test('US Eastern DST boundaries are handled, because an hour matters on a close', () => {
  // 2026: DST runs 2026-03-08 through 2026-11-01.
  assert.equal(isUsEasternDst(2026, 3, 7), false);
  assert.equal(isUsEasternDst(2026, 3, 8), true);
  assert.equal(isUsEasternDst(2026, 10, 31), true);
  assert.equal(isUsEasternDst(2026, 11, 1), false);
  assert.equal(isUsEasternDst(2026, 7, 4), true);
  assert.equal(isUsEasternDst(2026, 1, 15), false);
});

test('a date-only close resolves to 23:59:59 Eastern and is flagged imprecise', () => {
  // October 4 2026 is EDT (-04:00), so 23:59:59 local is 03:59:59Z the next day.
  const oct = gsaCloseInstant('10/04/2026')!;
  assert.equal(oct.iso, '2026-10-05T03:59:59.000Z');
  assert.equal(oct.precise, false);

  // December 15 is EST (-05:00), so 23:59:59 local is 04:59:59Z the next day.
  const dec = gsaCloseInstant('2026-12-15')!;
  assert.equal(dec.iso, '2026-12-16T04:59:59.000Z');

  assert.equal(gsaCloseInstant('garbage'), null);
  assert.equal(gsaCloseInstant('10/04/1823'), null);
});

// ------------------------------------------------- the location distinction

test('PropertyState is pickup; LocationST is the selling agency and must not leak', () => {
  // This is the whole reason a Wisconsin buyer can see Wisconsin inventory: a
  // generator physically in Milwaukee, sold by a GSA region in Philadelphia.
  const { lots } = normalizeGsaResponse(fixture);
  const gen = lots.find((l) => l.externalId === '21QSCI25001/1')!;

  assert.equal(gen.pickup!.state, 'WI');       // where you drive to
  assert.equal(gen.pickup!.city, 'MILWAUKEE');
  assert.equal(gen.pickup!.postalCode, '53295');

  // PA is the agency's state. It must never appear as the pickup state.
  assert.notEqual(gen.pickup!.state, 'PA');
  assert.equal((gen.raw as any)._meta.sellerState, 'PA');
});

test('state codes are normalized to uppercase two-letter', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const furniture = lots.find((l) => l.externalId === '71QSCI24099/3')!;
  assert.equal(furniture.pickup!.state, 'WI'); // fixture has lowercase "wi"
});

test('ZIP+4 is truncated to the 5-digit centroid key', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const furniture = lots.find((l) => l.externalId === '71QSCI24099/3')!;
  // "53703-1234" -> "53703", which is what postal_codes is keyed on.
  assert.equal(furniture.pickup!.postalCode, '53703');
});

test('a city with no state is flagged ambiguous rather than guessed', () => {
  // The fixture's Beloit record has PropertyCity but no PropertyState. There is a
  // Beloit in Wisconsin AND in Kansas, so inferring would be actively harmful.
  const { lots } = normalizeGsaResponse(fixture);
  const truck = lots.find((l) => l.externalId === '39QSCI25044/7')!;
  assert.equal(truck.pickup!.city, 'BELOIT');
  assert.equal(truck.pickup!.state, null);
  assert.equal(truck.pickup!.ambiguous, true);
});

test('street address prefers the most specific of the three address lines', () => {
  const loc = propertyLocation({
    PropertyAddr1: 'VA MEDICAL CENTER',
    PropertyAddr2: 'ENGINEERING SERVICE',
    PropertyAddr3: '5000 W NATIONAL AVE',
    PropertyCity: 'MILWAUKEE',
    PropertyState: 'WI',
  })!;
  // Addr3 is documented as the street address, so it wins over the agency name.
  assert.equal(loc.line1, '5000 W NATIONAL AVE');
});

// ------------------------------------------------------------------- money

test('HighBidAmount parses from both string and numeric forms', () => {
  // openapi.yaml types this as string, fields.html as Numeric 8.2. The upstream
  // spec disagrees with itself, which is exactly why the parser takes both.
  const { lots } = normalizeGsaResponse(fixture);

  assert.equal(lots.find((l) => l.externalId === '21QSCI25001/1')!.currentBidCents, 185000);
  assert.equal(lots.find((l) => l.externalId === '71QSCI24099/3')!.currentBidCents, 32550);
  // "" means no bid, which must be null, NOT zero.
  assert.equal(lots.find((l) => l.externalId === '21QSCI25001/2')!.currentBidCents, null);
  // Numeric 0 is a real zero bid and stays 0.
  assert.equal(lots.find((l) => l.externalId === '39QSCI25044/7')!.currentBidCents, 0);
});

test('the source-published increment beats our generic ladder', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const gen = lots.find((l) => l.externalId === '21QSCI25001/1')!;
  // $1,850.00 + $50.00 increment = $1,900.00
  assert.equal(gen.nextBidCents, 190000);
});

test('Reserve maps to the low estimate and drives reserveMet', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const gen = lots.find((l) => l.externalId === '21QSCI25001/1')!;
  assert.equal(gen.estimateLowCents, 250000);   // $2,500 reserve
  assert.equal(gen.reserveMet, false);          // $1,850 < $2,500

  const furniture = lots.find((l) => l.externalId === '71QSCI24099/3')!;
  assert.equal(furniture.reserveMet, true);     // $325.50 >= $150
});

// --------------------------------------------------------------- structure

test('one SaleNo with many items becomes one auction and many lots', () => {
  const { auctions, lots } = normalizeGsaResponse(fixture);
  const sale = auctions.filter((a) => a.externalId === '21QSCI25001');
  assert.equal(sale.length, 1, 'auctions must be deduped by SaleNo');
  assert.equal(lots.filter((l) => l.auctionExternalId === '21QSCI25001').length, 2);
});

test('lot ids are stable and composite, so upserts are idempotent', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const ids = lots.map((l) => l.externalId);
  assert.ok(ids.includes('21QSCI25001/1'));
  assert.ok(ids.includes('21QSCI25001/2'));
  assert.equal(new Set(ids).size, ids.length, 'external ids must be unique');
});

test('LotInfo descriptions are ordered by LotSequence and instructions appended', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const gen = lots.find((l) => l.externalId === '21QSCI25001/1')!;
  // Fixture deliberately lists sequence 2 before sequence 1.
  assert.ok(
    gen.description!.startsWith('Diesel generator set'),
    `expected sequence-1 text first, got: ${gen.description}`,
  );
  assert.match(gen.description!, /Inspection: Inspection by appointment only\. Call 414-555-0100\./);
});

test('records missing SaleNo or ItemName are dropped AND reported', () => {
  const { lots, warnings } = normalizeGsaResponse(fixture);
  // Two bad records in the fixture: one with no SaleNo, one with no ItemName.
  assert.equal(lots.length, 4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped 2 of 6 records/);
});

test('closure is derived from the date, never from AuctionStatus', () => {
  // AuctionStatus has no "closed" value at all ('A'/'P'/' '), so relying on it
  // would leave every expired lot marked open forever.
  const past = normalizeGsaRecord({
    SaleNo: 'X1',
    LotNo: 1,
    ItemName: 'Expired thing',
    AucEndDt: '01/02/2020',
    AuctionStatus: 'A', // still says Active
  })!;
  assert.equal(past.lot.closed, true);

  const future = normalizeGsaRecord({
    SaleNo: 'X2',
    LotNo: 1,
    ItemName: 'Future thing',
    AucEndDt: '01/02/2099',
    AuctionStatus: 'P',
  })!;
  assert.equal(future.lot.closed, false);
});

test('close-time imprecision is recorded so the UI cannot fake a countdown', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const gen = lots.find((l) => l.externalId === '21QSCI25001/1')!;
  const meta = (gen.raw as any)._meta;
  assert.equal(meta.closeTimePrecise, false);
  assert.equal(meta.inactivityMinutes, 15);
  assert.match(meta.closeTimeNote, /date only/);
});

test('GSA lots are pickup-only by default', () => {
  // Claiming shippable would put undeliverable lots into shipping-inclusive
  // searches, which is worse than omitting them.
  const { lots, auctions } = normalizeGsaResponse(fixture);
  assert.ok(lots.every((l) => l.ships === false));
  assert.ok(auctions.every((a) => a.ships === false));
});

test('malformed response bodies degrade instead of throwing', () => {
  assert.deepEqual(normalizeGsaResponse(null).lots, []);
  assert.match(normalizeGsaResponse(null).warnings[0], /not an object or array/);
  assert.deepEqual(normalizeGsaResponse('nope').lots, []);
  // A bare array is tolerated even though the envelope is documented.
  assert.equal(normalizeGsaResponse(fixture.results).lots.length, 4);
});

// ------------------------------------------------------------ adapter plumbing

function ctxWith(fetch: Fetcher, secrets: Record<string, string | undefined> = {}): AdapterContext {
  const source: SourceConfig = {
    id: 'src-gsa',
    slug: 'gsa-auctions',
    name: 'GSA Auctions',
    url: 'https://www.gsaauctions.gov',
    apiBase: GSA_API_BASE,
    tier: 'federal',
    ingest: 'official_api',
    rateLimitRpm: 60,
    ingestAllowed: true,
    robotsAllows: true,
    crawlCadenceMin: 30,
    consecutiveFailures: 0,
  };
  return { source, fetch, now: () => new Date(), log: () => {}, secrets };
}

test('the adapter sends the key as a header, not in the query string', async () => {
  let seenUrl = '';
  let seenHeaders: Record<string, string> = {};
  const fetch: Fetcher = async (url, init) => {
    seenUrl = url;
    seenHeaders = init?.headers ?? {};
    return { status: 200, headers: {}, text: fixtureText };
  };

  const result = await gsaAdapter.run(ctxWith(fetch, { GSA_API_KEY: 'secret-key' }));

  assert.equal(seenHeaders['X-API-KEY'], 'secret-key');
  // A key in the URL leaks into access logs, proxy logs and error reports.
  assert.ok(!seenUrl.includes('secret-key'), `key leaked into URL: ${seenUrl}`);
  assert.equal(seenUrl, `${GSA_API_BASE}/auctions?format=JSON`);
  assert.equal(result.lots.length, 4);
  assert.equal(result.stats.httpRequests, 1);
});

test('a missing API key fails loudly and says where to get one', async () => {
  const fetch: Fetcher = async () => ({ status: 200, headers: {}, text: '{}' });
  await assert.rejects(() => gsaAdapter.run(ctxWith(fetch, {})), /GSA_API_KEY is required/);
});

test('rate limiting is reported distinctly from a generic failure', async () => {
  const fetch: Fetcher = async () => ({ status: 429, headers: {}, text: '' });
  await assert.rejects(
    () => gsaAdapter.run(ctxWith(fetch, { GSA_API_KEY: 'k' })),
    /rate limit/i,
  );
});

test('non-JSON and error responses raise rather than silently returning nothing', async () => {
  const html: Fetcher = async () => ({ status: 200, headers: {}, text: '<html>nope</html>' });
  await assert.rejects(() => gsaAdapter.run(ctxWith(html, { GSA_API_KEY: 'k' })), /not valid JSON/);

  const boom: Fetcher = async () => ({ status: 503, headers: {}, text: '' });
  await assert.rejects(() => gsaAdapter.run(ctxWith(boom, { GSA_API_KEY: 'k' })), /HTTP 503/);
});
