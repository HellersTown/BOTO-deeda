/**
 * Money is integer cents everywhere (the schema's rule 1). Formatting builds an
 * exact decimal string from the cents with BigInt and hands that string to
 * Intl.NumberFormat, which formats decimal strings exactly (NumberFormat v3),
 * so no amount is ever divided as a float. Parsing assembles cents from digits.
 */

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function toBig(cents: number | bigint): bigint {
  if (typeof cents === 'bigint') return cents;
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Money must be whole cents (got ${cents}).`);
  return BigInt(cents);
}

/** "-1234.05" for -123405n: the exact decimal the cents stand for. */
export function centsToDecimal(cents: number | bigint): `${number}` {
  const c = toBig(cents);
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const dollars = abs / 100n;
  const rest = abs % 100n;
  return `${negative ? '-' : ''}${dollars}.${rest.toString().padStart(2, '0')}` as `${number}`;
}

/** "$1,234.56". */
export function formatCents(cents: number | bigint): string {
  return USD.format(centsToDecimal(cents));
}

/** "$1,500" for whole dollars, "$1,500.50" otherwise: for chips, plan prices and compact labels. */
export function formatCentsShort(cents: number | bigint): string {
  const c = toBig(cents);
  return c % 100n === 0n ? USD_WHOLE.format(centsToDecimal(c)) : formatCents(c);
}

/** formatCents, or a dash-free fallback for a missing amount. */
export function formatMaybeCents(cents: number | null | undefined, missing = 'Not listed'): string {
  return cents === null || cents === undefined ? missing : formatCents(cents);
}

/**
 * "$1,234.56", "1234.5", "85", " $ 12 " -> integer cents. Null for anything
 * that is not a plain non-negative amount with at most two decimals, rather
 * than a guess. Commas must be thousands separators.
 */
export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$\s*/, '').replace(/\s+/g, '');
  if (s === '') return null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s) ?? /^()\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  const whole = (m[1] ?? '').replace(/,/g, '') || '0';
  const frac = (m[2] ?? '').padEnd(2, '0');
  const cents = BigInt(whole) * 100n + BigInt(frac === '' ? '0' : frac);
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

/** "30", "30%", "12.5 %" -> 30 / 12.5, within 0..100. Percentages are rates, not money. */
export function parsePercent(input: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d{1,2})?)\s*%?\s*$/.exec(input);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? v : null;
}

/** "15%", "5.5%", "0%": a rate as the engine reports it, trimmed of float noise. */
export function formatPercent(pct: number): string {
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded}%`;
}
