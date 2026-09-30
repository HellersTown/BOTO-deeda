// GENERATED from packages/ingest/src/money.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * Money parsing.
 *
 * This file is small and boring and it is the one most likely to cost real money
 * if it is wrong, so it is written defensively and tested hard.
 *
 * Two rules:
 *
 * 1. NEVER MULTIPLY A FLOAT BY 100. `19.99 * 100` is `1998.9999999999998` in
 *    IEEE-754. `Math.round` papers over it for small values and then fails
 *    somewhere you are not looking. Instead we split the string on its decimal
 *    separator and assemble an integer from the digits. No float ever touches
 *    the value.
 *
 * 2. AMBIGUOUS INPUT RETURNS null, NEVER A GUESS. A null bid renders as "—" and
 *    a user shrugs. A wrongly-parsed bid makes someone believe a $1,234 lot is
 *    open at $1.23, and they lose their trust in the whole product the first time
 *    they click through.
 */

/** Digits only, with the sign and separators already handled by the caller. */
function digitsToCents(intPart: string, fracPart: string): number | null {
  const ip = intPart.replace(/\D/g, '');
  const fp = fracPart.replace(/\D/g, '');
  if (ip === '' && fp === '') return null;

  // Pad or truncate the fractional part to exactly two digits. Truncation rather
  // than rounding: a source that publishes three decimals on a currency amount is
  // giving us sub-cent precision we have no business rounding into a bid.
  const cents = (fp + '00').slice(0, 2);
  const combined = (ip === '' ? '0' : ip) + cents;

  // Strip leading zeros so "000123" parses, but keep at least one digit.
  const normalized = combined.replace(/^0+(?=\d)/, '');
  const n = Number(normalized);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * Tokens that mean "there is no number here". Auction sites are full of these and
 * every one of them must map to null rather than to zero — "no bids" and "$0.00"
 * are different facts, and the sleeper score depends on telling them apart.
 */
const EMPTY_TOKENS = new Set([
  '', '-', '--', '—', '–', 'n/a', 'na', 'none', 'no bid', 'no bids',
  'not bid', 'nobid', 'tbd', 'pending', 'unsold', 'passed', 'no sale',
  'reserve not met', 'closed', 'sold', 'ask', 'call', 'inquire',
]);

/**
 * Parse a currency string into integer cents.
 *
 * Handles: "$1,234.56"  "1234.56"  "USD 1,234"  "Current Bid: $45.00"
 *          "1.234,56" (European)   "45"   "$0.99"
 * Rejects:  "no bids"  "—"  ""  "$1.2K"  "call for price"  negatives
 *
 * @returns cents, or null when the input does not contain an unambiguous amount
 */
export function parseMoneyToCents(input: unknown): number | null {
  if (input === null || input === undefined) return null;

  // Numbers are assumed to already be in the source's major unit (dollars),
  // because that is what every JSON API we have seen does. Integer cents arriving
  // as a number would be indistinguishable, so adapters must convert explicitly
  // rather than relying on this path.
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    // Guard the exponent-notation range: String(1e21) is "1e+21", whose digits
    // would assemble into a plausible-looking but completely wrong amount.
    if (input >= 1e12) return null;
    return digitsToCents(String(Math.trunc(input)), String(input).split('.')[1] ?? '');
  }

  if (typeof input !== 'string') return null;

  const raw = input.trim().toLowerCase();
  if (EMPTY_TOKENS.has(raw)) return null;

  // A leading minus, or accounting-style parentheses, means a negative amount.
  // There is no such thing as a negative bid, so this is bad data, not a value.
  if (/^\(.*\)$/.test(raw) || /(^|\s)-\s*[\d$]/.test(raw)) return null;

  // Reject abbreviated magnitudes outright. "$1.2K" could be 1200 or 1.2 and we
  // are not going to find out by guessing.
  if (/\d\s*[km]\b/.test(raw)) return null;

  // Pull out the first number-shaped run of characters. This tolerates the labels
  // that real pages wrap around amounts ("Current Bid: $45.00 USD").
  const m = raw.match(/\d[\d.,\s\u00a0]*/);
  if (!m) return null;

  // Strip spaces used as thousands separators (common in non-US formats).
  let numeric = m[0].replace(/[\s\u00a0]/g, '').replace(/[.,]+$/, '');
  if (numeric === '') return null;

  const lastDot = numeric.lastIndexOf('.');
  const lastComma = numeric.lastIndexOf(',');

  // Both separators present: whichever comes LAST is the decimal separator.
  // "1,234.56" -> dot decimal.   "1.234,56" -> comma decimal (European).
  if (lastDot >= 0 && lastComma >= 0) {
    const decIdx = Math.max(lastDot, lastComma);
    const intPart = numeric.slice(0, decIdx);
    const fracPart = numeric.slice(decIdx + 1);
    // A "decimal" part with three digits is a thousands group, not cents.
    if (fracPart.length === 3) return digitsToCents(numeric, '');
    if (fracPart.length > 2) return null;
    return digitsToCents(intPart, fracPart);
  }

  // Exactly one separator: decide whether it is a decimal point or a group mark.
  const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
  if (sep) {
    const idx = numeric.lastIndexOf(sep);
    const frac = numeric.slice(idx + 1);
    const occurrences = numeric.split(sep).length - 1;

    // Repeated separators are always grouping: "1,234,567".
    if (occurrences > 1) return digitsToCents(numeric, '');

    if (frac.length === 3) {
      // A COMMA with three trailing digits is a thousands group in every US
      // source we care about: "1,234" is unambiguously $1,234.
      if (sep === ',') return digitsToCents(numeric, '');

      // A DOT with three trailing digits is genuinely ambiguous. "1.234" is
      // $1,234 to a European source and arguably $1.23 to a sloppy US one, and
      // "45.500" is most likely $45.50 written with three decimals. US auction
      // data essentially never uses a dot as a thousands separator, so there is no
      // reading here we can defend. Rule 2 applies: refuse rather than guess.
      return null;
    }

    if (frac.length > 3) return null;
    return digitsToCents(numeric.slice(0, idx), frac);
  }

  // No separator at all: plain integer major units.
  return digitsToCents(numeric, '');
}

/** cents -> "$1,234.56". Used in alerts and CSV export. */
export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100).toLocaleString('en-US');
  const rest = String(abs % 100).padStart(2, '0');
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${sign}${symbol}${dollars}.${rest}`;
}

/**
 * Total a buyer will actually pay, premium included.
 *
 * Showing a hammer price alone is the standard quiet deception of the auction
 * world. Hamele's terms, for one real example, are 10% online premium plus 3.5%
 * for card payment — so a $100 hammer is $113.50 out the door, and a user
 * comparing against a $110 retail price needs to know that.
 */
export function totalWithPremium(
  hammerCents: number | null | undefined,
  premiumPct: number | null | undefined,
  cardFeePct: number | null | undefined = null,
): number | null {
  if (hammerCents === null || hammerCents === undefined) return null;
  const pct = (premiumPct ?? 0) + (cardFeePct ?? 0);
  if (pct < 0) return null;
  // Integer arithmetic: scale the percentage to basis points first so we never
  // introduce a float into a money path.
  const bps = Math.round(pct * 100);
  return hammerCents + Math.round((hammerCents * bps) / 10000);
}

/**
 * The next bid a user would have to place, which is what "under $50" must be
 * tested against. Increment tables vary per house; this is the common ladder and
 * adapters should override it when the source publishes its own.
 */
export function defaultNextBidCents(currentCents: number | null | undefined): number | null {
  if (currentCents === null || currentCents === undefined) return null;
  if (currentCents < 0) return null;
  const c = currentCents;
  let step: number;
  if (c < 2500) step = 250;           // < $25        -> $2.50
  else if (c < 10000) step = 500;     // < $100       -> $5
  else if (c < 50000) step = 1000;    // < $500       -> $10
  else if (c < 100000) step = 2500;   // < $1,000     -> $25
  else if (c < 500000) step = 5000;   // < $5,000     -> $50
  else if (c < 1000000) step = 10000; // < $10,000    -> $100
  else step = 25000;                  // >= $10,000   -> $250
  return c + step;
}
