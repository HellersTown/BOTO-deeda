/**
 * PropertyRoom.com adapter. Platform key: 'propertyroom'.
 *
 * Police-seized, forfeited and unclaimed property sold online for hundreds of
 * agencies, plus "ShopKeeper" resellers. It ships nationwide, so a Wisconsin
 * buyer can use most of it without a Wisconsin address.
 *
 * VERIFIED 2026-09-30 through inspect_url (our crawler, Supabase egress):
 *
 *   robots.txt (www.propertyroom.com), in full:
 *       User-agent: *
 *       Disallow: /account/
 *       Disallow: /watchlist/
 *       Disallow: /activity/
 *     Everything this adapter reads is allowed. No Sitemap line is declared.
 *
 *   No JSON-LD, no embedded app state, no feed. The listing pages are
 *   server-rendered HTML with a clean, data-attribute card per listing:
 *     <a href="/l/{slug}/{id}" class="listing-card" data-listing-id="…"
 *        data-format="English|BidToBeApproved|FixedPrice" data-photos='["…"]'>
 *       <div class="listing-title">…</div>
 *       <span class="listing-time" data-end="2026-09-30T22:09:00.0000000Z">
 *       <span class="listing-price">$1.00</span>
 *       <span class="listing-bids">1 bid</span>          (absent on FixedPrice)
 *
 * SCOPE: /police-auctions, not /c/all. /c/all is 265 pages of 40 and mostly
 * ShopKeeper resellers (pawn shops, coin dealers), which are not government
 * surplus. /police-auctions is the police and agency channel: 33 pages of 40
 * (about 1,300 listings) on 2026-09-30. Sorted soonest-closing
 * (?sort=closingsoon&page=N, verified: page 33 ends Oct 5-7, page 1 in 6 hours).
 *
 * LOCATION AND STATE. Listing cards publish no agency and no agency state, so
 * items cannot be scoped by the selling agency's state. Two kinds of listing:
 *   - Vehicles name their pickup location in the title, "2018 Ford Taurus
 *     (Hartford, CT 06114)". That is a location the source DECLARES: those lots
 *     get pickup {city, state, postalCode}, ships=false, and are kept only when
 *     the state is in sources.states (default WI).
 *   - Everything else names no location and is shipped by PropertyRoom. Those
 *     lots are taken whole, with ships=true and no pickup.
 *
 * ONE AUCTION PER LISTING. PropertyRoom has no sale grouping: each listing is
 * its own sale with its own close. Each listing therefore becomes an auction and
 * its single lot, which is also the only place the schema can carry the
 * listing's format (fixed_price vs online) and its buyer's premium.
 *
 * BUDGET. rate_limit_rpm is 10, so requests are spaced 6 s apart, and a run
 * stops near 100 s of wall clock (docs/08 §4: one invocation must not sweep a
 * whole source). That is about 14 pages. When the catalogue fits, the run
 * sweeps it to the last page and reports completeSnapshot=true. When it does not
 * (33 pages today), each run takes the soonest-closing pages plus a window of the
 * rest that rotates with the crawl slot, so every page is seen every few runs,
 * and it reports completeSnapshot=false.
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

export const PR_BASE = 'https://www.propertyroom.com';
export const PR_LIST_PATH = '/police-auctions';
export const PR_SORT = 'closingsoon';
/** Listings per page, observed on every full page. */
export const PR_PAGE_SIZE = 40;
/** The site shows closing times in Eastern ("Ended Sep 30, 2026 at 12:02 PM (Eastern)"). */
export const PR_TIMEZONE = 'America/New_York';
/** Wall-clock budget for one run, including the politeness spacing. */
export const PR_RUN_BUDGET_MS = 100_000;
/** Hard cap on pages per run, whatever the rate limit allows. */
export const PR_MAX_PAGES_PER_RUN = 60;
/** Rough network time per page, for planning how many pages fit the budget. */
const PR_EST_FETCH_MS = 1_500;

// ------------------------------------------------------------------ helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', laquo: '«', raquo: '»', times: '×',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags stripped first, then entities decoded, then all whitespace (tabs included) collapsed. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
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

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

/** The states a run is scoped to: sources.states, or Wisconsin when unset. */
export function scopeStates(source: Pick<SourceConfig, 'states'>): string[] {
  const list = (source.states ?? [])
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
  return list.length ? list : ['WI'];
}

/** Milliseconds between requests to one host for a requests-per-minute ceiling. */
export function spacingMs(rateLimitRpm: number | null | undefined): number {
  const rpm = typeof rateLimitRpm === 'number' && Number.isFinite(rateLimitRpm) && rateLimitRpm > 0 ? rateLimitRpm : 10;
  return Math.ceil(60_000 / rpm);
}

// ------------------------------------------------------------------ parsing

/**
 * A pickup location the title DECLARES, "(Hartford, CT 06114)" at its end.
 * Nothing is inferred: a title without that pattern has no location.
 */
export function parsePrLocation(title: string): NormalizedLocation | null {
  const m = title.match(/\(\s*([A-Za-z][A-Za-z .'\-]*?)\s*,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*\)\s*$/);
  if (!m || !STATE_CODES.has(m[2])) return null;
  return { line1: null, city: m[1].trim(), state: m[2], postalCode: m[3], ambiguous: false };
}

/**
 * data-end, "2026-09-30T22:09:00.0000000Z": UTC with seven fractional digits,
 * which not every Date parser accepts. Parsed by hand; returns ISO or null.
 */
export function parsePrEnd(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  if (+y < 2000 || +y > 2100 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return null;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const probe = new Date(Date.UTC(+y, +mo - 1, +d));
  if (probe.getUTCDate() !== +d) return null;
  if (zone !== 'Z') {
    const zm = zone.match(/^([+-])(\d{2}):?(\d{2})$/)!;
    const offsetMin = (+zm[2] * 60 + +zm[3]) * (zm[1] === '+' ? 1 : -1);
    ms -= offsetMin * 60_000;
  }
  return new Date(ms).toISOString();
}

export interface PrCard {
  listingId: string;
  slug: string | null;
  /** data-format as published: "English", "BidToBeApproved", "FixedPrice". */
  format: string | null;
  url: string;
  title: string;
  /** Full-size photos, in the site's order. */
  photos: string[];
  thumbnailUrl: string | null;
  endRaw: string | null;
  closesAt: string | null;
  priceText: string | null;
  priceCents: number | null;
  /** Number of bids. null when the card shows no bid count (FixedPrice). */
  bidCount: number | null;
  freeShipping: boolean;
  /** "seller1" style code from the image path; the only seller signal on a card. */
  sellerCode: string | null;
  location: NormalizedLocation | null;
}

export interface PrCardsResult {
  cards: PrCard[];
  /** Card elements found, parsed or not. */
  found: number;
  warnings: string[];
}

const CARD_RE = /<a\b([^>]*\bclass="[^"]*\blisting-card\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;

/** Parse every listing card on a page. Pure; never throws on bad markup. */
export function parsePrCards(html: string, base: string = PR_BASE): PrCardsResult {
  const warnings: string[] = [];
  if (typeof html !== 'string') return { cards: [], found: 0, warnings: ['Response body was not text.'] };

  const cards: PrCard[] = [];
  let found = 0;
  let skipped = 0;
  let badPhotos = 0;
  let badEnd = 0;
  let badPrice = 0;
  let badBids = 0;

  for (const m of html.matchAll(CARD_RE)) {
    found++;
    const tag = ` ${m[1]}`;
    const body = m[2];
    const listingId = attr(tag, 'data-listing-id')?.trim() ?? '';
    const url = absoluteUrl(attr(tag, 'href'), base);
    const title = textOf(body.match(/<div\s+class="listing-title"\s*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
    // Id, link and title are the minimum for a lot a user can act on.
    if (!/^\d+$/.test(listingId) || !url || !title) {
      skipped++;
      continue;
    }

    let photos: string[] = [];
    const photosRaw = attr(tag, 'data-photos');
    if (photosRaw) {
      try {
        const parsed = JSON.parse(decodeEntities(photosRaw));
        if (!Array.isArray(parsed)) throw new Error('not an array');
        photos = parsed.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
      } catch {
        badPhotos++;
      }
    }
    const img = body.match(/<img\b[^>]*>/i)?.[0] ?? null;
    const thumbnailUrl = absoluteUrl(img ? attr(img, 'src') : null, base);

    const endRaw = body.match(/\bdata-end="([^"]*)"/i)?.[1] ?? null;
    const closesAt = parsePrEnd(endRaw);
    if (!closesAt) badEnd++;

    const priceHtml = body.match(/<span\s+class="listing-price"\s*>([\s\S]*?)<\/span>/i)?.[1];
    const priceText = priceHtml === undefined ? null : textOf(priceHtml);
    const priceCents = priceText === null ? null : parseMoneyToCents(priceText);
    if (priceCents === null) badPrice++;

    let bidCount: number | null = null;
    const bidsHtml = body.match(/<span\s+class="listing-bids"\s*>([\s\S]*?)<\/span>/i)?.[1];
    if (bidsHtml !== undefined) {
      const b = textOf(bidsHtml).match(/^([\d,]+)\s+bids?$/i);
      if (b) bidCount = Number(b[1].replace(/,/g, ''));
      else badBids++;
    }

    cards.push({
      listingId,
      slug: attr(tag, 'data-slug'),
      format: attr(tag, 'data-format'),
      url,
      title,
      photos,
      thumbnailUrl,
      endRaw,
      closesAt,
      priceText,
      priceCents,
      bidCount,
      freeShipping: /free-shipping-overlay/.test(body),
      sellerCode: (photos[0] ?? thumbnailUrl ?? '').match(/\/sellers\/(seller\d+)\//)?.[1] ?? null,
      location: parsePrLocation(title),
    });
  }

  if (skipped) warnings.push(`Skipped ${skipped} of ${found} listing cards with no id, link or title.`);
  if (badPhotos) warnings.push(`${badPhotos} listing(s) had an unreadable data-photos list; used the thumbnail.`);
  if (badEnd) warnings.push(`${badEnd} listing(s) had no parseable close time.`);
  if (badPrice) warnings.push(`${badPrice} listing(s) had no parseable price.`);
  if (badBids) warnings.push(`${badBids} listing(s) had an unreadable bid count.`);
  return { cards, found, warnings };
}

export interface PrPager {
  /** A pagination block was present. Single-page lists have none. */
  present: boolean;
  current: number | null;
  maxPage: number | null;
  /** The enabled "»" link's target, when there is one. */
  nextPage: number | null;
  /** false on the last page ("»" is a disabled span). null when unknown. */
  hasNext: boolean | null;
}

export function parsePrPager(html: string): PrPager {
  const block = html.match(/<div\s+class="pagination"\s*>([\s\S]*?)<\/div>/i)?.[1];
  if (block === undefined) return { present: false, current: null, maxPage: null, nextPage: null, hasNext: null };
  const current = Number(block.match(/<span\s+class="[^"]*\bactive\b[^"]*"\s*>\s*(\d+)\s*<\/span>/i)?.[1] ?? NaN);
  const pages = [...block.matchAll(/data-page="(\d+)"/g)].map((m) => Number(m[1]));
  const known = Number.isFinite(current) ? [...pages, current] : pages;
  const maxPage = known.length ? Math.max(...known) : null;
  const next = block.match(/<a\b[^>]*data-page="(\d+)"[^>]*>\s*(?:&raquo;|»)\s*<\/a>/i);
  const nextDisabled = /<span\b[^>]*\bdisabled\b[^>]*>\s*(?:&raquo;|»)\s*<\/span>/i.test(block);
  const cur = Number.isFinite(current) ? current : null;
  const hasNext = next ? true : nextDisabled ? false : cur !== null && maxPage !== null ? cur < maxPage : null;
  return { present: true, current: cur, maxPage, nextPage: next ? Number(next[1]) : null, hasNext };
}

// ------------------------------------------------------------------ normalize

const BUYER_PREMIUM_NOTE =
  'PropertyRoom listing cards do not show a buyer’s premium or fees; check the listing page before bidding.';

/** One PropertyRoom listing as an auction (the sale) and its single lot. */
export function normalizePrCard(card: PrCard, now: Date): { auction: NormalizedAuction; lot: NormalizedLot } {
  const fmt = (card.format ?? '').toLowerCase();
  const fixedPrice = fmt === 'fixedprice';

  // The card shows ONE price whose meaning depends on the format and bid count:
  //   bidding, bids > 0   the current high bid
  //   bidding, 0 bids     the opening price, which is also the next bid you can place
  //   FixedPrice          the buy-now price: no bid exists, so it is what you pay
  // Treating a 0-bid opening price as a current bid would break "no bids" signals.
  let startingBidCents: number | null = null;
  let currentBidCents: number | null = null;
  let nextBidCents: number | null = null;
  let bidCount: number | null = card.bidCount;
  if (fixedPrice) {
    nextBidCents = card.priceCents;
    bidCount = null;
  } else if (card.bidCount === 0) {
    startingBidCents = card.priceCents;
    nextBidCents = card.priceCents;
  } else if (card.bidCount !== null && card.bidCount > 0) {
    currentBidCents = card.priceCents;
    // PropertyRoom's increment table is not published on the card; no guess.
  }

  const pickup = card.location;
  const ships = !pickup;
  const closed = card.closesAt ? Date.parse(card.closesAt) <= now.getTime() : false;
  const images: NormalizedImage[] = (card.photos.length ? card.photos : card.thumbnailUrl ? [card.thumbnailUrl] : [])
    .map((url, position) => ({ url, position }));

  const meta = {
    source: 'propertyroom',
    listingFormat: card.format,
    // BidToBeApproved: the seller approves the winning bid, like an undisclosed reserve.
    bidNeedsApproval: fmt === 'bidtobeapproved',
    buyNowCents: fixedPrice ? card.priceCents : null,
    freeShipping: card.freeShipping,
    sellerCode: card.sellerCode,
    locationSource: pickup ? 'title' : null,
    closeTimePrecise: !!card.closesAt,
  };

  const auction: NormalizedAuction = {
    externalId: card.listingId,
    title: card.title,
    description: null,
    auctioneer: 'PropertyRoom.com',
    url: card.url,
    format: fixedPrice ? 'fixed_price' : 'online',
    startsAt: null,
    endsAt: card.closesAt,
    timezone: PR_TIMEZONE,
    pickup,
    pickupRequired: !!pickup,
    ships,
    shipsNote: pickup
      ? 'The listing title names a pickup location; treated as pickup-only.'
      : card.freeShipping
        ? 'Ships from PropertyRoom.com; the listing is marked Free Shipping.'
        : 'Ships from PropertyRoom.com; the listing names no pickup location.',
    sellerName: null,
    sellerState: null,
    lotCount: 1,
    currency: 'USD',
    buyerPremiumPct: null,
    buyerPremiumNote: BUYER_PREMIUM_NOTE,
    termsUrl: null,
    raw: { listingId: card.listingId, slug: card.slug, _meta: meta },
  };

  const lot: NormalizedLot = {
    externalId: card.listingId,
    auctionExternalId: card.listingId,
    lotNumber: null,
    title: card.title,
    description: null,
    brand: null,
    model: null,
    condition: null,
    quantity: 1,
    startingBidCents,
    currentBidCents,
    nextBidCents,
    estimateLowCents: null,
    estimateHighCents: null,
    soldPriceCents: null,
    bidCount,
    reserveMet: null,
    closesAt: card.closesAt,
    closed,
    url: card.url,
    pickup,
    ships,
    images,
    raw: { ...card, _meta: meta },
  };

  return { auction, lot };
}

// ------------------------------------------------------------------ planning

export function prListUrl(base: string, page: number): string {
  return `${base.replace(/\/+$/, '')}${PR_LIST_PATH}?sort=${PR_SORT}&page=${page}`;
}

/** How many pages fit one run's wall-clock budget at this spacing. */
export function pagesPerRun(budgetMs: number, spacing: number): number {
  const n = Math.floor(budgetMs / (spacing + PR_EST_FETCH_MS)) + 1;
  return Math.max(1, Math.min(PR_MAX_PAGES_PER_RUN, n));
}

/**
 * Pages to fetch after page 1 when the catalogue is too big for one run.
 *
 * The first half of the budget always goes to the soonest-closing pages, where
 * freshness matters most. The rest is a window over the later pages that moves
 * by one window per crawl slot, so every page is visited every
 * ceil(rest / window) runs without the adapter keeping any state.
 */
export function planRotatingPages(maxPage: number, perRun: number, slot: number): number[] {
  if (maxPage <= 1) return [];
  if (maxPage <= perRun) return range(2, maxPage);
  const head = Math.max(1, Math.ceil(perRun / 2));
  const rest = range(head + 1, maxPage);
  const width = Math.min(Math.max(0, perRun - head), rest.length);
  const start = ((Math.abs(Math.trunc(slot)) % rest.length) * width) % rest.length;
  const window = Array.from({ length: width }, (_, i) => rest[(start + i) % rest.length]);
  return [...new Set([...range(2, head), ...window])].sort((a, b) => a - b);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** A refusal is an answer: never retried, always reported. */
export function blockReason(status: number, text: string): string | null {
  if (status === 403 || status === 405 || status === 429 || status === 503) return `HTTP ${status}`;
  if (status === 200 && !/listing-card|class="pagination"/.test(text) &&
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

export interface PrRunOptions {
  /** Injected so tests do not wait out the politeness spacing. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget for the run. */
  budgetMs?: number;
}

// ------------------------------------------------------------------ run

export async function runPropertyRoom(ctx: AdapterContext, opts: PrRunOptions = {}): Promise<IngestResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const budgetMs = opts.budgetMs ?? PR_RUN_BUDGET_MS;
  const base = originOf(ctx.source.apiBase) ?? originOf(ctx.source.url) ?? PR_BASE;
  const states = scopeStates(ctx.source);
  const spacing = spacingMs(ctx.source.rateLimitRpm);
  const perRun = pagesPerRun(budgetMs, spacing);
  const startedAt = ctx.now().getTime();

  const warnings: string[] = [];
  const auctions = new Map<string, NormalizedAuction>();
  const lots = new Map<string, NormalizedLot>();
  let httpRequests = 0;
  let bytesIn = 0;
  let outOfScope = 0;

  /** Fetch and ingest one page. null when the page failed (already warned). */
  const fetchPage = async (page: number): Promise<{ pager: PrPager; found: number } | null> => {
    if (httpRequests > 0) await sleep(spacing);
    const res = await ctx.fetch(prListUrl(base, page), { headers: { Accept: 'text/html' } });
    httpRequests++;
    bytesIn += res.text.length;

    const refused = blockReason(res.status, res.text);
    if (refused || res.status < 200 || res.status >= 300) {
      const msg = `PropertyRoom police-auctions page ${page}: ${refused ?? `HTTP ${res.status}`}.`;
      if (page === 1) throw new Error(msg);
      warnings.push(`${msg} Stopped paging.`);
      return null;
    }

    const parsed = parsePrCards(res.text, base);
    for (const w of parsed.warnings) warnings.push(`page ${page}: ${w}`);
    const now = ctx.now();
    for (const card of parsed.cards) {
      // Pickup-only lots outside the configured states are no use to these buyers.
      if (card.location?.state && !states.includes(card.location.state)) {
        outOfScope++;
        continue;
      }
      const { auction, lot } = normalizePrCard(card, now);
      // Pages shift while a sweep runs; the same listing on two pages is one lot.
      auctions.set(auction.externalId, auction);
      lots.set(lot.externalId, lot);
    }
    return { pager: parsePrPager(res.text), found: parsed.found };
  };

  const overBudget = () => ctx.now().getTime() - startedAt + spacing > budgetMs;
  /** Whether a page says more pages follow. No pager at all means a single page. */
  const hasMore = (r: { pager: PrPager; found: number }) =>
    r.pager.hasNext ?? (r.pager.present ? r.found >= PR_PAGE_SIZE : false);

  const first = await fetchPage(1);
  let complete = false;
  let mode: 'sweep' | 'rotate' = 'sweep';
  const maxPage = first ? (first.pager.maxPage ?? 1) : 1;

  if (first && first.found === 0) {
    warnings.push('Page 1 held no listing cards; the list is empty or its markup changed.');
  } else if (first && maxPage <= perRun) {
    // The whole catalogue fits: page until the site says there is no next page.
    let more = hasMore(first);
    let page = 2;
    let failed = false;
    while (more && page <= perRun + 2) {
      if (overBudget()) {
        warnings.push(`Stopped at page ${page - 1} of ${maxPage}: run time budget reached.`);
        failed = true;
        break;
      }
      const r = await fetchPage(page);
      if (!r) {
        failed = true;
        break;
      }
      if (r.found === 0) {
        warnings.push(`Page ${page} held no listing cards before the pager said the list ended.`);
        failed = true;
        break;
      }
      more = hasMore(r);
      page++;
    }
    complete = !failed && !more;
    if (more && !failed) warnings.push(`Stopped at the ${perRun + 1}-page cap with pages still to come.`);
  } else if (first) {
    mode = 'rotate';
    const slotMs = Math.max(5, ctx.source.crawlCadenceMin || 60) * 60_000;
    const plan = planRotatingPages(maxPage, perRun, Math.floor(startedAt / slotMs));
    for (const page of plan) {
      if (overBudget()) {
        warnings.push(`Stopped after ${httpRequests} pages: run time budget reached.`);
        break;
      }
      const r = await fetchPage(page);
      if (!r) break;
      if (r.found === 0) break; // the list shrank below this page since page 1 was read
    }
  }

  const lotList = [...lots.values()];
  ctx.log('info', 'PropertyRoom ingest complete', {
    mode,
    maxPage,
    pagesPerRun: perRun,
    lots: lotList.length,
    outOfScope,
    states,
    httpRequests,
    complete,
    warnings: warnings.length,
  });

  return {
    auctions: [...auctions.values()],
    lots: lotList,
    bids: [], // Cards carry a bid count, not bid history.
    stats: { httpRequests, bytesIn },
    warnings,
    // True only when this run read every police-auction page through the one the
    // site marks as last. A rotating run never is.
    completeSnapshot: complete,
  };
}

export const propertyroomAdapter: Adapter = {
  key: 'propertyroom',
  method: 'html',
  run: (ctx: AdapterContext) => runPropertyRoom(ctx),
};
