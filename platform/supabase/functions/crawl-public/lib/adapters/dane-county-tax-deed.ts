// GENERATED from packages/ingest/src/adapters/dane-county-tax-deed.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * Dane County tax-deed adapter. Platform key: 'dane-county-tax-deed'.
 *
 * The Dane County Treasurer sells land the county has taken by tax deed, by
 * sealed bid, and lists every parcel on one page:
 * https://treasurer.danecounty.gov/taxdeedauction. Most Wisconsin counties sell
 * tax-deeded land through Wisconsin Surplus, which is held (docs/10 section 1);
 * Dane runs its own sale.
 *
 * TERMS. robots.txt disallows only /Account. The site publishes no terms of
 * use: the only terms it links are Google's, for the reCAPTCHA on its forms,
 * and its FAQ says nothing on automated access. One request an hour reads the
 * listing page. Bid forms, parcel details and anything behind reCAPTCHA are
 * never requested; the rows link to them.
 *
 * VERIFIED 2026-10-01 through inspect_url (our crawler, Supabase egress):
 *
 *   /taxdeedauction (143,392 bytes) shows two tabs: "Available Parcels" with a
 *   count badge (20), in <table id="tblAuction">, then the sold history in
 *   <table id="tblAuctionSold">. An available row:
 *     <td data-sort=" BELLEVILLE"> BELLEVILLE (VILLAGE)<br />34 E CHURCH ST</td>
 *     <td>0508-343-6145-4</td>                          parcel number
 *     <td data-sort="20261006">10/6/2026 1:00 PM</td>   bid due, local time
 *     <td> $175000.00 </td>                             minimum bid
 *     <td> View Parcel (accessdane.countyofdane.com), Details
 *          (/TaxDeedAuction/Detail/181), Bid Form (/TaxDeedAuction/BidForm/181)</td>
 *   A parcel with no street address shows nothing after the <br />.
 *
 * THE SALE, from the Treasurer's Tax Deed Details page, read the same day:
 *   - Bids are sealed and due Tuesday at 1:00 PM. They are opened Wednesday at
 *     10:00 AM.
 *   - A bid must meet the appraised value, which is the "Minimum Bid". It goes
 *     in with a 10% earnest deposit in cash or cashier's check. The balance is
 *     due within ten days.
 *   - Parcels are quit-claimed as is, with or without occupants.
 *   - A parcel not sold on its first date stays listed with that date. "The
 *     treasurer may sell the parcel at anytime thereafter to any person making
 *     an offer at or exceeding the appraised value" (Dane Co. Ord. 26.19(3)).
 *     Offers go in by email from the day after the bid opening, and the
 *     earliest qualifying offer wins.
 * So a row is one of three things, by the clock:
 *   - Bid due ahead: a lot in that date's sealed-bid sale (auction
 *     sale:YYYY-MM-DD), closing at its due time.
 *   - Due, but before the day after the opening: the same lot, closed, while
 *     the bids are opened and awarded.
 *   - From the day after the opening: an open offer at the minimum (auction
 *     "offers", format fixed_price, no close).
 * A parcel the county lists twice, re-offered at a new appraisal (DeForest,
 * 6/2/2026 at $335,700 and 10/6/2026 at $260,000), is kept once, at its latest
 * date: the older minimum is stale.
 *
 * PRIVACY. A row names the parcel by municipality and parcel number, never by
 * street address, and the street is not kept in raw either. These are former
 * homes, some still occupied. The Details link shows the address to anyone who
 * opens it.
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  NormalizedAuction,
  NormalizedLocation,
  NormalizedLot,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';
import { zonedIso } from '../usTime.ts';
import { tidyCity } from '../listingText.ts';

export const DANE_BASE = 'https://treasurer.danecounty.gov';
export const DANE_LIST_PATH = '/taxdeedauction';
export const DANE_RULES_URL = `${DANE_BASE}/Property-Owner-Info/foreclosure/Tax-Deed-Details`;
export const DANE_ZONE = 'America/Chicago';
export const DANE_OFFERS_ID = 'offers';

export type MunicipalityKind = 'CITY' | 'VILLAGE' | 'TOWN';

/** One available row, as listed. The street is read only to say whether there is one. */
export interface DaneRow {
  municipality: string;
  kind: MunicipalityKind | null;
  hasStreet: boolean;
  parcel: string;
  due: { y: number; m: number; d: number; h: number; mi: number } | null;
  dueText: string;
  minimumText: string;
  minimumCents: number | null;
  detailId: string;
  detailUrl: string;
  parcelUrl: string | null;
}

export interface DaneTable {
  /** False when the available-parcels table is not on the page at all. */
  found: boolean;
  /** The count on the "Available Parcels" tab, or null when it is not shown. */
  badge: number | null;
  rows: DaneRow[];
  /** Rows of the table that could not be read. */
  unreadable: number;
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITY[e])
    .replace(/\s+/g, ' ')
    .trim();
}

/** "10/6/2026 1:00 PM" -> its parts, or null. */
export function parseDaneDue(s: string): DaneRow['due'] {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return null;
  const [mo, d, y, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100 || h < 1 || h > 12 || mi > 59) return null;
  return { y, m: mo, d, h: (h % 12) + (m[6].toUpperCase() === 'P' ? 12 : 0), mi };
}

/** Read the available-parcels table. Pure; exported for tests. */
export function parseDaneTable(html: string, base: string = DANE_BASE): DaneTable {
  const badgeMatch = html.match(/Available Parcels\s*<span[^>]*badge[^>]*>\s*(\d+)\s*<\/span>/i);
  const badge = badgeMatch ? Number(badgeMatch[1]) : null;
  const start = html.search(/<table[^>]*\bid=["']tblAuction["']/i);
  if (start < 0) return { found: false, badge, rows: [], unreadable: 0 };
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? html.length : end);
  const tbody = table.slice(Math.max(0, table.search(/<tbody/i)));

  const rows: DaneRow[] = [];
  let unreadable = 0;
  for (const tr of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 5) {
      unreadable++;
      continue;
    }
    const [place, street = ''] = cells[0].split(/<br\s*\/?>/i);
    const where = cellText(place).match(/^(.+?)\s*\((CITY|VILLAGE|TOWN)\)$/i);
    const municipality = where ? where[1] : cellText(place);
    const parcel = cellText(cells[1]);
    const dueText = cellText(cells[2]);
    const minimumText = cellText(cells[3]);
    const detail = cells[4].match(/href=["']([^"']*\/TaxDeedAuction\/Detail\/(\d+))["']/i);
    const accessDane = cells[4].match(/href=["'](https:\/\/accessdane\.countyofdane\.com\/Parcel\/Index\/\d+)["']/i);
    if (!municipality || !/^\d{4}-\d{3}-\d{4}-\d$/.test(parcel) || !detail) {
      unreadable++;
      continue;
    }
    rows.push({
      municipality,
      kind: where ? (where[2].toUpperCase() as MunicipalityKind) : null,
      hasStreet: cellText(street) !== '',
      parcel,
      due: parseDaneDue(dueText),
      dueText,
      minimumText,
      minimumCents: parseMoneyToCents(minimumText),
      detailId: detail[2],
      detailUrl: new URL(detail[1], base).toString(),
      parcelUrl: accessDane ? accessDane[1] : null,
    });
  }
  return { found: true, badge, rows, unreadable };
}

const KIND_WORD: Record<MunicipalityKind, string> = { CITY: 'City', VILLAGE: 'Village', TOWN: 'Town' };

/** "BELLEVILLE" + VILLAGE -> "Village of Belleville". */
export function municipalityName(row: Pick<DaneRow, 'municipality' | 'kind'>): string {
  const name = tidyCity(row.municipality) ?? row.municipality;
  return row.kind ? `${KIND_WORD[row.kind]} of ${name}` : name;
}

/** Calendar arithmetic on a local date, safe across month and year ends. */
function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export type DanePhase = 'sealed_bid' | 'awarding' | 'offers';

/**
 * Where a row stands at `now`: before its due time a sealed-bid lot; then
 * closed while the bids are opened (the next day) and awarded; and from the
 * day after the opening, an open offer at the minimum.
 */
export function danePhase(due: NonNullable<DaneRow['due']>, now: Date): { phase: DanePhase; closesAt: string } {
  const closesAt = zonedIso(due.y, due.m, due.d, due.h, due.mi, DANE_ZONE);
  if (now.getTime() < Date.parse(closesAt)) return { phase: 'sealed_bid', closesAt };
  const from = addDays(due.y, due.m, due.d, 2);
  const offersFrom = zonedIso(from.y, from.m, from.d, 0, 0, DANE_ZONE);
  return { phase: now.getTime() < Date.parse(offersFrom) ? 'awarding' : 'offers', closesAt };
}

const SALE_NOTE =
  'Sealed-bid sale of tax-deeded land by the Dane County Treasurer. A bid must meet the minimum (the appraised ' +
  'value) and go in with a 10% earnest deposit in cash or cashier\'s check; the balance is due within ten days. ' +
  'Parcels are sold as is by quit claim deed, with or without occupants, and without title insurance. Open Details ' +
  'for the address, occupancy and the committee report, and read the Treasurer\'s rules before bidding.';
const OFFER_NOTE =
  'Not sold at its sealed-bid sale, so the Treasurer may sell it to the first qualifying offer at or above the ' +
  'minimum (the appraised value), made in writing to the Treasurer\'s office (Dane Co. Ord. 26.19(3)). Sold as is ' +
  'by quit claim deed, with or without occupants, and without title insurance. The county\'s list can trail a sale ' +
  'until the deed is recorded, so confirm with the Treasurer that it is still available. Open Details for the ' +
  'address and occupancy, and read the Treasurer\'s rules before making an offer.';
const PAYMENT_NOTE =
  'No buyer\'s premium is mentioned. A 10% earnest deposit in cash or cashier\'s check goes with each sealed bid; ' +
  'no personal checks, cards or wires; the balance is due within ten days of the award.';

function saleTitle(due: NonNullable<DaneRow['due']>): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h12 = due.h % 12 === 0 ? 12 : due.h % 12;
  const time = `${h12}:${String(due.mi).padStart(2, '0')} ${due.h < 12 ? 'AM' : 'PM'}`;
  return `Dane County tax-deed sale: sealed bids due ${months[due.m - 1]} ${due.d}, ${due.y}, ${time}`;
}

const county = (city: string | null): NormalizedLocation => ({
  line1: null,
  city,
  state: 'WI',
  postalCode: null,
  lat: null,
  lon: null,
  ambiguous: false,
});

export interface DaneNormalized {
  auctions: NormalizedAuction[];
  lots: NormalizedLot[];
  warnings: string[];
  counts: { sealedBid: number; awarding: number; offers: number; superseded: number; undated: number; unpriced: number };
}

/** The table's rows as auctions and lots. Pure; exported for tests. */
export function normalizeDaneRows(rows: DaneRow[], now: Date, base: string = DANE_BASE): DaneNormalized {
  const counts = { sealedBid: 0, awarding: 0, offers: 0, superseded: 0, undated: 0, unpriced: 0 };
  const warnings: string[] = [];

  // One row per parcel: a re-offer at a later date replaces the earlier listing.
  const latest = new Map<string, DaneRow>();
  for (const r of rows) {
    if (!r.due) {
      counts.undated++;
      continue;
    }
    const prev = latest.get(r.parcel);
    const key = (x: DaneRow) => Date.UTC(x.due!.y, x.due!.m - 1, x.due!.d, x.due!.h, x.due!.mi);
    if (prev) counts.superseded++;
    if (!prev || key(r) > key(prev)) latest.set(r.parcel, r);
  }

  const auctions = new Map<string, NormalizedAuction>();
  const lots: NormalizedLot[] = [];
  const listUrl = `${base}${DANE_LIST_PATH}`;
  for (const r of latest.values()) {
    const due = r.due!;
    const { phase, closesAt } = danePhase(due, now);
    if (r.minimumCents === null) counts.unpriced++;
    const offer = phase === 'offers';
    if (phase === 'sealed_bid') counts.sealedBid++;
    else if (phase === 'awarding') counts.awarding++;
    else counts.offers++;

    const dateKey = `${due.y}-${String(due.m).padStart(2, '0')}-${String(due.d).padStart(2, '0')}`;
    const auctionId = offer ? DANE_OFFERS_ID : `sale:${dateKey}`;
    const place = municipalityName(r);
    const city = tidyCity(r.municipality);
    if (!auctions.has(auctionId)) {
      auctions.set(
        auctionId,
        offer
          ? {
              externalId: auctionId,
              title: 'Dane County unsold tax-deed parcels: offers at or above the minimum',
              description: OFFER_NOTE,
              auctioneer: 'Dane County Treasurer',
              url: listUrl,
              format: 'fixed_price',
              startsAt: null,
              endsAt: null,
              timezone: DANE_ZONE,
              pickup: county(null),
              ships: false,
              sellerName: 'Dane County',
              sellerState: 'WI',
              lotCount: 0,
              currency: 'USD',
              buyerPremiumPct: null,
              buyerPremiumNote: PAYMENT_NOTE,
              termsUrl: DANE_RULES_URL,
              raw: { list: listUrl, phase: 'offers' },
            }
          : {
              externalId: auctionId,
              title: saleTitle(due),
              description: SALE_NOTE,
              auctioneer: 'Dane County Treasurer',
              url: listUrl,
              format: 'sealed_bid',
              startsAt: null,
              endsAt: closesAt,
              timezone: DANE_ZONE,
              pickup: county(null),
              ships: false,
              sellerName: 'Dane County',
              sellerState: 'WI',
              lotCount: 0,
              currency: 'USD',
              buyerPremiumPct: null,
              buyerPremiumNote: PAYMENT_NOTE,
              termsUrl: DANE_RULES_URL,
              raw: { list: listUrl, bidDue: r.dueText },
            },
      );
    }
    const auction = auctions.get(auctionId)!;
    auction.lotCount = (auction.lotCount ?? 0) + 1;

    lots.push({
      // The phase is part of the id: a sealed-bid lot that ends unsold is a
      // different listing from the standing offer that replaces it.
      externalId: `${offer ? 'offer' : 'bid'}:${r.detailId}`,
      auctionExternalId: auctionId,
      lotNumber: r.parcel,
      title: `Tax-deeded parcel ${r.parcel}, ${place}`,
      description: offer ? OFFER_NOTE : SALE_NOTE,
      quantity: 1,
      startingBidCents: r.minimumCents,
      currentBidCents: null,
      nextBidCents: r.minimumCents,
      bidCount: null,
      closesAt: offer ? null : closesAt,
      closed: phase === 'awarding',
      url: r.detailUrl,
      pickup: county(city),
      ships: false,
      images: [],
      // Never the street: see PRIVACY above.
      raw: {
        detailId: r.detailId,
        parcel: r.parcel,
        municipality: r.municipality,
        kind: r.kind,
        hasStreetAddress: r.hasStreet,
        bidDue: r.dueText,
        minimumBid: r.minimumText,
        parcelUrl: r.parcelUrl,
        _meta: { source: 'dane-county-tax-deed', phase, listedFirstDue: r.dueText },
      },
    });
  }
  if (counts.undated) warnings.push(`${counts.undated} parcel row(s) gave no readable bid-due date and were left out.`);
  if (counts.unpriced) warnings.push(`${counts.unpriced} parcel(s) gave no readable minimum bid.`);
  if (counts.superseded) warnings.push(`${counts.superseded} earlier listing(s) of a re-offered parcel were replaced by the latest.`);
  return { auctions: [...auctions.values()], lots, warnings, counts };
}

export async function runDaneCountyTaxDeed(ctx: AdapterContext): Promise<IngestResult> {
  const base = (() => {
    try {
      return new URL(ctx.source.url).origin;
    } catch {
      return DANE_BASE;
    }
  })();
  const res = await ctx.fetch(`${base}${DANE_LIST_PATH}`, { headers: { Accept: 'text/html' } });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new Error(`Dane County tax-deed listing: HTTP ${res.status}. Not retried.`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Dane County tax-deed listing: HTTP ${res.status}.`);
  const table = parseDaneTable(res.text, base);
  // A missing table is a changed page, not an empty sale: fail loudly so the
  // run is not mistaken for "no parcels".
  if (!table.found) throw new Error('Dane County tax-deed listing: the available-parcels table (#tblAuction) is not on the page.');
  const out = normalizeDaneRows(table.rows, ctx.now(), base);
  const warnings = [...out.warnings];
  if (table.unreadable) warnings.push(`${table.unreadable} row(s) of the available-parcels table could not be read.`);
  if (table.badge !== null && table.badge !== table.rows.length + table.unreadable) {
    warnings.push(`The page counts ${table.badge} available parcels but its table holds ${table.rows.length + table.unreadable} rows.`);
  }
  ctx.log('info', 'Dane County tax-deed ingest complete', { ...out.counts, rows: table.rows.length, badge: table.badge });
  return {
    auctions: out.auctions,
    lots: out.lots,
    bids: [],
    stats: { httpRequests: 1, bytesIn: res.text.length },
    warnings,
    // The table lists every available parcel, so one missing from it has sold
    // or been withdrawn; only a fully read table is a snapshot.
    completeSnapshot:
      table.unreadable === 0 && out.counts.undated === 0 && (table.badge === null || table.badge === table.rows.length),
  };
}

export const daneCountyTaxDeedAdapter: Adapter = {
  key: 'dane-county-tax-deed',
  method: 'html',
  run: runDaneCountyTaxDeed,
};
