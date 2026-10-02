import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/index.ts';

// Tuesday 29 September 2026, 10:00 in Chicago (15:00 UTC). Every timing test
// pins the clock: "ending today" means something different at 10pm.
const NOW = new Date('2026-09-29T15:00:00Z');
const parse = (q: string, opts: Parameters<typeof parseQuery>[1] = {}) => parseQuery(q, { now: NOW, ...opts });

// ------------------------------------------------------- the brief's examples

test('DJI drone with thermal under $1500 within 50 miles of 53202', () => {
  const r = parse('DJI drone with thermal under $1500 within 50 miles of 53202');
  assert.deepEqual(r.brands, ['DJI']);
  assert.deepEqual(r.categories, ['drones']);
  assert.deepEqual(r.features, ['thermal']);
  assert.equal(r.maxPriceCents, 150000);
  assert.equal(r.minPriceCents, null);
  assert.equal(r.location.postalCode, '53202');
  assert.equal(r.location.postalCodeSource, 'query');
  assert.equal(r.location.radiusMiles, 50);
  assert.equal(r.location.radiusIsDefault, false);
  assert.deepEqual(r.terms, ['dji', 'drone', 'thermal']);
  assert.ok(!r.terms.includes('with'), '"with" is filler');
  assert.equal(r.websearchQuery, 'dji drone thermal');
  assert.deepEqual(r.synonyms.drone.slice(0, 2), ['quadcopter', 'uav']);
  assert.deepEqual(r.unparsed, []);
  assert.equal(r.confidence, 1);
});

test('the DJI example maps exactly onto search_lots and hunts', () => {
  const r = parse('DJI drone with thermal under $1500 within 50 miles of 53202');
  assert.deepEqual(r.searchParams, {
    p_query: 'dji drone thermal',
    p_postal_code: '53202',
    p_radius_miles: 50,
    p_include_shippable: true,
    p_states: null,
    p_min_cents: null,
    p_max_cents: 150000,
    p_tiers: null,
    p_closing_within_hours: null,
    p_min_sleeper: null,
    p_sort: 'relevance',
  });
  const { parsed, ...columns } = r.hunt;
  assert.deepEqual(columns, {
    query_text: 'DJI drone with thermal under $1500 within 50 miles of 53202',
    keywords: ['dji', 'drone', 'thermal'],
    exclude_keywords: [],
    brands: ['DJI'],
    required_terms: ['thermal'],
    min_price_cents: null,
    max_price_cents: 150000,
    conditions: [],
    postal_code: '53202',
    radius_miles: 50,
    states: [],
    include_shippable: true,
    category_ids: [],
    tiers_only: [],
    min_sleeper_score: null,
  });
  assert.equal(parsed.websearchQuery, 'dji drone thermal');
  assert.deepEqual(parsed.categories, ['drones']);
  assert.ok(!('hunt' in parsed) && !('searchParams' in parsed), 'parsed must not contain itself');
  assert.doesNotThrow(() => JSON.stringify(r.hunt), 'hunt.parsed must be JSON for the jsonb column');
});

test('Snap-on toolbox near Madison WI', () => {
  const r = parse('Snap-on toolbox near Madison WI');
  assert.deepEqual(r.brands, ['Snap-on']);
  assert.deepEqual(r.categories, ['tools']);
  assert.ok(r.terms.includes('toolbox'));
  assert.deepEqual(r.location.place, { raw: 'madison wi', city: 'Madison', state: 'WI', ambiguous: false, needsResolution: true });
  // A place is never turned into a ZIP here: postal_codes does that.
  assert.equal(r.location.postalCode, null);
  assert.equal(r.location.radiusMiles, 50);
  assert.equal(r.location.radiusIsDefault, true);
  // "Snap-on" becomes the phrase "snap on", which Postgres reads as 'snap': it
  // matches both "Snap-on" and "Snap On", where "snap-on" would only match the first.
  assert.equal(r.websearchQuery, '"snap on" toolbox');
  assert.deepEqual(r.location.states, []);
});

test('silver coins no replicas under 200', () => {
  const r = parse('silver coins no replicas under 200');
  assert.deepEqual(r.excludeTerms, ['replicas']);
  assert.equal(r.maxPriceCents, 20000);
  assert.deepEqual(r.categories, ['coins']);
  assert.deepEqual(r.features, ['silver']);
  assert.equal(r.websearchQuery, 'silver coins -replicas');
  assert.match(r.tsquery, /!\( 'replicas' \| 'replica' \| 'reproduction'/);
  assert.deepEqual(r.hunt.exclude_keywords, ['replicas']);
});

test('john deere lawn tractor ending today', () => {
  const r = parse('john deere lawn tractor ending today');
  assert.deepEqual(r.brands, ['John Deere']);
  assert.deepEqual(r.categories, ['lawn-garden']);
  assert.deepEqual(r.phrases, ['john deere', 'lawn tractor']);
  // 10:00 in Chicago: "today" ends in 14 hours, not 24.
  assert.equal(r.timing.closingWithinHours, 14);
  assert.equal(r.timing.phrase, 'ending today');
  assert.equal(r.searchParams.p_closing_within_hours, 14);
  assert.ok(r.explanation.some((e) => e.includes('before midnight today')));
});

test('estate sale furniture within 25 mi', () => {
  const r = parse('estate sale furniture within 25 mi');
  assert.deepEqual(r.tiers, ['estate']);
  assert.deepEqual(r.categories, ['furniture']);
  assert.equal(r.location.radiusMiles, 25);
  assert.deepEqual(r.terms, ['furniture'], 'the only word left, so the category word is kept');
  assert.deepEqual(r.searchParams.p_tiers, ['estate']);
  // No ZIP and no home ZIP: the radius has no centre, and the parser says so.
  assert.equal(r.location.postalCode, null);
  assert.ok(r.explanation.some((e) => e.includes('needs a starting point')));
  assert.ok(r.confidence < 1);
});

test('estate sale furniture within 25 mi uses the home ZIP when there is one', () => {
  const r = parse('estate sale furniture within 25 mi', { homePostalCode: '53703' });
  assert.equal(r.location.postalCode, '53703');
  assert.equal(r.location.postalCodeSource, 'home');
  assert.equal(r.searchParams.p_postal_code, '53703');
  assert.equal(r.searchParams.p_radius_miles, 25);
});

test('14k gold jewelry: the grade matters, the word "jewelry" does not', () => {
  const r = parse('14k gold jewelry');
  assert.deepEqual(r.categories, ['jewelry']);
  assert.deepEqual(r.features, ['14k', 'gold']);
  assert.equal(r.maxPriceCents, null, '14k is a grade here, not $14,000');
  assert.equal(r.websearchQuery, '14k gold');
  assert.ok(r.explanation.some((e) => e.includes('did not require the word “jewelry”')));
  assert.match(r.tsquery, /'14k' \| '14kt' \| '14 karat' \| '585'/);
  assert.deepEqual(r.hunt.required_terms, ['14k', 'gold']);
});

test('Ford F-150 2015 or newer under 10k', () => {
  const r = parse('Ford F-150 2015 or newer under 10k');
  assert.deepEqual(r.brands, ['Ford']);
  assert.deepEqual(r.models, ['f-150']);
  assert.deepEqual(r.phrases, ['f-150']);
  assert.equal(r.minYear, 2015);
  assert.equal(r.maxYear, null);
  assert.equal(r.maxPriceCents, 1000000);
  // The year is a filter, not a search word: a 2016 truck does not say "2015".
  assert.equal(r.websearchQuery, 'ford "f-150"');
  assert.match(r.tsquery, /\( 'f-150' \| 'f150' \| 'f 150' \)/);
});

test('pallet of laptops pickup only', () => {
  const r = parse('pallet of laptops pickup only');
  assert.equal(r.location.includeShippable, false);
  assert.equal(r.searchParams.p_include_shippable, false);
  assert.equal(r.hunt.include_shippable, false);
  assert.deepEqual(r.terms, ['pallet', 'laptops']);
  assert.ok(r.categories.includes('computers'));
  assert.ok(!r.terms.includes('pickup'), 'pickup here is the shipping term, not a truck');
});

test('mavic 3 thermal', () => {
  const r = parse('mavic 3 thermal');
  assert.deepEqual(r.phrases, ['mavic 3']);
  assert.deepEqual(r.models, ['mavic 3']);
  assert.deepEqual(r.features, ['thermal']);
  assert.deepEqual(r.brands, ['DJI'], 'Mavic is a DJI product line');
  assert.deepEqual(r.categories, ['drones']);
  assert.equal(r.websearchQuery, '"mavic 3" thermal');
  // The prefix sits on the model number only, so "Mavic 3T" and "Mavic 3 Pro" both match.
  assert.match(r.tsquery, /^\( 'mavic' <-> '3':\* \) & /);
});

test('cheap welder near beloit: an ambiguous place, never a guessed ZIP', () => {
  const r = parse('cheap welder near beloit');
  assert.deepEqual(r.terms, ['welder']);
  assert.deepEqual(r.categories, ['welding']);
  assert.deepEqual(r.location.place, { raw: 'beloit', city: 'Beloit', state: null, ambiguous: true, needsResolution: true });
  assert.equal(r.location.postalCode, null);
  assert.equal(r.searchParams.p_postal_code, null);
  assert.ok(r.explanation.some((e) => e.includes('I did not guess a ZIP')));
  assert.ok(r.confidence < 1, 'an ambiguous place lowers confidence');
});

test('around Beloit is ambiguous even with a home ZIP: a named place beats home', () => {
  const r = parse('tractor around Beloit', { homePostalCode: '53202' });
  assert.equal(r.location.place?.ambiguous, true);
  assert.equal(r.location.postalCode, null);
});

test('stickley chair', () => {
  const r = parse('stickley chair');
  assert.deepEqual(r.brands, ['Stickley']);
  assert.deepEqual(r.categories, ['furniture']);
  assert.deepEqual(r.terms, ['stickley', 'chair']);
  assert.equal(r.websearchQuery, 'stickley chair');
});

test('morgan silver dollar PCGS', () => {
  const r = parse('morgan silver dollar PCGS');
  assert.deepEqual(r.brands, ['Morgan', 'PCGS']);
  assert.deepEqual(r.categories, ['coins']);
  assert.deepEqual(r.features, ['silver']);
  // Words, not one phrase: "Morgan Dollar 1884-O 90% silver" must match too.
  assert.equal(r.websearchQuery, 'morgan silver dollar pcgs');
});

test('an empty query is empty, not an error', () => {
  for (const q of ['', '   ', '\n\t']) {
    const r = parse(q);
    assert.equal(r.websearchQuery, '');
    assert.equal(r.tsquery, '');
    assert.equal(r.searchParams.p_query, null, 'never pass an empty string: it would match nothing');
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.terms, []);
  }
  assert.ok(parse('').explanation[0].includes('empty'));
});

test("an injection-shaped query is plain text: drone'); drop table lots;--", () => {
  const r = parse("drone'); drop table lots;--");
  assert.deepEqual(r.terms, ['drone', 'drop', 'table']);
  assert.equal(r.websearchQuery, 'drone drop table');
  for (const s of [r.websearchQuery, r.tsquery.replace(/'[a-z0-9 .-]*'/g, '')]) {
    assert.ok(!/[;"()\\]|--/.test(s.replace(/[()]/g, '')), `no raw syntax in ${s}`);
  }
  assert.ok(!r.websearchQuery.includes("'"));
  assert.deepEqual(r.excludeTerms, [], '"--" is not an exclusion');
});

// ------------------------------------------------------------------- filler

test('filler words are dropped: with, a, for, looking, need, want, cheap, good, deal', () => {
  const r = parse('looking for a good deal on a cheap drone with thermal');
  assert.deepEqual(r.terms, ['drone', 'thermal']);
  assert.deepEqual(parse('need a welder').terms, ['welder']);
  assert.deepEqual(parse('want a tractor').terms, ['tractor']);
  assert.ok(r.explanation.some((e) => e.startsWith('Ignored as filler')));
});

// ------------------------------------------------------------------- prices

test('price: under $1,500', () => assert.equal(parse('under $1,500').maxPriceCents, 150000));
test('price: below 1.5k is 150000 cents', () => assert.equal(parse('below 1.5k').maxPriceCents, 150000));
test('price: less than 200', () => assert.equal(parse('less than 200').maxPriceCents, 20000));
test('price: $50-$100', () => {
  const r = parse('$50-$100');
  assert.equal(r.minPriceCents, 5000);
  assert.equal(r.maxPriceCents, 10000);
});
test('price: between 50 and 100', () => {
  const r = parse('between 50 and 100');
  assert.deepEqual([r.minPriceCents, r.maxPriceCents], [5000, 10000]);
});
test('price: over 500', () => assert.equal(parse('over 500').minPriceCents, 50000));
test('price: at most 2k', () => assert.equal(parse('at most 2k').maxPriceCents, 200000));
test('price: max $300', () => assert.equal(parse('max $300').maxPriceCents, 30000));
test('price: budget 400', () => assert.equal(parse('budget 400').maxPriceCents, 40000));

test('price: postfix and spaced forms', () => {
  assert.equal(parse('$500 or less').maxPriceCents, 50000);
  assert.equal(parse('$500+').minPriceCents, 50000);
  assert.equal(parse('$500 and up').minPriceCents, 50000);
  assert.deepEqual([parse('$50 - $100').minPriceCents, parse('$50 - $100').maxPriceCents], [5000, 10000]);
  assert.deepEqual([parse('from $50 to $100').minPriceCents, parse('from $50 to $100').maxPriceCents], [5000, 10000]);
  assert.equal(parse('under 5 grand').maxPriceCents, 500000);
  assert.equal(parse('under 300 bucks').maxPriceCents, 30000);
  assert.equal(parse('less than $1,234.56').maxPriceCents, 123456);
});

test('price: no float ever touches the amount', () => {
  assert.equal(parse('under 19.99').maxPriceCents, 1999);
  assert.equal(parse('under $0.07').maxPriceCents, 7);
  assert.equal(parse('under 1.1k').maxPriceCents, 110000);
  assert.equal(parse('under 1.25k').maxPriceCents, 125000);
  for (let d = 0; d < 100; d += 7) {
    for (let c = 0; c < 100; c += 3) {
      const s = `${d}.${String(c).padStart(2, '0')}`;
      assert.equal(parse(`under $${s}`).maxPriceCents, d * 100 + c, `failed on ${s}`);
    }
  }
});

test('price: a bare amount is reported, never guessed as a ceiling', () => {
  const r = parse('drone $500');
  assert.equal(r.maxPriceCents, null);
  assert.equal(r.minPriceCents, null);
  assert.deepEqual(r.unparsed, ['$500']);
  assert.ok(r.explanation.some((e) => e.includes('not whether it is a most or a least')));
  assert.ok(r.confidence < 1);
});

test('price: "around $500" has no firm limit and is reported', () => {
  const r = parse('around $500');
  assert.equal(r.maxPriceCents, null);
  assert.deepEqual(r.unparsed, ['around $500']);
});

test('price: "under 1.500" could be $1,500 or $1.50, so it is refused (money.ts rule 2)', () => {
  const r = parse('under 1.500');
  assert.equal(r.maxPriceCents, null);
  assert.deepEqual(r.unparsed, ['under 1.500']);
});

test('price: equipment hours and odometer miles are not prices or radii', () => {
  const hours = parse('kubota tractor under 500 hours');
  assert.equal(hours.maxPriceCents, null);
  assert.deepEqual(hours.unparsed, ['under 500 hours']);
  const miles = parse('truck under 100k miles');
  assert.equal(miles.location.radiusMiles, null);
  assert.equal(miles.maxPriceCents, null);
  assert.deepEqual(miles.unparsed, ['under 100k miles']);
});

test('price: min above max is swapped and said so', () => {
  const r = parse('over $500 under $100');
  assert.deepEqual([r.minPriceCents, r.maxPriceCents], [10000, 50000]);
  assert.ok(r.explanation.some((e) => e.includes('swapped')));
});

// ----------------------------------------------------------------- location

test('radius: within 50 miles, 50 mi, 25mi radius, 50-mile radius, km', () => {
  assert.equal(parse('within 50 miles').location.radiusMiles, 50);
  assert.equal(parse('50 mi').location.radiusMiles, 50);
  assert.equal(parse('25mi radius').location.radiusMiles, 25);
  assert.equal(parse('50-mile radius of 53703').location.radiusMiles, 50);
  // 50 km is 31.07 miles; integer maths only.
  assert.equal(parse('within 50 km of 53703').location.radiusMiles, 31);
});

test('nearby and local use the default radius and say so', () => {
  const r = parse('nearby tractors', { homePostalCode: '53202' });
  assert.equal(r.location.radiusMiles, 50);
  assert.equal(r.location.radiusIsDefault, true);
  assert.equal(r.location.postalCode, '53202');
  assert.equal(r.location.postalCodeSource, 'home');
  assert.ok(r.explanation.some((e) => e.includes('the default radius') && e.includes('home ZIP 53202')));
  const local = parse('local welders', { homePostalCode: '53202', defaultRadiusMiles: 30 });
  assert.equal(local.location.radiusMiles, 30);
  assert.deepEqual(local.terms, ['welders']);
});

test('"near me" with no home ZIP asks for one instead of guessing', () => {
  const r = parse('drone near me');
  assert.equal(r.location.postalCode, null);
  assert.equal(r.location.radiusMiles, 50);
  assert.ok(r.explanation.some((e) => e.includes('needs a starting point')));
  assert.deepEqual(r.location.states, [], '"me" is not Maine');
});

test('place: in Green Bay, Wisconsin', () => {
  const r = parse('snowblower in Green Bay, Wisconsin');
  assert.deepEqual(r.location.place, { raw: 'green bay, wisconsin', city: 'Green Bay', state: 'WI', ambiguous: false, needsResolution: true });
  assert.deepEqual(r.terms, ['snowblower']);
});

test('place: a town with its state but no cue word ("fond du lac wi", "new berlin wi")', () => {
  assert.equal(parse('fond du lac wi tractors').location.place?.city, 'Fond du Lac');
  assert.equal(parse('new berlin wi tractor').location.place?.city, 'New Berlin');
  assert.equal(parse('kubota near new glarus wi').location.place?.city, 'New Glarus');
});

test('place: a second place is reported, not merged or searched for', () => {
  const r = parse('welder near madison or milwaukee');
  assert.equal(r.location.place?.city, 'Madison');
  assert.deepEqual(r.terms, ['welder']);
  assert.deepEqual(r.unparsed, ['or milwaukee']);
});

test('place: "in the madison area"', () => {
  const r = parse('estate sales in the madison area');
  assert.equal(r.location.place?.city, 'Madison');
  assert.equal(r.location.place?.ambiguous, true);
  assert.deepEqual(r.terms, []);
});

test('place: "in box", "in oak" and "near new" are not places', () => {
  assert.equal(parse('drone in box').location.place, null);
  assert.equal(parse('chairs in oak').location.place, null);
  assert.deepEqual(parse('chairs in oak').features, ['oak']);
  assert.equal(parse('chainsaw near new').location.place, null);
});

test('states: in Wisconsin, WI only, only in MN, full names', () => {
  assert.deepEqual(parse('tractors in Wisconsin').location.states, ['WI']);
  const only = parse('WI only');
  assert.deepEqual(only.location.states, ['WI']);
  assert.equal(only.location.includeShippable, false, '"only" leaves out lots that merely ship');
  assert.deepEqual(parse('only in MN').location.states, ['MN']);
  assert.deepEqual(parse('boats in north carolina').location.states, ['NC']);
  assert.deepEqual(parse('trailers in the district of columbia').location.states, ['DC']);
  assert.deepEqual(parse('trucks wisconsin').location.states, ['WI']);
});

test('states: every state name and code maps to its USPS code', async () => {
  const { US_STATES } = await import('../src/index.ts');
  assert.equal(US_STATES.length, 51);
  for (const s of US_STATES) {
    assert.deepEqual(parse(`tractors in ${s.name}`).location.states, [s.code], s.name);
    assert.deepEqual(parse(`tractors in ${s.code}`).location.states, [s.code], s.code);
  }
});

test('states: words that are also codes are not states ("or", "me", "in", "mi")', () => {
  assert.deepEqual(parse('f-150 or silverado').location.states, []);
  assert.deepEqual(parse('drone in stock').location.states, []);
  assert.deepEqual(parse('12 ga shotgun case').location.states, []);
  assert.deepEqual(parse('radius 50 mi').location.states, []);
  assert.deepEqual(parse('george washington memorabilia').location.states, []);
});

test('ZIP codes: cue words, ZIP+4, and numbers that are not ZIPs', () => {
  assert.equal(parse('tractor near 53202').location.postalCode, '53202');
  assert.equal(parse('53202-1234 welder').location.postalCode, '53202');
  assert.equal(parse('welder 53202').location.postalCode, '53202');
  assert.equal(parse('12000 btu air conditioner').location.postalCode, null);
  assert.equal(parse('under 10000').location.postalCode, null);
  const two = parse('near 53202 or 53703');
  assert.equal(two.location.postalCode, null, 'two ZIPs: pick neither');
  assert.ok(two.explanation.some((e) => e.includes('more than one ZIP')));
});

// ------------------------------------------------------- shipping, condition

test('shipping: pickup only, local pickup, ships, and "shipping container" is an item', () => {
  assert.equal(parse('desk local pickup').location.includeShippable, false);
  assert.equal(parse('drone ships').location.includeShippable, true);
  assert.equal(parse('drone with free shipping').location.includeShippable, true);
  const box = parse('40ft shipping container');
  assert.equal(box.location.includeShippable, null);
  assert.ok(box.categories.includes('building-materials'));
});

test('conditions: new, used, refurbished, and parts for "for parts", "not working", "as-is"', () => {
  assert.deepEqual(parse('new drill').conditions, ['new']);
  assert.deepEqual(parse('used tractor').conditions, ['used']);
  assert.deepEqual(parse('refurbished laptop').conditions, ['refurbished']);
  assert.deepEqual(parse('laptop for parts').conditions, ['parts']);
  assert.deepEqual(parse('not working ipad').conditions, ['parts']);
  assert.deepEqual(parse('generator as-is').conditions, ['parts']);
  assert.deepEqual(parse('as is welder').conditions, ['parts']);
  assert.deepEqual(parse('new or used forklift').conditions, ['new', 'used']);
});

test('conditions: "not broken" is everything but parts; "like new" is noted, not filtered', () => {
  assert.deepEqual(parse('not broken iphone').conditions, ['new', 'used', 'refurbished']);
  const r = parse('like new chainsaw');
  assert.deepEqual(r.conditions, []);
  assert.ok(r.explanation.some((e) => e.includes('“like new” noted')));
});

// ------------------------------------------------------------------- timing

test('timing: ending today, closing soon, ends tomorrow, this weekend', () => {
  assert.equal(parse('tractor ending today').timing.closingWithinHours, 14);
  assert.equal(parse('closing soon').timing.closingWithinHours, 12);
  assert.equal(parse('ends tomorrow').timing.closingWithinHours, 38);
  // Tuesday 10:00 to the end of Sunday: 14 + 5 * 24.
  assert.equal(parse('this weekend').timing.closingWithinHours, 134);
});

test('timing: the calendar is read in the buyer\'s zone and never cut short', () => {
  // Saturday 15:00 in Chicago: this weekend is 9 + 24 hours.
  assert.equal(parseQuery('this weekend', { now: new Date('2026-10-03T20:00:00Z') }).timing.closingWithinHours, 33);
  // 23:30 in Chicago: today still has half an hour, rounded up to 1.
  assert.equal(parseQuery('ending today', { now: new Date('2026-09-30T04:30:00Z') }).timing.closingWithinHours, 1);
  // Same instant in New York is already tomorrow.
  const ny = parseQuery('ending today', { now: new Date('2026-09-30T04:30:00Z'), timeZone: 'America/New_York' });
  assert.equal(ny.timing.closingWithinHours, 24);
  const bad = parseQuery('ending today', { now: NOW, timeZone: 'Mars/Olympus' });
  assert.equal(bad.timing.closingWithinHours, 14);
  assert.ok(bad.explanation.some((e) => e.includes('not a time zone')));
});

test('timing: explicit hours and days', () => {
  assert.equal(parse('ending in 3 hours').timing.closingWithinHours, 3);
  assert.equal(parse('within 2 days').timing.closingWithinHours, 48);
  assert.equal(parse('next 48 hours').timing.closingWithinHours, 48);
  assert.equal(parse('48 hours left').timing.closingWithinHours, 48);
  assert.equal(parse('within 50 miles').timing.closingWithinHours, null, 'miles are not hours');
});

// --------------------------------------------------------------------- sort

test('sort: closest, cheapest, ending soonest, newest listings, hidden gems, sleepers', () => {
  assert.equal(parse('closest drills').sort, 'nearest');
  assert.equal(parse('cheapest drills').sort, 'cheapest');
  assert.equal(parse('drills ending soonest').sort, 'closing');
  assert.equal(parse('newest listings').sort, 'newest');
  assert.equal(parse('hidden gems').sort, 'sleeper');
  assert.equal(parse('sleepers').sort, 'sleeper');
  assert.equal(parse('drills').sort, 'relevance');
  assert.equal(parse('cheapest drills').searchParams.p_sort, 'cheapest');
  assert.deepEqual(parse('cheapest drills').terms, ['drills'], '"cheapest" is a sort, not a search word');
});

test('sort: "ending soonest" is an order, "ending soon" is a deadline', () => {
  const soonest = parse('welders ending soonest');
  assert.equal(soonest.sort, 'closing');
  assert.equal(soonest.timing.closingWithinHours, null);
  const soon = parse('welders ending soon');
  assert.equal(soon.sort, 'relevance');
  assert.equal(soon.timing.closingWithinHours, 12);
});

test('sleeper score filter', () => {
  const r = parse('sleeper score 6+ tools');
  assert.equal(r.minSleeperScore, 6);
  assert.equal(r.searchParams.p_min_sleeper, 6);
  assert.equal(r.hunt.min_sleeper_score, 6);
  assert.equal(parse('min sleeper 7.5').minSleeperScore, 7.5);
});

// -------------------------------------------------------------------- tiers

test('tiers: government, federal, state, county, municipal, school, estate sale, private', () => {
  assert.deepEqual(parse('government trucks').tiers, ['federal', 'state', 'county', 'municipal', 'school']);
  assert.deepEqual(parse('federal surplus vehicles').tiers, ['federal']);
  assert.deepEqual(parse('gsa vehicles').tiers, ['federal']);
  assert.deepEqual(parse('state surplus').tiers, ['state']);
  assert.deepEqual(parse('county auction plow truck').tiers, ['county']);
  assert.deepEqual(parse('municipal dump truck').tiers, ['municipal']);
  assert.deepEqual(parse('school district desks').tiers, ['school']);
  assert.deepEqual(parse('estate sale').tiers, ['estate']);
  assert.deepEqual(parse('private auction').tiers, ['private']);
  assert.deepEqual(parse('government trucks').hunt.tiers_only, ['federal', 'state', 'county', 'municipal', 'school']);
});

test('tiers: "estate jewelry", "real estate" and "school bus" are not seller types', () => {
  assert.deepEqual(parse('estate jewelry').tiers, []);
  assert.deepEqual(parse('estate jewelry').categories, ['jewelry']);
  assert.deepEqual(parse('school bus').tiers, []);
  const land = parse('real estate');
  assert.deepEqual(land.tiers, []);
  assert.deepEqual(land.categories, ['real-estate']);
  assert.ok(!land.explanation.some((e) => e.includes('out of scope')));
});

// --------------------------------------------------------------- exclusions

test('exclusions: no X, not X, without X, -X, exclude X', () => {
  assert.deepEqual(parse('drone without thermal').excludeTerms, ['thermal']);
  assert.deepEqual(parse('drone without thermal').features, [], 'an excluded feature is not required');
  assert.deepEqual(parse('dresser -mirror').excludeTerms, ['mirror']);
  assert.deepEqual(parse('table exclude pine').excludeTerms, ['pine']);
  assert.deepEqual(parse('table not maple').excludeTerms, ['maple']);
  assert.deepEqual(parse('chairs no rockers or recliners').excludeTerms, ['rockers', 'recliners']);
  assert.equal(parse('chairs no rockers or recliners').websearchQuery, 'chairs -rockers -recliners');
  assert.deepEqual(parse('bullion no silver plate').excludeTerms, ['silver plate']);
  assert.equal(parse('bullion no silver plate').websearchQuery, 'bullion -"silver plate"');
});

test('exclusions: "no reserve" is a feature and "no rust" is reported, not excluded', () => {
  const reserve = parse('no reserve tractor');
  assert.deepEqual(reserve.excludeTerms, []);
  assert.deepEqual(reserve.features, ['no reserve']);
  const rust = parse('truck no rust');
  assert.deepEqual(rust.excludeTerms, [], 'listings that say "no rust" contain the word rust');
  assert.deepEqual(rust.unparsed, ['no rust']);
});

// ----------------------------------------------------------------- synonyms

test('synonyms: drone, tv, fridge', () => {
  assert.deepEqual(parse('drone').synonyms.drone, ['quadcopter', 'uav', 'uas', 'multirotor']);
  assert.deepEqual(parse('tv').synonyms.tv, ['television']);
  assert.deepEqual(parse('fridge').synonyms.fridge, ['refrigerator']);
  // Plurals find their group; the typed word is still what is searched.
  assert.deepEqual(parse('laptops').synonyms.laptops, ['laptop', 'notebook']);
  assert.equal(parse('fridge').tsquery, "( 'fridge' | 'refrigerator' )");
  assert.equal(parse('fridge').websearchQuery, 'fridge', 'websearch carries no synonym groups');
});

// ------------------------------------------------------ brands in context

test('brands that are ordinary words need context: case, ram, apple, cat', () => {
  assert.deepEqual(parse('case tractor').brands, ['Case']);
  assert.deepEqual(parse('phone case').brands, []);
  assert.deepEqual(parse('ram 1500').brands, ['Ram'], 'a model number confirms the brand');
  assert.deepEqual(parse('16gb ram').brands, []);
  assert.deepEqual(parse('apple iphone').brands, ['Apple']);
  assert.deepEqual(parse('apple peeler').brands, []);
  assert.deepEqual(parse('cat excavator').brands, ['Caterpillar']);
  assert.deepEqual(parse('cat tree').brands, []);
  assert.ok(parse('phone case').explanation.every((e) => !e.startsWith('Brand:')));
  assert.ok(parse('apple peeler').explanation.some((e) => e.includes('kept it as a plain word')));
});

test('brands: one word, several companies ("lincoln")', () => {
  assert.deepEqual(parse('lincoln welder').brands, ['Lincoln Electric']);
  assert.deepEqual(parse('lincoln town car').brands, ['Lincoln']);
  assert.deepEqual(parse('lincoln penny').brands, []);
  assert.deepEqual(parse('lincoln penny').categories, ['coins']);
});

test('brands: spellings, run-together names, accents and ampersands', () => {
  assert.deepEqual(parse('snapon wrench').brands, ['Snap-on']);
  assert.deepEqual(parse('chevy silverado').brands, ['Chevrolet']);
  assert.deepEqual(parse('volkswagon beetle').brands, ['Volkswagen']);
  assert.deepEqual(parse('can-am outlander').brands, ['Can-Am']);
  assert.equal(parse('can-am outlander').websearchQuery, 'can-am outlander', 'both halves are stop words: keep the hyphen');
  assert.deepEqual(parse('hermès scarf').brands, ['Hermes']);
  assert.deepEqual(parse('u.s. mint proof set').brands, ['US Mint']);
  assert.deepEqual(parse('black & decker drill').brands, ['Black & Decker']);
  assert.equal(parse('black & decker drill').websearchQuery, 'black decker drill', '"and" would break a phrase');
});

test('brands named after their category split cleanly: "indian motorcycle", "mac tools" stays whole', () => {
  assert.equal(parse('indian motorcycle').websearchQuery, 'indian motorcycle');
  assert.deepEqual(parse('indian motorcycle').brands, ['Indian Motorcycle']);
  assert.equal(parse('mac tools').websearchQuery, '"mac tools"');
});

// ----------------------------------------------------------- years, models

test('years: ranges, decades and "pre-"', () => {
  assert.deepEqual([parse('1960s pyrex').minYear, parse('1960s pyrex').maxYear], [1960, 1969]);
  assert.deepEqual([parse('pre-1970 tonka').minYear, parse('pre-1970 tonka').maxYear], [null, 1969]);
  assert.deepEqual([parse('2010-2015 tacoma').minYear, parse('2010-2015 tacoma').maxYear], [2010, 2015]);
  assert.deepEqual([parse('between 1950 and 1960 tractor').minYear, parse('between 1950 and 1960 tractor').maxYear], [1950, 1960]);
  const exact = parse('1967 mustang');
  assert.deepEqual([exact.minYear, exact.maxYear], [1967, 1967]);
  assert.deepEqual(exact.terms, ['1967', 'mustang'], 'an exact year is also searched for');
  assert.deepEqual(parse('ford 2000 tractor').models, ['2000'], 'after a brand it is a model number');
  assert.equal(parse('ford 2000 tractor').minYear, null);
});

test('models: letter-digit designators, spaced numbers and measurements', () => {
  assert.deepEqual(parse('cat d6 dozer').models, ['d6']);
  assert.match(parse('cat d6 dozer').tsquery, /'d6':\*/);
  assert.deepEqual(parse('stihl ms 261').models, ['ms 261']);
  assert.match(parse('stihl ms 261').tsquery, /'ms261' \| 'ms-261'/);
  assert.deepEqual(parse('tesla model 3').phrases, ['model 3']);
  const hp = parse('5 hp motor');
  assert.deepEqual(hp.phrases, ['5 hp']);
  assert.equal(hp.location.postalCode, null);
});

test('measurements: fractions, inch marks and decimals are searched the way Postgres indexes them', () => {
  // Postgres indexes "3/8" as one lexeme, so it stays whole.
  assert.equal(parse('3/8 drive socket set').websearchQuery, '3/8 drive "socket set"');
  assert.deepEqual(parse('3/4 ton truck').phrases, ['3/4 ton']);
  // The inch mark is not indexed at all: '65" TV' is '65' to the search.
  const tv = parse('65" tv');
  assert.equal(tv.websearchQuery, '65 tv');
  assert.match(tv.tsquery, /\( '65' \| '65 inch' \| '65in' \)/);
  assert.equal(parse('40 inch tv').websearchQuery, '40 tv');
  assert.deepEqual(parse('ipad pro 12.9').terms, ['ipad', 'pro', '12.9']);
});

test('"2000 hours" alone could be engine hours or a deadline, so it is reported', () => {
  const r = parse('tractor 2000 hours');
  assert.deepEqual(r.unparsed, ['2000 hours']);
  assert.equal(r.timing.closingWithinHours, null);
  assert.deepEqual(r.models, []);
});

test('edge cases that once went wrong stay right', () => {
  // A quote that closes a phrase is not an inch mark, even after a digit.
  const quoted = parse('drone !"mini 2"');
  assert.deepEqual(quoted.excludeTerms, ['mini 2']);
  assert.equal(quoted.websearchQuery, 'drone -"mini 2"');
  // "from ... to ..." is a year range, not "2015 or newer" plus a stray "to 2020".
  assert.deepEqual([parse('from 2015 to 2020 tacoma').minYear, parse('from 2015 to 2020 tacoma').maxYear], [2015, 2020]);
  // A big radius is still a radius; only odometer wording means mileage.
  assert.equal(parse('within 1500 miles of 53202').location.radiusMiles, 1500);
  assert.deepEqual(parse('truck 150000 miles').unparsed, ['150000 miles']);
  // An age is not a price.
  const age = parse('tools over 50 years old');
  assert.equal(age.minPriceCents, null);
  assert.deepEqual(age.unparsed, ['over 50 years old']);
  // A town that is also a brand name keeps both words.
  assert.equal(parse('lathe near south bend').location.place?.city, 'South Bend');
});

test('quantities are noted, not searched for', () => {
  const r = parse('lot of 10 laptops');
  assert.deepEqual(r.terms, ['laptops']);
  assert.ok(r.explanation.some((e) => e.includes('lot of 10')));
});

// ------------------------------------------------------------ either-or

test('"or" between two things is an either-or, spelled out for websearch', () => {
  const r = parse('f-150 or silverado');
  assert.deepEqual(r.alternatives, [['f-150', 'silverado']]);
  assert.deepEqual(r.terms, []);
  assert.equal(r.websearchQuery, '"f-150" or silverado');
  assert.match(r.tsquery, /^\( \( 'f-150' \| 'f150' \| 'f 150' \) \| 'silverado' \)$/);
  const withRest = parse('diesel f-150 or silverado no rust');
  assert.equal(withRest.websearchQuery, 'diesel "f-150" or diesel silverado');
});

// ------------------------------------------------------------ explanation

test('the explanation reads as "I read this as ..."', () => {
  const r = parse('DJI drone with thermal under $1500 within 50 miles of 53202');
  assert.deepEqual(r.explanation, [
    'Looking for lots that mention “dji”, “drone” and “thermal”.',
    'Brand: DJI.',
    'Category: Drones.',
    'Must have: thermal.',
    'The full query also accepts “quadcopter”, “uav”, “uas”, “multirotor” for “drone”; “infrared”, “thermal imaging”, “radiometric” for “thermal”.',
    'Price: at most $1,500 (from “under $1500”).',
    'Location: within 50 miles of ZIP 53202.',
    'Ignored as filler: “with”.',
  ]);
});

test('options are validated rather than trusted', () => {
  const r = parse('nearby drones', { homePostalCode: '5320', defaultRadiusMiles: -4 });
  assert.equal(r.location.postalCode, null);
  assert.equal(r.location.radiusMiles, 50);
  assert.ok(r.explanation.some((e) => e.includes('not a 5-digit ZIP')));
  assert.ok(r.explanation.some((e) => e.includes('default radius must be')));
});
