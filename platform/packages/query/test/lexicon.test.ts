import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANDS,
  CATEGORIES,
  FEATURES,
  PG_ENGLISH_STOPWORDS,
  SYNONYM_GROUPS,
  TIER_PHRASES,
  US_STATES,
  normalizeKey,
} from '../src/index.ts';

test('the brand dictionary covers at least 250 auction brands', () => {
  assert.ok(BRANDS.length >= 250, `only ${BRANDS.length} brands`);
  const names = new Set(BRANDS.map((b) => b.name));
  assert.equal(names.size, BRANDS.length, 'brand names are unique');
});

test('every brand the brief names is present', () => {
  const required = [
    // tools
    'Snap-on', 'Milwaukee', 'DeWalt', 'Makita', 'Craftsman', 'Hilti', 'Festool', 'Lincoln Electric', 'Miller Electric',
    // equipment
    'John Deere', 'Kubota', 'Case', 'Caterpillar', 'Bobcat', 'New Holland', 'Toro', 'Husqvarna', 'Stihl',
    // vehicles
    'Ford', 'Chevrolet', 'GMC', 'Dodge', 'Ram', 'Toyota', 'Honda', 'Harley-Davidson', 'Polaris', 'Can-Am',
    // electronics
    'DJI', 'Apple', 'Dell', 'HP', 'Lenovo', 'Samsung', 'Sony', 'Canon', 'Nikon', 'FLIR',
    // appliances, optics
    'Whirlpool', 'KitchenAid', 'Vitamix', 'Leupold', 'Vortex',
    // coins
    'US Mint', 'Morgan', 'Peace', 'PCGS', 'NGC',
    // furniture, collectibles
    'Stickley', 'Herman Miller', 'Ethan Allen', 'Lionel', 'Hummel', 'Pyrex', 'Fiestaware', 'Le Creuset',
  ];
  const names = new Set(BRANDS.map((b) => b.name));
  for (const name of required) assert.ok(names.has(name), `missing ${name}`);
});

test('every brand points at a real category', () => {
  const slugs = new Set(CATEGORIES.map((c) => c.slug));
  for (const b of BRANDS) {
    assert.ok(slugs.has(b.category), `${b.name} -> ${b.category}`);
    for (const c of b.context ?? []) assert.ok(slugs.has(c), `${b.name} context ${c}`);
  }
});

test('no invented model numbers: product lines are words, not numbers', () => {
  for (const b of BRANDS) {
    for (const f of b.families ?? []) {
      assert.ok(!/\d{2,}/.test(f), `${b.name} family "${f}" looks like a model number`);
    }
    for (const a of b.aliases ?? []) {
      // "Dept 56" is the company's name, not a model.
      if (b.name === 'Department 56') continue;
      assert.ok(!/\d{2,}/.test(a), `${b.name} alias "${a}" looks like a model number`);
    }
  }
});

test('an ambiguous form is always a real key of its brand', () => {
  for (const b of BRANDS) {
    const keys = new Set([b.name, ...(b.aliases ?? [])].map(normalizeKey));
    for (const a of b.ambiguous ?? []) assert.ok(keys.has(normalizeKey(a)), `${b.name}: "${a}" is marked ambiguous but is not a key`);
  }
});

test('two brands never share an unambiguous spelling', () => {
  const owner = new Map<string, string>();
  for (const b of BRANDS) {
    const ambiguous = new Set((b.ambiguous ?? []).map(normalizeKey));
    for (const form of [b.name, ...(b.aliases ?? [])]) {
      const key = normalizeKey(form);
      if (ambiguous.has(key)) continue;
      const prev = owner.get(key);
      assert.ok(prev === undefined || prev === b.name, `"${key}" belongs to both ${prev} and ${b.name}`);
      owner.set(key, b.name);
    }
  }
});

test('the taxonomy has about forty categories with the required slugs', () => {
  assert.ok(CATEGORIES.length >= 38 && CATEGORIES.length <= 50, `${CATEGORIES.length} categories`);
  const slugs = CATEGORIES.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slugs are unique');
  for (const slug of [
    'drones', 'vehicles', 'trucks', 'heavy-equipment', 'lawn-garden', 'tools', 'power-tools', 'welding',
    'computers', 'phones-tablets', 'cameras', 'jewelry', 'coins', 'bullion', 'furniture', 'antiques',
    'collectibles', 'firearms-accessories', 'boats', 'trailers', 'atv-utv', 'appliances', 'electronics',
    'office-furniture', 'medical', 'restaurant-equipment', 'farm', 'hvac', 'building-materials',
    'sporting-goods', 'musical-instruments', 'art', 'books', 'toys', 'clothing-shoes', 'industrial', 'real-estate',
  ]) {
    assert.ok(slugs.includes(slug), `missing ${slug}`);
  }
  for (const c of CATEGORIES) {
    assert.match(c.slug, /^[a-z]+(-[a-z]+)*$/, c.slug);
    assert.ok(c.label.length > 0 && c.synonyms.length > 0, c.slug);
    assert.ok(Array.isArray(c.negativeTerms), c.slug);
    if (c.parent) assert.ok(slugs.includes(c.parent), `${c.slug} parent ${c.parent}`);
  }
});

test('real estate is matched but flagged out of scope, and only real estate is', () => {
  const out = CATEGORIES.filter((c) => c.outOfScope).map((c) => c.slug);
  assert.deepEqual(out, ['real-estate']);
});

test('all 50 states plus DC, with unique codes', () => {
  assert.equal(US_STATES.length, 51);
  assert.equal(new Set(US_STATES.map((s) => s.code)).size, 51);
  assert.ok(US_STATES.some((s) => s.code === 'DC'));
  for (const s of US_STATES) assert.match(s.code, /^[A-Z]{2}$/);
});

test('the stop list is Postgres english.stop, all 127 words', () => {
  assert.equal(PG_ENGLISH_STOPWORDS.size, 127);
  for (const w of ['with', 'for', 'a', 'no', 'not', 'or', 'can', 'am', 'on', 'only']) assert.ok(PG_ENGLISH_STOPWORDS.has(w), w);
  // "us" is NOT a Postgres stop word, which is why "US Mint" can be a phrase.
  assert.ok(!PG_ENGLISH_STOPWORDS.has('us'));
});

test('synonym groups include the brief\'s examples and never repeat a member', () => {
  const find = (w: string) => SYNONYM_GROUPS.find((g) => g.includes(w)) ?? [];
  assert.ok(find('drone').includes('quadcopter') && find('drone').includes('uav'));
  assert.ok(find('tv').includes('television'));
  assert.ok(find('fridge').includes('refrigerator'));
  for (const g of SYNONYM_GROUPS) assert.equal(new Set(g).size, g.length, g.join(', '));
});

test('features cover the brief\'s examples and metal grades', () => {
  const names = new Set(FEATURES.map((f) => f.name));
  for (const n of ['thermal', '4x4', 'cordless', 'diesel', '14k', '18k', '.999', 'sterling']) assert.ok(names.has(n), n);
});

test('seller tiers only use values of the source_tier enum', () => {
  const allowed = new Set(['federal', 'state', 'county', 'municipal', 'school', 'private', 'estate', 'wholesale', 'marketplace', 'dealer']);
  for (const t of TIER_PHRASES) for (const tier of t.tiers) assert.ok(allowed.has(tier), `${t.phrase} -> ${tier}`);
});

test('normalizeKey folds spelling differences into one key', () => {
  assert.equal(normalizeKey('Snap-on'), 'snap on');
  assert.equal(normalizeKey('U.S. Mint'), 'us mint');
  assert.equal(normalizeKey('Black & Decker'), 'black decker');
  assert.equal(normalizeKey('Black and Decker'), 'black decker');
  assert.equal(normalizeKey("Levi's"), 'levis');
  assert.equal(normalizeKey('Pokémon'), 'pokemon');
  assert.equal(normalizeKey('.999'), '.999');
  assert.equal(normalizeKey('0.999 fine'), '0.999 fine');
});
