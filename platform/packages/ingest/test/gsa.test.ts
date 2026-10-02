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
  sanitizeZip,
  field,
  htmlToText,
  parseLotInfo,
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

test('LotInfo descriptions are ordered by LotSequence; instructions go to terms', () => {
  const { lots } = normalizeGsaResponse(fixture);
  const gen = lots.find((l) => l.externalId === '21QSCI25001/1')!;
  // Fixture deliberately lists sequence 2 before sequence 1.
  assert.ok(
    gen.description!.startsWith('Diesel generator set'),
    `expected sequence-1 text first, got: ${gen.description}`,
  );
  // Behavior change, deliberate: instructions used to be appended to the
  // description. Live data showed they are near-identical logistics on every lot,
  // so counting them inflated every listing's apparent detail (hiding sleepers)
  // and made every lot match a search for "inspection". The buyer still sees them.
  assert.doesNotMatch(gen.description!, /Inspection by appointment/);
  assert.match(
    (gen.raw as any)._meta.terms,
    /Inspection: Inspection by appointment only\. Call 414-555-0100\./,
  );
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

// ======================================================================
// LIVE-SHAPE TESTS
//
// Everything above was written from GSA's openapi.yaml. The live API turned out
// to differ in envelope, casing, and five field types, and against real data the
// adapter produced ZERO lots while every test above passed. The tests below run
// against records captured from the real endpoint on 2026-09-27, so they fail if
// the adapter drifts from what GSA actually sends.
// ======================================================================

const liveText = readFileSync(join(here, 'fixtures', 'gsa-live-2026-09-27.json'), 'utf8');
const live = JSON.parse(liveText);

test('LIVE: the capitalized Results envelope is read (the actual zero-lots bug)', () => {
  const { lots, warnings } = normalizeGsaResponse(live);
  assert.equal(lots.length, 4, `expected 4 lots, got ${lots.length}; warnings: ${warnings}`);
  assert.deepEqual(warnings, []);
});

test('LIVE: a Milwaukee lot sold by an Arizona office is pickup WI, seller AZ', () => {
  const { lots } = normalizeGsaResponse(live);
  const tw = lots.find((l) => l.title === 'Typewriters')!;
  assert.equal(tw.externalId, '2-1-QSC-I-26-390/40');
  assert.equal(tw.lotNumber, '040'); // display keeps the source's own form
  assert.equal(tw.pickup!.state, 'WI');
  assert.equal(tw.pickup!.city, 'Milwaukee');
  assert.equal(tw.pickup!.postalCode, '53203');
  // addr1 is the occupant ("U.S. Dept. of HUD"); the street is addr2.
  assert.equal(tw.pickup!.line1, '310 W. Wisconsin Avenue, Suite 950W');
  assert.equal((tw.raw as any)._meta.sellerState, 'AZ');
  assert.equal(tw.url, 'https://www.gsaauctions.gov/auctions/preview/377880');
  assert.equal(tw.images[0].url, 'https://www.ppms.gov/gw/auction/ppms/api/v1/auction/image/21QSCI26390040.jpg');
});

test('LIVE: "85007null" zips are repaired, and garbage is refused rather than guessed', () => {
  assert.equal(sanitizeZip('85007null'), '85007');
  assert.equal(sanitizeZip('53703-1234'), '53703');
  assert.equal(sanitizeZip(' 02108null '), '02108'); // leading zero kept: it is a string
  assert.equal(sanitizeZip('null'), null);
  assert.equal(sanitizeZip('1234'), null);
  assert.equal(sanitizeZip(null), null);
});

test('LIVE: boilerplate is separated from the description and kept as terms', () => {
  const { lots } = normalizeGsaResponse(live);
  const tw = lots.find((l) => l.title === 'Typewriters')!;
  assert.match(tw.description!, /This lot contains 4 typewriters/);
  assert.match(tw.description!, /Condition & Markings|Parts may be missing/);
  // The ~150 identical words on every lot must not count as description...
  assert.doesNotMatch(tw.description!, /Removal Responsibilities|not warranted/);
  // ...but the buyer still needs them.
  const terms = (tw.raw as any)._meta.terms as string;
  assert.match(terms, /Removal Responsibilities/);
  assert.match(terms, /not warranted/);
  assert.match(terms, /Inspection: .*Monday through Friday/);
  // Entities decoded, not shown raw.
  assert.doesNotMatch(tw.description!, /&amp;/);
});

test('LIVE: Specifications become brand and model a hunt can match', () => {
  const { lots } = normalizeGsaResponse(live);
  const dell = lots.find((l) => l.title === 'Dell Laptops')!;
  assert.equal(dell.brand, 'Dell');
  assert.equal(dell.model, '5320');

  const truck = lots.find((l) => l.title === '2004 Ford F-350')!;
  assert.equal(truck.brand, 'Ford');
  assert.equal(truck.model, '2004 F-350 4x4');
  assert.equal((truck.raw as any)._meta.vin, '1FTSF31L94ED77243');
  assert.equal((truck.raw as any)._meta.mileage, '70000');
  // Vehicle Documentation is boilerplate too.
  assert.doesNotMatch(truck.description!, /SF-97/);
  assert.match((truck.raw as any)._meta.terms, /SF-97/);
  // &#39; decoded inside terms.
  assert.match((truck.raw as any)._meta.terms, /purchaser's receipt/);
});

test('LIVE: dollar high bids, bidder counts and the increment are parsed', () => {
  const { lots } = normalizeGsaResponse(live);
  const truck = lots.find((l) => l.title === '2004 Ford F-350')!;
  assert.equal(truck.currentBidCents, 367700);  // highBidAmount 3677 (dollars)
  assert.equal(truck.nextBidCents, 377700);     // + aucIncrement 100
  assert.equal(truck.bidCount, 8);
  assert.equal(truck.pickup!.state, 'KS');
  assert.equal(truck.pickup!.line1, '5020 Tuttle Creek Blvd');

  const tw = lots.find((l) => l.title === 'Typewriters')!;
  assert.equal(tw.currentBidCents, null); // null means no bid, not $0
  assert.equal(tw.bidCount, null);
  assert.equal(tw.nextBidCents, null);
});

test('LIVE: reserve is a boolean flag; it is never mistaken for a dollar amount', () => {
  const { lots } = normalizeGsaResponse(live);
  for (const l of lots) {
    assert.equal((l.raw as any)._meta.hasReserve, true);
    assert.equal(l.estimateLowCents, null); // amount undisclosed
    assert.equal(l.reserveMet, null);       // so reserve_met is unknowable
  }
});

test('LIVE: free-form aircraft listing keeps its text and surfaces the hidden fee', () => {
  const { lots } = normalizeGsaResponse(live);
  const plane = lots.find((l) => l.title.startsWith('1983 Beechcraft'))!;
  assert.equal(plane.currentBidCents, 10010000); // $100,100
  assert.equal(plane.bidCount, 2);
  assert.match(plane.description!, /Total hours - 15,905\.4/);
  // $23k-$25k of removal fees on top of the hammer price. A total-cost display
  // that omitted this would understate the real price by ~25%.
  assert.match((plane.raw as any)._meta.feeNote, /\$23,000 to \$25,000/);
  // Street line chosen over the unit name "309th AMARG".
  assert.equal(plane.pickup!.line1, '4730 S SAFFORD AVE');
  assert.equal(plane.pickup!.city, 'TUCSON');
  assert.equal(plane.pickup!.state, 'AZ');
});

test('LIVE: word statuses decode, and dates are the ISO form', () => {
  assert.equal(decodeStatus('Active'), 'active');
  assert.equal(decodeStatus('Preview'), 'preview');
  assert.equal(decodeStatus('Scheduled'), 'scheduled');
  assert.equal(decodeStatus('Closed'), 'closed');
  // The old first-letter rule would have read these wrongly.
  assert.equal(decodeStatus('Sold'), 'unknown');

  const { lots } = normalizeGsaResponse(live);
  const tw = lots.find((l) => l.title === 'Typewriters')!;
  assert.equal((tw.raw as any)._meta.saleStatus, 'active');
  // 2026-10-02 is EDT, so 23:59:59 Eastern is 03:59:59Z on the 3rd.
  assert.equal(tw.closesAt, '2026-10-03T03:59:59.000Z');
});

test('LIVE: two lots of one sale become one auction', () => {
  const { auctions, lots } = normalizeGsaResponse(live);
  assert.equal(auctions.length, 3);
  assert.equal(lots.filter((l) => l.auctionExternalId === '2-1-QSC-I-26-390').length, 2);
  const hud = auctions.find((a) => a.externalId === '2-1-QSC-I-26-390')!;
  assert.equal(hud.sellerName, 'Department of Housing and Urban Development');
});

test('LIVE: the full adapter path produces lots from the captured body', async () => {
  const fetch: Fetcher = async () => ({ status: 200, headers: {}, text: liveText });
  const result = await gsaAdapter.run(ctxWith(fetch, { GSA_API_KEY: 'k' }));
  assert.equal(result.lots.length, 4);
  assert.deepEqual(result.warnings, []);
});

test('field() reads live camelCase and falls back to documented PascalCase', () => {
  assert.equal(field({ saleNo: 'a' }, 'saleNo'), 'a');
  assert.equal(field({ SaleNo: 'b' }, 'saleNo'), 'b');
  assert.equal(field({ saleNo: 'a', SaleNo: 'b' }, 'saleNo'), 'a');
  assert.equal(field({}, 'saleNo'), undefined);
});

test('htmlToText and parseLotInfo handle entities, lists and unstructured HTML', () => {
  assert.equal(htmlToText('<p>A &amp; B&nbsp;&#39;C&#39;</p>'), "A & B 'C'");
  assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), '• one\n• two');
  const p = parseLotInfo('<p>just text</p>');
  assert.equal(p.description, 'just text');
  assert.equal(p.terms, null);
  assert.deepEqual(parseLotInfo(null), { description: null, terms: null, specs: {}, feeNote: null });
});

test('LIVE: the selling office state is carried on the auction, never as pickup', () => {
  const { auctions } = normalizeGsaResponse(live);
  const hud = auctions.find((a) => a.externalId === '2-1-QSC-I-26-390')!;
  assert.equal(hud.sellerState, 'AZ');
  assert.equal(hud.pickup!.state, 'WI');
});
