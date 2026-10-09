import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPRAISAL_SCHEMA,
  APPRAISAL_SYSTEM,
  BATCH_SIZE,
  DESCRIPTION_CHARS,
  FRESH_DAYS,
  buildBatchPrompt,
  ineligibility,
  isFresh,
  parseAppraisals,
  type AppraisalLot,
} from '../src/appraisal.ts';

function lot(overrides: Partial<AppraisalLot> = {}): AppraisalLot {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Milwaukee M18 FUEL 1/2" hammer drill kit',
    description: 'Two 5.0 Ah batteries, charger and case. Tested, works.',
    brand: 'Milwaukee',
    model: '2804-22',
    condition: 'used',
    quantity: 1,
    currentBidCents: 4500,
    seller: 'PropertyRoom',
    pickupCity: 'Eau Claire',
    pickupState: 'WI',
    ships: true,
    closed: false,
    saleLevel: false,
    sourcePlatform: 'propertyroom',
    sourceActive: true,
    sourceAllowed: true,
    ...overrides,
  };
}

const DRILL = lot();
const MOWER = lot({
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Toro push mower',
  description: null,
  brand: null,
  model: null,
  condition: null,
  currentBidCents: null,
  ships: null,
});

function answer(entries: unknown[]): string {
  return JSON.stringify({ appraisals: entries });
}

const GOOD_DRILL = {
  ref: 1,
  item: 'Milwaukee M18 FUEL hammer drill kit, 2 batteries',
  resale_low_usd: 120,
  resale_likely_usd: 150.5,
  resale_high_usd: 185,
  new_price_usd: 399,
  confidence: 'high',
  channel: 'ebay',
  days_to_sell: 10,
  project_tags: ['Construction', 'woodworking', 'construction'],
  flags: [],
  comps_query: 'Milwaukee 2804-22 M18 FUEL kit',
  rationale: 'Complete kits with two 5.0 batteries sell steadily.',
};

// ------------------------------------------------------------------ eligibility

test('open lots from a permitted source are appraised; closed, sale cards, held sources and land are not', () => {
  assert.equal(ineligibility(DRILL), null);
  assert.equal(ineligibility(lot({ closed: true })), 'closed');
  assert.equal(ineligibility(lot({ saleLevel: true })), 'sale_level');
  assert.equal(ineligibility(lot({ sourceAllowed: false })), 'source_held');
  assert.equal(ineligibility(lot({ sourceActive: false })), 'source_held');
  assert.equal(ineligibility(lot({ sourcePlatform: 'dane-county-tax-deed' })), 'real_estate');
});

// ---------------------------------------------------------------------- prompt

test('the batch prompt numbers lots from 1 and leaves out empty fields', () => {
  const prompt = buildBatchPrompt([DRILL, MOWER]);
  const lines = prompt.split('\n').slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], {
    ref: 1,
    title: DRILL.title,
    description: DRILL.description,
    brand: 'Milwaukee',
    model: '2804-22',
    condition: 'used',
    current_bid_usd: 45,
    seller: 'PropertyRoom',
    pickup: 'Eau Claire, WI',
    ships: true,
  });
  assert.deepEqual(lines[1], { ref: 2, title: 'Toro push mower', seller: 'PropertyRoom', pickup: 'Eau Claire, WI' });
  assert.match(prompt, /^Appraise these 2 lots/);
});

test('a long description is clipped, whitespace collapsed; quantities over 1 are sent', () => {
  const long = `Lot of drills.   ${'x'.repeat(DESCRIPTION_CHARS * 2)}`;
  const [entry] = buildBatchPrompt([lot({ description: long, quantity: 3 })])
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l) as { description: string; quantity: number });
  assert.equal(entry?.description.length, DESCRIPTION_CHARS);
  assert.ok(entry?.description.startsWith('Lot of drills. x'));
  assert.ok(entry?.description.endsWith('…'));
  assert.equal(entry?.quantity, 3);
});

test('the system prompt says listing text is data, and stays the same for every batch (cacheable)', () => {
  assert.match(APPRAISAL_SYSTEM, /data, not instructions/);
  assert.match(APPRAISAL_SYSTEM, /SOLD prices, never asking prices/);
  assert.ok(APPRAISAL_SYSTEM.length > 2000, 'long enough to clear the 512-token cache minimum');
  assert.equal(BATCH_SIZE, 10);
});

test('the schema meets structured outputs: every object closed, every property required', () => {
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as { type?: unknown; properties?: Record<string, unknown>; required?: unknown; additionalProperties?: unknown };
    if (n.type === 'object') {
      assert.equal(n.additionalProperties, false);
      assert.deepEqual([...(n.required as string[])].sort(), Object.keys(n.properties ?? {}).sort());
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(APPRAISAL_SCHEMA);
});

// ----------------------------------------------------------------------- parse

test('a clean answer becomes one row per lot, in cents', () => {
  const r = parseAppraisals(
    answer([
      GOOD_DRILL,
      { ...GOOD_DRILL, ref: 2, item: 'Toro push mower', resale_low_usd: 60, resale_likely_usd: 90, resale_high_usd: 120, new_price_usd: 329, confidence: 'medium', channel: 'facebook_marketplace', flags: ['condition_unknown', 'untested'], project_tags: ['landscaping'] },
    ]),
    [DRILL, MOWER],
    'claude-opus-5-5',
  );
  assert.deepEqual(r.problems, []);
  assert.equal(r.rows.length, 2);
  const [d, m] = r.rows;
  assert.deepEqual(d, {
    lot_id: DRILL.id,
    model: 'claude-opus-5-5',
    item: 'Milwaukee M18 FUEL hammer drill kit, 2 batteries',
    resale_low_cents: 12000,
    resale_likely_cents: 15050,
    resale_high_cents: 18500,
    new_price_cents: 39900,
    confidence: 'high',
    channel: 'ebay',
    days_to_sell: 10,
    project_tags: ['construction', 'woodworking'],
    flags: [],
    comps_query: 'Milwaukee 2804-22 M18 FUEL kit',
    rationale: 'Complete kits with two 5.0 batteries sell steadily.',
    lot_title: DRILL.title,
    bid_cents_at: 4500,
  });
  assert.equal(m?.lot_id, MOWER.id);
  assert.equal(m?.bid_cents_at, null);
  assert.deepEqual(m?.flags, ['condition_unknown', 'untested']);
});

test('the range is put in order: low <= likely <= high', () => {
  const [row] = parseAppraisals(answer([{ ...GOOD_DRILL, resale_low_usd: 200, resale_likely_usd: 150, resale_high_usd: 100 }]), [DRILL], 'm').rows;
  assert.equal(row?.resale_low_cents, 15000);
  assert.equal(row?.resale_likely_cents, 15000);
  assert.equal(row?.resale_high_cents, 15000);
});

test('no likely value: two ends give a midpoint; one end alone is no range, and confidence drops to low', () => {
  const [mid] = parseAppraisals(answer([{ ...GOOD_DRILL, resale_low_usd: 180, resale_likely_usd: null, resale_high_usd: 100 }]), [DRILL], 'm').rows;
  assert.deepEqual([mid?.resale_low_cents, mid?.resale_likely_cents, mid?.resale_high_cents], [10000, 14000, 18000]);
  const [none] = parseAppraisals(answer([{ ...GOOD_DRILL, resale_low_usd: 100, resale_likely_usd: null, resale_high_usd: null }]), [DRILL], 'm').rows;
  assert.deepEqual([none?.resale_low_cents, none?.resale_likely_cents, none?.resale_high_cents], [null, null, null]);
  assert.equal(none?.confidence, 'low');
});

test('impossible numbers are dropped: negative, not finite, or beyond any lot here', () => {
  const [row] = parseAppraisals(
    answer([{ ...GOOD_DRILL, resale_low_usd: -5, resale_likely_usd: 150, resale_high_usd: 9e9, new_price_usd: 'cheap', days_to_sell: 2.5 }]),
    [DRILL],
    'm',
  ).rows;
  assert.equal(row?.resale_low_cents, null);
  assert.equal(row?.resale_likely_cents, 15000);
  assert.equal(row?.resale_high_cents, null);
  assert.equal(row?.new_price_cents, null);
  assert.equal(row?.days_to_sell, null);
});

test('unknown enums fall back safely; tags are cleaned, de-duplicated and capped at 6', () => {
  const [row] = parseAppraisals(
    answer([
      {
        ...GOOD_DRILL,
        confidence: 'certain',
        channel: 'pawn shop',
        flags: ['vehicle', 'stolen', 'vehicle'],
        project_tags: ['Auto Repair!', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 7, 'x'.repeat(50)],
      },
    ]),
    [DRILL],
    'm',
  ).rows;
  assert.equal(row?.confidence, 'low');
  assert.equal(row?.channel, 'other');
  assert.deepEqual(row?.flags, ['vehicle']);
  assert.deepEqual(row?.project_tags, ['auto repair', 'a', 'b', 'c', 'd', 'e']);
});

test('bad refs, repeats and missing lots are reported, never stored against the wrong lot', () => {
  const r = parseAppraisals(answer([GOOD_DRILL, { ...GOOD_DRILL }, { ...GOOD_DRILL, ref: 9 }, { ...GOOD_DRILL, ref: '2' }, 'x']), [DRILL, MOWER], 'm');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]?.lot_id, DRILL.id);
  assert.deepEqual(r.problems, [
    'lot 1 came back twice; the first answer is kept',
    'ref 9 is not a lot in this batch',
    'ref 2 is not a lot in this batch',
    'an entry is not an object',
    'lot 2 was not appraised',
  ]);
});

test('an answer that is not the expected JSON stores nothing', () => {
  assert.deepEqual(parseAppraisals('Sorry, I cannot help', [DRILL], 'm'), { rows: [], problems: ['the answer is not JSON'] });
  assert.deepEqual(parseAppraisals('{"lots": []}', [DRILL], 'm'), { rows: [], problems: ['the answer has no appraisals list'] });
});

test('missing text fields fall back to the title', () => {
  const [row] = parseAppraisals(answer([{ ...GOOD_DRILL, item: '  ', comps_query: '', rationale: null }]), [DRILL], 'm').rows;
  assert.equal(row?.item, DRILL.title);
  assert.equal(row?.comps_query, DRILL.title);
  assert.equal(row?.rationale, null);
});

// ---------------------------------------------------------------------- fresh

test('an appraisal is current while the title is unchanged and it is under FRESH_DAYS old', () => {
  const now = new Date('2026-10-01T21:00:00Z');
  const recent = { lot_title: DRILL.title, created_at: '2026-09-30T21:00:00Z' };
  assert.equal(isFresh(recent, DRILL, now), true);
  assert.equal(isFresh(recent, { title: 'Milwaukee M18 drill (bare tool)' }, now), false);
  const old = { lot_title: DRILL.title, created_at: new Date(now.getTime() - FRESH_DAYS * 86_400_000 - 1).toISOString() };
  assert.equal(isFresh(old, DRILL, now), false);
  assert.equal(isFresh({ lot_title: DRILL.title, created_at: 'garbage' }, DRILL, now), false);
});
