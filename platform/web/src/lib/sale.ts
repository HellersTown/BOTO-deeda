/**
 * Sale-level rows (0023). Some sources list sales, not lots (AuctionGuide:
 * "Farm and tool auction, 421 lots, Greenleaf WI, ends today"). Such a sale is
 * one `lots` row with sale_level = true: its title, description, close and link
 * are the sale's, and it has no price, no bid count and no sleeper score. The
 * app draws it as a sale, and everything that prices a lot leaves it out.
 */

/** "Sale · 421 lots", "Sale · 1 lot", or just "Sale" when the count is not known. */
export function saleLotsText(lotCount: number | null | undefined): string {
  if (typeof lotCount !== 'number' || !Number.isSafeInteger(lotCount) || lotCount <= 0) return 'Sale';
  return `Sale · ${lotCount.toLocaleString('en-US')} ${lotCount === 1 ? 'lot' : 'lots'}`;
}

/** "Greenleaf, WI": where a sale is, from the row's own place. Null when it gives none. */
export function salePlace(city: string | null | undefined, state: string | null | undefined): string | null {
  const c = city?.trim() || null;
  const s = state?.trim() || null;
  return c && s ? `${c}, ${s}` : (c ?? s);
}

/**
 * How many results, naming sales apart from lots: "12 lots", "1 sale",
 * "12 lots and 3 sales". A sale is not one lot: it holds many.
 */
export function resultsText(lots: number, sales: number): string {
  const l = `${lots} ${lots === 1 ? 'lot' : 'lots'}`;
  if (sales <= 0) return l;
  const s = `${sales} ${sales === 1 ? 'sale' : 'sales'}`;
  return lots > 0 ? `${l} and ${s}` : s;
}

/** resultsText for search rows: a sale-level row (0023) counts as a sale. */
export function tallyRows(rows: readonly { sale_level?: boolean | null }[]): string {
  const sales = rows.filter((r) => r.sale_level === true).length;
  return resultsText(rows.length - sales, sales);
}
