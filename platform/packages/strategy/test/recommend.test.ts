import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../src/strategies.ts';
import { IMPRECISE_CLOSE_CAVEAT } from '../src/rules.ts';
import { NOW, at, lot } from './fixtures.ts';
import type { LotContext, Recommendation } from '../src/types.ts';

const rec = (ctx: LotContext, now = NOW): Recommendation => recommend(ctx, now);
const closeMs = (minutes: number) => NOW.getTime() + minutes * 60000;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------- timing by closing rule

test('hard close: alert at T-120 s, one bid at T-10 s, countdown allowed', () => {
  // eBay's card fee default is 0: k = 1.15 x 1.055 = 1.21325; 9100 / 1.21325 -> $75, on the $5 grid.
  const r = rec(lot({ sourcePlatform: 'ebay', closesAt: at(2880) }));
  const t = r.timing!;
  assert.equal(t.mode, 'snipe');
  assert.equal(t.precise, true);
  assert.equal(t.countdown, true);
  assert.equal(t.alertSecondsBefore, 120);
  assert.equal(t.alertAt, iso(closeMs(2880) - 120000));
  assert.equal(t.bidAt, iso(closeMs(2880) - 10000));
  assert.match(t.instruction, /place ONE bid of \$75\.00 with about 10 seconds left \(T-10 s\)/);
});

test('extending close: enter the single max bid at T-(W+1) min, alert at T-(W+5) min', () => {
  const t = rec(lot({ closesAt: at(600) })).timing!;
  assert.equal(t.mode, 'proxy_before_window');
  assert.equal(t.windowMinutes, 3);
  assert.equal(t.windowAssumed, false);
  assert.equal(t.alertSecondsBefore, 480);
  assert.equal(t.alertAt, iso(closeMs(600) - 480000));
  assert.equal(t.bidAt, iso(closeMs(600) - 4 * 60000));
  assert.match(t.instruction, /Enter your single max bid of \$70\.00 once, at T-4 min or earlier/);
});

test('inside the extension window: enter it now, once, and do not raise it', () => {
  const t = rec(lot({ closesAt: at(2) })).timing!;
  assert.equal(t.mode, 'in_extension_window');
  assert.equal(t.bidAt, NOW.toISOString());
  assert.equal(t.alertAt, null);
  assert.match(t.instruction, /inside the 3-minute extension window/);
});

test('window not captured: the spec assumes 10 minutes, and the advice says so', () => {
  const t = rec(lot({ softCloseMinutes: null })).timing!;
  assert.equal(t.windowMinutes, 10);
  assert.equal(t.windowAssumed, true);
  assert.equal(t.alertSecondsBefore, 900);
  assert.match(t.instruction, /T-11 min/);
  assert.match(t.instruction, /assumes 10 minutes; check the auction terms/);
});

test('GSA inactivity close with a precise time: changing your own proxy late restarts the clock', () => {
  const t = rec(lot({ sourcePlatform: 'gsa', softCloseMinutes: 10, closesAt: at(600) })).timing!;
  assert.equal(t.closeType, 'inactivity');
  assert.match(t.instruction, /closes only after 10 minutes with no bids, and changing your own proxy bid late restarts that clock too/);
});

test('live webcast: absentee bid, alert an hour before', () => {
  const t = rec(lot({ auctionFormat: 'live', closesAt: at(600) })).timing!;
  assert.equal(t.mode, 'absentee');
  assert.equal(t.alertSecondsBefore, 3600);
  assert.match(t.instruction, /leave an absentee \(max\) bid of \$70\.00 before the sale/);
});

test('sealed bid: submit the ceiling, alert a day before; no ladder rounding', () => {
  // gsa:sealed has a 0 card fee default: k = 1.21325 and the ceiling is $75, entered as is.
  const r = rec(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid', bidCount: 0, closesAt: at(3000) }));
  assert.equal(r.timing?.mode, 'sealed');
  assert.equal(r.timing?.alertSecondsBefore, 86400);
  assert.equal(r.walkAway.maxBidCents, r.walkAway.hammerCeilingCents);
  assert.match(r.timing!.instruction, /Submit \$75\.00 or less/);
});

test('tag sale: the tag rule decides between buying early, waiting, and passing', () => {
  const tag = (price: number) =>
    rec(lot({ sourcePlatform: 'estatesales-net', category: 'furniture', estimatedResaleCents: 25000, distanceMiles: 10, currentBidCents: price, buyerPremiumPct: null }));
  const early = tag(5000);
  assert.equal(early.timing?.mode, 'tag');
  assert.equal(early.primary?.ruleId, 'R16');
  assert.equal(early.timing?.instruction, early.primary?.text);
  const wait = tag(10000);
  assert.equal(wait.timing?.mode, 'tag');
  assert.equal(wait.primary?.ruleId, 'R17');
  assert.equal(wait.status, 'ok');
  const pass = tag(15000);
  assert.equal(pass.timing?.mode, 'walk_away');
  assert.equal(pass.status, 'walk_away');
});

test('closing rule not captured: one max bid about 11 minutes before, with an alert the spec leaves out', () => {
  const t = rec(lot({ sourcePlatform: 'purple-wave', softCloseMinutes: null, closesAt: at(600) })).timing!;
  assert.equal(t.mode, 'unknown_rule');
  assert.equal(t.alertSecondsBefore, 900);
  assert.equal(t.bidAt, iso(closeMs(600) - 11 * 60000));
});

test('walk away: no alert, no bid time, the reason in plain words', () => {
  const r = rec(lot({ currentBidCents: 9000 }));
  assert.equal(r.status, 'walk_away');
  assert.equal(r.timing?.mode, 'walk_away');
  assert.equal(r.timing?.alertSecondsBefore, null);
  assert.equal(r.timing?.bidAt, null);
  assert.match(r.timing!.instruction, /^Don't bid\. Walk away\. The next bid would be \$91\.00; your ceiling is \$72\.00/);
  assert.equal(r.walkAway.maxBidCents, null);
});

test('reserve not met near the ceiling is a stop, even though a bid is still possible', () => {
  const r = rec(lot({ hasReserve: true, reserveMet: false, currentBidCents: 6600 }));
  assert.equal(r.primary?.ruleId, 'R03');
  assert.equal(r.status, 'walk_away');
  assert.equal(r.walkAway.status, 'ok'); // the calculator alone would let you bid
});

test('closed lot: status closed and the record-the-result instruction', () => {
  const r = rec(lot({ closesAt: at(-30) }));
  assert.equal(r.status, 'closed');
  assert.equal(r.timing?.mode, 'closed');
  assert.deepEqual(r.strategies, []);
});

// ---------------------------------------------------------------- close time known only to the day

test('date-only close (GSA): no countdown, no seconds, and everything moves a day earlier', () => {
  const closesAt = '2026-09-30T03:59:59.000Z'; // 23:59:59 America/New_York on Sep 29, as the GSA adapter writes it
  const r = rec(lot({ sourcePlatform: 'gsa', softCloseMinutes: 10, closeTimePrecise: false, closesAt }));
  const t = r.timing!;
  assert.equal(t.precise, false);
  assert.equal(t.countdown, false);
  assert.equal(t.mode, 'proxy_before_close_date');
  assert.equal(t.alertSecondsBefore, 86400 + (10 + 5) * 60);
  assert.equal(t.bidAt, iso(Date.parse(closesAt) - 86400000 - 11 * 60000));
  assert.doesNotMatch(t.instruction, /second|T-\d/);
  assert.match(t.instruction, /at least a day before the listed close/);
  assert.ok(r.explanation.includes(IMPRECISE_CLOSE_CAVEAT));
  assert.equal(r.rules.caveats.length, 1);
});

test('date-only hard close: a last-seconds bid cannot be timed, so the advice becomes a proxy bid', () => {
  const r = rec(lot({ sourcePlatform: 'other:hard', closeTimePrecise: false, closesAt: at(2880) }));
  assert.equal(r.primary?.ruleId, 'R10');
  assert.equal(r.timing?.mode, 'proxy_before_close_date');
  assert.doesNotMatch(r.timing!.instruction, /second|T-\d/);
  assert.ok(!r.strategies.some((s) => s.id === 'S4'), 'no sniping advice without a close time');
  assert.ok(r.strategies.some((s) => s.id === 'S1'));
});

test('date-only live and sealed lots keep their mode but move the alert a day earlier', () => {
  assert.equal(rec(lot({ auctionFormat: 'live', closeTimePrecise: false, closesAt: at(4000) })).timing?.alertSecondsBefore, 3600 + 86400);
  assert.equal(
    rec(lot({ sourcePlatform: 'gsa', auctionFormat: 'sealed_bid', bidCount: 0, closeTimePrecise: false, closesAt: at(9000) })).timing?.alertSecondsBefore,
    86400 + 86400,
  );
});

// ---------------------------------------------------------------- the whole recommendation

test('the explanation reads in order: number, where it came from, moment, warnings, what is unverified', () => {
  // Premium not captured on HiBid -> 20%: k = 1.30398; 9100 / 1.30398 = 6978.6 -> $69, entered as $65.
  const r = rec(lot({ buyerPremiumPct: null, bidCount: 15 }));
  const [first, second, third] = r.explanation;
  assert.match(first!, /^Walk-away: \$69\.00 hammer\. From a \$300\.00 resale value: \$258\.00 after selling costs, minus \$90\.00 required profit, \$32\.00 pickup and \$45\.00 risk and repair reserve, divided by 1\.304 for premium, tax and card fee\.$/);
  assert.match(second!, /^Enter it as \$65\.00/);
  assert.match(third!, /^Extending close/);
  assert.ok(r.explanation.some((l) => /Crowded lot \(15 bids\)/.test(l)));
  assert.ok(r.explanation.some((l) => /Buyer's premium was not captured/.test(l)));
  assert.ok(r.explanation.some((l) => /^Placeholder values behind these numbers/.test(l)));
});

test('labels gather every PLACEHOLDER and UNVERIFIED value behind the recommendation', () => {
  const r = rec(lot({ buyerPremiumPct: null, bidCount: 15, hasReserve: true, reserveMet: false, currentBidCents: 5700 }));
  for (const p of ['buyer_premium_pct', 'card_fee_rate', 'category.target_margin_rate', 'category.herd_bid_count', 'constants.reserve_stop_ratio', 'constants.pickup_time_cost_cents']) {
    assert.ok(r.labels.placeholders.includes(p), `${p} missing from ${r.labels.placeholders.join(', ')}`);
  }
  assert.ok(r.labels.unverified.includes('sales_tax_rate'));
  // With every placeholder replaced by the user's own numbers, fewer remain.
  const own = rec(lot({ targetMarginPct: 25, minProfitCents: 2000, timeValueCents: 3000, cardFeePct: 0 }));
  assert.ok(!own.labels.placeholders.includes('category.target_margin_rate'));
  assert.ok(!own.labels.placeholders.includes('constants.pickup_time_cost_cents'));
  assert.ok(!own.labels.placeholders.includes('card_fee_rate'));
});

test('no value estimate: status needs_value, null walk-away with the reason, timing still offered', () => {
  const r = rec(lot({ estimatedResaleCents: null }));
  assert.equal(r.status, 'needs_value');
  assert.equal(r.walkAway.maxBidCents, null);
  assert.equal(r.walkAway.status, 'insufficient_data');
  assert.match(r.explanation[0]!, /^No ceiling yet\. Add the median of recent SOLD prices/);
  assert.match(r.timing!.instruction, /^No walk-away number yet; add sold comps first\. Then:/);
});

test('no close time: the walk-away number still comes back, with what is missing', () => {
  const r = rec(lot({ closesAt: null }));
  assert.equal(r.status, 'insufficient_data');
  assert.equal(r.timing, null);
  assert.equal(r.walkAway.maxBidCents, 7000);
  assert.ok(r.explanation.some((l) => /without: closesAt/.test(l)));
});

test('invalid input: status invalid_input and the errors, nothing else', () => {
  const r = rec(lot({ currentBidCents: -5 }));
  assert.equal(r.status, 'invalid_input');
  assert.deepEqual(r.strategies, []);
  assert.match(r.explanation[0]!, /currentBidCents/);
});

test('platform spellings from the seeds resolve; an ambiguous one is refused, not guessed', () => {
  assert.equal(rec(lot({ sourcePlatform: 'publicsurplus' })).rules.platformKey, 'public-surplus');
  assert.equal(rec(lot({ sourcePlatform: 'KBID' })).rules.platformKey, 'k-bid');
  assert.equal(rec(lot({ sourcePlatform: 'estatesales' })).rules.platformKey, 'other:tag');
  const ls = rec(lot({ sourcePlatform: 'liquidity-services' }));
  assert.equal(ls.rules.platformKey, 'other');
  assert.ok(ls.explanation.some((l) => /GovDeals, AllSurplus and Liquidation\.com/.test(l)));
});

test('the same input and now give the same answer, and the engine never reads the clock', () => {
  const RealDate = globalThis.Date;
  class NoClockDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) throw new Error('the engine read the clock');
      super(...(args as [number]));
    }
    static override now(): number {
      throw new Error('the engine read the clock');
    }
  }
  const now = new NoClockDate(NOW.getTime());
  globalThis.Date = NoClockDate as unknown as DateConstructor;
  try {
    const a = recommend(lot({ closeTimePrecise: false }), now);
    const b = recommend(lot({ closeTimePrecise: false }), now);
    assert.deepEqual(a, b);
  } finally {
    globalThis.Date = RealDate;
  }
});

test('now must be supplied', () => {
  assert.throws(() => recommend(lot(), undefined as unknown as Date), TypeError);
});
