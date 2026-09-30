// GENERATED from packages/ingest/src/adapters/irs-auctions.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * IRS Auctions adapter (irsauctions.gov). Platform key: 'irs-auctions'.
 *
 * The IRS sells property seized for unpaid federal taxes (Internal Revenue
 * Code sections 6331 and 6335), plus judicial and acquired-property sales, and
 * advertises each one on irsauctions.gov. The site is a US government work (17
 * U.S.C. 105) and its robots.txt is `User-agent: * / Allow: /`.
 *
 * VERIFIED 2026-09-30 through inspect_url (our crawler, Supabase egress):
 *
 *   /index.json   the site's own search index, declared in every page's head
 *                 (<link ... href=https://www.irsauctions.gov/index.json>):
 *                 521,712 bytes, a JSON array of cards, one per page:
 *                   {cardType, content, date, image, imageAlt, location,
 *                    minimumBid, section, title, url, weight}
 *                 Sale pages have url "/ad/{slug}/". A card holds the whole
 *                 site's history (cancelled, past and current sales alike), so
 *                 this adapter keeps only current ones: dated in the future,
 *                 and not cancelled, adjourned or redeemed.
 *     date        "Oct 28, 2026 12:00 PM": the sale's local time, no zone.
 *     location    "Pembroke NH, 03275" (city, state, ZIP), or "" on some cards.
 *     minimumBid  "81480.00", or "" (a 2016 Bentley had none).
 *     image       "/sites/default/files/2026-08/nh-treed-lot-view-91.jpg".
 *     content     the whole notice of sale: the property's address, where the
 *                 sale is held, the minimum bid, the IRS officer's name, phone
 *                 and email, and the taxpayer's name. Read only to place a card
 *                 whose `location` is empty; NEVER stored or shown. A row names
 *                 a place by city, state and ZIP, never a person.
 *
 * One card is one sale, and all but a few sell a single property (a house, a
 * lot, a vehicle), so each becomes a lot whose starting bid is the minimum bid
 * and whose close is the sale's date and time. Cards titled as GSA sales are
 * left out: GSA Auctions, crawled directly, lists those.
 *
 * One request an hour (plus robots.txt through the crawl gate).
 */

import type {
  Adapter,
  AdapterContext,
  AuctionFormat,
  IngestResult,
  NormalizedAuction,
  NormalizedImage,
  NormalizedLocation,
  NormalizedLot,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';
import { US_ZONES, zonedIso } from '../usTime.ts';

export const IRS_BASE = 'https://www.irsauctions.gov';
export const IRS_INDEX_PATH = '/index.json';

/** One card of index.json, as the site publishes it. */
export interface IrsCard {
  cardType?: string;
  content?: string;
  date?: string;
  image?: string;
  imageAlt?: string;
  location?: string;
  minimumBid?: string;
  section?: string;
  title?: string;
  url?: string;
  weight?: number;
}

export type IrsSaleKind = 'seized' | 'judicial' | 'acquired';

export type IrsSkip = 'not_a_sale' | 'cancelled' | 'gsa' | 'no_date' | 'past';

/** Why a card is not a current sale, before its time is read (see normalizeIrsIndex). */
export type IrsCardSkip = Exclude<IrsSkip, 'past'>;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Oct 28, 2026 12:00 PM" -> its parts; a date with no time reads as noon. */
export function parseIrsDate(s: string | null | undefined): { y: number; m: number; d: number; h: number; mi: number; timeGiven: boolean } | null {
  if (!s) return null;
  const m = s.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?)?$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  if (m[4] === undefined) return { y: year, m: month, d: day, h: 12, mi: 0, timeGiven: false };
  let hour = Number(m[4]) % 12;
  if (m[6].toLowerCase() === 'p') hour += 12;
  const minute = Number(m[5]);
  if (minute > 59) return null;
  return { y: year, m: month, d: day, h: hour, mi: minute, timeGiven: true };
}

/** "Pembroke NH, 03275" -> city, state, ZIP. Only a real US state code is accepted. */
export function parseIrsLocation(s: string | null | undefined): { city: string | null; state: string; postalCode: string | null } | null {
  if (!s) return null;
  const m = s.trim().match(/^(.*?)[\s,]+([A-Z]{2})(?:[\s,]+(\d{5})(?:-\d{4})?)?$/);
  if (!m || !US_ZONES[m[2]]) return null;
  const city = m[1].replace(/[\s,]+$/, '').trim();
  return { city: city || null, state: m[2], postalCode: m[3] ?? null };
}

// The notice's IRS contact block, which follows the property and the sale place.
const CONTACT = /Internal Revenue Service|Property Appraisal|Liquidation Specialist|\bIRS\b|@irs\.gov|\(\d{3}\)\s*\d{3}-\d{4}/i;

/**
 * State and ZIP of the property when the card's `location` is empty, read from
 * the notice: the first "ST 12345" after the title and before the minimum bid
 * (or, with no minimum bid, before the IRS contact block). The notice gives the
 * property's address first, then where the sale is held, then the officer's
 * office, so the first one is the property's.
 */
export function placeFromNotice(content: string | null | undefined, title: string, minimumBid: string | null): { state: string; postalCode: string } | null {
  if (!content) return null;
  let text = content;
  if (title && text.startsWith(title)) text = text.slice(title.length);
  let end = text.length;
  const bidAt = minimumBid ? text.indexOf(minimumBid) : -1;
  if (bidAt >= 0) end = bidAt;
  else {
    const c = text.search(CONTACT);
    if (c >= 0) end = c;
  }
  const region = text.slice(0, Math.min(end, 600));
  for (const m of region.matchAll(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/g)) {
    if (US_ZONES[m[1]]) return { state: m[1], postalCode: m[2] };
  }
  return null;
}

const CANCELLED = /\bcancel+ed\b|\bcanceceled\b|\badjourned\b|\bredeemed\b/i;
const STILL_ON = /\bnew sale date\b|\brescheduled\b/i;

/** Why a card is not a sale this adapter keeps, or null when it may be one. */
export function skipReason(card: IrsCard): IrsCardSkip | null {
  const url = card.url ?? '';
  if (!/^\/ad\/[^/]+\/?$/.test(url)) return 'not_a_sale';
  const title = card.title ?? '';
  if (CANCELLED.test(title) && !STILL_ON.test(title)) return 'cancelled';
  if (/\bGSA\b/.test(title)) return 'gsa';
  if (!parseIrsDate(card.date)) return 'no_date';
  return null;
}

// Pictographs, plus the variation selector (U+FE0F) and zero-width joiner
// (U+200D) that build emoji; written as code points so the source stays ASCII.
const PICTOGRAPHS = new RegExp(`\\p{Extended_Pictographic}|[${String.fromCharCode(0xfe0f, 0x200d)}]`, 'gu');

/** Decorative pictographs out: the fire emoji either side of "RARE RIVERFRONT!!!" go. */
export function cleanTitle(title: string): string {
  return title.replace(PICTOGRAPHS, '').replace(/\s+/g, ' ').trim();
}

export function saleKind(title: string): IrsSaleKind {
  if (/\bjudicial\b/i.test(title)) return 'judicial';
  if (/\bacquired\b/i.test(title)) return 'acquired';
  return 'seized';
}

const KIND_NOTE: Record<IrsSaleKind, string> = {
  seized:
    'IRS sale of seized property: the taxpayer\'s right, title and interest, as is and where is, subject to any prior liens. Read the notice of sale before bidding.',
  judicial: 'Judicial sale by court order, conducted by the IRS. Read the notice of sale for its terms before bidding.',
  acquired: 'Sale of property the government has acquired, conducted by the IRS. Read the notice of sale for its terms before bidding.',
};

const PREMIUM_NOTE =
  'The notice of sale gives the terms of payment; the government does not finance purchases (irsauctions.gov FAQ).';

function formatFrom(title: string, content: string): AuctionFormat {
  if (/\bsealed[- ]bid\b/i.test(title) || /\bsealed[- ]bid\b/i.test(content.slice(0, 2000))) return 'sealed_bid';
  if (/\bonline\b/i.test(title)) return 'online';
  return 'live';
}

function absolute(path: string | null | undefined, base: string): string | null {
  if (!path) return null;
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

export interface IrsNormalized {
  auction: NormalizedAuction;
  lot: NormalizedLot;
  placed: 'card' | 'notice' | 'none';
}

/** One sale card as an auction and its one lot. Pure. */
export function normalizeIrsCard(card: IrsCard, now: Date, base: string = IRS_BASE): IrsNormalized | null {
  const url = absolute(card.url, base);
  const d = parseIrsDate(card.date);
  const rawTitle = card.title?.trim() ?? '';
  const title = cleanTitle(rawTitle);
  if (!url || !d || !title) return null;
  const slug = (card.url ?? '').replace(/^\/ad\//, '').replace(/\/$/, '');

  const minimumBid = card.minimumBid?.trim() || null;
  let placed: IrsNormalized['placed'] = 'none';
  let pickup: NormalizedLocation | null = null;
  const fromCard = parseIrsLocation(card.location);
  if (fromCard) {
    placed = 'card';
    pickup = { line1: null, city: fromCard.city, state: fromCard.state, postalCode: fromCard.postalCode, ambiguous: false };
  } else {
    const fromNotice = placeFromNotice(card.content, rawTitle, minimumBid);
    if (fromNotice) {
      placed = 'notice';
      pickup = { line1: null, city: null, state: fromNotice.state, postalCode: fromNotice.postalCode, ambiguous: false };
    }
  }

  const zoneInfo = pickup?.state ? US_ZONES[pickup.state] : null;
  const zone = zoneInfo?.zone ?? 'America/New_York';
  const closesAt = zonedIso(d.y, d.m, d.d, d.h, d.mi, zone);
  const kind = saleKind(title);
  const image = absolute(card.image, base);
  const images: NormalizedImage[] = image ? [{ url: image, position: 0 }] : [];

  const meta = {
    source: 'irs-auctions',
    saleKind: kind,
    // The site gives the sale's local time with no zone; it is read in the
    // zone of the property's state. Exact only where that state keeps one zone.
    closeTimePrecise: d.timeGiven && !!zoneInfo?.exact,
    timezoneBasis: zoneInfo ? (zoneInfo.exact ? 'state' : 'state-primary') : 'default-eastern',
    dateText: card.date ?? null,
    locationSource: placed,
  };
  // Never the notice text: it names the taxpayer and the IRS officer.
  const raw = {
    url: card.url ?? null,
    title: rawTitle,
    date: card.date ?? null,
    location: card.location ?? null,
    minimumBid,
    image: card.image ?? null,
    _meta: meta,
  };

  const format = formatFrom(title, card.content ?? '');
  const auction: NormalizedAuction = {
    externalId: slug,
    title,
    description: KIND_NOTE[kind],
    auctioneer: 'Internal Revenue Service',
    url,
    format,
    startsAt: null,
    endsAt: closesAt,
    timezone: zone,
    pickup,
    pickupRequired: true,
    ships: false,
    sellerName: 'Internal Revenue Service',
    sellerState: null,
    lotCount: 1,
    currency: 'USD',
    buyerPremiumPct: null,
    buyerPremiumNote: PREMIUM_NOTE,
    termsUrl: `${base.replace(/\/+$/, '')}/notice-public-auction-sale/`,
    raw: { url: card.url ?? null, _meta: meta },
  };
  const lot: NormalizedLot = {
    externalId: slug,
    auctionExternalId: slug,
    lotNumber: null,
    title,
    description: KIND_NOTE[kind],
    quantity: 1,
    startingBidCents: minimumBid ? parseMoneyToCents(minimumBid) : null,
    currentBidCents: null,
    nextBidCents: null,
    bidCount: null,
    closesAt,
    closed: Date.parse(closesAt) <= now.getTime(),
    url,
    pickup,
    ships: false,
    images,
    raw,
  };
  return { auction, lot, placed };
}

/** A whole index.json body. Pure; exported for tests. */
export function normalizeIrsIndex(body: unknown, now: Date, base: string = IRS_BASE): {
  auctions: NormalizedAuction[];
  lots: NormalizedLot[];
  warnings: string[];
  counts: Record<IrsSkip | 'kept' | 'unplaced' | 'placedFromNotice' | 'malformed', number>;
} {
  const counts = { kept: 0, not_a_sale: 0, cancelled: 0, gsa: 0, no_date: 0, past: 0, unplaced: 0, placedFromNotice: 0, malformed: 0 };
  const warnings: string[] = [];
  if (!Array.isArray(body)) {
    return { auctions: [], lots: [], warnings: ['index.json is not an array of cards.'], counts };
  }
  const auctions = new Map<string, NormalizedAuction>();
  const lots = new Map<string, NormalizedLot>();
  for (const item of body) {
    if (!item || typeof item !== 'object') {
      counts.malformed++;
      continue;
    }
    const card = item as IrsCard;
    const skip = skipReason(card);
    if (skip) {
      counts[skip]++;
      continue;
    }
    const n = normalizeIrsCard(card, now, base);
    if (!n) {
      counts.malformed++;
      continue;
    }
    // A sale whose time has come is history, not a listing.
    if (n.lot.closed) {
      counts.past++;
      continue;
    }
    if (n.placed === 'none') counts.unplaced++;
    if (n.placed === 'notice') counts.placedFromNotice++;
    counts.kept++;
    auctions.set(n.auction.externalId, n.auction);
    lots.set(n.lot.externalId, n.lot);
  }
  if (counts.malformed) warnings.push(`${counts.malformed} sale card(s) could not be read (no title, link or date).`);
  if (counts.no_date) warnings.push(`${counts.no_date} sale card(s) give no sale date and were left out.`);
  if (counts.unplaced) warnings.push(`${counts.unplaced} current sale(s) name no state or ZIP; kept without a place.`);
  return { auctions: [...auctions.values()], lots: [...lots.values()], warnings, counts };
}

export async function runIrsAuctions(ctx: AdapterContext): Promise<IngestResult> {
  const base = (() => {
    try {
      return new URL(ctx.source.url).origin;
    } catch {
      return IRS_BASE;
    }
  })();
  const res = await ctx.fetch(`${base}${IRS_INDEX_PATH}`, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new Error(`IRS Auctions index.json: HTTP ${res.status}. Not retried.`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`IRS Auctions index.json: HTTP ${res.status}.`);
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new Error('IRS Auctions index.json is not valid JSON.');
  }
  const { auctions, lots, warnings, counts } = normalizeIrsIndex(body, ctx.now(), base);
  ctx.log('info', 'IRS Auctions ingest complete', counts);
  return {
    auctions,
    lots,
    bids: [],
    stats: { httpRequests: 1, bytesIn: res.text.length },
    warnings,
    // The index lists every page on the site, so a current sale missing from
    // it has been taken down; the drift guard in crawl_run_finish still applies.
    completeSnapshot: Array.isArray(body) && counts.malformed === 0,
  };
}

export const irsAuctionsAdapter: Adapter = {
  key: 'irs-auctions',
  method: 'internal_json',
  run: runIrsAuctions,
};
