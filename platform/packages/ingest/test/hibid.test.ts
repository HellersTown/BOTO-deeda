import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  tenantFromUrl,
  tenantUrls,
  catalogUrl,
  catalogIdsFromHtml,
  extractBuyerPremium,
  extractCardFee,
  probeTenant,
  normalizeCatalogPage,
  parseRssAuctions,
  hibidAdapter,
} from '../src/adapters/hibid.ts';
import type { AdapterContext, Fetcher, SourceConfig } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const lotHtml = readFileSync(join(here, 'fixtures', 'hibid-style-lot.html'), 'utf8');

// ------------------------------------------------------------------- tenancy

test('subdomain and white-label hosts are the same thing to this adapter', () => {
  // This equivalence is what makes onboarding a WI auction house an INSERT.
  const sub = tenantFromUrl('https://hameleauctions.hibid.com/auctions')!;
  assert.equal(sub.slug, 'hameleauctions');
  assert.equal(sub.isHibidSubdomain, true);

  const white = tenantFromUrl('https://bids.beloitauction.com/auctions')!;
  assert.equal(white.slug, 'beloitauction');
  assert.equal(white.isHibidSubdomain, false);

  // Both produce a usable tenant. Neither needed its own adapter.
  assert.equal(sub.host, 'hameleauctions.hibid.com');
  assert.equal(white.host, 'bids.beloitauction.com');
});

test('handles bare hostnames, central hibid.com, and junk', () => {
  assert.equal(tenantFromUrl('auctionwi.hibid.com')!.slug, 'auctionwi');
  assert.equal(tenantFromUrl('https://hibid.com')!.slug, 'hibid-central');
  assert.equal(tenantFromUrl('https://www.hibid.com/wisconsin')!.slug, 'hibid-central');
  assert.equal(tenantFromUrl('not a url at all !!')!, null);
  assert.equal(tenantFromUrl(''), null);
});

test('entry points follow the verified URL shapes', () => {
  const t = tenantFromUrl('hameleauctions.hibid.com')!;
  const u = tenantUrls(t);
  assert.equal(u.auctions, 'https://hameleauctions.hibid.com/auctions');
  assert.equal(u.pastAuctions, 'https://hameleauctions.hibid.com/auctions/past');
  assert.equal(u.robots, 'https://hameleauctions.hibid.com/robots.txt');
  assert.equal(catalogUrl(t, 619877, 'beloit-real-estate-auction'),
    'https://hameleauctions.hibid.com/catalog/619877/beloit-real-estate-auction');
});

// --------------------------------------------------- catalogue discovery

test('catalogue ids come from href shape, not CSS classes', () => {
  // /catalog/{id}/ is a routing contract the site cannot break without breaking
  // its own links. A class name is cosmetic and changes on any restyle.
  const html = `
    <a href="/catalog/619877/beloit-real-estate-auction">Beloit Real Estate</a>
    <a href="https://hameleauctions.hibid.com/catalog/620114/september-estate">September</a>
    <a href="/catalog/619877/beloit-real-estate-auction#lots">dupe, same id</a>
    <a href="/catalog/12/too-short">short but valid</a>
    <a href="/catalogue/999/not-matching">wrong path</a>
    <a href="/auctions">not a catalog</a>`;
  const ids = catalogIdsFromHtml(html);
  assert.deepEqual(ids.sort(), ['619877', '620114']);
  // Deduped, and the 2-digit id is correctly rejected by the {3,12} bound.
  assert.ok(!ids.includes('12'));
  assert.ok(!ids.includes('999'));
});

test('an auction list with no catalogues returns empty, not garbage', () => {
  assert.deepEqual(catalogIdsFromHtml('<html><body>No auctions at this time</body></html>'), []);
  assert.deepEqual(catalogIdsFromHtml(''), []);
});

// ------------------------------------------------------------ buyer premium

test("buyer's premium is extracted from real terms phrasing", () => {
  // Hamele's actual published terms.
  assert.equal(
    extractBuyerPremium('A 10% online buyer premium is added to all sales.')!.pct, 10);
  assert.equal(
    extractBuyerPremium("15% Buyer's Premium applies to all lots")!.pct, 15);
  assert.equal(
    extractBuyerPremium('Buyers premium of 13% will be added')!.pct, 13);
  assert.equal(extractBuyerPremium('18% BP')!.pct, 18);
  assert.equal(extractBuyerPremium('Premium: 12.5% buyers premium')!.pct, 12.5);
});

test('an ambiguous or absurd premium is refused, because a wrong total looks authoritative', () => {
  assert.equal(extractBuyerPremium('No premium charged on this sale'), null);
  assert.equal(extractBuyerPremium('Sales tax 5.5% applies'), null);
  // 85% is a misparse of something else, not a premium.
  assert.equal(extractBuyerPremium("85% buyer's premium"), null);
  assert.equal(extractBuyerPremium(''), null);
});

test('card surcharge is captured separately, since it stacks on the premium', () => {
  // Hamele: 10% premium PLUS 3.5% for cards -> $100 hammer is $113.50.
  const text = 'A 10% online buyer premium with a 3.5% additional fee for credit card payments.';
  assert.equal(extractBuyerPremium(text)!.pct, 10);
  assert.equal(extractCardFee(text), 3.5);
  assert.equal(extractCardFee('Cash only, no cards accepted'), null);
});

// ------------------------------------------------------ catalogue normalization

test('a catalogue page becomes one auction and namespaced lots', () => {
  const t = tenantFromUrl('hameleauctions.hibid.com')!;
  const { auction, lots } = normalizeCatalogPage(lotHtml, {
    tenant: t,
    catalogId: '619877',
    pageUrl: 'https://hameleauctions.hibid.com/catalog/619877/september',
    auctioneer: 'Hamele Auction Service',
  });

  assert.equal(auction.externalId, 'hameleauctions/619877');
  assert.equal(auction.auctioneer, 'Hamele Auction Service');
  assert.equal(auction.timezone, 'America/Chicago'); // WI is Central
  assert.equal(auction.lotCount, 3);

  // Lot ids MUST be namespaced: "147" repeats across auctions and across houses,
  // so a bare lot number would make upserts overwrite unrelated lots.
  assert.ok(lots.every((l) => l.externalId.startsWith('hameleauctions/619877/')));
  assert.ok(lots.some((l) => l.externalId === 'hameleauctions/619877/147'));
  assert.equal(new Set(lots.map((l) => l.externalId)).size, lots.length);
  assert.ok(lots.every((l) => l.auctionExternalId === 'hameleauctions/619877'));
});

test('auction end time is the LATEST lot close, and per-lot times are preserved', () => {
  const t = tenantFromUrl('auctionwi.hibid.com')!;
  const { auction, lots } = normalizeCatalogPage(lotHtml, {
    tenant: t,
    catalogId: '1',
    pageUrl: 'https://auctionwi.hibid.com/catalog/1/x',
  });

  // Fixture lots close at 23:00, 23:05 and 23:10 (-05:00).
  assert.equal(auction.endsAt, '2099-10-05T04:10:00.000Z');

  // Soft close means per-lot times differ and must NOT be flattened to the
  // auction-level value, or every snipe alert fires at the wrong moment.
  const closes = lots.map((l) => l.closesAt).sort();
  assert.equal(new Set(closes).size, 3);
  assert.equal(closes[0], '2099-10-05T04:00:00.000Z');
});

test('next bid is computed so "under $50" filters work on HiBid lots', () => {
  const t = tenantFromUrl('auctionwi.hibid.com')!;
  const { lots } = normalizeCatalogPage(lotHtml, {
    tenant: t, catalogId: '1', pageUrl: 'https://auctionwi.hibid.com/catalog/1/x',
  });
  const tools = lots.find((l) => l.externalId.endsWith('/148'))!;
  assert.equal(tools.currentBidCents, 1250);  // $12.50
  // $12.50 is under $25, so the increment is $2.50 -> $15.00. An "under $15"
  // filter must therefore EXCLUDE this lot: you can no longer get in at $15.
  assert.equal(tools.nextBidCents, 1500);

  const drone = lots.find((l) => l.externalId.endsWith('/147'))!;
  assert.equal(drone.currentBidCents, 145000); // $1,450 sits in the +$50 band
  assert.equal(drone.nextBidCents, 150000);
});

test('a catalogue with no parseable lots warns loudly instead of reporting success', () => {
  const t = tenantFromUrl('bids.beloitauction.com')!;
  const { lots, warnings } = normalizeCatalogPage('<html><body>empty</body></html>', {
    tenant: t, catalogId: '42', pageUrl: 'https://bids.beloitauction.com/catalog/42/x',
  });
  assert.equal(lots.length, 0);
  assert.match(warnings.join(' '), /No JSON-LD products found/);
  assert.match(warnings.join(' '), /probeTenant/);
});

test('lots without close times are flagged as unable to drive alerts', () => {
  const noClose = `<script type="application/ld+json">
    {"@type":"Product","sku":"1","name":"Thing","offers":{"@type":"Offer","price":"5.00"}}</script>`;
  const t = tenantFromUrl('auctionwi.hibid.com')!;
  const { lots, warnings } = normalizeCatalogPage(noClose, {
    tenant: t, catalogId: '9', pageUrl: 'https://auctionwi.hibid.com/catalog/9/x',
  });
  assert.equal(lots.length, 1);
  assert.match(warnings.join(' '), /snipe alerts cannot be armed/);
});

// --------------------------------------------------------------------- RSS

test('RSS parsing handles CDATA and entity escaping', () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[September Estate & Equipment]]></title>
          <link>https://hameleauctions.hibid.com/catalog/619877/sept</link>
          <guid>619877</guid></item>
    <item><title>Fall Consignment &amp; Tools</title>
          <link>https://hameleauctions.hibid.com/catalog/620114/fall</link></item>
    <item><title>Broken, no link</title></item>
  </channel></rss>`;
  const items = parseRssAuctions(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'September Estate & Equipment');
  assert.equal(items[0].guid, '619877');
  assert.equal(items[1].title, 'Fall Consignment & Tools');
  // The item missing a link is dropped rather than half-created.
  assert.deepEqual(parseRssAuctions(''), []);
});

// ----------------------------------------------------- capability probing

function ctxWith(fetch: Fetcher, url = 'https://hameleauctions.hibid.com'): AdapterContext {
  const source: SourceConfig = {
    id: 'src-hamele', slug: 'hamele', name: 'Hamele Auction Service', url,
    tier: 'private', ingest: 'json_ld', platform: 'hibid', states: ['WI'],
    rateLimitRpm: 10, ingestAllowed: true, robotsAllows: true,
    crawlCadenceMin: 60, consecutiveFailures: 0,
  };
  return { source, fetch, now: () => new Date(), log: () => {}, secrets: {} };
}

test('probe recommends json_ld when the markup actually supports it', async () => {
  const fetch: Fetcher = async () => ({ status: 200, headers: {}, text: lotHtml });
  const p = await probeTenant(ctxWith(fetch), 'hameleauctions.hibid.com');

  assert.equal(p.recommendedIngest, 'json_ld');
  assert.equal(p.jsonLd.verdict, 'json_ld');
  assert.match(p.notes.join(' '), /durable ingestion, no selectors needed/);
});

test('probe recommends headless when the grid is client-rendered', async () => {
  // HTML came back, but no JSON-LD and no catalogue links: a React shell.
  const fetch: Fetcher = async () => ({
    status: 200, headers: {}, text: '<html><body><div id="root"></div></body></html>',
  });
  const p = await probeTenant(ctxWith(fetch), 'someauctioneer.hibid.com');
  assert.equal(p.recommendedIngest, 'headless');
  assert.match(p.notes.join(' '), /rendered client-side/);
});

test('probe recommends html when catalogues are discoverable but JSON-LD is absent', async () => {
  const fetch: Fetcher = async () => ({
    status: 200, headers: {},
    text: '<a href="/catalog/619877/sale">Sale</a> with a 12% buyer premium',
  });
  const p = await probeTenant(ctxWith(fetch), 'x.hibid.com');
  assert.equal(p.recommendedIngest, 'html');
  assert.equal(p.catalogIdsFound, 1);
  assert.equal(p.buyerPremiumPct, 12);
});

test('probe degrades to manual and says why when the fetch fails', async () => {
  const fetch: Fetcher = async () => ({ status: 403, headers: {}, text: '' });
  const p = await probeTenant(ctxWith(fetch), 'blocked.hibid.com');
  assert.equal(p.recommendedIngest, 'manual');
  assert.equal(p.httpStatus, 403);
  assert.match(p.notes.join(' '), /HTTP 403/);
});

// ------------------------------------------------------------ adapter run

test('the adapter discovers catalogues then fetches them', async () => {
  const seen: string[] = [];
  const fetch: Fetcher = async (url) => {
    seen.push(url);
    if (url.endsWith('/auctions')) {
      return {
        status: 200, headers: {},
        text: '<a href="/catalog/619877/a">A</a><a href="/catalog/620114/b">B</a>',
      };
    }
    return { status: 200, headers: {}, text: lotHtml };
  };

  const result = await hibidAdapter.run(ctxWith(fetch));

  assert.equal(seen[0], 'https://hameleauctions.hibid.com/auctions');
  assert.equal(result.auctions.length, 2);
  assert.equal(result.lots.length, 6); // 3 lots per catalogue
  assert.equal(result.stats.httpRequests, 3);
  assert.ok(result.lots.every((l) => l.externalId.startsWith('hameleauctions/')));
});

test('catalogue fetches are bounded per run to stay polite to small hosts', async () => {
  // A tenant with 20 live auctions must not become 20 sequential requests.
  const ids = Array.from({ length: 20 }, (_, i) => `<a href="/catalog/${700000 + i}/x">x</a>`).join('');
  let fetches = 0;
  const fetch: Fetcher = async (url) => {
    fetches++;
    if (url.endsWith('/auctions')) return { status: 200, headers: {}, text: ids };
    return { status: 200, headers: {}, text: lotHtml };
  };

  const result = await hibidAdapter.run(ctxWith(fetch));
  assert.equal(fetches, 9, '1 list page + 8 catalogues');
  assert.equal(result.auctions.length, 8);
  assert.match(result.warnings.join(' '), /20 catalogues found; fetched 8 this run/);
});

test('a dead catalogue is skipped and reported, not fatal', async () => {
  const fetch: Fetcher = async (url) => {
    if (url.endsWith('/auctions')) {
      return { status: 200, headers: {}, text: '<a href="/catalog/619877/a">A</a><a href="/catalog/620114/b">B</a>' };
    }
    if (url.includes('/catalog/620114/')) return { status: 500, headers: {}, text: '' };
    return { status: 200, headers: {}, text: lotHtml };
  };

  const result = await hibidAdapter.run(ctxWith(fetch));
  assert.equal(result.auctions.length, 1);
  assert.match(result.warnings.join(' '), /Catalogue 620114 returned HTTP 500; skipped/);
});

test('a tenant with no live auctions returns empty with an explanation', async () => {
  const fetch: Fetcher = async () => ({
    status: 200, headers: {}, text: '<html>No auctions at this time</html>',
  });
  const result = await hibidAdapter.run(ctxWith(fetch));
  assert.equal(result.lots.length, 0);
  assert.match(result.warnings.join(' '), /No \/catalog\/\{id\}\/ links/);
});

test('a tenant returning an error status fails loudly', async () => {
  const fetch: Fetcher = async () => ({ status: 503, headers: {}, text: '' });
  await assert.rejects(() => hibidAdapter.run(ctxWith(fetch)), /returned HTTP 503/);
});
