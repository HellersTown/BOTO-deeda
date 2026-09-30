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
 *    zip, lat, lng}. Scope uses that field and nothing else. Auction names end
 *    in "- Ettrick, WI", and a Marenisco, MI consignment sale sits in the same
 *    list; the name is never parsed for a state.
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
 * 7. Weight: ~14 KB per item, almost all of it four signed CDN URLs per photo.
 *    A full Wisconsin refresh for Hansen is ~15 MB, so a run is budgeted (see
 *    planAuctions): lots closing within 24 hours always, then a rotating slice
 *    of the rest. A run is a complete snapshot only when it got everything.
 * 8. Politeness: the crawl worker's fetcher does not yet enforce
 *    sources.rate_limit_rpm, so run() spaces its own requests by
 *    60s / rate_limit_rpm (capped at 10 s). Drop that once the fetcher does.
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
  NormalizedAuction,
  NormalizedImage,
  NormalizedLocation,
  NormalizedLot,
  SourceConfig,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';

export type BwRecord = Record<string, unknown>;

/** Page size of /api/auctions, observed and confirmed by a third party. */
export const BW_AUCTIONS_PER_PAGE = 50;
/** Items per request. ~1.4 MB per page at the observed ~14 KB per item. */
export const BW_ITEMS_PER_PAGE = 100;
/** Used only to decide whether an auction fits in the remaining byte budget. */
export const BW_EST_BYTES_PER_ITEM = 15_000;
/** Images kept per lot, in source order. The deep link shows the rest. */
export const BW_MAX_IMAGES = 20;

export const BW_DEFAULTS = {
  maxRequests: 24,
  maxBytes: 8_000_000,
  maxListPages: 3,
  itemsPerPage: BW_ITEMS_PER_PAGE,
  /** An auction closing within this window is refreshed on every run. */
  urgentWindowMs: 24 * 3_600_000,
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
    .replace(/[ \t ]+/g, ' ')
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
    pickup: bwLocation(a.location),
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
]);

/**
 * An informational pseudo-lot ("#1A Payment Information"): a biddable row that
 * carries terms, not merchandise. Matched on the WHOLE name only, so "Pickup
 * Truck" and "Shipping Container" are real lots.
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
  return INFO_LOT_NAMES.has(n);
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
    // An item may declare its own location; otherwise the auction's applies.
    pickup: bwLocation(item.location) ?? bwLocation(ctx.auction?.location),
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

/**
 * Decide which auctions to fetch items for, and in what order.
 *
 * Open auctions in scope are split into URGENT (closing within urgentWindowMs,
 * soonest first) and the REST. The rest is rotated by the hour of `now`, so a
 * budget that cannot cover every auction still reaches each of them within a
 * few runs instead of starving the ones that close last. Stateless and
 * deterministic for a given `now`, which keeps it testable.
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
    const state = declaredState(obj(a.location)?.state);
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
  const offset = rest.length ? Math.floor(t / 3_600_000) % rest.length : 0;
  const rotated = [...rest.slice(offset), ...rest.slice(0, offset)];

  return { queue: [...urgent, ...rotated], inScope, outOfScope, undeclaredState, notOpen };
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
    const res = await get(auctionListUrl(base, page));
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
  if (plan.undeclaredState.length) {
    warnings.push(
      `Skipped ${plan.undeclaredState.length} open auction(s) with no declared state ` +
        `(ids ${plan.undeclaredState.slice(0, 5).map((a) => a.id).join(', ')}); state is never guessed from a name.`,
    );
  }

  const auctions: NormalizedAuction[] = [];
  const byId = new Map<number, BwRecord>();
  for (const a of plan.inScope) {
    const n = normalizeBwAuction(a, base);
    if (!n) {
      warnings.push(`Skipped an auction record without id or name.`);
      continue;
    }
    auctions.push(n);
    byId.set(int(a.id)!, a);
  }

  // 3. Items, in plan order, inside the request and byte budgets.
  const lots: NormalizedLot[] = [];
  const skippedForBudget: number[] = [];
  const unknownStatuses = new Set<string>();
  let infoLots = 0;
  let unnamed = 0;
  let foreignItems = 0;
  let outOfScopeItems = 0;

  let itemRequests = 0;
  for (const a of plan.queue) {
    const auctionId = int(a.id)!;
    if (!byId.has(auctionId)) continue;
    const expected = int(a.published_items_count) ?? int(a.items_count) ?? 0;
    const pagesNeeded = Math.max(1, Math.ceil(expected / perPage));
    // The first auction in the queue is always attempted, so a run whose
    // budget is too small for everything still makes progress on the most
    // urgent sale instead of fetching nothing.
    if (
      itemRequests > 0 &&
      (stats.bytesIn + expected * BW_EST_BYTES_PER_ITEM > maxBytes ||
        stats.httpRequests + pagesNeeded > maxRequests)
    ) {
      skippedForBudget.push(auctionId);
      complete = false;
      continue;
    }

    let gotAll = false;
    let seen = 0;
    let total: number | null = null;
    for (let page = 1; page <= pagesNeeded + 1; page++) {
      if (stats.httpRequests >= maxRequests) break;
      itemRequests++;
      const res = await get(itemsUrl(base, auctionId, page, perPage));
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
      for (const item of parsed.records) {
        if (int(item.auction_id) !== null && int(item.auction_id) !== auctionId) {
          foreignItems++;
          continue;
        }
        if (isInformationalLot(item)) {
          infoLots++;
          continue;
        }
        const ownState = declaredState(obj(item.location)?.state);
        if (ownState && !scope.includes(ownState)) {
          outOfScopeItems++;
          continue;
        }
        const lot = normalizeBwItem(item, { base, now, auction: a });
        if (!lot) {
          unnamed++;
          continue;
        }
        const status = str(item.status);
        if (status && !OPEN_ITEM_STATUSES.has(status) && !CLOSED_ITEM_STATUSES.has(status)) {
          unknownStatuses.add(status);
        }
        lots.push(lot);
      }
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
    if (!gotAll) complete = false;
  }

  if (unknownStatuses.size) {
    // Only accepting_bids and pending were observed live. Anything else is kept
    // (closed is then decided by the clock) and reported so the vocabulary can
    // be pinned down from real runs instead of guessed.
    warnings.push(`Unrecognised item status value(s): ${[...unknownStatuses].slice(0, 8).join(', ')}.`);
  }
  if (infoLots) warnings.push(`Skipped ${infoLots} informational pseudo-lot(s) (e.g. "Payment Information").`);
  if (unnamed) warnings.push(`Skipped ${unnamed} item(s) without an id or name.`);
  if (foreignItems) warnings.push(`Skipped ${foreignItems} item(s) whose auction_id did not match the request.`);
  if (outOfScopeItems) warnings.push(`Skipped ${outOfScopeItems} item(s) declaring a location outside ${scope.join('/')}.`);
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
  run: (ctx: AdapterContext) => runBidwrangler(ctx),
};
