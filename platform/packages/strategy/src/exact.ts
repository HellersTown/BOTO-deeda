/**
 * Exact numbers.
 *
 * ingest's money.ts has one rule above all others: never multiply a float by 100.
 * This package multiplies money by rates all the time (premium, tax, card fee,
 * selling fee, margin, haircut), so it needs the same guarantee for arithmetic,
 * not just for parsing.
 *
 * The doc's own formula shows why. Run in floats, the way json-logic-js would run
 * it, a $153.43 tool lot 10 miles away with a 10% premium and a 3% card fee gets a
 * $19 ceiling. The exact answer is $20: the room before fees is 2390.63 cents,
 * k is 1.195315, and 2390.63 / 1.195315 is exactly 2000 cents, which floats
 * land a hair under and floor a dollar low.
 *
 * So a number is read as the decimal a person wrote, via String(x) (the shortest
 * string that round-trips the double), exactly as money.ts assembles cents from
 * digits. 0.055 becomes 55/1000, not the binary fraction just below it. From
 * there everything is a fraction of two BigInts, and rounding happens once, on
 * purpose, where a value leaves the engine as whole cents.
 */

export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** n/d in lowest terms with a positive denominator. */
export function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new RangeError('rat: zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

export const ZERO: Rat = { n: 0n, d: 1n };
export const ONE: Rat = { n: 1n, d: 1n };

export function isRat(v: unknown): v is Rat {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { n?: unknown }).n === 'bigint' &&
    typeof (v as { d?: unknown }).d === 'bigint'
  );
}

export function fromInt(x: bigint | number): Rat {
  if (typeof x === 'number') {
    if (!Number.isSafeInteger(x)) throw new RangeError(`fromInt: ${x} is not a safe integer`);
    return { n: BigInt(x), d: 1n };
  }
  return { n: x, d: 1n };
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

/** "12.5" -> 25/2, "1.5e-7" -> 3/20000000. null for anything that is not a plain decimal. */
export function fromDecimalString(s: string): Rat | null {
  const m = DECIMAL.exec(s.trim());
  if (!m) return null;
  const sign = m[1];
  const intPart = m[2] as string;
  const frac = m[3] ?? '';
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  // A value like 1e-400 is not a rate anyone meant; refuse rather than build a huge BigInt.
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  let n = BigInt(intPart + frac);
  if (sign === '-') n = -n;
  const shift = exp - frac.length;
  return shift >= 0 ? rat(n * 10n ** BigInt(shift)) : rat(n, 10n ** BigInt(-shift));
}

/** The decimal a person wrote, exactly. null for NaN and infinities. */
export function fromNumber(x: number): Rat | null {
  if (!Number.isFinite(x)) return null;
  return fromDecimalString(String(x));
}

export function add(a: Rat, b: Rat): Rat {
  return a.d === b.d ? rat(a.n + b.n, a.d) : rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function neg(a: Rat): Rat {
  return { n: -a.n, d: a.d };
}

export function sub(a: Rat, b: Rat): Rat {
  return add(a, neg(b));
}

export function mul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new RangeError('division by zero');
  return rat(a.n * b.d, a.d * b.n);
}

export function cmp(a: Rat, b: Rat): -1 | 0 | 1 {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
}

export function minRat(a: Rat, b: Rat): Rat {
  return cmp(a, b) <= 0 ? a : b;
}

export function maxRat(a: Rat, b: Rat): Rat {
  return cmp(a, b) >= 0 ? a : b;
}

/** Floor division for BigInt, which natively truncates toward zero. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('division by zero');
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

export function floor(a: Rat): bigint {
  return floorDiv(a.n, a.d);
}

export function ceil(a: Rat): bigint {
  return -floorDiv(-a.n, a.d);
}

/** Nearest integer, halves away from zero. Used only where a value is displayed. */
export function roundHalfAway(a: Rat): bigint {
  const twice = floorDiv(2n * (a.n < 0n ? -a.n : a.n) + a.d, 2n * a.d);
  return a.n < 0n ? -twice : twice;
}

export function isInteger(a: Rat): boolean {
  return a.d === 1n;
}

/** A BigInt as a JS number, or null when it would lose precision. */
export function toSafeNumber(b: bigint): number | null {
  return b > MAX_SAFE || b < -MAX_SAFE ? null : Number(b);
}

/**
 * For display only (ratios, rates, minutes). Money leaves as whole cents through
 * toSafeNumber instead.
 */
export function toNumber(a: Rat): number {
  if (a.d === 1n) return Number(a.n);
  const absN = a.n < 0n ? -a.n : a.n;
  if (absN <= MAX_SAFE && a.d <= MAX_SAFE) return Number(a.n) / Number(a.d);
  return Number(toFixedString(a, 20));
}

/** a rounded half away from zero to `places` decimals, as a plain decimal string. */
export function toFixedString(a: Rat, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = roundHalfAway(mul(a, rat(scale)));
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  if (places === 0) return `${negative ? '-' : ''}${abs}`;
  const s = abs.toString().padStart(places + 1, '0');
  return `${negative ? '-' : ''}${s.slice(0, -places)}.${s.slice(-places)}`;
}

/** A decimal without trailing zeros: 25/2 -> "12.5", 3 -> "3", 1/3 -> "0.333333". */
export function formatPlain(a: Rat): string {
  if (a.d === 1n) return a.n.toString();
  const s = toFixedString(a, 6);
  return s.replace(/\.?0+$/, '');
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * cents -> "$1,234.56". Same output as ingest money.ts formatCents, but takes a
 * BigInt so it never has to round-trip a large amount through a double.
 */
export function formatUsd(cents: bigint | number): string {
  const c = typeof cents === 'bigint' ? cents : BigInt(cents);
  const negative = c < 0n;
  const abs = negative ? -c : c;
  const dollars = groupThousands((abs / 100n).toString());
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${rest}`;
}

/** A fraction as a percent with one decimal: 0.123 -> "12.3%" (the spec's |pct filter). */
export function formatPercent(fraction: Rat): string {
  return `${toFixedString(mul(fraction, rat(100n)), 1)}%`;
}

// ---------------------------------------------------------------- time

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Epoch milliseconds for an ISO-8601 instant, or null.
 *
 * Stricter than Date.parse on purpose. Date.parse reads "2026-09-27T18:00:00"
 * (no offset) as LOCAL time, which makes a close time depend on the server's
 * zone; it rolls "2026-02-30" over to March 2; and it accepts "24:00". Each of
 * those is a guess about what the source meant, so each is refused.
 */
export function parseInstant(s: string): number | null {
  const m = ISO_INSTANT.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  if (m[8] !== 'Z' && (Number(m[9]) > 23 || Number(m[10]) > 59)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}
