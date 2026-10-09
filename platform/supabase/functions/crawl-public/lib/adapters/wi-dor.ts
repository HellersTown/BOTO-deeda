// GENERATED from packages/ingest/src/adapters/wi-dor.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * Wisconsin Department of Revenue public auctions. Platform key: 'wi-dor'.
 *
 * When a delinquent taxpayer's property is relinquished to the Department of
 * Revenue, the Department sells it at public auction and lists each sale on
 * https://www.revenue.wi.gov/Pages/PublicAuction/home.aspx. The sale itself
 * runs at an auctioneer's (both current ones at Hansen Auction Group, whose
 * catalogue crawl-private reads lot by lot), so this adapter emits one
 * sale-level row per listed sale: the state's own record that the sale exists,
 * what it sells and where its notice is.
 *
 * TERMS. The Department's privacy page: "All postings on this page and all
 * other Wisconsin Department of Revenue internet pages are subject to open
 * records laws. Unless a copyright is indicated, the information posted here
 * is in the public domain and may be copied and distributed without
 * permission." robots.txt blocks only SharePoint internals. One request an
 * hour; the notices (PDF) are linked, never fetched.
 *
 * VERIFIED 2026-10-01 through inspect_url (our crawler, Supabase egress): the
 * page (48,567 bytes, SharePoint) holds one table whose caption is "UPCOMING
 * PUBLIC AUCTIONS", columns County, Date, Time, Location, Notice of Sale/
 * Photos, cells marked data-title. SharePoint writes ":" as &#58;, even in
 * hrefs. The first row is a hidden placeholder ("No scheduled auctions at this
 * time.", class="hidden"), shown only when no other row is there. A row:
 *   County "Brown<br>", Date "9/23/2026 - 10/07/2026", Time "10&#58;00 a.m.",
 *   Location <a href="https&#58;//www.hansenauctiongroup.com/">Hansen Auction Group</a>,
 *   Notice <a href="/Pages/PublicAuction/1994-Jeep-Wrangler-2021-Ford-Expedition.pdf">Details</a>
 * The notice's file name lists what is sold. When it starts with a model year,
 * it is read as items, one per year ("1994 Jeep Wrangler, 2021 Ford
 * Expedition"); any other file name is not read.
 *
 * DATES. A range is an online sale: it opens on the first date at the listed
 * time, and closes on the last date at a time the page does not give, so the
 * close is stored as 23:59:59 local with closeTimePrecise false (the convention
 * GSA and AuctionGuide use; the app shows the date without a countdown). A
 * single date is a live sale at the listed time.
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  NormalizedAuction,
  NormalizedLocation,
  NormalizedLot,
} from '../types.ts';
import { zonedIso } from '../usTime.ts';

export const DOR_BASE = 'https://www.revenue.wi.gov';
export const DOR_PATH = '/Pages/PublicAuction/home.aspx';
export const DOR_ZONE = 'America/Chicago';

type Ymd = { y: number; m: number; d: number };

export interface DorRow {
  county: string;
  dateText: string;
  start: Ymd | null;
  end: Ymd | null;
  /** Minutes after midnight, or null when no time is listed. */
  time: number | null;
  auctioneer: string | null;
  auctioneerUrl: string | null;
  noticeUrl: string | null;
  items: string[];
}

export interface DorTable {
  found: boolean;
  rows: DorRow[];
  unreadable: number;
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"');
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' ')).replace(/[\s ​]+/g, ' ').trim();
}

function ymd(s: string): Ymd | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return { y, m: mo, d };
}

/** "9/23/2026 - 10/07/2026" or "10/14/2026" -> start and end. */
export function parseDorDates(s: string): { start: Ymd; end: Ymd } | null {
  const parts = s.split(/\s*[-–]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const start = ymd(parts[0]);
  const end = parts.length === 2 ? ymd(parts[1]) : start;
  if (!start || !end) return null;
  const key = (x: Ymd) => x.y * 10000 + x.m * 100 + x.d;
  return key(end) >= key(start) ? { start, end } : null;
}

/** "10:00 a.m." -> 600; null when there is no readable time. */
export function parseDorTime(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?$/i);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 1 || h > 12 || mi > 59) return null;
  return ((h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + mi;
}

/** "1994-Jeep-Wrangler-2021-Ford-Expedition.pdf" -> ["1994 Jeep Wrangler", "2021 Ford Expedition"]. */
export function itemsFromNotice(url: string | null): string[] {
  if (!url) return [];
  const file = decodeURIComponent(url.split('/').pop() ?? '').replace(/\.pdf$/i, '');
  const words = file.split(/[-_\s]+/).filter(Boolean);
  if (!words.length || !/^(19|20)\d{2}$/.test(words[0])) return [];
  const items: string[][] = [];
  for (const w of words) {
    if (/^(19|20)\d{2}$/.test(w) || !items.length) items.push([w]);
    else items[items.length - 1].push(w);
  }
  return items.map((i) => i.join(' '));
}

function href(cell: string, base: string): string | null {
  const m = cell.match(/href="([^"]+)"/i);
  if (!m) return null;
  try {
    return new URL(decode(m[1]), base).toString();
  } catch {
    return null;
  }
}

/** Read the "UPCOMING PUBLIC AUCTIONS" table. Pure; exported for tests. */
export function parseDorTable(html: string, base: string = DOR_BASE): DorTable {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => m[1]);
  const table = tables.find((t) => /UPCOMING PUBLIC AUCTIONS/i.test(t));
  if (!table) return { found: false, rows: [], unreadable: 0 };
  const rows: DorRow[] = [];
  let unreadable = 0;
  for (const tr of table.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if (/class="[^"]*\bhidden\b/i.test(tr[1]) || /<th\b/i.test(tr[2])) continue;
    const cells: Record<string, string> = {};
    for (const td of tr[2].matchAll(/<td\b[^>]*data-title="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)) cells[td[1].toLowerCase()] = td[2];
    const county = text(cells['county'] ?? '');
    const dateText = text(cells['date'] ?? '');
    const dates = parseDorDates(dateText);
    if (!county || !dates) {
      unreadable++;
      continue;
    }
    const location = cells['location'] ?? '';
    const noticeUrl = href(cells['notice of sale'] ?? '', base);
    rows.push({
      county,
      dateText,
      start: dates.start,
      end: dates.end,
      time: parseDorTime(text(cells['time'] ?? '')),
      auctioneer: text(location) || null,
      auctioneerUrl: href(location, base),
      noticeUrl,
      items: itemsFromNotice(noticeUrl),
    });
  }
  return { found: true, rows, unreadable };
}

const iso = (x: Ymd) => `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;

/** 23:59:59 local on a date: the last moment a sale closing that day can be open. */
const endOfDay = (x: Ymd) => zonedIso(x.y, x.m, x.d, 23, 59, DOR_ZONE).replace(/:00([+-]\d{2}:\d{2})$/, ':59$1');

const NOTE =
  'Property relinquished to the Wisconsin Department of Revenue for delinquent taxes, sold at public auction "as ' +
  'is"; the Department is not responsible for its quality or authenticity, and the buyer is responsible for any ' +
  'remaining liens, debts, mortgages or liabilities. Some auctions require payment in guaranteed funds. The ' +
  'notice of sale lists the property and the terms.';

/** One sale-level row per listed sale. Pure; exported for tests. */
export function normalizeDorRows(rows: DorRow[], now: Date, base: string = DOR_BASE): {
  auctions: NormalizedAuction[];
  lots: NormalizedLot[];
  past: number;
} {
  const auctions: NormalizedAuction[] = [];
  const lots: NormalizedLot[] = [];
  let past = 0;
  const page = `${base}${DOR_PATH}`;
  for (const r of rows) {
    const range = iso(r.start!) !== iso(r.end!);
    const closesAt = range
      ? endOfDay(r.end!)
      : zonedIso(r.end!.y, r.end!.m, r.end!.d, Math.floor((r.time ?? 0) / 60), (r.time ?? 0) % 60, DOR_ZONE);
    if (Date.parse(closesAt) <= now.getTime()) {
      past++;
      continue;
    }
    const startsAt = r.time !== null
      ? zonedIso(r.start!.y, r.start!.m, r.start!.d, Math.floor(r.time / 60), r.time % 60, DOR_ZONE)
      : zonedIso(r.start!.y, r.start!.m, r.start!.d, 0, 0, DOR_ZONE);
    const id = `${r.county.toLowerCase().replace(/[^a-z]+/g, '-')}:${iso(r.start!)}`;
    const title = `Wisconsin DOR seized-property sale, ${r.county} County${r.items.length ? `: ${r.items.join(', ')}` : ''}`;
    const when = range ? `from ${r.dateText.replace(/\s*-\s*/, ' to ')}` : `on ${r.dateText}`;
    const description = `${r.auctioneer ? `Sold through ${r.auctioneer} ${when}. ` : ''}${NOTE}`;
    const pickup: NormalizedLocation = { line1: null, city: null, state: 'WI', postalCode: null, lat: null, lon: null, ambiguous: false };
    const url = r.noticeUrl ?? page;
    const meta = {
      source: 'wi-dor',
      closeTimePrecise: !range && r.time !== null,
      startTimePrecise: r.time !== null,
      timeListed: r.time,
      dateText: r.dateText,
      county: r.county,
    };
    auctions.push({
      externalId: id,
      title,
      description,
      auctioneer: r.auctioneer,
      url,
      format: range ? 'online' : 'live',
      startsAt,
      endsAt: closesAt,
      timezone: DOR_ZONE,
      pickup,
      ships: false,
      sellerName: 'Wisconsin Department of Revenue',
      sellerState: 'WI',
      lotCount: null,
      currency: 'USD',
      buyerPremiumPct: null,
      buyerPremiumNote: 'Set by the auctioneer; see the notice of sale and the auctioneer\'s terms.',
      termsUrl: page,
      raw: { notice: r.noticeUrl, auctioneerUrl: r.auctioneerUrl, _meta: meta },
    });
    lots.push({
      externalId: `sale:${id}`,
      auctionExternalId: id,
      lotNumber: null,
      title,
      description,
      quantity: null,
      startingBidCents: null,
      currentBidCents: null,
      nextBidCents: null,
      bidCount: null,
      closesAt,
      closed: false,
      url,
      pickup,
      ships: false,
      images: [],
      raw: { county: r.county, dateText: r.dateText, items: r.items, notice: r.noticeUrl, auctioneer: r.auctioneer, _meta: meta },
      saleLevel: true,
    });
  }
  return { auctions, lots, past };
}

export async function runWiDor(ctx: AdapterContext): Promise<IngestResult> {
  const base = (() => {
    try {
      return new URL(ctx.source.url).origin;
    } catch {
      return DOR_BASE;
    }
  })();
  const res = await ctx.fetch(`${base}${DOR_PATH}`, { headers: { Accept: 'text/html' } });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new Error(`Wisconsin DOR public auctions: HTTP ${res.status}. Not retried.`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Wisconsin DOR public auctions: HTTP ${res.status}.`);
  const table = parseDorTable(res.text, base);
  if (!table.found) throw new Error('Wisconsin DOR public auctions: the "UPCOMING PUBLIC AUCTIONS" table is not on the page.');
  const { auctions, lots, past } = normalizeDorRows(table.rows, ctx.now(), base);
  const warnings: string[] = [];
  if (table.unreadable) warnings.push(`${table.unreadable} row(s) of the auction table could not be read.`);
  if (past) warnings.push(`${past} listed sale(s) have already closed and were left out.`);
  ctx.log('info', 'Wisconsin DOR ingest complete', { rows: table.rows.length, kept: lots.length, past });
  return {
    auctions,
    lots,
    bids: [],
    stats: { httpRequests: 1, bytesIn: res.text.length },
    warnings,
    // The table is the Department's whole list of upcoming sales.
    completeSnapshot: table.unreadable === 0,
  };
}

export const wiDorAdapter: Adapter = {
  key: 'wi-dor',
  method: 'html',
  run: runWiDor,
};
