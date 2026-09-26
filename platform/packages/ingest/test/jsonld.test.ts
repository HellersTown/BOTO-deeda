import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractJsonLdBlocks,
  flattenNodes,
  lotsFromJsonLd,
  assessJsonLd,
} from '../src/jsonld.ts';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'fixtures', 'hibid-style-lot.html'), 'utf8');

test('finds every valid ld+json block and survives the malformed one', () => {
  const blocks = extractJsonLdBlocks(html);
  // Four blocks in the fixture; one has a trailing comma and must be skipped
  // WITHOUT taking the others down with it.
  assert.equal(blocks.length, 3);
});

test('handles single-quoted type attributes and HTML-escaped bodies', () => {
  // The @graph block uses type='...' and the last block is &quot;-escaped.
  const lots = lotsFromJsonLd(html);
  const skus = lots.map((l) => l.lotNumber).sort();
  assert.deepEqual(skus, ['147', '148', '149']);
});

test('flattens @graph and itemListElement containers', () => {
  const nodes = flattenNodes(extractJsonLdBlocks(html));
  assert.ok(nodes.length >= 6, `expected nodes from graph + breadcrumbs, got ${nodes.length}`);
});

test('normalizes a lot completely', () => {
  const lots = lotsFromJsonLd(html, { pageUrl: 'https://example-auction.test/lot/4471-147' });
  const drone = lots.find((l) => l.lotNumber === '147')!;

  assert.equal(drone.title, 'DJI Mavic 3T Thermal Drone with Radiometric Payload');
  assert.equal(drone.brand, 'DJI');          // unwrapped from {"@type":"Brand","name":...}
  assert.equal(drone.model, 'M3T-2024');
  assert.equal(drone.condition, 'used');     // mapped from schema.org/UsedCondition
  assert.equal(drone.currentBidCents, 145000); // "1,450.00" -> cents, no float error
  assert.equal(drone.url, 'https://example-auction.test/lot/4471-147');
  assert.equal(drone.closed, false);
  assert.ok(drone.closesAt!.startsWith('2099-10-05T04:00:00'), drone.closesAt!);
});

test('collects images from mixed shapes and dedupes them', () => {
  const lots = lotsFromJsonLd(html);
  const drone = lots.find((l) => l.lotNumber === '147')!;
  // Fixture has 3 distinct URLs plus one repeat, and one is an ImageObject.
  assert.equal(drone.images.length, 3);
  assert.deepEqual(
    drone.images.map((i) => i.url),
    [
      'https://cdn.example-auction.test/147/a.jpg',
      'https://cdn.example-auction.test/147/b.jpg',
      'https://cdn.example-auction.test/147/c.jpg',
    ],
  );
  // Lead image order is preserved: the site chose which one goes first.
  assert.equal(drone.images[0].position, 0);
});

test('the thin-description lot is exactly the sleeper case', () => {
  const lots = lotsFromJsonLd(html);
  const tools = lots.find((l) => l.lotNumber === '148')!;
  assert.equal(tools.title, 'Lot of assorted hand tools');
  assert.equal(tools.description, 'Box of misc tools');
  assert.equal(tools.currentBidCents, 1250);
  // "Box of misc tools" is 4 words. This is the input the sleeper score is built
  // to flag, and it arrived from the source with no special handling.
  assert.ok(tools.description!.split(/\s+/).length < 12);
});

test('assessJsonLd decides the ingest rung for a source', () => {
  const a = assessJsonLd(html);
  assert.equal(a.verdict, 'json_ld');
  assert.equal(a.usableLots, 3);
  assert.equal(a.withPrice, 3);
  assert.equal(a.withCloseTime, 3);
  assert.equal(a.withImages, 2);
});

test('a page with no JSON-LD reports none rather than throwing', () => {
  const a = assessJsonLd('<html><body><p>nothing here</p></body></html>');
  assert.equal(a.verdict, 'none');
  assert.equal(a.usableLots, 0);
  assert.equal(a.blocks, 0);
});

test('markup with products but no prices is "partial", not a false success', () => {
  const partial = `<script type="application/ld+json">
    {"@type":"Product","sku":"1","name":"Mystery box"}</script>`;
  const a = assessJsonLd(partial);
  // Honest verdict: the lot exists but cannot drive an alert without a close time.
  assert.equal(a.verdict, 'partial');
  assert.equal(a.usableLots, 1);
  assert.equal(a.withPrice, 0);
});

test('nonsense close times are refused rather than published', () => {
  const bad = `<script type="application/ld+json">
    {"@type":"Product","sku":"9","name":"Thing",
     "offers":{"@type":"Offer","price":"5.00","availabilityEnds":"1969-01-01T00:00:00Z"}}</script>`;
  const lots = lotsFromJsonLd(bad);
  assert.equal(lots.length, 1);
  // A 1969 close time means we misread a field; a nonsense countdown is worse
  // than no countdown.
  assert.equal(lots[0].closesAt, null);
});

test('a product with no name is not a usable lot', () => {
  const nameless = `<script type="application/ld+json">
    {"@type":"Product","sku":"x","offers":{"@type":"Offer","price":"1.00"}}</script>`;
  assert.equal(lotsFromJsonLd(nameless).length, 0);
});

test('duplicate nodes for one product collapse to a single lot', () => {
  const dupe = `
  <script type="application/ld+json">
   {"@type":"Product","sku":"501","name":"Snap-on socket set","offers":{"@type":"Offer","price":"40.00"}}</script>
  <script type="application/ld+json">
   {"@type":"Product","sku":"501","name":"Snap-on socket set","offers":{"@type":"Offer","price":"40.00"}}</script>`;
  assert.equal(lotsFromJsonLd(dupe).length, 1);
});
