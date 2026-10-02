import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoneyToCents,
  formatCents,
  totalWithPremium,
  defaultNextBidCents,
} from '../src/money.ts';

test('parses the formats real auction pages actually emit', () => {
  assert.equal(parseMoneyToCents('$1,234.56'), 123456);
  assert.equal(parseMoneyToCents('1234.56'), 123456);
  assert.equal(parseMoneyToCents('$45'), 4500);
  assert.equal(parseMoneyToCents('45'), 4500);
  assert.equal(parseMoneyToCents('USD 1,234.00'), 123400);
  assert.equal(parseMoneyToCents('Current Bid: $45.00'), 4500);
  assert.equal(parseMoneyToCents('  $0.99  '), 99);
  assert.equal(parseMoneyToCents('$1,234,567.89'), 123456789);
  assert.equal(parseMoneyToCents('1,234'), 123400);
  assert.equal(parseMoneyToCents('$12.5'), 1250);
});

test('no float multiplication error creeps in', () => {
  // 19.99 * 100 is 1998.9999999999998 in IEEE-754. String assembly avoids it.
  assert.equal(parseMoneyToCents('19.99'), 1999);
  assert.equal(parseMoneyToCents('0.07'), 7);
  assert.equal(parseMoneyToCents('1.10'), 110);
  assert.equal(parseMoneyToCents('8.29'), 829);
  assert.equal(parseMoneyToCents(19.99), 1999);
  assert.equal(parseMoneyToCents(0.07), 7);

  // Exhaustive sweep over two decimal places: any float bug shows up here.
  for (let d = 0; d < 100; d++) {
    for (let c = 0; c < 100; c++) {
      const s = `${d}.${String(c).padStart(2, '0')}`;
      assert.equal(parseMoneyToCents(s), d * 100 + c, `failed on ${s}`);
    }
  }
});

test('European format resolves by last-separator-wins', () => {
  assert.equal(parseMoneyToCents('1.234,56'), 123456);
  assert.equal(parseMoneyToCents('1 234,56'), 123456);
});

test('"no bid" is null, not zero — the sleeper score depends on the difference', () => {
  for (const t of ['', '-', '—', 'N/A', 'no bids', 'No Bid', 'unsold', 'passed', 'TBD', 'call']) {
    assert.equal(parseMoneyToCents(t), null, `expected null for ${JSON.stringify(t)}`);
  }
  // And $0.00 is a real, distinct fact: a lot genuinely opening at zero.
  assert.equal(parseMoneyToCents('$0.00'), 0);
});

test('ambiguous input refuses rather than guessing', () => {
  assert.equal(parseMoneyToCents('$1.2K'), null);
  assert.equal(parseMoneyToCents('1.5M'), null);
  // A lone dot with three trailing digits cannot be resolved: $1,234 or $1.23?
  assert.equal(parseMoneyToCents('1.234'), null);
  assert.equal(parseMoneyToCents('45.500'), null);
  assert.equal(parseMoneyToCents('12.3456'), null);
  assert.equal(parseMoneyToCents('call for price'), null);
  assert.equal(parseMoneyToCents(null), null);
  assert.equal(parseMoneyToCents(undefined), null);
  assert.equal(parseMoneyToCents({}), null);
});

test('negatives are bad data, not values — there is no negative bid', () => {
  assert.equal(parseMoneyToCents('-$5.00'), null);
  assert.equal(parseMoneyToCents('($5.00)'), null);
  assert.equal(parseMoneyToCents(-500), null);
});

test('absurd magnitudes are rejected rather than mangled', () => {
  assert.equal(parseMoneyToCents(1e21), null);
  assert.equal(parseMoneyToCents(Number.POSITIVE_INFINITY), null);
  assert.equal(parseMoneyToCents(Number.NaN), null);
});

test('formatCents round-trips', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(7), '$0.07');
  assert.equal(formatCents(null), '—');
  assert.equal(formatCents(100000000), '$1,000,000.00');
});

test('buyer premium maths uses the real Hamele terms', () => {
  // 10% online premium, plus 3.5% for paying by card: $100 hammer is $113.50.
  assert.equal(totalWithPremium(10000, 10, 3.5), 11350);
  // Premium alone.
  assert.equal(totalWithPremium(10000, 10), 11000);
  // No premium published means no adjustment, not a silent zero-fill error.
  assert.equal(totalWithPremium(10000, null), 10000);
  assert.equal(totalWithPremium(null, 10), null);
  // Rounding stays in integer cents.
  assert.equal(totalWithPremium(999, 13), 1129); // 999 + round(129.87) = 999 + 130
});

test('next bid is what "under $50" must actually be tested against', () => {
  assert.equal(defaultNextBidCents(0), 250);
  assert.equal(defaultNextBidCents(4750), 5250);   // $47.50 -> +$5 -> $52.50
  assert.equal(defaultNextBidCents(1000000), 1025000);
  assert.equal(defaultNextBidCents(null), null);
});
