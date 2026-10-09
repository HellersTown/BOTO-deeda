import { describe, expect, it } from 'vitest';
import {
  centsToDecimal,
  formatCents,
  formatCentsShort,
  formatMaybeCents,
  formatPercent,
  parseDollarsToCents,
  parsePercent,
} from './money';

describe('formatCents', () => {
  it('formats integer cents as en-US dollars', () => {
    expect(formatCents(8500)).toBe('$85.00');
    expect(formatCents(123456)).toBe('$1,234.56');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-1999)).toBe('-$19.99');
  });

  it('is exact where float division is not', () => {
    // 1234567890123456789 cents / 100 as a float would round the last digits.
    expect(formatCents(1234567890123456789n)).toBe('$12,345,678,901,234,567.89');
    expect(formatCents(Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,409.91');
  });

  it('refuses fractional cents rather than rounding them', () => {
    expect(() => formatCents(10.5)).toThrow(RangeError);
  });

  it('builds the exact decimal string', () => {
    expect(centsToDecimal(100)).toBe('1.00');
    expect(centsToDecimal(7)).toBe('0.07');
    expect(centsToDecimal(-250n)).toBe('-2.50');
  });
});

describe('formatCentsShort', () => {
  it('drops .00 for whole dollars and keeps cents otherwise', () => {
    expect(formatCentsShort(150000)).toBe('$1,500');
    expect(formatCentsShort(150050)).toBe('$1,500.50');
  });

  it('formatMaybeCents says so when the amount is missing', () => {
    expect(formatMaybeCents(null)).toBe('Not listed');
    expect(formatMaybeCents(100000, '—')).toBe('$1,000.00');
  });
});

describe('parseDollarsToCents', () => {
  it('reads what people type', () => {
    expect(parseDollarsToCents('$1,234.56')).toBe(123456);
    expect(parseDollarsToCents('1234.5')).toBe(123450);
    expect(parseDollarsToCents(' 85 ')).toBe(8500);
    expect(parseDollarsToCents('$ 300')).toBe(30000);
    expect(parseDollarsToCents('.5')).toBe(50);
    expect(parseDollarsToCents('0')).toBe(0);
  });

  it('returns null instead of guessing', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('12.345')).toBeNull();
    expect(parseDollarsToCents('1,23')).toBeNull();
    expect(parseDollarsToCents('-5')).toBeNull();
    expect(parseDollarsToCents('five dollars')).toBeNull();
    expect(parseDollarsToCents('1e3')).toBeNull();
  });
});

describe('percentages', () => {
  it('parses a rate from 0 to 100', () => {
    expect(parsePercent('30%')).toBe(30);
    expect(parsePercent(' 12.5 % ')).toBe(12.5);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('101')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
  });

  it('formats an engine rate without float noise', () => {
    expect(formatPercent(5.5)).toBe('5.5%');
    expect(formatPercent(3.0000000000000004)).toBe('3%');
    expect(formatPercent(0)).toBe('0%');
  });
});
