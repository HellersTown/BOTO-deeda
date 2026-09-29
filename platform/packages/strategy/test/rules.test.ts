import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, evaluateRules, renderTemplate, ruleEvidenceLabel } from '../src/rules.ts';
import { NOW, at, lot } from './fixtures.ts';
import type { FiredRule, LotContext, RulesResult } from '../src/types.ts';

const tested = new Set<string>();

/** One test per rule id; the last test in the file checks none was skipped. */
function ruleTest(id: string, title: string, fn: () => void): void {
  tested.add(id);
  const rule = RULES.find((r) => r.id === id);
  assert.ok(rule, `no rule ${id}`);
  test(`${id} ${rule.code}: ${title}`, fn);
}

function run(ctx: LotContext, now = NOW): RulesResult {
  const r = evaluateRules(ctx, now);
  assert.equal(r.status, 'ok', `expected ok, got ${r.status} (${[...r.missing, ...r.errors].join(', ')})`);
  return r;
}
const ids = (r: RulesResult): string[] => r.fired.map((f) => f.ruleId);
const fires = (ctx: LotContext, id: string, now = NOW): FiredRule => {
  const r = run(ctx, now);
  const f = r.fired.find((x) => x.ruleId === id);
  assert.ok(f, `${id} should fire; fired: ${ids(r).join(',')}`);
  return f;
};
const quiet = (ctx: LotContext, id: string, now = NOW): void => {
  const r = run(ctx, now);
  assert.ok(!ids(r).includes(id), `${id} should not fire; fired: ${ids(r).join(',')}`);
};

test('the base lot fires only its three info rules, and its primary is the proxy advice', () => {
  const r = run(lot());
  assert.deepEqual(ids(r), ['R11', 'R36', 'R37']);
  assert.equal(r.primary?.ruleId, 'R11');
  assert.equal(r.derived.max_hammer_cents, 7200);
});

// ---------------------------------------------------------------- actions

ruleTest('R00', 'fires once the close has passed, including at exactly the close', () => {
  const closed = run(lot({ closesAt: at(-5) }));
  assert.deepEqual(ids(closed), ['R00']);
  assert.equal(closed.primary?.code, 'LOT_CLOSED');
  assert.deepEqual(ids(run(lot({ closesAt: at(0) }))), ['R00']); // minutes_to_close = 0 is not open
  quiet(lot(), 'R00');
});

ruleTest('R01', 'fires when even a $0 hammer misses the margin, and names every deduction', () => {
  const f = fires(lot({ estimatedResaleCents: 5000, distanceMiles: 40 }), 'R01');
  assert.match(f.text, /^Skip this lot\. Even at a \$0 hammer/);
  assert.match(f.text, /pickup \$81\.00/);
  quiet(lot(), 'R01');
  quiet(lot({ estimatedResaleCents: null }), 'R01'); // no value: R20, not R01
});

ruleTest('R02', 'fires when the next bid is over the ceiling, and not when it equals it', () => {
  const f = fires(lot({ currentBidCents: 8000, bidCount: 5 }), 'R02');
  assert.equal(f.numbers.next_min_bid_cents, 8100);
  assert.equal(f.numbers.binding_cap, 'resale value');
  assert.equal(f.kind, 'action');
  assert.equal(f.evidenceLabel, 'SE');
  // next = 7100 + 100 = 7200 = ceiling: still biddable.
  quiet(lot({ currentBidCents: 7100, bidCount: 5 }), 'R02');
  // A tag sale is never "over max": R16-R18 handle it.
  quiet(lot({ sourcePlatform: 'estatesales-net', currentBidCents: 9000 }), 'R02');
});

ruleTest('R03', 'fires with the reserve unmet and bidding at 90% or more of the ceiling', () => {
  const f = fires(lot({ hasReserve: true, reserveMet: false, currentBidCents: 6480 }), 'R03'); // 6480 / 7200 = 0.9
  assert.match(f.text, /Reserve not met, and bidding is already at 90\.0% of your ceiling \(\$72\.00\)/);
  assert.ok(f.placeholder, 'the 90% is a PLACEHOLDER and the rule must say so');
  assert.ok(f.parameters.some((p) => p.name === 'constants.reserve_stop_ratio' && p.status === 'PLACEHOLDER'));
  quiet(lot({ hasReserve: true, reserveMet: false, currentBidCents: 6470 }), 'R03');
  quiet(lot({ hasReserve: true, reserveMet: true, currentBidCents: 6900 }), 'R03');
});

ruleTest('R10', 'fires on a hard close, from the platform or from a published 0-minute window', () => {
  const ebay = fires(lot({ sourcePlatform: 'ebay', buyerPremiumPct: null }), 'R10');
  assert.match(ebay.text, /alert you 120 seconds before the end; then place ONE bid of \$\d+\.00 with about 10 seconds left/);
  fires(lot({ softCloseMinutes: 0 }), 'R10');
  quiet(lot(), 'R10');
  quiet(lot({ sourcePlatform: 'ebay', currentBidCents: 20000 }), 'R10'); // over the ceiling: R02 instead
});

ruleTest('R11', 'fires on an extending close with more than the window left', () => {
  const f = fires(lot(), 'R11');
  assert.match(f.text, /at least 4 minutes before the scheduled close/);
  assert.equal(f.numbers.alert_seconds_before, 480); // (3 + 5) x 60
  quiet(lot({ closesAt: at(3) }), 'R11');
});

ruleTest('R12', 'fires inside the extension window, including exactly at its edge', () => {
  fires(lot({ closesAt: at(3) }), 'R12'); // minutes_to_close = window
  fires(lot({ closesAt: at(1) }), 'R12');
  quiet(lot({ closesAt: at(3.5) }), 'R12');
});

ruleTest('R13', 'warns when an extending close has no captured window', () => {
  const f = fires(lot({ softCloseMinutes: null }), 'R13');
  assert.equal(f.kind, 'warning');
  assert.match(f.text, /assumes up to 10 minutes/);
  fires(lot({ sourcePlatform: 'gsa', softCloseMinutes: null }), 'R13'); // inactivity, per-lot period not captured
  quiet(lot(), 'R13');
  quiet(lot({ sourcePlatform: 'maxsold', softCloseMinutes: null }), 'R13'); // platform default 2 min
});

ruleTest('R14', 'fires on a live webcast lot', () => {
  const r = run(lot({ auctionFormat: 'live' }));
  assert.equal(r.platformKey, 'hibid:webcast');
  assert.equal(r.primary?.ruleId, 'R14');
  quiet(lot(), 'R14');
});

ruleTest('R15', 'fires on a sealed bid with a positive ceiling', () => {
  fires(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid', bidCount: 0 }), 'R15');
  quiet(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid', bidCount: 0, estimatedResaleCents: 3000 }), 'R15');
});

// Tag sale: furniture, $250 value, 10 miles -> ceiling $56 (section 9.3).
const tag = (price: number): LotContext =>
  lot({ sourcePlatform: 'estatesales-net', category: 'furniture', estimatedResaleCents: 25000, distanceMiles: 10, buyerPremiumPct: null, currentBidCents: price, bidCount: null });

ruleTest('R16', 'fires when the tag price is already under the ceiling', () => {
  const f = fires(tag(5000), 'R16');
  assert.match(f.text, /tag price \$50\.00 is already under your ceiling \$56\.00/);
  fires(tag(5600), 'R16');
  quiet(tag(5700), 'R16');
});

ruleTest('R17', 'fires when only the final-day discount brings the tag under the ceiling', () => {
  const f = fires(tag(10000), 'R17');
  assert.match(f.text, /about \$50\.00, under your ceiling of \$56\.00/);
  assert.ok(f.parameters.some((p) => p.name === 'constants.tag_final_day_discount_rate' && p.status === 'PLACEHOLDER'));
  quiet(tag(15000), 'R17');
});

ruleTest('R18', 'fires when even the final-day price is over the ceiling', () => {
  fires(tag(15000), 'R18');
  fires(tag(11300), 'R18'); // floor(11300 x 0.5) = 5650 > 5600
  quiet(tag(11200), 'R18'); // 5600 <= 5600
});

ruleTest('R19', 'fires when the platform closing rule is not captured', () => {
  const f = fires(lot({ sourcePlatform: 'purple-wave', softCloseMinutes: null }), 'R19');
  assert.match(f.text, /about 11 minutes before the close/);
  fires(lot({ sourcePlatform: 'some-new-site', softCloseMinutes: null }), 'R19'); // unknown platform -> other
  quiet(lot(), 'R19');
  // A lot that publishes a window > 0 is treated as extending even when the
  // platform's rule is unknown (effective_close_type doc), so R11 applies instead.
  quiet(lot({ sourcePlatform: 'purple-wave', softCloseMinutes: 3 }), 'R19');
  fires(lot({ sourcePlatform: 'purple-wave', softCloseMinutes: 3 }), 'R11');
});

ruleTest('R20', 'fires when there is neither a value nor a budget', () => {
  const f = fires(lot({ estimatedResaleCents: null }), 'R20');
  assert.match(f.text, /Every \$100 bid here costs about \$124\.96 before pickup/);
  quiet(lot({ estimatedResaleCents: null, maxBudgetCents: 5000 }), 'R20');
  quiet(lot(), 'R20');
});

ruleTest('R21', 'warns when the ceiling comes from a budget alone', () => {
  const f = fires(lot({ estimatedResaleCents: null, maxBudgetCents: 10000 }), 'R21');
  assert.match(f.text, /\$80\.00 hammer, \$100\.00 invoice/);
  quiet(lot({ maxBudgetCents: 10000 }), 'R21');
});

// ---------------------------------------------------------------- warnings

ruleTest('R30', 'fires when all-in at the current bid is at or above the value, boundary included', () => {
  fires(lot({ currentBidCents: 26000 }), 'R30');
  // eBay, no premium, tax 5.5%, no card fee, ships free: all-in = current x 1.055 exactly.
  const exact = (value: number) =>
    lot({ sourcePlatform: 'ebay', buyerPremiumPct: 0, ships: true, pickupRequired: false, shippingCents: 0, distanceMiles: null, currentBidCents: 20000, estimatedResaleCents: value });
  fires(exact(21100), 'R30'); // 20000 x 1.055 = 21100 >= 21100
  quiet(exact(21101), 'R30');
});

ruleTest('R31', 'fires when transport is more than 25% of the value, not at exactly 25%', () => {
  const f = fires(lot({ distanceMiles: 60 }), 'R31'); // 10900 / 30000
  assert.match(f.text, /60 miles each way, about \$109\.00\) is 36\.3% of the expected resale value/);
  quiet(lot({ pickupCostCents: 7500 }), 'R31'); // exactly 0.25
  fires(lot({ pickupCostCents: 7501 }), 'R31');
});

ruleTest('R32', "fires at the category's herd threshold", () => {
  const f = fires(lot({ bidCount: 15 }), 'R32');
  assert.ok(f.parameters.some((p) => p.name === 'category.herd_bid_count' && p.status === 'PLACEHOLDER'));
  quiet(lot({ bidCount: 14 }), 'R32');
  fires(lot({ category: 'furniture', bidCount: 10 }), 'R32');
});

ruleTest('R33', 'fires on no photos in a high-value-risk category only', () => {
  fires(lot({ category: 'electronics', imageCount: 0 }), 'R33');
  quiet(lot({ category: 'electronics', imageCount: 1 }), 'R33');
  quiet(lot({ category: 'tools', imageCount: 0 }), 'R33');
});

ruleTest('R34', 'fires on a quiet lot with thin text or few photos, but at least one photo', () => {
  const f = fires(lot({ bidCount: 1, descriptionWords: 6 }), 'R34');
  assert.match(f.text, /thin listing \(6 words, 6 photo\(s\)\) with 1 bid\(s\)/);
  assert.equal(f.kind, 'info');
  fires(lot({ bidCount: 0, imageCount: 2 }), 'R34');
  quiet(lot({ bidCount: 2, descriptionWords: 6 }), 'R34');
  quiet(lot({ bidCount: 0, imageCount: 0, descriptionWords: 6 }), 'R34'); // no photos: a gamble, not a sleeper
  quiet(lot({ bidCount: 0 }), 'R34'); // 40 words, 6 photos: well described
});

ruleTest('R35', 'warns whenever the lot premium was not captured, naming what was assumed', () => {
  assert.match(fires(lot({ buyerPremiumPct: null }), 'R35').text, /using 20% \(conservative assumption\)/);
  assert.match(fires(lot({ sourcePlatform: 'govdeals', buyerPremiumPct: null }), 'R35').text, /using 12\.5% \(platform default\)/);
  quiet(lot(), 'R35');
});

ruleTest('R36', 'shows the true cost of $100 of hammer on every open lot', () => {
  const f = fires(lot(), 'R36');
  assert.equal(f.text, 'Every $100 of hammer price costs about $124.96 on the invoice (15% premium, 5.5% tax, 3.0% card fee), before pickup.');
  quiet(lot({ closesAt: at(-1) }), 'R36');
});

ruleTest('R37', 'notes that extending closes finish higher', () => {
  fires(lot(), 'R37');
  quiet(lot({ sourcePlatform: 'ebay' }), 'R37');
});

ruleTest('R38', 'gives the GSA inactivity, payment and removal terms on GSA lots', () => {
  fires(lot({ sourcePlatform: 'gsa' }), 'R38');
  fires(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid' }), 'R38'); // gsa:sealed, base gsa
  quiet(lot(), 'R38');
});

ruleTest('R39', 'gives the Wisconsin Surplus terms, whichever way the platform is spelled', () => {
  fires(lot({ sourcePlatform: 'wisconsin-surplus' }), 'R39');
  fires(lot({ sourcePlatform: 'wisconsinsurplus' }), 'R39');
  quiet(lot(), 'R39');
});

ruleTest('R40', 'asks for the removal terms on GovDeals, Public Surplus and Municibid', () => {
  for (const p of ['govdeals', 'public-surplus', 'publicsurplus', 'municibid']) fires(lot({ sourcePlatform: p }), 'R40');
  quiet(lot({ sourcePlatform: 'gsa' }), 'R40');
  // "liquidity-services" runs GovDeals and others; it is not guessed to be GovDeals.
  quiet(lot({ sourcePlatform: 'liquidity-services' }), 'R40');
});

ruleTest('R41', 'flags the SF-97 on federal vehicles', () => {
  fires(lot({ sourcePlatform: 'gsa', category: 'vehicles' }), 'R41');
  quiet(lot({ sourcePlatform: 'govdeals', category: 'vehicles' }), 'R41');
});

ruleTest('R42', 'asks about paperwork on vehicles anywhere but GSA', () => {
  const f = fires(lot({ sourcePlatform: 'govdeals', category: 'vehicles' }), 'R42');
  assert.equal(f.evidenceLabel, 'UNVERIFIED');
  quiet(lot({ sourcePlatform: 'gsa', category: 'vehicles' }), 'R42');
});

ruleTest('R43', 'warns about aircraft removal costs', () => {
  fires(lot({ category: 'aircraft' }), 'R43');
  quiet(lot(), 'R43');
});

ruleTest('R44', 'notes the winner\'s curse where the category haircut is 15% or more', () => {
  const f = fires(lot({ category: 'electronics' }), 'R44');
  assert.match(f.text, /20\.0% uncertainty haircut/);
  fires(lot({ category: 'vehicles' }), 'R44'); // exactly 0.15
  quiet(lot({ category: 'tools' }), 'R44'); // 0.10
  quiet(lot({ category: 'electronics', estimatedResaleCents: null }), 'R44');
});

ruleTest('R45', 'notes a quiet lot within 12 hours of closing', () => {
  const f = fires(lot({ bidCount: 1, closesAt: at(720) }), 'R45');
  assert.equal(f.text, 'Closes in 720 min with 1 bid(s): the crowd has not found it yet.');
  quiet(lot({ bidCount: 1, closesAt: at(721) }), 'R45');
  quiet(lot({ bidCount: 2, closesAt: at(60) }), 'R45');
});

test('every one of the 32 rules has its own test above', () => {
  assert.deepEqual([...tested].sort(), RULES.map((r) => r.id).sort());
});

// ---------------------------------------------------------------- evaluation mechanics

test('primary is the lowest-priority fired action; actions, warnings and info are split and sorted', () => {
  // Electronics at 20% assumed premium: ceiling $35, next bid $81.
  const r = run(lot({ currentBidCents: 8000, hasReserve: true, reserveMet: false, bidCount: 15, category: 'electronics', buyerPremiumPct: null }));
  assert.equal(r.derived.max_hammer_cents, 3500);
  assert.equal(r.primary?.ruleId, 'R02');
  assert.deepEqual(r.actions.map((a) => a.ruleId), ['R02', 'R03']);
  assert.ok(r.warnings.every((w) => w.kind === 'warning'));
  assert.ok(r.info.every((w) => w.kind === 'info'));
  const priorities = r.fired.map((f) => f.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b));
});

test('each fired rule carries the inputs that triggered it', () => {
  const f = fires(lot({ currentBidCents: 8000, bidCount: 5 }), 'R02');
  assert.deepEqual(f.triggeredBy, { is_open: true, effective_close_type: 'soft', max_hammer_cents: 7200, next_min_bid_cents: 8100 });
});

test('evidence labels: the strongest cited source, or the doc\'s own label when none is cited', () => {
  const byId = (id: string) => RULES.find((r) => r.id === id)!;
  assert.equal(ruleEvidenceLabel(byId('R10')), 'SE');
  assert.equal(ruleEvidenceLabel(byId('R00')), 'DESIGN');
  assert.equal(ruleEvidenceLabel(byId('R16')), 'UNVERIFIED');
  assert.equal(ruleEvidenceLabel(byId('R34')), 'SE'); // SE sources plus the INTERNAL sleeper thresholds
});

test('a missing photo count leaves R33 and R34 not evaluated instead of guessing either way', () => {
  const r = run(lot({ category: 'electronics', imageCount: null, bidCount: 0 }));
  const ne = Object.fromEntries(r.notEvaluated.map((n) => [n.ruleId, n.needs]));
  assert.deepEqual(ne.R33, ['imageCount']);
  assert.deepEqual(ne.R34, ['imageCount']);
  assert.ok(!ids(r).includes('R33'));
  // A missing word count cannot rule R34 in or out when there are few photos... but 1 photo < 3 decides it.
  const words = run(lot({ descriptionWords: null, imageCount: 1, bidCount: 0 }));
  assert.ok(ids(words).includes('R34'));
  const wordsOnly = run(lot({ descriptionWords: null, bidCount: 0 }));
  assert.deepEqual(wordsOnly.notEvaluated.map((n) => n.ruleId), ['R34']);
});

test('a missing bid count is fine when the lot publishes its next bid; the herd rules are then not evaluated', () => {
  const r = run(lot({ bidCount: null, nextBidCents: 2100 }));
  assert.equal(r.derived.next_min_bid_cents, 2100);
  // R34 is not among them: the lot is well described (40 words, 6 photos), which
  // rules it out whatever the bid count (false AND unknown is false).
  assert.deepEqual(r.notEvaluated.map((n) => n.ruleId).sort(), ['R32', 'R45']);
  assert.deepEqual(r.notEvaluated[0]?.needs, ['bidCount']);
});

test('without a close time, a current bid or a bid count the rules report insufficient data', () => {
  assert.deepEqual(evaluateRules(lot({ closesAt: null }), NOW).missing, ['closesAt']);
  assert.deepEqual(evaluateRules(lot({ closesAt: '2026-09-28 18:00' }), NOW).missing, ['closesAt']);
  assert.deepEqual(evaluateRules(lot({ currentBidCents: null }), NOW).missing, ['currentBidCents']);
  assert.deepEqual(evaluateRules(lot({ bidCount: null }), NOW).missing, ['bidCount']);
  // No bids yet: the opening bid stands in for the current bid, as the spec input doc says.
  const opening = run(lot({ currentBidCents: null, bidCount: 0, startingBidCents: 1500 }));
  assert.equal(opening.inputs.current_bid_cents, 1500);
  assert.equal(opening.derived.next_min_bid_cents, 1500);
  assert.equal(evaluateRules(lot({ bidCount: -1 }), NOW).status, 'invalid_input');
});

test('the lot page wins over the ladder for the next bid; a next bid below the current one is ignored', () => {
  assert.equal(run(lot({ nextBidCents: 2500 })).derived.next_min_bid_cents, 2500);
  assert.equal(run(lot({ nextBidCents: 1000 })).derived.next_min_bid_cents, 2050);
});

test('money in derived output is whole cents; ratios stay ratios', () => {
  const r = run(lot({ estimatedResaleCents: 12345, distanceMiles: 12.35 }));
  for (const [k, v] of Object.entries(r.derived)) {
    if (k.endsWith('_cents') && v !== null) assert.ok(Number.isSafeInteger(v), `${k} = ${String(v)}`);
  }
  assert.equal(typeof r.derived.cost_multiplier, 'number');
  assert.equal(r.derived.transport_cents, 4229); // 2 x 12.35 x 70 + 2500 = 4229
});

test('amounts too large for exact JS integers come out null, never wrong', () => {
  const r = run(lot({ currentBidCents: 9_000_000_000_000_000, bidCount: 0 }));
  assert.equal(r.derived.all_in_at_current_cents, null);
  assert.equal(r.inputs.current_bid_cents, 9_000_000_000_000_000);
});

test('a date-only close time puts a caveat on the timing rules, not on the others', () => {
  const r = run(lot({ sourcePlatform: 'gsa', softCloseMinutes: 10, closeTimePrecise: false, closesAt: at(3000) }));
  assert.equal(r.caveats.length, 1);
  assert.equal(r.fired.find((f) => f.ruleId === 'R11')?.caveats.length, 1);
  assert.equal(r.fired.find((f) => f.ruleId === 'R36')?.caveats.length, 0);
  assert.equal(run(lot()).caveats.length, 0);
});

test('templates render usd, pct, min, dotted constants and n/a exactly as output_contract says', () => {
  const data = { c: 123456, f: 0.123, m: 90.9, n: null, s: 'budget', constants: { k: 10 } };
  assert.equal(renderTemplate('{c|usd} {f|pct} {m|min} {n} {s} {constants.k}', data), '$1,234.56 12.3% 90 min n/a budget 10');
  assert.throws(() => renderTemplate('{missing}', data));
  // Every rule text renders without a leftover placeholder on a busy lot.
  const r = run(lot({ currentBidCents: 6600, hasReserve: true, reserveMet: false, bidCount: 1, closesAt: at(60), buyerPremiumPct: null, category: 'electronics' }));
  for (const f of r.fired) assert.ok(!/\{[a-z_.]+(\|[a-z]+)?\}/.test(f.text), f.text);
});

test('now is required and must be a real Date', () => {
  assert.throws(() => evaluateRules(lot(), new Date('garbage')), TypeError);
  assert.throws(() => evaluateRules(lot(), undefined as unknown as Date), TypeError);
});
