import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  ceil,
  cmp,
  div,
  floor,
  floorDiv,
  formatPercent,
  formatPlain,
  formatUsd,
  fromDecimalString,
  fromNumber,
  mul,
  parseInstant,
  rat,
  roundHalfAway,
  sub,
  toSafeNumber,
} from '../src/exact.ts';

test('numbers are read as the decimal that was written, never as the binary fraction', () => {
  assert.deepEqual(fromNumber(0.055), rat(55n, 1000n));
  assert.deepEqual(fromNumber(12.5), rat(25n, 2n));
  assert.deepEqual(fromNumber(8.875), rat(71n, 8n));
  assert.deepEqual(fromNumber(1.5e-7), rat(3n, 20000000n));
  assert.deepEqual(fromNumber(1e21), rat(10n ** 21n));
  assert.deepEqual(fromNumber(-0), rat(0n));
  assert.equal(fromNumber(Number.NaN), null);
  assert.equal(fromNumber(Number.POSITIVE_INFINITY), null);
  assert.equal(fromDecimalString('1.2.3'), null);
  assert.equal(fromDecimalString('1e-500'), null);
});

test('the float traps the doc formula falls into are exact here', () => {
  // 0.1 + 0.05 is 0.15000000000000002 in IEEE-754.
  assert.equal(0.1 + 0.05 === 0.15, false);
  assert.equal(cmp(add(fromNumber(0.1)!, fromNumber(0.05)!), fromNumber(0.15)!), 0);
  // 2390.63 / 1.195315 is exactly 2000.
  assert.deepEqual(div(fromNumber(2390.63)!, fromNumber(1.195315)!), rat(2000n));
});

test('floor and ceil are true floor and ceil for negatives too', () => {
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(floorDiv(7n, -2n), -4n);
  assert.equal(floorDiv(-6n, 3n), -2n);
  assert.equal(floor(rat(-1n, 3n)), -1n);
  assert.equal(ceil(rat(-1n, 3n)), 0n);
  assert.equal(ceil(rat(1n, 3n)), 1n);
  assert.throws(() => floorDiv(1n, 0n), RangeError);
  assert.throws(() => div(rat(1n), rat(0n)), RangeError);
});

test('display rounding is half away from zero', () => {
  assert.equal(roundHalfAway(rat(5n, 2n)), 3n);
  assert.equal(roundHalfAway(rat(-5n, 2n)), -3n);
  assert.equal(roundHalfAway(rat(249n, 100n)), 2n);
  assert.equal(roundHalfAway(mul(fromNumber(11100)!, fromNumber(1.055)!)), 11711n); // 11710.5
});

test('cents format like ingest money.ts, and percents like the spec |pct filter', () => {
  assert.equal(formatUsd(123456), '$1,234.56');
  assert.equal(formatUsd(5n), '$0.05');
  assert.equal(formatUsd(-500), '-$5.00');
  assert.equal(formatUsd(900719925474099100n), '$9,007,199,254,740,991.00');
  assert.equal(formatPercent(fromNumber(0.123)!), '12.3%');
  assert.equal(formatPercent(fromNumber(0.03)!), '3.0%');
  assert.equal(formatPercent(rat(450000n, 395900n)), '113.7%');
  assert.equal(formatPlain(rat(25n, 2n)), '12.5');
  assert.equal(formatPlain(rat(3n)), '3');
  assert.equal(formatPlain(rat(1n, 3n)), '0.333333');
});

test('amounts past exact JS integers are refused, not rounded', () => {
  assert.equal(toSafeNumber(9007199254740991n), 9007199254740991);
  assert.equal(toSafeNumber(9007199254740992n), null);
  assert.deepEqual(sub(rat(1n), rat(1n)), rat(0n));
});

test('close times must be ISO-8601 instants with an explicit offset', () => {
  assert.equal(parseInstant('2026-09-27T18:00:00Z'), Date.UTC(2026, 8, 27, 18));
  assert.equal(parseInstant('2026-09-27T18:00:00.123456+00:00'), Date.UTC(2026, 8, 27, 18, 0, 0, 123));
  assert.equal(parseInstant('2026-09-27T13:00:00-05:00'), Date.UTC(2026, 8, 27, 18));
  assert.equal(parseInstant('2026-09-27T18:00Z'), Date.UTC(2026, 8, 27, 18));
  // No offset: Date.parse would read it in the server's zone. Refuse.
  assert.equal(parseInstant('2026-09-27T18:00:00'), null);
  // Date only (GSA's AucEndDt): no time to read.
  assert.equal(parseInstant('2026-09-27'), null);
  // Date.parse rolls these over or accepts them; they are not real instants.
  assert.equal(parseInstant('2026-02-30T00:00:00Z'), null);
  assert.equal(parseInstant('2026-09-27T24:00:00Z'), null);
  assert.equal(parseInstant('2026-09-27T18:00:00+25:00'), null);
  assert.equal(parseInstant('next tuesday'), null);
});
