/**
 * Public Surplus adapter: school districts, counties, cities, technical colleges
 * and state agencies selling surplus on www.publicsurplus.com. Rung 5 (HTML), but
 * built on markup that carries machine-precise values: every close time on the
 * site is embedded as epoch milliseconds, so no wall-clock text is ever guessed at.
 *
 * VERIFIED SHAPES (captured live 2026-09-30 as WaystockBot; fixtures in
 * test/fixtures/public-surplus-*-2026-09-30.html):
 *
 *   /sms/all,{st}/browse/search?posting=y&endHours=-1&startHours=-1&page={n}
 *       A state's whole live catalogue, 25 auctions per page, 0-indexed `page`.
 *       Wisconsin had 99 live auctions on 4 pages. Each auction is rendered twice
 *       (grid card "NNNsearchGrid" and table row "NNNsearchList"). A row carries
 *       the full title, the state, the current price, a thumbnail, and
 *         updateTimeLeftSpan(timeLeftInfoMap, ID, "IDsearchList", NOW_MS, END_MS, ...)
 *       i.e. the server clock and the exact close instant in epoch ms.
 *       Pagination is JavaScript (srchPage('n')) that sets the form's hidden `page`
 *       input, so the next page is a plain GET. On the last page "Next" is rendered
 *       as a disabled span with no srchPage call.
 *
 *   /sms/all,{st}/auction/view?auc={id}
 *       One auction: the selling agency (sellerName), pick-up address, # of bids,
 *       current price, increment, minimum bid, quantity (Dutch auctions), all
 *       pictures, description, and the agency's disclaimer, which is where the
 *       buyer's premium is stated ("A Buyers Premium of 8% will be added ...").
 *
 * robots.txt disallows only /images/; nothing above is under it.
 *
 * TIME ZONES. Pages state times in the SITE'S zone for anonymous visitors, which is
 * Mountain ("Oct 1, 2026 07:00 PM MDT"), not the seller's. The epoch in the page's
 * own script is used first; the stated text is parsed with an explicit
 * abbreviation->offset table only as a fallback and cross-check. The auction's IANA
 * zone is the zone of the pickup state when that state lies in one zone (all of
 * Wisconsin is America/Chicago); the zone the site displayed is kept in raw._meta.
 *
 * WHY ENRICHMENT IS BUDGETED AND ORDERED BY AUCTION ID. The listing pages are cheap
 * (4 requests for all of Wisconsin) and give a COMPLETE snapshot every run. The
 * detail pages (seller, pickup address, bid count, premium, photos) cost one
 * request each, ~80 KB; a background run of the crawl worker (about 4 minutes at
 * the registry's pace) reads about a hundred of them. ingest_batch overwrites
 * every column on each upsert, so a lot that is enriched in one run and not in the
 * next would flap (bid count, description and photo count all feed
 * lots.updated_at, which re-fires hunt alerts). So the set of lots planned for
 * enrichment is a FIXED quota of the LOWEST auction ids, never sized by the time
 * a particular run happens to have: ids are sequential, new listings get higher
 * ids, so a lot enters the set once and stays until it closes. A planned detail
 * fetch that fails, or that the run has no time left for, is not emitted at all
 * (its stored row is kept) and the run is then not a complete snapshot, so
 * nothing is closed by mistake.
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  NormalizedAuction,
  NormalizedImage,
  NormalizedLocation,
  NormalizedLot,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';
import { isBudgetRefusal } from '../gate.ts';

export const PUBLIC_SURPLUS_ORIGIN = 'https://www.publicsurplus.com';

// ---------------------------------------------------------------- text helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', laquo: '«', raquo: '»', deg: '°', frac12: '½', frac14: '¼',
  frac34: '¾', times: '×', reg: '®', copy: '©', trade: '™', bull: '•',
};

/** Decode the HTML entities that appear in real titles and descriptions. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Collapse all whitespace runs (tabs and newlines included) to single spaces. */
export function squish(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** HTML fragment -> readable plain text with paragraph breaks kept. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/(p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      // Inline formatting must not add spaces: "<strong>AS IS</strong>." is "AS IS."
      .replace(/<\/?(strong|b|i|em|u|span|a|font|sup|sub|small|big|mark|abbr)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function textOf(fragment: string | null | undefined): string | null {
  if (!fragment) return null;
  const t = squish(decodeEntities(fragment.replace(/<[^>]+>/g, ' ')));
  return t === '' ? null : t;
}

function absolutize(href: string, origin: string): string | null {
  try {
    return new URL(decodeEntities(href), origin).toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- time zones

/**
 * US zone abbreviations -> UTC offset in minutes. Only abbreviations with ONE
 * meaning in a US context are listed; anything else is refused, never guessed.
 */
export const ZONE_OFFSETS_MIN: Record<string, number> = {
  UTC: 0, GMT: 0,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
  AKST: -540, AKDT: -480,
  HST: -600,
};

/** The IANA zone a US zone abbreviation belongs to (for raw provenance only). */
export const ZONE_IANA: Record<string, string> = {
  EST: 'America/New_York', EDT: 'America/New_York',
  CST: 'America/Chicago', CDT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver',
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
};

/**
 * States (and territories) that lie entirely in ONE time zone. A state that spans
 * zones (TX, FL, MI, IN, KY, TN, KS, NE, ND, SD, ID, OR, NV, AK) is deliberately
 * absent: its zone cannot be read off the state code.
 */
export const SINGLE_ZONE_STATES: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York',
  GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', NH: 'America/New_York', NJ: 'America/New_York',
  NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago',
  IA: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago',
  MS: 'America/Chicago', MO: 'America/Chicago', OK: 'America/Chicago',
  WI: 'America/Chicago',
  CO: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver',
  UT: 'America/Denver', WY: 'America/Denver', AZ: 'America/Phoenix',
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', HI: 'Pacific/Honolulu',
  PR: 'America/Puerto_Rico', GU: 'Pacific/Guam', VI: 'America/St_Thomas',
};

export function stateTimezone(state: string | null | undefined): string | null {
  if (!state) return null;
  return SINGLE_ZONE_STATES[state.toUpperCase()] ?? null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/**
 * Parse Public Surplus's stated time, e.g. "Oct 1, 2026 07:00 PM MDT".
 * Returns null for anything without a known zone abbreviation: a wall-clock time
 * with no zone is exactly the ambiguity the ISO+offset rule exists to prevent.
 */
export function parseStatedTime(text: string | null | undefined): { iso: string; zone: string } | null {
  if (!text) return null;
  const m = squish(text).match(
    /^([A-Za-z]{3,4})\.?\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?\s+([A-Z]{2,4})\b/,
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const zone = m[7];
  const offset = ZONE_OFFSETS_MIN[zone];
  if (!month || offset === undefined) return null;
  if (day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;
  if (year < 2000 || year > 2100) return null;
  if (m[6].toLowerCase() === 'p' && hour !== 12) hour += 12;
  if (m[6].toLowerCase() === 'a' && hour === 12) hour = 0;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - offset * 60_000;
  const d = new Date(utcMs);
  if (d.getUTCDate() !== new Date(Date.UTC(year, month - 1, day)).getUTCDate() && offset === 0) return null;
  return { iso: d.toISOString(), zone };
}

/** Epoch milliseconds -> ISO, refusing values that cannot be a real close time. */
export function epochMsToIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || y < 2000 || y > 2100) return null;
  return d.toISOString();
}

// ---------------------------------------------------------------------- URLs

export function regionCode(state: string): string {
  return `all,${state.toLowerCase()}`;
}

export function searchUrl(origin: string, state: string, page: number): string {
  return `${origin}/sms/${regionCode(state)}/browse/search?posting=y&endHours=-1&startHours=-1&page=${page}`;
}

export function auctionUrl(origin: string, state: string, id: string): string {
  return `${origin}/sms/${regionCode(state)}/auction/view?auc=${id}`;
}

// ------------------------------------------------------------ listing pages

export interface PsListing {
  id: string;
  title: string;
  url: string;
  priceCents: number | null;
  priceText: string | null;
  endsAtMs: number | null;
  serverNowMs: number | null;
  /** The two-letter state the listing itself displays for this auction. */
  state: string | null;
  imageUrl: string | null;
  dutch: boolean;
  newlyListed: boolean;
  source: 'table' | 'grid';
}

export interface PsPagination {
  /** 0-based index of the page this HTML is, from the <strong> marker. */
  current: number | null;
  /** 0-based index "Next" points at, or null when Next is disabled/absent. */
  next: number | null;
  /** Highest 0-based page index linked from the pagination block. */
  last: number | null;
}

/**
 * Arguments of an updateTimeLeftSpan(...) call: auction id, the server clock and
 * the close instant, both epoch ms. The call has a third number that is NOT the
 * start time (on auction 4089922 it decodes to Sep 29 04:30Z while the page says
 * "Auction Started Sep 18, 2026 10:47 AM MDT"), so it is deliberately not read.
 */
function timeLeftArgs(fragment: string, domId?: string): { id: string; nowMs: number; endMs: number } | null {
  const re = /updateTimeLeftSpan\(\s*timeLeftInfoMap\s*,\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*(\d+)\s*,\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    if (domId !== undefined && m[2] !== domId) continue;
    return { id: m[1], nowMs: Number(m[3]), endMs: Number(m[4]) };
  }
  return null;
}

function indexFrom(haystack: string, needle: string, from: number): number {
  const i = haystack.indexOf(needle, from);
  return i < 0 ? haystack.length : i;
}

function firstDocviewerImage(fragment: string, origin: string): string | null {
  const re = /<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    if (/\/docviewer\//.test(m[1])) return absolutize(m[1], origin);
  }
  return null;
}

function listingFlags(fragment: string): { dutch: boolean; newlyListed: boolean } {
  return {
    dutch: /title="Dutch Auction"|\/dutch\.gif/i.test(fragment),
    newlyListed: /Newly Listed Item/i.test(fragment),
  };
}

function parseTableRow(id: string, row: string, origin: string): PsListing | null {
  const link = row.match(/<a\b[^>]*\bhref\s*=\s*"([^"]*auction\/view\?auc=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  const title = link ? textOf(link[2]) : null;
  if (!link || !title) return null;
  const url = absolutize(link[1], origin);
  if (!url) return null;
  const priceCell = row.match(new RegExp(`id\\s*=\\s*"val_${id}searchList"[^>]*>([\\s\\S]*?)</td>`, 'i'));
  const priceText = priceCell ? textOf(priceCell[1]) : null;
  const stateCell = row.match(/<td\b[^>]*>\s*([A-Z]{2})\s*<\/td>/);
  const t = timeLeftArgs(row, `${id}searchList`) ?? timeLeftArgs(row);
  return {
    id,
    title,
    url,
    priceText,
    priceCents: parseMoneyToCents(priceText),
    endsAtMs: t && t.endMs > 0 ? t.endMs : null,
    serverNowMs: t && t.nowMs > 0 ? t.nowMs : null,
    state: stateCell ? stateCell[1] : null,
    imageUrl: firstDocviewerImage(row, origin),
    ...listingFlags(row),
    source: 'table',
  };
}

function parseGridCard(id: string, card: string, origin: string): PsListing | null {
  // The visible card title is truncated ("... Skid Steer wi..."); the title
  // attribute carries the whole thing, prefixed with "#ID - ".
  const titled = card.match(/<a\b[^>]*\bhref\s*=\s*"([^"]*auction\/view\?auc=\d+[^"]*)"[^>]*\btitle\s*=\s*"([^"]*)"/i);
  const rawTitle = titled ? squish(decodeEntities(titled[2])) : null;
  const title = rawTitle ? rawTitle.replace(new RegExp(`^#${id}\\s*-\\s*`), '').trim() : null;
  if (!titled || !title) return null;
  const url = absolutize(titled[1], origin);
  if (!url) return null;
  const price = card.match(new RegExp(`id\\s*=\\s*"val_${id}searchGrid"[^>]*>([\\s\\S]*?)</b>`, 'i'));
  const priceText = price ? textOf(price[1]) : null;
  const state = card.match(/class\s*=\s*"auction-item-state"[^>]*>\s*([A-Z]{2})\s*</);
  const t = timeLeftArgs(card, `${id}searchGrid`) ?? timeLeftArgs(card);
  return {
    id,
    title,
    url,
    priceText,
    priceCents: parseMoneyToCents(priceText),
    endsAtMs: t && t.endMs > 0 ? t.endMs : null,
    serverNowMs: t && t.nowMs > 0 ? t.nowMs : null,
    state: state ? state[1] : null,
    imageUrl: firstDocviewerImage(card, origin),
    ...listingFlags(card),
    source: 'grid',
  };
}

export function parsePagination(html: string): PsPagination {
  const block = html.match(/class\s*=\s*"ajax-loading-pagination"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (!block) return { current: null, next: null, last: null };
  const b = block[1];
  const strong = b.match(/<strong\b[^>]*>\s*(\d+)\s*<\/strong>/i);
  const current = strong ? Number(strong[1]) - 1 : null;
  const indices = [...b.matchAll(/srchPage\('(\d+)'\)/g)].map((m) => Number(m[1]));
  const nextM = b.match(/srchPage\('(\d+)'\);?"\s*>\s*Next/i);
  const next = nextM ? Number(nextM[1]) : null;
  const all = current === null ? indices : [...indices, current];
  return { current, next, last: all.length ? Math.max(...all) : null };
}

export interface PsSearchPage {
  listings: PsListing[];
  pagination: PsPagination;
  /** True when the page positively says "No auctions found" (not merely empty). */
  noResults: boolean;
  /** The server clock embedded in the page's scripts, if any. */
  serverNowMs: number | null;
  warnings: string[];
}

/**
 * Parse one search results page. Table rows are preferred (full titles); grid
 * cards fill in any auction that has no row, which is what keeps the adapter
 * working if the site ever serves only one of its two views.
 */
export function parseSearchPage(html: string, origin: string = PUBLIC_SURPLUS_ORIGIN): PsSearchPage {
  const warnings: string[] = [];
  const byId = new Map<string, PsListing>();
  let rowsSeen = 0;
  let cardsSeen = 0;
  let unparsed = 0;

  const rowRe = /<tr\b[^>]*\bid\s*=\s*"(\d+)searchList"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    rowsSeen++;
    const parsed = parseTableRow(m[1], m[2], origin);
    if (parsed) byId.set(parsed.id, parsed);
    else unparsed++;
  }

  const cardStarts = [...html.matchAll(/<div\b[^>]*\bclass\s*=\s*"auction-item"[^>]*\bid\s*=\s*"(\d+)searchGrid"[^>]*>/gi)];
  for (let i = 0; i < cardStarts.length; i++) {
    cardsSeen++;
    const start = cardStarts[i].index!;
    // A card ends at the next card, or at the end of the grid section: the last
    // card must not run on into the table rows (which carry other auctions' icons).
    const bounds = [
      i + 1 < cardStarts.length ? cardStarts[i + 1].index! : html.length,
      indexFrom(html, '</section>', start),
      indexFrom(html, 'searchList"', start),
      start + 12_000,
    ];
    const end = Math.min(...bounds);
    const id = cardStarts[i][1];
    if (byId.has(id)) continue;
    const parsed = parseGridCard(id, html.slice(start, end), origin);
    if (parsed) byId.set(id, parsed);
    else unparsed++;
  }

  if (unparsed > 0) {
    warnings.push(`Public Surplus: ${unparsed} of ${rowsSeen + cardsSeen} listing blocks had no parseable title/link and were skipped.`);
  }

  const listings = [...byId.values()];
  for (const l of listings) {
    if (l.endsAtMs === null) warnings.push(`Public Surplus: auction ${l.id} has no close time in the listing.`);
  }

  const noFound = html.match(/<div\b[^>]*\bclass\s*=\s*"([^"]*)"[^>]*\bid\s*=\s*"noAuctionsFound"/i);
  const noResults = !!noFound && !/\bd-none\b/.test(noFound[1]);
  const anyTime = timeLeftArgs(html);

  return {
    listings,
    pagination: parsePagination(html),
    noResults,
    serverNowMs: anyTime ? anyTime.nowMs : null,
    warnings,
  };
}

// -------------------------------------------------------------- detail page

export interface PsDetail {
  id: string;
  title: string | null;
  agencyName: string | null;
  agencyOrgId: string | null;
  agencyHome: string | null;
  termsUrl: string | null;
  startsAtIso: string | null;
  endsAtIso: string | null;
  serverNowMs: number | null;
  /** The zone abbreviation the page stated its times in ("MDT"). */
  statedZone: string | null;
  startedText: string | null;
  endsText: string | null;
  mightExtend: boolean;
  pickupName: string | null;
  pickup: NormalizedLocation | null;
  region: string | null;
  bidCount: number | null;
  currentPriceCents: number | null;
  incrementCents: number | null;
  minBidCents: number | null;
  quantity: number | null;
  currency: string | null;
  bidDeposit: string | null;
  shipping: string | null;
  condition: string | null;
  description: string | null;
  images: string[];
  attachments: string[];
  disclaimer: string | null;
  buyerPremiumPct: number | null;
  buyerPremiumNote: string | null;
}

/** Text of the first element that follows a label element containing `label`. */
function valueAfterLabel(html: string, label: RegExp): string | null {
  const m = html.match(new RegExp(`${label.source}\\s*:?\\s*</div>\\s*<div\\b[^>]*>([\\s\\S]*?)<`, 'i'));
  return m ? textOf(m[1]) : null;
}

/**
 * Pull a buyer's premium out of free text.
 *
 * Real disclaimers run sentences together with no space ("...making payment.Buyers
 * Premium: A Buyers Premium of 10% will be added") and sit next to sales-tax rates
 * ("a sales tax of 5.5%"), so the percentage must be tied to the words "buyer's
 * premium" themselves, never taken as "the first % in the paragraph".
 */
export function parseBuyerPremium(text: string | null | undefined): { pct: number; note: string } | null {
  if (!text) return null;
  const t = squish(text);
  if (/\bno\s+buyer'?s?'?\s+premium\b/i.test(t)) {
    const i = t.search(/\bno\s+buyer'?s?'?\s+premium\b/i);
    return { pct: 0, note: sentenceAround(t, i) };
  }
  const after = /buyer'?s?'?\s+premium\b[^%.]{0,60}?(\d{1,2}(?:\.\d{1,2})?)\s*%/i.exec(t);
  const before = /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:\(\s*)?buyer'?s?'?\s+premium\b/i.exec(t);
  const hit = after && before ? (after.index <= before.index ? after : before) : after ?? before;
  if (!hit) return null;
  const pct = Number(hit[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 50) return null;
  return { pct, note: sentenceAround(t, hit.index) };
}

function sentenceAround(t: string, index: number): string {
  // Sentences here can lack the space after the period, so split on a period
  // followed by a capital letter or space, but not inside "$1.00" or "5.5%".
  const startCut = Math.max(0, t.lastIndexOf('.', index - 1));
  let start = startCut === 0 ? 0 : startCut + 1;
  while (start < index && /\d/.test(t[start - 2] ?? '') && /\d/.test(t[start] ?? '')) start = index;
  const endRe = /\.(?=\s|[A-Z]|$)/g;
  endRe.lastIndex = index;
  const endM = endRe.exec(t);
  const end = endM ? endM.index + 1 : Math.min(t.length, index + 240);
  return t.slice(start, end).trim().slice(0, 300);
}

/** Parse "1535 Mt Vernon Ave / Milwaukee, WI 53233" from the print-address block. */
export function parsePickupAddress(block: string): NormalizedLocation | null {
  const lines = [...block.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((m) => textOf(m[1]))
    .filter((s): s is string => !!s);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const csz = last.match(/^(.*?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
  if (!csz) {
    return { line1: lines.join(', '), city: null, state: null, postalCode: null, ambiguous: false };
  }
  const city = csz[1].replace(/,\s*$/, '').trim() || null;
  return {
    line1: lines.slice(0, -1).join(', ') || null,
    city,
    state: csz[2],
    postalCode: csz[3],
    ambiguous: false,
  };
}

/**
 * Parse one auction page. Returns null (with a warning) when the page is not an
 * auction page for `expectedId`: an error page parsed as an auction would put a
 * wrong price on a real lot.
 */
export function parseDetailPage(
  html: string,
  origin: string = PUBLIC_SURPLUS_ORIGIN,
  expectedId?: string,
): { detail: PsDetail | null; warnings: string[] } {
  const warnings: string[] = [];
  const titleSpan = html.match(/<span\b[^>]*class\s*=\s*"text-wrap"[^>]*>\s*Auction\s*#(\d+)\s*-\s*([\s\S]*?)<\/span>/i);
  const time = timeLeftArgs(html, expectedId);
  const bidForm = html.match(/<input\b[^>]*name\s*=\s*"auc"[^>]*value\s*=\s*"(\d+)"/i);
  const id = titleSpan?.[1] ?? time?.id ?? bidForm?.[1] ?? null;

  if (!id) {
    return { detail: null, warnings: ['Public Surplus: detail page has no auction number; not an auction page.'] };
  }
  if (expectedId && id !== expectedId) {
    return { detail: null, warnings: [`Public Surplus: asked for auction ${expectedId}, page is auction ${id}.`] };
  }

  const title = titleSpan ? textOf(titleSpan[2]) : null;
  if (!title) warnings.push(`Public Surplus: auction ${id} page has no title.`);

  const agencyPrint = html.match(/class\s*=\s*"auction-print-agency[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const logoAlt = html.match(/docviewer\/logo\/\d+\/\d+"\s*alt\s*=\s*"([^"]*)"/i);
  const viewLink = html.match(/list\/current\?orgid=(\d+)"[^>]*>([\s\S]*?)<\/a>/i);
  const viewName = viewLink ? textOf(viewLink[2])?.replace(/^\[?\s*View\s+/i, '').replace(/\s+Auctions\s*\]?$/i, '') ?? null : null;
  const agencyName = textOf(agencyPrint?.[1]) ?? (logoAlt ? squish(decodeEntities(logoAlt[1])) || null : null) ?? viewName;
  if (!agencyName) warnings.push(`Public Surplus: auction ${id} page names no selling agency.`);
  const home = html.match(/href\s*=\s*"(\/sms\/[a-z0-9-]+,[a-z]{2}\/browse\/home)"/i);
  const terms = html.match(/'(\/sms\/[^']*docviewer\/aucterms\?auc=\d+)'/i);

  const startedText = valueAfterLabel(html, /Auction Started/);
  const endsText = valueAfterLabel(html, /Auction Ends/);
  const started = parseStatedTime(startedText);
  const ends = parseStatedTime(endsText);
  const epochEnd = time && time.endMs > 0 ? epochMsToIso(time.endMs) : null;
  const endsAtIso = epochEnd ?? ends?.iso ?? null;
  if (epochEnd && ends && Math.abs(Date.parse(epochEnd) - Date.parse(ends.iso)) > 60_000) {
    warnings.push(`Public Surplus: auction ${id} stated end "${endsText}" disagrees with its script (${epochEnd}); using the script.`);
  }
  if (!endsAtIso) warnings.push(`Public Surplus: auction ${id} page has no parseable close time.`);

  // Pick-up: the print-address block is structured one field per line.
  const pickupSection = html.match(/Pick-up Location\s*<\/div>([\s\S]*?)(?:Auction Contact|<!-- RIGHT INFO -->)/i);
  let pickup: NormalizedLocation | null = null;
  let pickupName: string | null = null;
  if (pickupSection) {
    const nameM = pickupSection[1].match(/^\s*<div\b[^>]*>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i);
    pickupName = nameM ? textOf(nameM[1]) : null;
    const printAddr = pickupSection[1].match(/class\s*=\s*"auction-print-address[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (printAddr) pickup = parsePickupAddress(printAddr[1] + '</div>');
    if (!pickup || !pickup.state) {
      // Fallback: the map button's "[street city, ST 12345]". Street and city are
      // not separable there, so only the declared state and ZIP are taken.
      const btn = textOf(pickupSection[1].match(/mapit\?auc=\d+[^>]*>([\s\S]*?)<\/button>/i)?.[1]);
      const sz = btn?.match(/,\s*([A-Z]{2})\s+(\d{5})/);
      if (sz) pickup = { line1: null, city: null, state: sz[1], postalCode: sz[2], ambiguous: false };
    }
  }
  if (!pickup) warnings.push(`Public Surplus: auction ${id} page has no parseable pick-up location.`);

  const region = html.match(/Region:\s*<\/div>\s*<div\b[^>]*>\s*<strong>\s*([A-Z]{2})\s*<\/strong>/i)?.[1] ?? null;
  const bidsM = html.match(/id\s*=\s*"noOfBids"[^>]*>\s*(\d+)\s*</i);
  const priceM = html.match(new RegExp(`id\\s*=\\s*"val_${id}"[^>]*>([\\s\\S]*?)<`, 'i'));
  const incM = html.match(new RegExp(`id\\s*=\\s*"valIncrement_${id}"[^>]*>([\\s\\S]*?)<`, 'i'));
  const minM = html.match(new RegExp(`id\\s*=\\s*"minBid_${id}"[^>]*>([\\s\\S]*?)<`, 'i'));
  if (!bidsM) warnings.push(`Public Surplus: auction ${id} page has no "# of Bids".`);

  // Quantity: Dutch auctions show "<!-- QTY --> ... Quantity</div><div>3 <button>"
  // and price per unit ("Your proxy bid: $ ... EACH"). Single-item auctions have
  // an empty QTY section.
  const qtyM = html.match(/<!--\s*QTY\s*-->\s*<div\b[^>]*>\s*Quantity\s*<\/div>\s*<div\b[^>]*>\s*(\d+)\b/i);

  const currency = html.match(/Currency:\s*<\/div>\s*<div\b[^>]*>\s*([A-Z]{3})\b/i)?.[1] ?? null;
  const bidDeposit = valueAfterLabel(html, /Bid Deposit/);
  const shipping = html.match(/<div class="auctitle">\s*Shipping\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i);
  const condition = html.match(/Condition:\s*<\/span>\s*<span\b[^>]*>([\s\S]*?)<\/span>/i);

  // Description: the rich-text div inside the DESCR BOX, up to the documents.
  let description: string | null = null;
  const descrStart = html.search(/<!--\s*DESCR BOX\s*-->/i);
  if (descrStart >= 0) {
    const rest = html.slice(descrStart);
    const stop = rest.search(/<!--\s*DOCUMENTS\s*-->|class\s*=\s*"auction-print-images|<section class="disclaimer"/i);
    const box = stop >= 0 ? rest.slice(0, stop) : rest.slice(0, 60_000);
    const rich = box.search(/overflow-wrap:\s*anywhere/i);
    if (rich >= 0) description = htmlToText(box.slice(box.indexOf('>', rich) + 1)) || null;
  }

  const imagesBlock = html.match(/class\s*=\s*"auction-print-images[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] ?? '';
  const images = uniq(
    [...imagesBlock.matchAll(/<img\b[^>]*?\bsrc\s*=\s*"([^"]+)"/gi)]
      .map((m) => absolutize(m[1], origin))
      .filter((u): u is string => !!u && /\/docviewer\//.test(u)),
  );
  const attachments = uniq(
    [...html.matchAll(/href\s*=\s*"(\/sms\/docviewer\/aucdoc\/[^"]+)"/gi)]
      .map((m) => absolutize(m[1], origin))
      .filter((u): u is string => !!u),
  );

  const disclaimerM = html.match(/<section class="disclaimer">([\s\S]*?)<\/section>/i);
  const disclaimer = disclaimerM ? htmlToText(disclaimerM[1]).replace(/^Disclaimer\s*/i, '') || null : null;
  const premium = parseBuyerPremium(disclaimer) ?? parseBuyerPremium(description);

  return {
    detail: {
      id,
      title,
      agencyName,
      agencyOrgId: viewLink?.[1] ?? null,
      agencyHome: home ? absolutize(home[1], origin) : null,
      termsUrl: terms ? absolutize(terms[1], origin) : null,
      startsAtIso: started?.iso ?? null,
      endsAtIso,
      serverNowMs: time && time.nowMs > 0 ? time.nowMs : null,
      statedZone: ends?.zone ?? started?.zone ?? null,
      startedText,
      endsText,
      mightExtend: /This auction might extend/i.test(html),
      pickupName,
      pickup,
      region,
      bidCount: bidsM ? Number(bidsM[1]) : null,
      currentPriceCents: priceM ? parseMoneyToCents(textOf(priceM[1])) : null,
      incrementCents: incM ? parseMoneyToCents(textOf(incM[1])) : null,
      minBidCents: minM ? parseMoneyToCents(textOf(minM[1])) : null,
      quantity: qtyM ? Number(qtyM[1]) : null,
      currency,
      bidDeposit,
      shipping: shipping ? textOf(shipping[1]) : null,
      condition: condition ? textOf(condition[1]) : null,
      description,
      images,
      attachments,
      disclaimer,
      buyerPremiumPct: premium?.pct ?? null,
      buyerPremiumNote: premium?.note ?? null,
    },
    warnings,
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------- normalize

/**
 * Listing (+ optional detail) -> one auction and its one lot. A Public Surplus
 * "auction" is a single item with its own close, so the mapping is 1:1 and both
 * share the auction number as their external id.
 */
export function normalizePublicSurplus(
  listing: PsListing,
  detail: PsDetail | null,
): { auction: NormalizedAuction; lot: NormalizedLot } {
  const id = listing.id;
  const title = listing.title || detail?.title || `Public Surplus auction ${id}`;

  // Close: the listing's epoch, unless the detail page (fetched later in the same
  // run) shows a later close, which means a soft-close extension happened.
  const listEnd = epochMsToIso(listing.endsAtMs);
  let closesAt = listEnd ?? detail?.endsAtIso ?? null;
  if (listEnd && detail?.endsAtIso && Date.parse(detail.endsAtIso) > Date.parse(listEnd)) closesAt = detail.endsAtIso;
  const nowMs = detail?.serverNowMs ?? listing.serverNowMs;
  const closed = closesAt !== null && nowMs !== null ? Date.parse(closesAt) <= nowMs : false;

  // Pickup: the detail page's address is authoritative. Without it, the state the
  // listing itself displays is the only declared location; the city stays unknown.
  let pickup: NormalizedLocation | null = null;
  let pickupStateSource: 'pickup-address' | 'listing-state' | null = null;
  if (detail?.pickup) {
    pickup = detail.pickup;
    pickupStateSource = detail.pickup.state ? 'pickup-address' : null;
  } else if (listing.state) {
    pickup = { line1: null, city: null, state: listing.state, postalCode: null, ambiguous: false };
    pickupStateSource = 'listing-state';
  }
  const sellerState = detail?.region ?? listing.state ?? null;
  const timezone = stateTimezone(pickup?.state ?? sellerState) ?? (detail?.statedZone ? ZONE_IANA[detail.statedZone] ?? null : null);

  // Money. The site's "Current Price" is the opening price until someone bids.
  // Only a known bid count separates the two: 0 bids -> starting price, no bid.
  const price = detail?.currentPriceCents ?? listing.priceCents;
  let currentBidCents: number | null = price;
  let startingBidCents: number | null = null;
  let nextBidCents: number | null = null;
  if (detail && detail.bidCount !== null) {
    if (detail.bidCount === 0) {
      currentBidCents = null;
      startingBidCents = price;
    }
    nextBidCents = detail.minBidCents;
  }

  const ships = detail?.shipping ? !/buyer must pick\s*-?\s*up/i.test(detail.shipping) : false;

  const images: NormalizedImage[] = (detail && detail.images.length > 0 ? detail.images : listing.imageUrl ? [listing.imageUrl] : [])
    .map((url, position) => ({ url, position }));

  const condition = detail?.condition && !/see\s+desc/i.test(detail.condition) && detail.condition.length <= 40
    ? detail.condition
    : null;

  const meta = {
    source: 'public-surplus',
    enriched: !!detail,
    listingState: listing.state,
    pickupStateSource,
    priceBasis: detail && detail.bidCount !== null ? 'detail' : 'listing-current-price',
    sourceStatedZone: detail?.statedZone ?? null,
    sourceEndsText: detail?.endsText ?? null,
    mightExtend: detail?.mightExtend ?? null,
    dutchAuction: listing.dutch,
    newlyListed: listing.newlyListed,
    incrementCents: detail?.incrementCents ?? null,
    bidDeposit: detail?.bidDeposit ?? null,
    agencyOrgId: detail?.agencyOrgId ?? null,
    agencyHome: detail?.agencyHome ?? null,
    pickupName: detail?.pickupName ?? null,
    attachments: detail?.attachments ?? [],
    shipping: detail?.shipping ?? null,
    disclaimer: detail?.disclaimer ?? null,
    listingSource: listing.source,
  };

  const auction: NormalizedAuction = {
    externalId: id,
    title,
    description: null,
    auctioneer: 'Public Surplus',
    url: listing.url,
    format: 'online',
    startsAt: detail?.startsAtIso ?? null,
    endsAt: closesAt,
    timezone,
    pickup,
    pickupRequired: true,
    ships,
    shipsNote: detail?.shipping ?? null,
    sellerName: detail?.agencyName ?? null,
    sellerState,
    lotCount: 1,
    currency: detail?.currency ?? 'USD',
    buyerPremiumPct: detail?.buyerPremiumPct ?? null,
    buyerPremiumNote: detail?.buyerPremiumNote ?? null,
    termsUrl: detail?.termsUrl ?? null,
    raw: { listing, _meta: meta },
  };

  const lot: NormalizedLot = {
    externalId: id,
    auctionExternalId: id,
    lotNumber: id,
    title,
    description: detail?.description ?? null,
    brand: null,
    model: null,
    condition,
    quantity: detail?.quantity ?? null,
    startingBidCents,
    currentBidCents,
    nextBidCents,
    estimateLowCents: null,
    estimateHighCents: null,
    soldPriceCents: null,
    bidCount: detail?.bidCount ?? null,
    reserveMet: null,
    closesAt,
    closed,
    url: listing.url,
    pickup,
    ships,
    images,
    raw: { listing, detail, _meta: meta },
  };

  return { auction, lot };
}

// ------------------------------------------------------------------ adapter

export interface PublicSurplusOptions {
  /** Hard ceiling on HTTP requests per run (listing + detail). */
  maxRequests?: number;
  /** Listing pages per state before giving up on completeness. */
  maxListPagesPerState?: number;
  /** Detail pages per run, before the request and time ceilings apply. */
  maxDetailPages?: number;
  /**
   * Wall-clock budget for a run. The worker's deadline (ctx.deadline) applies
   * too, whichever comes first; planned details past it are withheld.
   */
  timeBudgetMs?: number;
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS: Required<Omit<PublicSurplusOptions, 'sleep'>> = {
  // The worker caps a run at 150 requests, robots.txt included.
  maxRequests: 140,
  maxListPagesPerState: 20,
  maxDetailPages: 130,
  timeBudgetMs: 300_000,
};

/** ctx.source.states, upper-cased and validated, defaulting to Wisconsin. */
export function scopeStates(states: string[] | null | undefined): string[] {
  const valid = (states ?? [])
    .map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''))
    .filter((s) => /^[A-Z]{2}$/.test(s));
  return valid.length ? uniq(valid) : ['WI'];
}

function originOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).origin : PUBLIC_SURPLUS_ORIGIN;
  } catch {
    return PUBLIC_SURPLUS_ORIGIN;
  }
}

class BudgetExhausted extends Error {}

export function createPublicSurplusAdapter(options: PublicSurplusOptions = {}): Adapter {
  const opts = { ...DEFAULTS, ...options };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    key: 'public-surplus',
    method: 'html',

    async run(ctx: AdapterContext): Promise<IngestResult> {
      const origin = originOf(ctx.source.url);
      const states = scopeStates(ctx.source.states);
      const warnings: string[] = [];
      const stats = { httpRequests: 0, bytesIn: 0 };
      const started = ctx.now().getTime();
      const endBy = Math.min(started + opts.timeBudgetMs, ctx.deadline ?? Number.POSITIVE_INFINITY);
      // Politeness: the registry's per-source rate. The crawl gate paces every
      // request to the same rate; pacing here as well keeps the adapter polite
      // under any fetcher, including the tests'.
      const gapMs = Math.ceil(60_000 / Math.max(1, ctx.source.rateLimitRpm || 20));
      let lastAt: number | null = null;

      const get = async (url: string): Promise<{ status: number; text: string }> => {
        if (stats.httpRequests >= opts.maxRequests) throw new BudgetExhausted(url);
        if (lastAt !== null) {
          const wait = lastAt + gapMs - ctx.now().getTime();
          if (wait > 0) await sleep(wait);
        }
        lastAt = ctx.now().getTime();
        stats.httpRequests++;
        const res = await ctx.fetch(url, { headers: { Accept: 'text/html' } });
        stats.bytesIn += res.text.length;
        return { status: res.status, text: res.text };
      };

      // ---- 1. Listing pages: the complete catalogue for each state in scope.
      const listings = new Map<string, PsListing>();
      let complete = true;

      for (const st of states) {
        let page = 0;
        let pagesFetched = 0;
        let firstNow: number | null = null;
        let lastNow: number | null = null;
        let finished = false;
        const stateIds: string[] = [];

        while (pagesFetched < opts.maxListPagesPerState) {
          const url = searchUrl(origin, st, page);
          let res: { status: number; text: string };
          try {
            res = await get(url);
          } catch (e) {
            if (e instanceof BudgetExhausted || isBudgetRefusal(e)) {
              warnings.push(`Public Surplus ${st}: request budget reached while paginating; run is not a complete snapshot.`);
              break;
            }
            throw e;
          }
          pagesFetched++;
          if (res.status === 429) throw new Error('Public Surplus rate limit (HTTP 429).');
          if (res.status >= 500 && page === 0) throw new Error(`Public Surplus returned HTTP ${res.status} for ${st} page 1.`);
          if (res.status !== 200) {
            warnings.push(`Public Surplus ${st}: page ${page + 1} returned HTTP ${res.status}; run is not a complete snapshot.`);
            break;
          }
          const parsed = parseSearchPage(res.text, origin);
          warnings.push(...parsed.warnings.map((w) => `${w} (${st} page ${page + 1})`));
          if (parsed.serverNowMs !== null) {
            firstNow ??= parsed.serverNowMs;
            lastNow = parsed.serverNowMs;
          }

          if (parsed.listings.length === 0) {
            if (parsed.noResults || (page > 0 && parsed.pagination.next === null)) finished = true;
            else warnings.push(`Public Surplus ${st}: page ${page + 1} had no parseable auctions and no "No auctions found" notice; markup may have changed.`);
            break;
          }
          if (parsed.pagination.current !== null && parsed.pagination.current !== page) {
            warnings.push(`Public Surplus ${st}: asked for page ${page + 1}, got page ${parsed.pagination.current + 1}; stopping.`);
            break;
          }
          for (const l of parsed.listings) {
            if (!listings.has(l.id)) stateIds.push(l.id);
            listings.set(l.id, l);
          }
          if (parsed.pagination.next === null) {
            // A readable block with Next disabled is the last page. No block at
            // all is only trustworthy on the first page (a one-page result);
            // mid-sequence it means the markup moved, not that we are done.
            finished = parsed.pagination.current !== null || page === 0;
            if (!finished) warnings.push(`Public Surplus ${st}: pagination block unreadable on page ${page + 1}; run is not a complete snapshot.`);
            break;
          }
          if (parsed.pagination.next <= page) {
            warnings.push(`Public Surplus ${st}: pagination points backwards (${page} -> ${parsed.pagination.next}); stopping.`);
            break;
          }
          page = parsed.pagination.next;
        }

        if (!finished) {
          complete = false;
          if (pagesFetched >= opts.maxListPagesPerState) {
            warnings.push(`Public Surplus ${st}: stopped at ${pagesFetched} listing pages; run is not a complete snapshot.`);
          }
        }

        // Pages are ordered by time left. An auction that closes (or extends) while
        // we paginate shifts every later auction up one slot, so the first auction
        // of the next page can be missed. If anything in this state closes within
        // the pagination window, do not claim completeness for this run.
        if (finished && pagesFetched > 1 && lastNow !== null) {
          const windowEnd = lastNow + 5 * 60_000;
          const risky = stateIds.filter((id) => {
            const e = listings.get(id)!.endsAtMs;
            return e !== null && e <= windowEnd;
          });
          if (risky.length > 0) {
            complete = false;
            warnings.push(
              `Public Surplus ${st}: ${risky.length} auction(s) close during pagination, so listing order may have shifted; not claiming a complete snapshot this run.`,
            );
          }
        }
      }

      // ---- 2. Detail pages for a fixed quota of the lowest auction ids. The quota
      // depends on request counts only, never on the time this run has left, so
      // the enriched set is the same from run to run (see the header).
      const ids = [...listings.keys()].sort((a, b) => Number(a) - Number(b));
      const plannedCount = Math.max(
        0,
        Math.min(opts.maxDetailPages, opts.maxRequests - stats.httpRequests, ids.length),
      );
      const planned = ids.slice(0, plannedCount);
      const details = new Map<string, PsDetail>();
      const withheld = new Set<string>();
      let outOfBudget = false;

      for (const id of planned) {
        const listing = listings.get(id)!;
        const st = listing.state ?? states[0];
        // One more request needs a full gap before the deadline.
        if (outOfBudget || ctx.now().getTime() + gapMs > endBy) {
          withheld.add(id);
          continue;
        }
        let res: { status: number; text: string };
        try {
          res = await get(auctionUrl(origin, st, id));
        } catch (e) {
          if (e instanceof BudgetExhausted || isBudgetRefusal(e)) {
            outOfBudget = true;
            withheld.add(id);
            continue;
          }
          // A network failure on one detail page must not lose the whole run.
          warnings.push(`Public Surplus: auction ${id} detail fetch failed (${e instanceof Error ? e.message : String(e)}).`);
          withheld.add(id);
          continue;
        }
        if (res.status === 429) {
          warnings.push('Public Surplus rate limited (HTTP 429) during detail fetches; stopping enrichment.');
          withheld.add(id);
          for (const rest of planned.slice(planned.indexOf(id) + 1)) withheld.add(rest);
          break;
        }
        if (res.status !== 200) {
          warnings.push(`Public Surplus: auction ${id} detail returned HTTP ${res.status}.`);
          withheld.add(id);
          continue;
        }
        const { detail, warnings: w } = parseDetailPage(res.text, origin, id);
        warnings.push(...w);
        if (!detail) withheld.add(id);
        else details.set(id, detail);
      }
      if (withheld.size > 0) {
        complete = false;
        warnings.push(
          `Public Surplus: ${withheld.size} planned detail page(s) were not fetched or not parseable; those lots keep their stored values this run and nothing is closed by absence.`,
        );
      }

      // ---- 3. Normalize.
      const auctions: NormalizedAuction[] = [];
      const lots: NormalizedLot[] = [];
      for (const id of ids) {
        if (withheld.has(id)) continue;
        const { auction, lot } = normalizePublicSurplus(listings.get(id)!, details.get(id) ?? null);
        auctions.push(auction);
        lots.push(lot);
      }

      ctx.log('info', 'Public Surplus ingest complete', {
        states,
        listed: ids.length,
        enriched: details.size,
        withheld: withheld.size,
        requests: stats.httpRequests,
        complete,
      });

      return {
        auctions,
        lots,
        bids: [],
        stats,
        warnings,
        completeSnapshot: complete && lots.length === ids.length,
      };
    },
  };
}

export const publicSurplusAdapter: Adapter = createPublicSurplusAdapter();
