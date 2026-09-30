// GENERATED from packages/ingest/src/adapters/wisconsin-surplus.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * Wisconsin Surplus Online Auction adapter. Platform key: 'wisconsin-surplus'.
 *
 * The State of Wisconsin's contracted online-auction vendor (a private company in
 * Mount Horeb) and the de facto channel for 22+ counties, DNR, Revenue,
 * Corrections, UW campuses and technical colleges. The most important Wisconsin
 * government source.
 *
 * WHERE THE DATA LIVES, verified 2026-09-30 through inspect_url (our crawler, our
 * User-Agent, Supabase egress):
 *
 *   wisconsinsurplus.com         WordPress marketing site with a "maxanet-auction"
 *                                plugin. Its /current-auctions/ page renders the
 *                                list client-side; the HTML carries no auctions.
 *   bid.wisconsinsurplus.com     Maxanet (ASP.NET MVC on IIS). The real catalogue.
 *     /robots.txt                404, so RFC 9309 applies: no rules, all allowed.
 *     /Public/Auction            page shell; the list arrives by XHR from
 *     /Public/Auction/GetAuctions?filter=Current&pageSize=1000&pageNumber=1
 *                                an HTML fragment of auction cards (91 cards,
 *                                827 KB on 2026-09-30). It needs no cookie and no
 *                                session: only the X-Requested-With header that
 *                                the page's own jQuery sends.
 *     ...?filter=Future          same shape, hdn_Tense="future" (5 cards).
 *
 * WHAT A CARD PUBLISHES: the numeric Maxanet auction id (stable: it is also the
 * S3 image folder, "Inventory128265"), the title, category, a short description,
 * start and end as America/Chicago wall-clock time, the item count, one image,
 * and links to the auction's details and items pages.
 *
 * WHAT THIS ADAPTER DOES NOT DO: LOTS. /Public/Auction/GetAuctionItems answers an
 * anonymous client with an empty "All Caught Up! No Data Found" fragment (tried
 * aucId=128265, AuctionId=128274 and an encrypted pageSize token: the same
 * 30,828-byte empty fragment each time). Public scrapers of other Maxanet tenants
 * first open each auction's AuctionItems page to obtain an ASP.NET session cookie
 * and replay it. That is an anonymously issued session token, which
 * docs/03-legal-and-tos.md rates a "small step up" needing a human decision, and
 * it costs a request per auction. It was not done. So this adapter ingests SALE
 * EVENTS: every current and upcoming auction, with its seller, pickup town,
 * dates and item count, and no lots. completeSnapshot is therefore always false:
 * a run that carries no lots must never be allowed to close any.
 *
 * TITLES ARE THE ONLY STRUCTURE. Maxanet has no seller or location field. Titles
 * follow "#<sale no> - <seller or sale name> - <City>, <ST> - <STATUS NOTES>":
 *   #26-771B - Waushara County Emergency Management - Wautoma, WI - AUCTION ENDING SOON - STARTING AT 10:20 AM CDT
 *   #26-1418 - City of Platteville, Wisconsin - Surplus Real Estate
 * Pickup city and state come only from a "City, ST" segment the title declares.
 * The Platteville title declares no such segment, so its pickup stays empty even
 * though its seller name says Wisconsin: that is the seller's state, not a pickup
 * location, and it goes to sellerState.
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  NormalizedAuction,
  NormalizedLocation,
  SourceConfig,
} from '../types.ts';

export const WS_BASE = 'https://bid.wisconsinsurplus.com';
export const WS_LIST_PATH = '/Public/Auction/GetAuctions';
/** One page holds the whole list: 91 current auctions used 827 KB on 2026-09-30. */
export const WS_PAGE_SIZE = 1000;
/** Pagination guard. Page 2 has never been needed; 3 bounds a runaway loop. */
export const WS_MAX_PAGES = 3;
export const WS_FILTERS = ['Current', 'Future'] as const;
/** Maxanet prints times on the tenant's wall clock; titles say "CDT". */
export const WS_TIMEZONE = 'America/Chicago';
export const WS_AUCTIONEER = 'Wisconsin Surplus Online Auction';

/** The headers the site's own jQuery sends. The endpoint returns the fragment for them. */
const XHR_HEADERS: Record<string, string> = {
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'text/html, */*; q=0.01',
};

// ------------------------------------------------------------------ text helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', laquo: '«', raquo: '»', times: '×',
};

/** Decode named and numeric HTML entities. Unknown entities are left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip tags, decode entities, collapse whitespace. Tags go first so a decoded "&lt;" is never read as a tag. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\f\v\r\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function oneLine(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function absoluteUrl(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(decodeEntities(href.trim()), base).toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ US states

const STATE_NAMES: Record<string, string> = {
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
const STATE_CODES = new Set(Object.values(STATE_NAMES));

export function isUsStateCode(s: string): boolean {
  return STATE_CODES.has(s);
}

/** The states a run is scoped to: sources.states, or Wisconsin when unset. */
export function scopeStates(source: Pick<SourceConfig, 'states'>): string[] {
  const list = (source.states ?? [])
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
  return list.length ? list : ['WI'];
}

// ------------------------------------------------------------------ time

function nthSundayOfMonth(y: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/**
 * US daylight time for a LOCAL wall-clock time: from 02:00 on the second Sunday
 * of March to 02:00 on the first Sunday of November. The repeated 01:00 hour in
 * November is read as daylight time, its first occurrence.
 */
export function isUsDaylightTime(y: number, m: number, d: number, h: number): boolean {
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  if (m === 3) {
    const start = nthSundayOfMonth(y, 3, 2);
    return d > start || (d === start && h >= 2);
  }
  const end = nthSundayOfMonth(y, 11, 1);
  return d < end || (d === end && h < 2);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function centralIso(y: number, mo: number, d: number, h: number, mi: number, s: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  // Reject impossible calendar dates (02/30) instead of letting Date roll them over.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const offset = isUsDaylightTime(y, mo, d, h) ? '-05:00' : '-06:00';
  return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}${offset}`;
}

/**
 * A Maxanet data-auc-date ("09/30/2026 10:00:00", 24-hour, America/Chicago wall
 * clock) as ISO-8601 with its offset: "2026-09-30T10:00:00-05:00".
 *
 * The zone is proven, not assumed: the fragment's own nowDate read
 * "2026-09-30 11:08:38 AM" when the request left at about 16:08 UTC, and the
 * titles say "STARTING AT 10:00 AM CDT" against a data-auc-date of 10:00:00.
 */
export function parseMaxanetDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  return centralIso(+m[3], +m[1], +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

/** The fragment's server clock, "2026-09-30 11:08:38 AM" (America/Chicago), as epoch ms. */
export function parseMaxanetNow(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = +m[4];
  const ampm = m[7]?.toUpperCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'AM' && h === 12) h = 0;
    if (ampm === 'PM' && h !== 12) h += 12;
  }
  const iso = centralIso(+m[1], +m[2], +m[3], h, +m[5], +m[6]);
  return iso ? Date.parse(iso) : null;
}

/**
 * Warn when the server's clock does not read as America/Chicago. Every close
 * time this adapter emits depends on that zone, so a tenant moving zones must be
 * loud, not a silent one-hour shift.
 */
export function checkServerClock(serverNowRaw: string | null, now: Date): string | null {
  const server = parseMaxanetNow(serverNowRaw);
  if (server === null) return null;
  const driftMin = Math.round((server - now.getTime()) / 60_000);
  if (Math.abs(driftMin) <= 30) return null;
  return `Wisconsin Surplus server clock "${serverNowRaw}" is ${driftMin} min from now when read as ${WS_TIMEZONE}; auction times may be in another zone.`;
}

// ------------------------------------------------------------------ titles

export interface WsTitleParts {
  /** Sale number without the "#", e.g. "26-1355". */
  auctionNumber: string | null;
  /** Title segments after the sale number, status notes removed. */
  segments: string[];
  /** Transient status segments, e.g. "AUCTION ENDING SOON". */
  notes: string[];
  /** A "City, ST" segment the title declares. Never inferred. */
  location: { city: string; state: string } | null;
  /** First segment that is neither a note nor the location. */
  lead: string | null;
  /** State spelled out or abbreviated at the end of the lead segment. */
  leadState: string | null;
  /** Title without status notes, so it does not churn as a sale closes. */
  displayTitle: string;
}

const NOTE_WORDS = /\b(?:AUCTION|ENDING|ENDS|STARTING|STARTS|CLOSING|CLOSES|SOON|EXTENDED|BEGINS|OPEN|NOW|LIVE|PREVIEW|POSTPONED|CANCELL?ED)\b/;

function isStatusNote(segment: string): boolean {
  return /[A-Z]/.test(segment) && segment === segment.toUpperCase() && NOTE_WORDS.test(segment);
}

const LOCATION_SEGMENT = /^([A-Za-z][A-Za-z .'\-]*?[A-Za-z.])\s*,\s*([A-Z]{2})$/;

export function parseWsTitle(title: string): WsTitleParts {
  const clean = title.replace(/\s+/g, ' ').trim();
  // "#26-1355", "#26-771B", and the older undashed "#211025" (docs/07).
  const numbered = clean.match(/^#\s*(\d[0-9A-Za-z-]*?)\s*(?:-\s+(.*))?$/);
  const auctionNumber = numbered ? numbered[1] : null;
  const rest = numbered ? (numbered[2] ?? '') : clean;
  const parts = rest.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);

  const notes: string[] = [];
  const segments: string[] = [];
  for (const p of parts) (isStatusNote(p) ? notes : segments).push(p);

  let location: WsTitleParts['location'] = null;
  let lead: string | null = null;
  for (const seg of segments) {
    const m = seg.match(LOCATION_SEGMENT);
    if (!location && m && isUsStateCode(m[2])) {
      location = { city: m[1].trim(), state: m[2] };
      continue;
    }
    if (lead === null) lead = seg;
  }

  let leadState: string | null = null;
  if (lead) {
    const tail = lead.match(/,\s*([A-Za-z][A-Za-z ]+?)\s*$/);
    if (tail) {
      const word = tail[1].trim();
      const code = word.length === 2 ? word.toUpperCase() : STATE_NAMES[word.toLowerCase()];
      if (code && isUsStateCode(code)) leadState = code;
    }
  }

  const body = segments.join(' - ');
  const displayTitle = auctionNumber ? (body ? `#${auctionNumber} - ${body}` : `#${auctionNumber}`) : body || clean;
  return { auctionNumber, segments, notes, location, lead, leadState, displayTitle };
}

// ------------------------------------------------------------------ cards

export interface WsAuctionCard {
  /** Numeric Maxanet auction id, e.g. "128265". The stable external id. */
  auctionId: string;
  /** Title exactly as published, whitespace collapsed. */
  title: string;
  detailsUrl: string | null;
  itemsUrl: string | null;
  /** The site's own "Copylink" URL (published as http://). */
  shareUrl: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  categories: string[];
  description: string | null;
  startsRaw: string | null;
  endsRaw: string | null;
  itemCount: number | null;
  halted: boolean;
}

const CARD_START = /<div\s+class="row border auction-item-cardcolor[^"]*"\s*>/gi;

/** Split a GetAuctions fragment into one chunk per auction card. */
export function splitWsCards(html: string): string[] {
  const starts = [...html.matchAll(CARD_START)].map((m) => m.index ?? 0);
  return starts.map((s, i) => html.slice(s, i + 1 < starts.length ? starts[i + 1] : html.length));
}

/** Parse one card. Returns null when the card has no id or no title. */
export function parseWsCard(chunk: string, base: string = WS_BASE): WsAuctionCard | null {
  const idMatch =
    chunk.match(/id="auctionHalt_(\d+)"/) ??
    chunk.match(/LoadSocialNetworkUrl\([^)]*?,\s*(\d+)\s*,\s*\d+\s*\)/) ??
    chunk.match(/\/Inventory(\d+)\//);
  const head = chunk.match(/<h4\b[^>]*auction-gridhead[^>]*>\s*<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!idMatch || !head) return null;
  const title = oneLine(head[2]);
  if (!title) return null;

  const haltSpan = chunk.match(/<span\s+class="([^"]*)"\s+id="auctionHalt_\d+"/);
  const categories = (chunk.match(/<span\s+class="category-info"\s*>([\s\S]*?)<\/span>/i)?.[1] ?? '')
    .split(',')
    .map((c) => oneLine(c))
    .filter(Boolean);

  const descHtml = chunk.match(/<p\s+class="m-t-sm auction-desc[^"]*"\s*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
  const description =
    htmlToText(descHtml)
      .split('\n')
      .map((l) => l.replace(/^-\s+/, '').trim())
      .filter(Boolean)
      .join('\n') || null;

  let startsRaw: string | null = null;
  let endsRaw: string | null = null;
  const dateRe =
    /<p\s+class="bid-content-date[^"]*"\s*>([\s\S]*?)<\/p>\s*<p\s+class="[^"]*local-date-time[^"]*"\s+data-auc-date="([^"]*)"/gi;
  for (const m of chunk.matchAll(dateRe)) {
    const label = oneLine(m[1]).toLowerCase();
    if (label.startsWith('start')) startsRaw = m[2].trim() || null;
    else if (label.startsWith('end')) endsRaw = m[2].trim() || null;
  }

  const count = chunk.match(/<p>\s*([\d,]+)\s+Items?\s*<\/p>/i);
  const carousel = chunk.match(/<a\b[^>]*\bclass="[^"]*\bcarousel-item\b[^"]*"[^>]*>/i)?.[0] ?? null;
  const thumb = chunk.match(/<img\b[^>]*\balt="image"[^>]*>/i)?.[0] ?? null;

  return {
    auctionId: idMatch[1],
    title,
    detailsUrl: absoluteUrl(head[1], base),
    itemsUrl: absoluteUrl(chunk.match(/LoadA(?:cu|uc)tionItemList\(\s*"([^"]+)"\s*\)/)?.[1] ?? null, base),
    shareUrl: absoluteUrl(chunk.match(/CopyToClipboard\(\s*'([^']+)'\s*\)/)?.[1] ?? null, base),
    imageUrl: absoluteUrl(carousel ? attr(carousel, 'href') : null, base),
    thumbnailUrl: absoluteUrl(thumb ? attr(thumb, 'src') : null, base),
    categories,
    description,
    startsRaw,
    endsRaw,
    itemCount: count ? Number(count[1].replace(/,/g, '')) : null,
    halted: haltSpan ? !/\bhide\b/.test(haltSpan[1]) : false,
  };
}

export interface WsFragmentMeta {
  /** "current" | "future" | "past", from hdn_Tense. */
  tense: string | null;
  /** The server's clock, "2026-09-30 11:08:38 AM". */
  serverNow: string | null;
  /** true when the pager script disables "next"; null when no pager script was seen. */
  lastPage: boolean | null;
}

export function parseWsFragmentMeta(html: string): WsFragmentMeta {
  const tense = html.match(/id="hdn_Tense"\s+value="([^"]*)"/i)?.[1]?.trim().toLowerCase() || null;
  const serverNow = html.match(/id="nowDate"\s+data-nowdate="([^"]*)"/i)?.[1]?.trim() || null;
  const disabledNext = /\$\(\s*["']\.next["']\s*\)\s*\.addClass\(\s*["']disabled["']\s*\)/.test(html);
  const pagerScript = /\$\(\s*["']\.public-pagination["']\s*\)/.test(html);
  return { tense, serverNow, lastPage: disabledNext ? true : pagerScript ? false : null };
}

// ------------------------------------------------------------------ normalize

/** A card with only "General Public" in its categories is a consignment sale, not an agency's. */
function isAgencySale(categories: string[]): boolean {
  return categories.some((c) => c.toLowerCase() !== 'general public');
}

export function normalizeWsCard(card: WsAuctionCard, tense: string | null = null): NormalizedAuction {
  const t = parseWsTitle(card.title);
  const pickup: NormalizedLocation | null = t.location
    ? { line1: null, city: t.location.city, state: t.location.state, postalCode: null, ambiguous: false }
    : null;
  const sellerName = isAgencySale(card.categories) ? t.lead : null;

  return {
    externalId: card.auctionId,
    title: t.displayTitle,
    description: card.description,
    auctioneer: WS_AUCTIONEER,
    url: card.detailsUrl ?? card.itemsUrl,
    format: 'online',
    startsAt: parseMaxanetDate(card.startsRaw),
    endsAt: parseMaxanetDate(card.endsRaw),
    timezone: WS_TIMEZONE,
    pickup,
    pickupRequired: true,
    ships: false,
    shipsNote: null,
    sellerName,
    sellerState: sellerName ? t.leadState : null,
    lotCount: card.itemCount,
    currency: 'USD',
    // Not on the auction list. Our terms research (docs/06) found a buyer's fee
    // tiered by bid size, set per sale; a guessed percentage would be worse than none.
    buyerPremiumPct: null,
    buyerPremiumNote:
      "Wisconsin Surplus charges a buyer's fee that is tiered by bid size and set per sale. " +
      'The auction list does not publish it: read the sale terms on the auction page before bidding.',
    termsUrl: null,
    raw: {
      ...card,
      _meta: {
        source: 'wisconsin-surplus',
        tense,
        auctionNumber: t.auctionNumber,
        statusNotes: t.notes,
        titleSegments: t.segments,
        locationSource: pickup ? 'title' : null,
        closeTimeNote:
          'endsAt is when the sale starts closing. Lots close individually after it, and bids ' +
          'near a lot’s close extend that lot, so a lot can close later than endsAt.',
      },
    },
  };
}

export interface WsListResult {
  auctions: NormalizedAuction[];
  /** Cards found in the fragment, parsed or not. */
  cardCount: number;
  warnings: string[];
  meta: WsFragmentMeta;
}

/** Parse a whole GetAuctions fragment. Pure; never throws on bad markup. */
export function parseWsAuctionList(html: string, base: string = WS_BASE): WsListResult {
  const warnings: string[] = [];
  if (typeof html !== 'string') {
    return { auctions: [], cardCount: 0, warnings: ['Response body was not text.'], meta: { tense: null, serverNow: null, lastPage: null } };
  }
  const meta = parseWsFragmentMeta(html);
  const chunks = splitWsCards(html);
  const auctions: NormalizedAuction[] = [];
  let skipped = 0;
  let undated = 0;
  for (const chunk of chunks) {
    const card = parseWsCard(chunk, base);
    if (!card) {
      skipped++;
      continue;
    }
    const auction = normalizeWsCard(card, meta.tense);
    if (!auction.endsAt) undated++;
    auctions.push(auction);
  }
  if (skipped) warnings.push(`Skipped ${skipped} of ${chunks.length} auction cards with no auction id or title.`);
  if (undated) warnings.push(`${undated} auction(s) had no parseable end time.`);
  return { auctions, cardCount: chunks.length, warnings, meta };
}

// ------------------------------------------------------------------ run

export function wsListUrl(base: string, filter: string, pageNumber: number, pageSize: number = WS_PAGE_SIZE): string {
  const q = new URLSearchParams({ filter, pageSize: String(pageSize), pageNumber: String(pageNumber) });
  return `${base.replace(/\/+$/, '')}${WS_LIST_PATH}?${q.toString()}`;
}

/** Milliseconds between requests to one host for a requests-per-minute ceiling. */
export function spacingMs(rateLimitRpm: number | null | undefined): number {
  const rpm = typeof rateLimitRpm === 'number' && Number.isFinite(rateLimitRpm) && rateLimitRpm > 0 ? rateLimitRpm : 10;
  return Math.ceil(60_000 / rpm);
}

/** A refusal is an answer: never retried, always reported. */
export function blockReason(status: number, text: string): string | null {
  if (status === 403 || status === 405 || status === 429 || status === 503) return `HTTP ${status}`;
  if (status === 200 && !/auction-item-cardcolor|hdn_Tense/.test(text) &&
      /captcha|human verification|access denied|cf-chl|awswaf/i.test(text)) {
    return 'bot-protection challenge page';
  }
  return null;
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The crawl gate (gate.ts) refuses a request by throwing a CrawlRefused with a
 * reason. Read by name so this adapter works with or without the gate in front.
 */
export function refusalReason(e: unknown): 'robots' | 'blocked' | 'budget' | null {
  if (!e || typeof e !== 'object' || (e as { name?: unknown }).name !== 'CrawlRefused') return null;
  const r = (e as { reason?: unknown }).reason;
  return r === 'robots' || r === 'blocked' || r === 'budget' ? r : null;
}

export interface WsRunOptions {
  /** Injected so tests do not wait out the politeness spacing. */
  sleep?: (ms: number) => Promise<void>;
}

export async function runWisconsinSurplus(ctx: AdapterContext, opts: WsRunOptions = {}): Promise<IngestResult> {
  const sleep = opts.sleep ?? defaultSleep;
  // api_base points at the Maxanet host; sources.url stays the marketing site.
  const base = originOf(ctx.source.apiBase) ?? WS_BASE;
  const states = scopeStates(ctx.source);
  const spacing = spacingMs(ctx.source.rateLimitRpm);

  const warnings: string[] = [];
  const byId = new Map<string, NormalizedAuction>();
  let httpRequests = 0;
  let bytesIn = 0;
  let outOfScope = 0;
  let undeclared = 0;
  let clockChecked = false;
  let lastStart: number | null = null;
  let outOfBudget = false;

  for (const filter of WS_FILTERS) {
    if (outOfBudget) break;
    for (let page = 1; page <= WS_MAX_PAGES; page++) {
      // Space request STARTS by the rate limit. Behind the crawl gate, which paces
      // the same way, this waits for nothing; without it, it keeps us polite.
      if (lastStart !== null) {
        const wait = lastStart + spacing - ctx.now().getTime();
        if (wait > 0) await sleep(wait);
      }
      lastStart = ctx.now().getTime();
      const url = wsListUrl(base, filter, page);
      let res: { status: number; text: string };
      try {
        res = await ctx.fetch(url, { headers: XHR_HEADERS });
      } catch (e) {
        // Out of run budget after the current list: keep what we have. A robots
        // or bot-protection refusal, or losing the current list, fails the run.
        if (refusalReason(e) === 'budget' && !(filter === 'Current' && page === 1)) {
          warnings.push(`Run budget ran out before the ${filter} list page ${page}; kept what was fetched.`);
          outOfBudget = true;
          break;
        }
        throw e;
      }
      httpRequests++;
      bytesIn += res.text.length;

      const refused = blockReason(res.status, res.text);
      if (refused || res.status < 200 || res.status >= 300) {
        const msg = `Wisconsin Surplus ${filter} list page ${page}: ${refused ?? `HTTP ${res.status}`}.`;
        // Without the current list there is nothing to report: fail the run so the
        // source backs off. A missing upcoming list is a gap, not a failure.
        if (filter === 'Current' && page === 1) throw new Error(msg);
        warnings.push(`${msg} Stopped paging this list.`);
        break;
      }

      const parsed = parseWsAuctionList(res.text, base);
      for (const w of parsed.warnings) warnings.push(`${filter} page ${page}: ${w}`);
      if (!clockChecked && parsed.meta.serverNow) {
        const w = checkServerClock(parsed.meta.serverNow, ctx.now());
        if (w) warnings.push(w);
        clockChecked = true;
      }
      if (filter === 'Current' && page === 1 && parsed.cardCount === 0) {
        warnings.push('The current-auction list held no auction cards; the fragment markup may have changed.');
      }

      for (const a of parsed.auctions) {
        const state = a.pickup?.state ?? null;
        // Scope on the state the title DECLARES. A sale with no declared location
        // stays in: this is a Wisconsin-based regional source, and dropping it
        // would hide real Wisconsin sales whose titles name no town.
        if (state && !states.includes(state)) {
          outOfScope++;
          continue;
        }
        if (!state) undeclared++;
        // An auction can move from Future to Current between the two requests.
        if (!byId.has(a.externalId)) byId.set(a.externalId, a);
      }

      if (parsed.cardCount === 0) break;
      if (parsed.meta.lastPage === true) break;
      if (parsed.meta.lastPage === null && parsed.cardCount < WS_PAGE_SIZE) break;
      if (page === WS_MAX_PAGES) {
        warnings.push(`${filter} list still had pages after the ${WS_MAX_PAGES}-page cap.`);
      }
    }
  }

  const auctions = [...byId.values()];
  ctx.log('info', 'Wisconsin Surplus ingest complete', {
    auctions: auctions.length,
    outOfScope,
    noDeclaredLocation: undeclared,
    states,
    httpRequests,
    warnings: warnings.length,
  });

  return {
    auctions,
    // Lot lists need an anonymous ASP.NET session; see the header comment.
    lots: [],
    bids: [],
    stats: { httpRequests, bytesIn },
    warnings,
    // Complete at the auction level, but it carries no lots, so it must never be
    // allowed to close any.
    completeSnapshot: false,
  };
}

export const wisconsinSurplusAdapter: Adapter = {
  key: 'wisconsin-surplus',
  method: 'html',
  run: (ctx: AdapterContext) => runWisconsinSurplus(ctx),
};
