/**
 * BidWrangler platform adapter: rung 3 (internal JSON), verified live 2026-09-30.
 *
 * BidWrangler is a white-label timed/live bidding platform used by Midwest
 * auction houses. Hansen Auction Group (Downing, WI) is the first tenant:
 * www.hansenauctiongroup.com is a marketing site (the BidWrangler Website
 * Service), and every lot is bid on at bid.hansenauctiongroup.com/ui/...
 * The bidding app's own HTML declares the API host it talks to:
 *
 *   window.bwApiHost = "https://bid.hansenauctiongroup.com";
 *
 * so the tenant host goes in sources.api_base and nothing else is guessed.
 *
 * VERIFIED ENDPOINTS (captured 2026-09-30 through inspect_url, see fixtures):
 *
 *   GET {host}/api/auctions?page=N
 *     { total, page, per_page, auctions[], all_auction_ids[] }, 50 per page
 *     (~1 MB a page: each record carries its featured-image URLs).
 *     `total` counts the house's whole history (Hansen: 3,418, then 3,420 an
 *     hour later). The order is every NOT-complete auction first, by end time,
 *     then the completed history oldest-first: all_auction_ids runs 167959
 *     (closes Sep 30) ... 156558 (Nov 3) ... 156402, then 26846, 26663 (2018),
 *     and page=2&per_page=1 returned 168337, the second id. So the walk stops
 *     at the first page holding a completed auction (~2 pages, not 69), and
 *     only while that ordering is seen to hold on the page (openFirstOrderHolds).
 *
 *   GET {host}/api/auctions/{id}/items?page=N&per_page=M
 *     { total, page, per_page, items[], all_item_ids[] }. `page=2&per_page=3`
 *     returned {"total":195,"page":2,"per_page":3,...}, so paging is real.
 *     Unpaged, the same call returns every item (1.8 MB for 133 items).
 *
 *   Deep links. The server renders og:url for both, which is how they were
 *   confirmed (a SPA serves HTTP 200 for ANY /ui path, so 200 proves nothing):
 *     {host}/ui/auctions/{auctionId}   og:url on the auction page
 *     {host}/ui/items/{itemId}         og:url + og:title "1955 Massey-Harris 33
 *                                      Tractor" (/ui/auctions/{a}/items/{i}
 *                                      renders no og tags: not the server's
 *                                      canonical item route, so not used)
 *
 * robots.txt, bid.hansenauctiongroup.com:  User-agent: * / Disallow: /docs /
 * Disallow: /accounts. /api and /ui are allowed. (www has Crawl-delay: 10, but
 * this adapter never touches www.)
 *
 * WHAT THE DATA SAYS, AND THE TRAPS IN IT
 *
 * 1. Location is DECLARED per auction: location {street, city, state:"WI",
 *    zip, lat, lng}. Scope uses that field first. Auction names end in
 *    "- Ettrick, WI", and a Marenisco, MI consignment sale sits in the same
 *    list; the name is never parsed for a state. Some houses leave location
 *    null on every sale and state the place in the sale's own summary instead
 *    (verified 2026-10-01): Hansen & Young writes "ADDRESS: ELEVA, WI" and
 *    Peoples Company "Town of Pleasant Springs, Dane County, Wisconsin". Those
 *    two labelled forms are read from the summary only (textDeclaredLocation);
 *    a summary naming two states declares none.
 * 2. Items close on a stagger (1 minute per lot: 23:01Z, 23:02Z, 23:04Z...) and
 *    extend 10 minutes on a late bid, so closesAt is per ITEM (actual_end_time,
 *    which moves with extensions), never the auction's end.
 * 3. Money is in dollars as JSON numbers (1100.0). parseMoneyToCents treats a
 *    number as major units, so no float is ever multiplied by 100.
 * 4. Each catalogue opens with informational pseudo-lots: "#1A Payment
 *    Information", "#1B Open House", "#1D Inspection and Vehicles", "#1E
 *    Transfers", "#1F Shipping", biddable at $1. One of them had a $1 bid. They
 *    are skipped by exact name and counted in a warning.
 * 5. api_bidding_state.accepted_bid_count is the number of accepted BIDS (the
 *    tractor: 64), which is exactly what bidCount means. high.{user_id,
 *    account_id, bidder_number} identify a person across auctions and are
 *    removed from raw.
 * 6. Buyer's premium is prose, called a "Buyer's Fee" (with a curly
 *    apostrophe), sometimes tiered: "10% Buyer's Fee on the first $25,000 + 6%
 *    on the remainder". The card fee is separate: payment_cc_fee "3.99", or
 *    "A 3.75% credit card convenience fee" in the text.
 * 7. Weight: ~14-17 KB per item, almost all of it four signed CDN URLs per
 *    photo. A full Wisconsin refresh for Hansen is ~70 MB (4,759 open lots on
 *    2026-10-05), so a run is budgeted (BW_DEFAULTS). Without the database's
 *    state (tests, a first run) a run reads lots closing within 24 hours, then
 *    a rotating slice of the rest (planAuctions). With it (planWatch, 0055) a
 *    run reads NEW sales in full, then refreshes known lots BY ID for price,
 *    bids and close time, least recently seen first, so that with runs every
 *    15 minutes every open lot is refreshed within the hour and lots closing
 *    within 3 hours on every run; each sale is read in full again every 6
 *    hours, or as soon as its item count changes, to find added, edited and
 *    withdrawn lots. A run is a complete snapshot only when it got everything.
 *
 *    GET {host}/api/items?ids=26400668,26374935   (verified 2026-10-05)
 *      a bare JSON array of the same item records /items returns, in any
 *      auction; without ids it answers 400 {"error":"ids is missing"}.
 * 8. Politeness: the crawl gate spaces requests by sources.rate_limit_rpm (or
 *    the host's Crawl-delay). run() also spaces its own by 60s / rate_limit_rpm
 *    (capped at 10 s), so it stays polite behind any fetcher, including tests'.
 *
 * Shared helpers other adapters may want (kept here, per the ownership rule):
 * declaredState (full US state name or code -> code, never from a city),
 * decodeEntities/textFromHtml, toIso, validTimeZone, parseBuyerPremium
 * (handles "Buyer's Fee" and tiered premiums), parseCardFeePct.
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  KnownLot,
  KnownState,
  NormalizedAuction,
  NormalizedImage,
  NormalizedLocation,
  NormalizedLot,
  SourceConfig,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';
import { isBudgetRefusal } from '../gate.ts';
import { tidyCity } from '../listingText.ts';

export type BwRecord = Record<string, unknown>;

/** Page size of /api/auctions, observed and confirmed by a third party. */
export const BW_AUCTIONS_PER_PAGE = 50;
/** Items per request. ~1.4 MB per page at the observed ~14 KB per item. */
export const BW_ITEMS_PER_PAGE = 100;
/**
 * Used only to decide what fits in the remaining byte budget. Measured on
 * Hansen Auction Group, 2026-10-05: 32 MB carried 1,564 and 1,699 lots, list
 * pages included (19-20 KB each).
 */
export const BW_EST_BYTES_PER_ITEM = 19_000;
/** Images kept per lot, in source order. The deep link shows the rest. */
export const BW_MAX_IMAGES = 20;

// A background run of the crawl worker may start requests for about 225 s: at
// 20 rpm that is ~70 requests. Hansen's ~60 open Wisconsin sales fit in one
// run (first live run, 2026-09-30: 24 requests reached 21 of 61 sales).
export const BW_DEFAULTS = {
  maxRequests: 70,
  // ~2,500 items at the measured 19 KB. The six BidWrangler houses share one
  // worker, so each runs about every 20 minutes and, at BW_WATCH.staleMs,
  // refreshes about half its lots per run: 2,400 for Hansen Auction Group's
  // 4,760 (2026-10-05). The gate's deadline still bounds every run's time.
  maxBytes: 48_000_000,
  maxListPages: 3,
  itemsPerPage: BW_ITEMS_PER_PAGE,
  /** An auction closing within this window is refreshed on every run. */
  urgentWindowMs: 24 * 3_600_000,
};

/** Ids per /api/items?ids= request: ~1.7 MB, like a page of an auction's items. */
export const BW_IDS_PER_REQUEST = 100;

/** When a known lot or sale is due again (planWatch). */
export const BW_WATCH = {
  /**
   * A lot unseen this long is due. Each house's runs land about 20 minutes
   * apart (cadence, run time and the 5-minute tick of a shared worker), so a
   * lot is refreshed every second run, about every 40 minutes; at 40 minutes
   * (2026-10-05) lots seen 38-39 minutes before a run waited for the third,
   * an hour after they were last seen.
   */
  staleMs: 30 * 60_000,
  /** A lot closing within this window is due once unseen for nearCloseStaleMs, i.e. on every run. */
  nearCloseMs: 3 * 3_600_000,
  nearCloseStaleMs: 10 * 60_000,
  /** A sale read in full this long ago is read in full again, for added, edited and withdrawn lots. */
  fullReadMaxAgeMs: 6 * 3_600_000,
  /**
   * Most of a run's byte and request budget that full reads may leave to the
   * due known lots. Full reads stop short of it, so a long queue of sales
   * waiting to be read cannot keep known lots from being watched (on
   * 2026-10-05 Hansen Auction Group had 46 sales queued and lots unseen for
   * 99 hours), and always keep at least the other half, so the queue drains.
   */
  watchReserveShare: 0.5,
};

// ------------------------------------------------------------ small helpers

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function int(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v.trim());
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function obj(v: unknown): BwRecord | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as BwRecord) : null;
}

/** HTML to plain text: tags stripped, common entities decoded, whitespace collapsed. */
export function textFromHtml(html: unknown): string | null {
  if (typeof html !== 'string') return null;
  const t = decodeEntities(
    html
      .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\xa0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return t === '' ? null : t;
}

/** Decode the entities these pages actually use (&amp;nbsp; is double-encoded in og tags). */
export function decodeEntities(s: string): string {
  let out = s;
  // Twice, because og:description carries "&amp;nbsp;" (an escaped &nbsp;).
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&');
  }
  return out;
}

/** ISO-8601 in UTC ("...Z"), from an ISO string or unix seconds. Out-of-range dates are refused. */
export function toIso(v: unknown): string | null {
  let d: Date | null = null;
  if (typeof v === 'string' && v.trim() !== '') d = new Date(v.trim());
  else if (typeof v === 'number' && Number.isFinite(v) && v > 0) d = new Date(v * 1000);
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return d.toISOString();
}

/** An IANA zone the runtime recognises, or null. Never a guess. */
export function validTimeZone(tz: unknown): string | null {
  const z = str(tz);
  if (!z) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

const US_STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/**
 * Normalise a DECLARED state value to its two-letter code.
 *
 * Accepts a two-letter code or a full US state name, both of which are the
 * source stating the state. Anything else (a city, a county, "-") is null.
 * This never looks at a city: Beloit is in Wisconsin and in Kansas.
 */
export function declaredState(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return US_STATE_NAMES[s.toLowerCase().replace(/\s+/g, ' ')] ?? null;
}

/** The states a run is scoped to: sources.states, defaulting to Wisconsin. */
export function scopeStates(states: string[] | null | undefined): string[] {
  const list = (states ?? []).map((s) => declaredState(s)).filter((s): s is string => !!s);
  return list.length ? [...new Set(list)] : ['WI'];
}

// ---------------------------------------------------------------- tenancy

/**
 * The tenant's API host, from sources.api_base (preferred) or sources.url when
 * that is itself a bidding host. A marketing site such as
 * www.hansenauctiongroup.com is NOT accepted: it serves no /api.
 */
export function tenantApiBase(source: Pick<SourceConfig, 'apiBase' | 'url'>): string | null {
  for (const candidate of [source.apiBase, source.url]) {
    if (!candidate) continue;
    let u: URL;
    try {
      u = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    const isBiddingHost = candidate === source.apiBase || host.startsWith('bid.') || host.endsWith('.bidwrangler.com');
    if (isBiddingHost) return `https://${host}`;
  }
  return null;
}

export const auctionListUrl = (base: string, page: number) => `${base}/api/auctions?page=${page}`;
export const itemsUrl = (base: string, auctionId: number, page: number, perPage: number) =>
  `${base}/api/auctions/${auctionId}/items?page=${page}&per_page=${perPage}`;
export const itemsByIdsUrl = (base: string, ids: readonly string[]) => `${base}/api/items?ids=${ids.join(',')}`;
export const auctionPageUrl = (base: string, auctionId: number | string) => `${base}/ui/auctions/${auctionId}`;
export const itemPageUrl = (base: string, itemId: number | string) => `${base}/ui/items/${itemId}`;

// ---------------------------------------------------------------- envelopes

export interface BwPage<T> {
  records: T[];
  total: number | null;
  page: number | null;
  perPage: number | null;
  warnings: string[];
}

function parseEnvelope(body: unknown, key: 'auctions' | 'items'): BwPage<BwRecord> {
  const env = obj(body);
  if (!env || !Array.isArray(env[key])) {
    return {
      records: [],
      total: null,
      page: null,
      perPage: null,
      warnings: [`BidWrangler ${key} response was not a { ${key}: [...] } envelope.`],
    };
  }
  const list = env[key] as unknown[];
  const records = list.filter((r): r is BwRecord => !!obj(r));
  const warnings: string[] = [];
  if (records.length !== list.length) {
    warnings.push(`Skipped ${list.length - records.length} non-object ${key} entries.`);
  }
  return {
    records,
    total: int(env.total),
    page: int(env.page),
    perPage: int(env.per_page),
    warnings,
  };
}

export const parseAuctionsPage = (body: unknown) => parseEnvelope(body, 'auctions');
export const parseItemsPage = (body: unknown) => parseEnvelope(body, 'items');

/** /api/items?ids=: a bare array of item records (an { items } envelope is read too). */
export function parseItemsList(body: unknown): { records: BwRecord[]; warnings: string[] } {
  const list = Array.isArray(body) ? body : obj(body) && Array.isArray(obj(body)!.items) ? (obj(body)!.items as unknown[]) : null;
  if (!list) return { records: [], warnings: ['BidWrangler /api/items response was not an array of items.'] };
  const records = list.filter((r): r is BwRecord => !!obj(r));
  const warnings =
    records.length !== list.length ? [`Skipped ${list.length - records.length} non-object entries in /api/items.`] : [];
  return { records, warnings };
}

/**
 * True when, within one page, every open auction precedes every completed one:
 * the ordering the early stop below relies on. Checked on every page so a
 * change in BidWrangler's sort is noticed instead of silently losing sales.
 */
export function openFirstOrderHolds(records: BwRecord[]): boolean {
  let seenComplete = false;
  for (const r of records) {
    if (r.complete === true) seenComplete = true;
    else if (seenComplete) return false;
  }
  return true;
}

/**
 * Should the /api/auctions walk stop after this page?
 *
 * Open auctions come first, so the first completed record means every later
 * page is history, but only while that ordering demonstrably holds. The other
 * conditions end the walk regardless, and maxListPages bounds it absolutely.
 */
export function auctionWalkDone(parsed: BwPage<BwRecord>, pageNo: number): boolean {
  if (parsed.records.length === 0) return true;
  if (parsed.records.some((a) => a.complete === true) && openFirstOrderHolds(parsed.records)) return true;
  const per = parsed.perPage ?? BW_AUCTIONS_PER_PAGE;
  if (parsed.records.length < per) return true;
  if (parsed.total !== null && pageNo * per >= parsed.total) return true;
  return false;
}

/** Should the item walk for one auction stop after this page? */
export function itemWalkDone(parsed: BwPage<BwRecord>, pageNo: number, perPage: number): boolean {
  if (parsed.records.length === 0) return true;
  if (parsed.records.length < perPage) return true;
  if (parsed.total !== null && pageNo * perPage >= parsed.total) return true;
  return false;
}

// ------------------------------------------------------------- normalizers

/** A BidWrangler location object as declared by the house. */
export function bwLocation(v: unknown): NormalizedLocation | null {
  const o = obj(v);
  if (!o) return null;
  const city = str(o.city);
  const state = declaredState(o.state);
  const zip = str(o.zip);
  const postalCode = zip && /^\d{5}/.test(zip) ? zip.slice(0, 5) : null;
  const line1 = str(o.street);
  const lat = num(o.lat);
  const lon = num(o.lng);
  if (!city && !state && !postalCode && !line1) return null;
  return {
    line1,
    city,
    state,
    postalCode,
    lat: lat !== null && Math.abs(lat) <= 90 ? lat : null,
    lon: lon !== null && Math.abs(lon) <= 180 ? lon : null,
    ambiguous: !!city && !state,
  };
}

const STATE_CODES = new Set(Object.values(US_STATE_NAMES));
// Full state names as a house writes them: Title Case or capitals, longest
// first so "West Virginia" is tried before "Virginia".
const STATE_NAME_ALT = Object.keys(US_STATE_NAMES)
  .sort((a, b) => b.length - a.length)
  .flatMap((n) => [n.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bOf\b/, 'of'), n.toUpperCase()])
  .map((n) => n.replace(/ /g, String.raw`\s+`))
  .join('|');
// "ADDRESS: ELEVA, WI", "ADDRESS: 1264 5th Ave - Prairie Farm, WI": a label,
// then the place, a comma and the state. Case-sensitive, so "in" is never Indiana.
const LABELLED_PLACE = new RegExp(
  String.raw`\b(?:ADDRESS|Address|LOCATION|Location)\s*:\s*([^:\n]{1,120}?),\s*(?:([A-Z]{2})|(${STATE_NAME_ALT}))(?![A-Za-z])`,
  'g',
);
// "Auction Location: N11067 County Rd. F, Phillips, WI": the one form read from
// a sale's long description, where only a place-of-sale label is a declaration.
const LABELLED_SALE_PLACE = new RegExp(
  String.raw`\b(?:Auction|AUCTION|Sale|SALE)\s+(?:Location|LOCATION|Address|ADDRESS)\s*:\s*([^:\n]{1,120}?),\s*(?:([A-Z]{2})|(${STATE_NAME_ALT}))(?![A-Za-z])`,
  'g',
);
// "Dane County, Wisconsin", "Dane and Green Counties, WI".
const COUNTY_STATE = new RegExp(
  String.raw`\b(?:County|COUNTY|Counties|COUNTIES),\s*(?:([A-Z]{2})|(${STATE_NAME_ALT}))(?![A-Za-z])`,
  'g',
);

function stateFrom(code: string | undefined, name: string | undefined): string | null {
  if (code) return STATE_CODES.has(code) ? code : null;
  return name ? declaredState(name.replace(/\s+/g, ' ')) : null;
}

/** "1264 5th Ave - Prairie Farm" -> "Prairie Farm"; anything with a digit is not a city. */
function cityFrom(place: string): string | null {
  const last = place.split(/\s+-\s+|,\s*/).pop()?.trim() ?? '';
  if (!last || last.length > 40 || !/^[A-Za-z][A-Za-z .'-]*$/.test(last)) return null;
  return tidyCity(last);
}

/**
 * Where a sale says it is in its own summary, for houses that leave the
 * location object empty (point 1 above). Two forms count, both the house
 * stating the state, never a city implying one: a labelled place ("ADDRESS:
 * Eleva, WI") and a county with its state ("Dane County, Wisconsin"). The
 * summary is read (simple_description and formatted_simple_description), never
 * the name. The long description, where directions and neighbouring counties
 * are mentioned in passing, is read only when the summary declares nothing,
 * and only for a place-of-sale label ("Auction Location: N11067 County Rd. F,
 * Phillips, WI": Bennett Auction Service writes its sales' places only so,
 * and its 975-lot sale of 2026-10-25 was skipped until this was read). Text
 * that names two different states declares none. The street is not kept,
 * only the city and state.
 */
export function textDeclaredLocation(a: BwRecord): NormalizedLocation | null {
  const texts = [textFromHtml(a.formatted_simple_description), str(a.simple_description)]
    .filter((t): t is string => !!t)
    .map(decodeEntities);
  const states = new Set<string>();
  const cities = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(LABELLED_PLACE)) {
      const state = stateFrom(m[2], m[3]);
      if (!state) continue;
      states.add(state);
      const city = cityFrom(m[1]);
      if (city) cities.add(city);
    }
    for (const m of t.matchAll(COUNTY_STATE)) {
      const state = stateFrom(m[1], m[2]);
      if (state) states.add(state);
    }
  }
  if (states.size === 0) {
    const long = textFromHtml(a.description);
    if (long) {
      for (const m of decodeEntities(long).matchAll(LABELLED_SALE_PLACE)) {
        const state = stateFrom(m[2], m[3]);
        if (!state) continue;
        states.add(state);
        const city = cityFrom(m[1]);
        if (city) cities.add(city);
      }
    }
  }
  if (states.size !== 1) return null;
  return {
    line1: null,
    city: cities.size === 1 ? [...cities][0] : null,
    state: [...states][0],
    postalCode: null,
    lat: null,
    lon: null,
    ambiguous: false,
  };
}

/**
 * The sale's location: its location object when that names a state, else the
 * state its summary declares (textDeclaredLocation). A location object with a
 * city but no state keeps its details and takes the summary's state.
 */
export function auctionLocation(a: BwRecord): NormalizedLocation | null {
  const declared = bwLocation(a.location);
  if (declared?.state) return declared;
  const fromText = textDeclaredLocation(a);
  if (!fromText) return declared;
  if (!declared) return fromText;
  return { ...declared, city: declared.city ?? fromText.city, state: fromText.state, ambiguous: false };
}

// "1918 Packard Pedal Car (Arpin, WI)": a city and a state in parentheses
// ending an item's name, as Hansen Auction Group marks each car of a sale held
// at "Multiple Locations". "(Has WI Title)" is not a place.
const NAME_PLACE = /\(\s*([A-Za-z][A-Za-z .'-]{0,39}?)\s*,\s*([A-Z]{2})\s*\)\s*$/;

/**
 * Where an item says it is in its own name: a city and state in parentheses
 * that end the name. Read only for items of a sale that declares no state of
 * its own (itemPickup), never to move an item out of its sale's declared place.
 */
export function nameDeclaredLocation(name: unknown): NormalizedLocation | null {
  const n = str(name);
  if (!n) return null;
  const m = NAME_PLACE.exec(decodeEntities(n));
  if (!m || !STATE_CODES.has(m[2])) return null;
  const city = tidyCity(m[1]);
  if (!city) return null;
  return { line1: null, city, state: m[2], postalCode: null, lat: null, lon: null, ambiguous: false };
}

/**
 * The state an item declares for itself: its location object, or the place
 * ending its name. What an item of a sale without a declared state needs to
 * be kept.
 */
export function itemDeclaredLocation(item: BwRecord): NormalizedLocation | null {
  const own = bwLocation(item.location);
  if (own?.state) return own;
  return nameDeclaredLocation(item.name);
}

/**
 * An item's pickup place. In a sale that declares its state, the item's own
 * location object or else the sale's, as always. In a sale that declares none
 * (each item somewhere else), what the item declares for itself.
 */
export function itemPickup(item: BwRecord, auction: BwRecord | null): NormalizedLocation | null {
  const own = bwLocation(item.location);
  const sale = auction ? auctionLocation(auction) : null;
  if (sale?.state) return own ?? sale;
  return itemDeclaredLocation(item) ?? own ?? sale;
}

export interface BuyerPremium {
  pct: number;
  note: string;
}

/**
 * Buyer's premium from terms prose. BidWrangler houses call it a "Buyer's Fee".
 *
 * A tiered premium ("10% ... on the first $25,000 + 6% on the remainder") is
 * reported as its FIRST tier, with the tiers spelled out in the note. That
 * overstates the premium on lots above the break, the safe direction for an
 * all-in cost. Returns null rather than a guess.
 */
export function parseBuyerPremium(text: string | null | undefined): BuyerPremium | null {
  if (!text) return null;
  const t = decodeEntities(text).replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, ' ');
  const patterns = [
    /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:online\s+)?buyer'?s?\s*(?:premium|fee)\b/i,
    /buyer'?s?\s*(?:premium|fee)\s*(?:of|is|:)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const pct = Number(m[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 30) continue;
    const after = t.slice(m.index, m.index + 200);
    const tier = /on the first \$\s?([\d,]+)(?:\.\d{2})?\s*(?:\+|and|,|plus)\s*(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:on|of)\s*(?:the\s+)?(?:remainder|balance|rest)/i.exec(after);
    const note = tier
      ? `Tiered: ${pct}% on the first $${tier[1]}, ${Number(tier[2])}% on the remainder`
      : m[0].trim();
    return { pct, note };
  }
  return null;
}

/** Card surcharge: the structured payment_cc_fee first, then the prose. */
export function parseCardFeePct(structured: unknown, text: string | null | undefined): number | null {
  const s = num(structured);
  if (s !== null && s > 0 && s <= 15) return s;
  if (!text) return null;
  const t = decodeEntities(text).replace(/\s+/g, ' ');
  const m = /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:credit\s*card\s+)?convenience\s+fee/i.exec(t)
    ?? /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:fee\s+)?(?:for\s+)?credit\s*card/i.exec(t);
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) && pct > 0 && pct <= 15 ? pct : null;
}

/** All the terms prose an auction record carries, entity-decoded. */
function auctionTerms(a: BwRecord): string {
  return [str(a.simple_description), textFromHtml(a.description)]
    .filter((s): s is string => !!s)
    .map(decodeEntities)
    .join('\n');
}

/** Auction raw without the megabyte of featured-image URLs. */
function slimAuctionRaw(a: BwRecord): BwRecord {
  const { featured_images, ...rest } = a;
  return {
    ...rest,
    featured_images_count: Array.isArray(featured_images) ? featured_images.length : 0,
  };
}

export function normalizeBwAuction(a: BwRecord, base: string): NormalizedAuction | null {
  const id = int(a.id);
  const name = str(a.name);
  if (id === null || !name) return null;

  const terms = auctionTerms(a);
  const bp = parseBuyerPremium(terms);
  const cardFee = parseCardFeePct(a.payment_cc_fee, terms);
  const company = obj(a.company);
  const noteParts = [bp?.note ?? null, cardFee !== null ? `${cardFee}% credit card fee` : null]
    .filter((s): s is string => !!s);

  return {
    externalId: String(id),
    title: decodeEntities(name),
    description: textFromHtml(a.description) ?? str(a.simple_description),
    auctioneer: str(company?.name) ?? str(a.contact_company),
    url: auctionPageUrl(base, id),
    format: a.online_only === true ? 'online' : a.offline_only === true ? 'live' : 'hybrid',
    startsAt: toIso(a.starts_at) ?? toIso(a.starts_at_unix),
    endsAt: toIso(a.scheduled_end_time) ?? toIso(a.scheduled_end_time_unix),
    timezone: validTimeZone(a.timezone),
    pickup: auctionLocation(a),
    pickupRequired: /\bpick\s*-?\s*up\b|\bpickup\b/i.test(terms) ? true : undefined,
    sellerName: null,
    sellerState: null,
    lotCount: int(a.published_items_count) ?? int(a.items_count),
    currency: str(a.currency_name) ?? 'USD',
    buyerPremiumPct: bp?.pct ?? null,
    buyerPremiumNote: noteParts.length ? noteParts.join('; ') : null,
    termsUrl: null,
    raw: slimAuctionRaw(a),
  };
}

const INFO_LOT_NAMES = new Set([
  'payment information', 'payment info', 'payment', 'payments',
  'open house', 'open house information', 'preview', 'inspection', 'inspection and vehicles',
  'pick up', 'pickup', 'pick-up', 'pick up information', 'pickup information', 'removal',
  'load out', 'loadout', 'transfers', 'transfer', 'shipping', 'shipping information',
  'terms', 'terms and conditions', 'important information', 'please read', "buyer's premium",
  "buyer's fee",
  // Seen open on 2026-10-05 (Hansen Auction Group, North Central Sales, Hansen & Young).
  "buyer's terms", 'buyers terms', 'highlighted terms', 'additional information', 'new registration',
  'text messages & alerts', 'text messages and alerts', 'no shipping',
]);

// Whole-name forms with a variable tail: "For Equipment Questions Please Call
// Rich at 715-…", "FOR QUESTIONS ON THE ITEMS CONTACT: Andy • 715-…", "Fire
// Arms Terms-FFL WI.", "Preview Auction October 1st". Anchored at the start, so
// a lot that merely mentions terms or a preview is still a lot.
const INFO_LOT_PATTERNS: readonly RegExp[] = [
  /^for (?:[a-z]+ )?questions\b/,
  /^(?:fire ?arms?|firearms?|gun) terms\b/,
  /^preview auction\b/,
];

/**
 * An informational pseudo-lot ("#1A Payment Information"): a biddable row that
 * carries terms, not merchandise. Matched on the WHOLE name (or one of the
 * anchored forms above) only, so "Pickup Truck" and "Shipping Container" are
 * real lots.
 */
export function isInformationalLot(item: BwRecord): boolean {
  const name = str(item.name);
  if (!name) return false;
  const n = decodeEntities(name)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.:!*\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return INFO_LOT_NAMES.has(n) || INFO_LOT_PATTERNS.some((re) => re.test(n));
}

/** Lot images, largest-but-sane size first: lg (1200x756 box) > xl > sm > xs. */
export function bwImages(v: unknown): NormalizedImage[] {
  if (!Array.isArray(v)) return [];
  const out: NormalizedImage[] = [];
  const seen = new Set<string>();
  for (const img of v) {
    const o = obj(img);
    if (!o) continue;
    const url = str(o.lg) ?? str(o.xl) ?? str(o.sm) ?? str(o.xs) ?? str(o.base_url);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, position: out.length });
    if (out.length >= BW_MAX_IMAGES) break;
  }
  return out;
}

/** Observed live on 2026-09-30. */
const OPEN_ITEM_STATUSES = new Set(['accepting_bids', 'pending']);

/** Plausible end states; none was observed live, so `closed` also checks the clock. */
const CLOSED_ITEM_STATUSES = new Set([
  'closed', 'sold', 'no_sale', 'unsold', 'passed', 'complete', 'completed', 'ended',
  'canceled', 'cancelled', 'withdrawn',
]);

/** Item raw without images (normalized separately) and without the bidder's identity. */
function slimItemRaw(item: BwRecord): BwRecord {
  const { images, ...rest } = item;
  const state = obj(item.api_bidding_state);
  const high = obj(state?.high);
  let bidding: BwRecord | undefined;
  if (state) {
    bidding = { ...state };
    if (high) {
      const { user_id, account_id, bidder_number, ...anon } = high;
      bidding.high = anon;
    }
  }
  return {
    ...rest,
    ...(bidding ? { api_bidding_state: bidding } : {}),
    images_count: Array.isArray(images) ? images.length : 0,
  };
}

export interface NormalizeItemContext {
  base: string;
  now: Date;
  auction?: BwRecord | null;
}

export function normalizeBwItem(item: BwRecord, ctx: NormalizeItemContext): NormalizedLot | null {
  const id = int(item.id);
  const name = str(item.name);
  if (id === null || !name) return null;

  const hidePrices = item.hide_prices === true || ctx.auction?.hide_prices === true;
  const state = obj(item.api_bidding_state) ?? {};
  const high = obj(state.high);
  const cfg = obj(item.bidding_configuration) ?? {};

  const currentBidCents = hidePrices ? null : parseMoneyToCents(high?.amount ?? null);
  const nextBidCents = hidePrices ? null : parseMoneyToCents(state.minimum_bid_amount ?? state.ask_amount ?? null);
  const startingBidCents = hidePrices ? null : parseMoneyToCents(cfg.start_amount ?? item.start_amount ?? null);
  const reserveCents = parseMoneyToCents(cfg.reserve_amount ?? null);

  // actual_end_time moves with soft-close extensions; scheduled_end_time does not.
  const closesAt =
    toIso(item.actual_end_time) ?? toIso(item.scheduled_end_time) ?? toIso(item.scheduled_end_time_unix);
  const status = str(item.status);
  const closed =
    (status !== null && CLOSED_ITEM_STATUSES.has(status)) ||
    (closesAt !== null && Date.parse(closesAt) <= ctx.now.getTime());

  const closing = state.closing_bid;
  const soldPriceCents =
    closed && !hidePrices
      ? parseMoneyToCents(typeof closing === 'number' ? closing : obj(closing)?.amount ?? null)
      : null;

  return {
    externalId: String(id),
    auctionExternalId: int(item.auction_id) !== null ? String(int(item.auction_id)) : null,
    lotNumber: str(item.lot_identifier),
    title: decodeEntities(name),
    description:
      str(item.description_without_html) ?? str(item.simple_description) ?? textFromHtml(item.description),
    brand: null,
    model: null,
    condition: null,
    quantity: int(item.quantity),
    startingBidCents,
    currentBidCents,
    nextBidCents,
    estimateLowCents: parseMoneyToCents(cfg.low_estimate ?? null),
    estimateHighCents: parseMoneyToCents(cfg.high_estimate ?? null),
    soldPriceCents,
    bidCount: int(state.accepted_bid_count),
    reserveMet: currentBidCents !== null && reserveCents !== null ? currentBidCents >= reserveCents : null,
    closesAt,
    closed,
    url: itemPageUrl(ctx.base, id),
    // An item may declare its own location; otherwise the auction's applies
    // (and in a sale that declares no state, only the item's own: itemPickup).
    pickup: itemPickup(item, ctx.auction ?? null),
    ships: item.shippable === true,
    images: bwImages(item.images),
    raw: slimItemRaw(item),
  };
}

// -------------------------------------------------------------- planning

export interface AuctionPlan {
  /** In scope and worth an item fetch, in fetch order. */
  queue: BwRecord[];
  /** Every in-scope auction to emit (queued or not). */
  inScope: BwRecord[];
  outOfScope: number;
  undeclaredState: BwRecord[];
  notOpen: number;
}

function endMs(a: BwRecord): number {
  const e = toIso(a.scheduled_end_time) ?? toIso(a.scheduled_end_time_unix);
  return e ? Date.parse(e) : Number.POSITIVE_INFINITY;
}

const GOLDEN = 0.6180339887498949;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * How far the rotation's starting point moves between two hourly runs over n
 * sales: the whole number nearest n times the golden ratio's fraction that
 * shares no factor with n. Successive windows then land far apart and barely
 * overlap, and because the step is coprime with n every starting point comes
 * round within n runs. Moving by one sale an hour (the first version) left the
 * far half of Hansen's ~50 sales waiting a day when a run reached ~25 of them.
 */
export function rotationStride(n: number): number {
  if (n <= 1) return 0;
  const s = Math.max(1, Math.round(n * GOLDEN));
  for (let d = 0; d < n; d++) {
    for (const c of [s + d, s - d]) if (c >= 1 && c < n && gcd(c, n) === 1) return c;
  }
  return 1;
}

/**
 * Decide which auctions to fetch items for, and in what order.
 *
 * Open auctions in scope are split into URGENT (closing within urgentWindowMs,
 * soonest first) and the REST. The rest is rotated by the hour of `now`, the
 * start moving rotationStride(n) sales each hour, so a budget that cannot cover
 * every auction still reaches each of them within a few runs (3 runs for 50
 * sales when a run reaches 20) instead of starving the ones that close last.
 * Stateless and deterministic for a given `now`, which keeps it testable.
 */
export function planAuctions(
  auctions: BwRecord[],
  scope: string[],
  now: Date,
  urgentWindowMs = BW_DEFAULTS.urgentWindowMs,
): AuctionPlan {
  const inScope: BwRecord[] = [];
  const undeclaredState: BwRecord[] = [];
  let outOfScope = 0;
  let notOpen = 0;
  const seen = new Set<number>();

  for (const a of auctions) {
    const id = int(a.id);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    if (a.complete === true || a.archived === true || a.published === false || a.listing === true) {
      notOpen++;
      continue;
    }
    const state = auctionLocation(a)?.state ?? null;
    if (!state) {
      undeclaredState.push(a);
      continue;
    }
    if (!scope.includes(state)) {
      outOfScope++;
      continue;
    }
    inScope.push(a);
  }

  const published = (a: BwRecord) => int(a.published_items_count) ?? int(a.items_count) ?? 0;
  const fetchable = inScope.filter((a) => published(a) > 0).sort((x, y) => endMs(x) - endMs(y));
  const t = now.getTime();
  const urgent = fetchable.filter(
    (a) => str(a.status) === 'accepting_bids' && endMs(a) - t <= urgentWindowMs,
  );
  const rest = fetchable.filter((a) => !urgent.includes(a));
  const n = rest.length;
  const offset = n ? ((Math.floor(t / 3_600_000) % n) * rotationStride(n)) % n : 0;
  const rotated = [...rest.slice(offset), ...rest.slice(0, offset)];

  return { queue: [...urgent, ...rotated], inScope, outOfScope, undeclaredState, notOpen };
}

export type FullReadReason = 'new' | 'count-changed' | 'aged';

/** Bytes and requests full reads leave for refreshing known lots by id. */
interface Reserve {
  readonly bytes: number;
  readonly requests: number;
}
const NO_RESERVE: Reserve = { bytes: 0, requests: 0 };

export interface WatchPlan {
  /**
   * Sales to read in full: never read in full, or declaring a different item
   * count than at their last full read (lots were added or withdrawn). New
   * listings are what a buyer is waiting for.
   */
  firstReads: { auction: BwRecord; reason: FullReadReason }[];
  /** Known lots closing within BW_WATCH.nearCloseMs and due, soonest close first. */
  nearClose: string[];
  /** Sales whose last full read is older than BW_WATCH.fullReadMaxAgeMs, oldest read first. */
  agedReads: { auction: BwRecord; reason: FullReadReason }[];
  /** Every other due known lot, least recently seen first. */
  stale: string[];
}

/**
 * Decide, from what the database already holds (0055), which sales to read in
 * full and which known lots to refresh by id. Stateless given its inputs.
 *
 * Only sales listed open and in scope count: a known lot of a sale that is no
 * longer listed (complete, or out of scope) is not refreshed here and closes on
 * its own clock. A lot of a sale queued for a full read is still watched by id:
 * the run may not reach that read, and a lot it does read is not fetched twice.
 * Lots without a close time are refreshed as stale ones.
 */
export function planWatch(
  inScope: BwRecord[],
  known: KnownState,
  now: Date,
  watch: typeof BW_WATCH = BW_WATCH,
): WatchPlan {
  const t = now.getTime();
  const knownAuctions = new Map(known.auctions.map((a) => [a.externalId, a]));
  const published = (a: BwRecord) => int(a.published_items_count) ?? int(a.items_count) ?? 0;
  const fetchable = inScope.filter((a) => published(a) > 0).sort((x, y) => endMs(x) - endMs(y));

  const firstReads: WatchPlan['firstReads'] = [];
  const aged: { auction: BwRecord; readAt: number }[] = [];
  const listed = new Set<string>();
  for (const a of fetchable) {
    const id = String(int(a.id));
    listed.add(id);
    const k = knownAuctions.get(id);
    if (!k || k.itemsReadAt === null) {
      firstReads.push({ auction: a, reason: 'new' });
    } else if (k.itemsReadCount !== published(a)) {
      firstReads.push({ auction: a, reason: 'count-changed' });
    } else if (t - k.itemsReadAt >= watch.fullReadMaxAgeMs) {
      aged.push({ auction: a, readAt: k.itemsReadAt });
    }
  }
  // New sales before sales whose count changed; each group soonest close first.
  firstReads.sort((x, y) => Number(x.reason !== 'new') - Number(y.reason !== 'new'));
  aged.sort((x, y) => x.readAt - y.readAt);

  const near: KnownLot[] = [];
  const stale: KnownLot[] = [];
  for (const lot of known.lots) {
    const auctionId = lot.auctionExternalId;
    if (!auctionId || !listed.has(auctionId)) continue;
    const unseen = t - lot.lastSeenAt;
    const closingSoon = lot.closesAt !== null && lot.closesAt - t <= watch.nearCloseMs;
    if (closingSoon && unseen >= watch.nearCloseStaleMs) near.push(lot);
    else if (unseen >= watch.staleMs) stale.push(lot);
  }
  near.sort((x, y) => (x.closesAt ?? 0) - (y.closesAt ?? 0));
  stale.sort((x, y) => x.lastSeenAt - y.lastSeenAt);

  return {
    firstReads,
    nearClose: near.map((l) => l.externalId),
    agedReads: aged.map(({ auction }) => ({ auction, reason: 'aged' as const })),
    stale: stale.map((l) => l.externalId),
  };
}

// -------------------------------------------------------------------- run

export interface BidwranglerRunOptions {
  maxRequests?: number;
  maxBytes?: number;
  maxListPages?: number;
  itemsPerPage?: number;
  /** Minimum gap between requests. Defaults to 60s / sources.rate_limit_rpm. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export async function runBidwrangler(
  ctx: AdapterContext,
  opts: BidwranglerRunOptions = {},
): Promise<IngestResult> {
  const base = tenantApiBase(ctx.source);
  if (!base) {
    throw new Error(
      'BidWrangler needs sources.api_base set to the tenant bidding host (the page\'s ' +
        'window.bwApiHost), e.g. https://bid.hansenauctiongroup.com.',
    );
  }
  const maxRequests = opts.maxRequests ?? BW_DEFAULTS.maxRequests;
  const maxBytes = opts.maxBytes ?? BW_DEFAULTS.maxBytes;
  const maxListPages = opts.maxListPages ?? BW_DEFAULTS.maxListPages;
  const perPage = opts.itemsPerPage ?? BW_DEFAULTS.itemsPerPage;
  const minInterval =
    opts.minIntervalMs ?? Math.min(10_000, Math.ceil(60_000 / Math.max(1, ctx.source.rateLimitRpm || 10)));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const scope = scopeStates(ctx.source.states);
  const now = ctx.now();
  const warnings: string[] = [];
  const stats = { httpRequests: 0, bytesIn: 0 };
  let complete = true;
  let lastAt = 0;

  const get = async (url: string) => {
    if (stats.httpRequests > 0 && minInterval > 0) {
      const wait = lastAt + minInterval - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const res = await ctx.fetch(url, { headers: { Accept: 'application/json' } });
    lastAt = Date.now();
    stats.httpRequests++;
    stats.bytesIn += res.text.length;
    if (res.status === 429) throw new Error(`BidWrangler rate limit (HTTP 429) at ${url}`);
    return res;
  };

  // 1. Enumerate open auctions. Open ones come first; stop at the history.
  const listed: BwRecord[] = [];
  for (let page = 1; ; page++) {
    let res: Awaited<ReturnType<typeof get>>;
    try {
      res = await get(auctionListUrl(base, page));
    } catch (e) {
      // Out of run budget after page 1: work with the auctions already listed.
      if (page === 1 || !isBudgetRefusal(e)) throw e;
      warnings.push(`Run budget ran out before auction list page ${page}; list incomplete.`);
      complete = false;
      break;
    }
    if (res.status !== 200) {
      if (page === 1) throw new Error(`BidWrangler /api/auctions returned HTTP ${res.status}`);
      warnings.push(`Auction list page ${page} returned HTTP ${res.status}; list incomplete.`);
      complete = false;
      break;
    }
    const json = parseJson(res.text);
    if (!json.ok) {
      if (page === 1) throw new Error('BidWrangler /api/auctions returned a body that is not JSON.');
      warnings.push(`Auction list page ${page} was not JSON; list incomplete.`);
      complete = false;
      break;
    }
    const parsed = parseAuctionsPage(json.value);
    warnings.push(...parsed.warnings);
    listed.push(...parsed.records);
    if (!openFirstOrderHolds(parsed.records)) {
      warnings.push(
        `Auction list page ${page} mixes open and completed sales out of order; ` +
          'the early stop is disabled and this run is not a complete snapshot.',
      );
      complete = false;
    }
    if (auctionWalkDone(parsed, page)) break;
    if (page >= maxListPages) {
      warnings.push(`Stopped the auction list at ${maxListPages} pages with open auctions still coming.`);
      complete = false;
      break;
    }
  }

  // 2. Scope by DECLARED location, then plan the item fetches.
  const plan = planAuctions(listed, scope, now);
  // A sale that declares no state of its own ("Midwest Fall Classic Car -
  // Multiple Locations") is not placed, but its items are read, and an item is
  // kept only where it declares its own place in scope (itemDeclaredLocation).
  const itemLocated = plan.undeclaredState.filter(
    (a) => (int(a.published_items_count) ?? int(a.items_count) ?? 0) > 0,
  );
  const itemLocatedIds = new Set(itemLocated.map((a) => int(a.id)!));
  if (plan.undeclaredState.length) {
    warnings.push(
      `${plan.undeclaredState.length} open auction(s) declare no state in their location or summary ` +
        `(ids ${plan.undeclaredState.slice(0, 5).map((a) => a.id).join(', ')}); state is never guessed from a sale's name, ` +
        `so their items are kept only where each declares its own place.`,
    );
  }

  const auctions: NormalizedAuction[] = [];
  const auctionByExt = new Map<string, NormalizedAuction>();
  const byId = new Map<number, BwRecord>();
  for (const a of [...plan.inScope, ...itemLocated]) {
    const n = normalizeBwAuction(a, base);
    if (!n) {
      warnings.push(`Skipped an auction record without id or name.`);
      continue;
    }
    auctions.push(n);
    auctionByExt.set(n.externalId, n);
    byId.set(int(a.id)!, a);
  }

  // 3. Items, inside the request and byte budgets.
  const lots: NormalizedLot[] = [];
  const readIds = new Set<string>();
  const skippedForBudget: number[] = [];
  const unknownStatuses = new Set<string>();
  const counts = { infoLots: 0, unnamed: 0, foreignItems: 0, outOfScopeItems: 0, unplacedItems: 0 };
  let itemRequests = 0;
  /** Full reads started in this run: the first is always tried, however large. */
  let fullReadsTried = 0;
  let outOfBudget = false;

  /** Keep one item record as a lot, or count why not. `expectAuction` refuses items of another sale. */
  const accept = (item: BwRecord, auction: BwRecord | null, expectAuction: number | null) => {
    if (expectAuction !== null && int(item.auction_id) !== null && int(item.auction_id) !== expectAuction) {
      counts.foreignItems++;
      return;
    }
    if (isInformationalLot(item)) {
      counts.infoLots++;
      return;
    }
    const ownState = declaredState(obj(item.location)?.state);
    if (ownState && !scope.includes(ownState)) {
      counts.outOfScopeItems++;
      return;
    }
    const saleId = int(auction?.id) ?? int(item.auction_id);
    if (saleId !== null && itemLocatedIds.has(saleId)) {
      // A sale with no state of its own: the item must declare one.
      const place = itemDeclaredLocation(item)?.state ?? null;
      if (!place) {
        counts.unplacedItems++;
        return;
      }
      if (!scope.includes(place)) {
        counts.outOfScopeItems++;
        return;
      }
    }
    const lot = normalizeBwItem(item, { base, now, auction });
    if (!lot) {
      counts.unnamed++;
      return;
    }
    const status = str(item.status);
    if (status && !OPEN_ITEM_STATUSES.has(status) && !CLOSED_ITEM_STATUSES.has(status)) {
      unknownStatuses.add(status);
    }
    if (readIds.has(lot.externalId)) return;
    readIds.add(lot.externalId);
    lots.push(lot);
  };

  /**
   * Would reading this sale in full overrun the budget, less what is held back
   * for the watch? A run's first full read is always tried, so no sale is too
   * big ever to be read.
   */
  const overBudget = (a: BwRecord, reserve: Reserve): boolean => {
    const expected = int(a.published_items_count) ?? int(a.items_count) ?? 0;
    const pagesNeeded = Math.max(1, Math.ceil(expected / perPage));
    return (
      fullReadsTried > 0 &&
      (stats.bytesIn + expected * BW_EST_BYTES_PER_ITEM > maxBytes - reserve.bytes ||
        stats.httpRequests + pagesNeeded > maxRequests - reserve.requests)
    );
  };

  /**
   * Read every item of one sale, page by page. True when the walk got them all.
   * The gate's time or request budget running out sets outOfBudget and keeps
   * every item already read; the rest is left for the next run.
   */
  const readAuction = async (a: BwRecord): Promise<boolean> => {
    const auctionId = int(a.id)!;
    const expected = int(a.published_items_count) ?? int(a.items_count) ?? 0;
    const pagesNeeded = Math.max(1, Math.ceil(expected / perPage));
    let gotAll = false;
    let seen = 0;
    let total: number | null = null;
    for (let page = 1; page <= pagesNeeded + 1; page++) {
      if (stats.httpRequests >= maxRequests) break;
      itemRequests++;
      let res: Awaited<ReturnType<typeof get>>;
      try {
        res = await get(itemsUrl(base, auctionId, page, perPage));
      } catch (e) {
        if (!isBudgetRefusal(e)) throw e;
        outOfBudget = true;
        break;
      }
      if (res.status !== 200) {
        warnings.push(`Items for auction ${auctionId} page ${page}: HTTP ${res.status}.`);
        break;
      }
      const json = parseJson(res.text);
      if (!json.ok) {
        warnings.push(`Items for auction ${auctionId} page ${page} were not JSON.`);
        break;
      }
      const parsed = parseItemsPage(json.value);
      warnings.push(...parsed.warnings.map((w) => `Auction ${auctionId}: ${w}`));
      seen += parsed.records.length;
      total = parsed.total ?? total;
      for (const item of parsed.records) accept(item, a, auctionId);
      if (itemWalkDone(parsed, page, perPage)) {
        gotAll = true;
        break;
      }
    }
    // A walk that "finished" short of the server's own total is not a snapshot:
    // items moved between pages, or a page came back short.
    if (gotAll && total !== null && seen < total) {
      warnings.push(`Auction ${auctionId}: received ${seen} of ${total} items; treated as incomplete.`);
      gotAll = false;
    }
    if (gotAll) auctionByExt.get(String(auctionId))!.itemsComplete = true;
    return gotAll;
  };

  /** One sale in full, unless the budget (less the reserve) is spent; a sale left unread is reported. */
  const fullRead = async (a: BwRecord, reserve: Reserve = NO_RESERVE): Promise<boolean> => {
    const auctionId = int(a.id)!;
    if (outOfBudget || overBudget(a, reserve)) {
      skippedForBudget.push(auctionId);
      return false;
    }
    fullReadsTried++;
    const gotAll = await readAuction(a);
    // A walk the budget cut short is deferred, like the sales after it.
    if (outOfBudget) skippedForBudget.push(auctionId);
    return gotAll;
  };

  let watchedLots = 0;
  let watchMissing = 0;
  let watchDeferred = 0;
  /**
   * Batches the platform refused with 404 ("Record not found!"): /api/items
   * answers that for the whole request when any one id no longer exists
   * (checked live on bid.hansenauctiongroup.com, 2026-10-05), so the other
   * lots of the batch are unread too. Their sales are read in full instead.
   */
  const notFoundBatches: string[][] = [];
  /** The sale each known lot belongs to, for splitting a refused batch. */
  const saleOfLot = new Map((ctx.known?.lots ?? []).map((l) => [l.externalId, l.auctionExternalId ?? '']));
  /** A batch's ids grouped by sale, in the order the sales first appear. */
  const bySale = (batch: readonly string[]): string[][] => {
    const groups = new Map<string, string[]>();
    for (const id of batch) {
      const sale = saleOfLot.get(id) ?? '';
      const group = groups.get(sale);
      if (group) group.push(id);
      else groups.set(sale, [id]);
    }
    return [...groups.values()];
  };
  /**
   * One /api/items?ids= request. "stopped" means the budget or the platform
   * ended the watch for this run; `why` says which, when it was the platform.
   */
  const fetchByIds = async (batch: readonly string[]): Promise<{ outcome: 'read' | 'not-found' | 'stopped'; why?: string }> => {
    if (
      outOfBudget ||
      stats.httpRequests + 1 > maxRequests ||
      (itemRequests > 0 && stats.bytesIn + batch.length * BW_EST_BYTES_PER_ITEM > maxBytes)
    ) {
      return { outcome: 'stopped' };
    }
    itemRequests++;
    let res: Awaited<ReturnType<typeof get>>;
    try {
      res = await get(itemsByIdsUrl(base, batch));
    } catch (e) {
      if (!isBudgetRefusal(e)) throw e;
      outOfBudget = true;
      return { outcome: 'stopped' };
    }
    if (res.status === 404) return { outcome: 'not-found' };
    if (res.status !== 200) return { outcome: 'stopped', why: `Items by id: HTTP ${res.status}` };
    const json = parseJson(res.text);
    if (!json.ok) return { outcome: 'stopped', why: 'Items by id were not JSON' };
    const parsed = parseItemsList(json.value);
    warnings.push(...parsed.warnings);
    const returned = new Set<string>();
    for (const item of parsed.records) {
      const id = int(item.id);
      if (id === null) continue;
      returned.add(String(id));
      const before = lots.length;
      accept(item, byId.get(int(item.auction_id) ?? -1) ?? null, null);
      watchedLots += lots.length - before;
    }
    watchMissing += batch.filter((id) => !returned.has(id)).length;
    return { outcome: 'read' };
  };
  /** Known lots by id, BW_IDS_PER_REQUEST at a time, skipping any already read in this run. */
  const watchIds = async (ids: readonly string[]) => {
    const due = ids.filter((id) => !readIds.has(id));
    for (let i = 0; i < due.length; i += BW_IDS_PER_REQUEST) {
      const batch = due.slice(i, i + BW_IDS_PER_REQUEST).filter((id) => !readIds.has(id));
      if (!batch.length) continue;
      const after = Math.max(0, due.length - (i + BW_IDS_PER_REQUEST));
      const r = await fetchByIds(batch);
      if (r.outcome === 'stopped') {
        if (r.why) warnings.push(`${r.why}; ${due.length - i} due lot(s) left for the next run.`);
        watchDeferred += due.length - i;
        return;
      }
      if (r.outcome === 'read') continue;
      // One lot of the batch is gone; the rest may be fine. Ask again one sale
      // at a time, so a lot that is gone holds up only its own sale: on
      // 2026-10-05 eight lots withdrawn from one Hansen Auction Group sale were
      // the oldest due ids and kept 92 lots of three other sales in their
      // refused batch for hours. When every other sale was answered, the last
      // must hold the missing lot and is not asked again.
      const groups = bySale(batch);
      if (groups.length === 1) {
        notFoundBatches.push(batch);
        continue;
      }
      let refused = false;
      for (let g = 0; g < groups.length; g++) {
        if (g === groups.length - 1 && !refused) {
          notFoundBatches.push(groups[g]);
          break;
        }
        const rg = await fetchByIds(groups[g]);
        if (rg.outcome === 'not-found') {
          refused = true;
          notFoundBatches.push(groups[g]);
        } else if (rg.outcome === 'stopped') {
          const left = groups.slice(g).reduce((n, group) => n + group.length, 0) + after;
          if (rg.why) warnings.push(`${rg.why}; ${left} due lot(s) left for the next run.`);
          watchDeferred += left;
          return;
        }
      }
    }
  };

  if (!ctx.known) {
    // No database state: lots closing within 24 hours, then a rotating slice.
    for (const a of [...plan.queue, ...itemLocated]) {
      const auctionId = int(a.id)!;
      if (!byId.has(auctionId)) continue;
      if (!(await fullRead(a))) complete = false;
    }
  } else {
    // With it (0055): lots about to close by id, where bids move fastest; then
    // sales in full, down to a reserve that keeps every other due known lot
    // watched within the hour; then those lots by id.
    const wp = planWatch([...byId.values()], ctx.known, now);
    await watchIds(wp.nearClose);
    const reserve: Reserve = {
      bytes: Math.min(wp.stale.length * BW_EST_BYTES_PER_ITEM, maxBytes * BW_WATCH.watchReserveShare),
      requests: Math.min(Math.ceil(wp.stale.length / BW_IDS_PER_REQUEST), Math.floor(maxRequests * BW_WATCH.watchReserveShare)),
    };
    for (const { auction } of wp.firstReads) await fullRead(auction, reserve);
    for (const { auction } of wp.agedReads) await fullRead(auction, reserve);
    await watchIds(wp.stale);
    // A batch naming a lot the platform no longer has: read its lots' sales in
    // full, which refreshes the rest and lets the run close the lot that is
    // gone (crawl_run_finish, per sale), so the next run's batches are clean.
    if (notFoundBatches.length) {
      const saleOf = new Map(ctx.known.lots.map((l) => [l.externalId, l.auctionExternalId]));
      const sales = new Set<string>();
      for (const batch of notFoundBatches) {
        for (const id of batch) {
          const sale = saleOf.get(id);
          if (sale && !readIds.has(id)) sales.add(sale);
        }
      }
      const toRead = [...sales]
        .map((id) => byId.get(Number(id)))
        .filter((a): a is BwRecord => a !== undefined && !auctionByExt.get(String(int(a.id)))?.itemsComplete);
      for (const auction of toRead) await fullRead(auction);
      const lotsInBatches = notFoundBatches.reduce((n, b) => n + b.length, 0);
      warnings.push(
        `Watch: ${notFoundBatches.length} id request(s) (${lotsInBatches} lots) named a lot the platform no longer has ` +
          `(HTTP 404 "Record not found!"); ${toRead.length} of their ${sales.size} sale(s) were read in full instead.`,
      );
    }
    // A complete snapshot still means every listed sale was read in full here.
    const unread = [...byId.values()].filter(
      (a) => (int(a.published_items_count) ?? int(a.items_count) ?? 0) > 0 && !auctionByExt.get(String(int(a.id)))?.itemsComplete,
    );
    if (unread.length) complete = false;
    if (watchDeferred) {
      warnings.push(`Watch: ${watchedLots} known lot(s) refreshed by id; ${watchDeferred} due lot(s) left for the next run.`);
    }
    if (watchMissing) {
      warnings.push(
        `Watch: ${watchMissing} known lot(s) were not returned by /api/items (withdrawn or unpublished); ` +
          'the next full read of their sale settles them.',
      );
    }
    ctx.log('info', 'BidWrangler watch', {
      firstReads: wp.firstReads.length,
      agedReads: wp.agedReads.length,
      nearClose: wp.nearClose.length,
      stale: wp.stale.length,
      watchedLots,
      watchDeferred,
      watchMissing,
    });
  }

  if (unknownStatuses.size) {
    // Only accepting_bids and pending were observed live. Anything else is kept
    // (closed is then decided by the clock) and reported so the vocabulary can
    // be pinned down from real runs instead of guessed.
    warnings.push(`Unrecognised item status value(s): ${[...unknownStatuses].slice(0, 8).join(', ')}.`);
  }
  if (counts.infoLots) warnings.push(`Skipped ${counts.infoLots} informational pseudo-lot(s) (e.g. "Payment Information").`);
  if (counts.unnamed) warnings.push(`Skipped ${counts.unnamed} item(s) without an id or name.`);
  if (counts.foreignItems) warnings.push(`Skipped ${counts.foreignItems} item(s) whose auction_id did not match the request.`);
  if (counts.outOfScopeItems) {
    warnings.push(`Skipped ${counts.outOfScopeItems} item(s) declaring a location outside ${scope.join('/')}.`);
  }
  if (counts.unplacedItems) {
    warnings.push(
      `Skipped ${counts.unplacedItems} item(s) of auctions without a state that declare no place of their own.`,
    );
  }
  if (skippedForBudget.length) {
    warnings.push(
      `Budget (${maxRequests} requests / ${maxBytes} bytes) left ${skippedForBudget.length} in-scope auction(s) ` +
        `for a later run: ${skippedForBudget.join(', ')}.`,
    );
  }

  ctx.log('info', 'BidWrangler ingest complete', {
    base,
    scope,
    listed: listed.length,
    inScope: plan.inScope.length,
    outOfScope: plan.outOfScope,
    lots: lots.length,
    requests: stats.httpRequests,
    bytes: stats.bytesIn,
  });

  return {
    auctions,
    lots,
    bids: [], // Only the high bid is published per item, not a history.
    stats,
    warnings,
    completeSnapshot: complete,
  };
}

export const bidwranglerAdapter: Adapter = {
  key: 'bidwrangler',
  method: 'internal_json',
  wantsKnownState: true,
  run: (ctx: AdapterContext) => runBidwrangler(ctx),
};
