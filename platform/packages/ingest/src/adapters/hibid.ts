/**
 * HiBid adapter — one key, 'hibid', for the Wisconsin portal row and for
 * single-tenant rows (one auction house on its *.hibid.com host).
 *
 * EVERYTHING BELOW WAS OBSERVED LIVE ON 2026-09-30 through inspect_url (our own
 * crawler identity, robots.txt checked on every call), and every fixture in
 * test/fixtures/hibid-*-2026-09-30.json is a byte-exact capture. The previous
 * version of this file was written blind around JSON-LD; real HiBid pages carry
 * NO JSON-LD at all, so none of that survived.
 *
 * WHERE THE DATA IS
 *   HiBid is an Angular app. Its server-rendered pages do not contain lot lists
 *   (hibid.com/wisconsin/lots renders "Lots Page of" with an empty grid, and
 *   tenant pages are an 11 KB client-side shell). The browser loads lots from the
 *   site's own GraphQL endpoint, POST https://{host}/graphql, with no login.
 *   robots.txt (User-agent: *) disallows livecatalog, webcast, /auctioneer/,
 *   account, catalog/print, /error/, /auctions/current/map/, past-auction search
 *   and /hibiddemo/. It does not disallow /graphql, /lot/ or /catalog/, and it
 *   sets no Crawl-delay for '*'. Introspection is off; field names below are the
 *   ones the server accepted (GraphQL.NET validation errors named the rest).
 *
 *   Two operations are used, both read-only and both what the site itself runs:
 *     auctionSearch(input:{state,status}, pageNumber, pageLength)
 *     lotSearch(input:{state,status,sortOrder,auctionId,countAsView:false}, ...)
 *   countAsView:false keeps our reads out of HiBid's view counters.
 *
 * SCOPING (verified)
 *   - input.state:"WI" filters by the auction's DECLARED eventState. The
 *     site_subdomain header does NOT scope: sent alone it returned CA, NV, IA
 *     and Ontario lots.
 *   - A tenant host scopes by itself: hameleauctions.hibid.com/graphql returned
 *     only Hamele's 2 auctions and 576 lots.
 *   - The search caps at 10,000: totalCount reads exactly 10000 both nationally
 *     and for WI, while WI's 82 open auctions report 24,565 open lots. A
 *     state-wide lot run therefore can never be a complete snapshot.
 *
 * DATA TRAPS FOUND IN REAL RESPONSES (each one is a test)
 *   1. Lot.bidAmount is the placeholder 123.45 on every lot. The live bid is
 *      lotState.highBid, meaningful only when lotState.bidCount > 0.
 *   2. Auction.bidCloseDateTime / bidOpenDateTime are naive datetimes in US
 *      EASTERN wall-clock, whatever the auction's own zone. For example, Wilkinson
 *      writes "Lots begin closing at 6pm Central" and HiBid sends 19:00. Mathies,
 *      the Iowa sale, Hamele and Hansen KS all agree.
 *   3. lotState.timeLeftTitle ("closes at: 10/1/2026 7:00:36 PM EST") gives the
 *      local daylight wall-clock labelled with the STANDARD abbreviation: in
 *      September "EST" means EDT and "PST" means PDT, as timeLeftSeconds proves.
 *      The label is also not the auction's zone (a Green Bay sale says "EST").
 *      We use it only to compute an instant, cross-checked against
 *      timeLeftSeconds, and never to decide the auction's timezone.
 *   4. quantity can be fractional: a DeForest land lot is 76.85 acres "PER
 *      ACRE". lots.quantity is an integer column, and ingest_batch would reject the
 *      whole chunk, so fractional quantities become null (raw keeps the value).
 *   5. eventAddress can be the auctioneer's own street in another state. Treasure
 *      Vault (West Saint Paul, MN) declares GREEN BAY, WI 54302 at its MN street.
 *      City, state and ZIP are kept as declared; that street line is dropped.
 *   6. Buyer's premium text is free-form ("20% bp added", "10% Buyer  Premium",
 *      "NO BUYER'S PREMIUM"). Terms can contradict it: Hamele's own terms say
 *      both "10% ... with a 3.5% additional fee for credit & debit cards" and
 *      "13.5% Buyer's Premium". Kansas terms say "5% of the purchase price as
 *      down payment", which is not a premium, and sales tax (5.5%) is not a fee.
 *   7. status:OPEN plus TIME_LEFT still returns lots that closed a minute ago,
 *      because the search index lags. lotState.isClosed is authoritative.
 *
 * DEEP LINKS (verified on a real page): https://hibid.com/lot/{id}/{slug} and
 * https://hibid.com/catalog/{auctionId}/{slug}. The slug rule is '&' -> 'and',
 * then every other non-alphanumeric character -> '-', with no collapsing: "Smith &
 * Wesson M&P ..." becomes "smith-and-wesson-mandp-...". /lot/{id} without a slug
 * also returns the page.
 */

import type {
  Adapter,
  AdapterContext,
  AuctionFormat,
  IngestResult,
  NormalizedAuction,
  NormalizedLocation,
  NormalizedLot,
  SourceConfig,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';

// ------------------------------------------------------------------ constants

export const HIBID_PORTAL_HOST = 'hibid.com';
/** Where lot and catalogue deep links point. Verified to serve both shapes. */
export const HIBID_LINK_HOST = 'hibid.com';
/** HiBid's search never pages past this many results (observed totalCount cap). */
export const HIBID_SEARCH_WINDOW = 10_000;
/** The zone HiBid's naive datetimes (bidCloseDateTime, bidOpenDateTime) are in. */
export const HIBID_SERVER_ZONE = 'America/New_York';

export const HIBID_DEFAULTS = {
  /** Lots per request. HiBid's own UI offers 25/50/100. */
  lotPageLength: 100,
  /** Auctions per request. Wisconsin had 82 open auctions: one request. */
  auctionPageLength: 100,
  /** Hard ceiling on requests per run (the brief allows ~60). */
  maxRequests: 45,
  /** Stop paging once this many response bytes have been read. */
  maxBytes: 6_000_000,
  /** Wall-clock budget, so one run stays inside an Edge Function invocation. */
  timeBudgetMs: 100_000,
};

// -------------------------------------------------------------------- queries

export const LOT_SEARCH_QUERY = `query LotSearch($pageNumber: Int!, $pageLength: Int!, $state: String = null, $status: AuctionLotStatus = null, $sortOrder: EventItemSortOrder = null, $auctionId: Int = null, $countAsView: Boolean = false) {
  lotSearch(input: {state: $state, status: $status, sortOrder: $sortOrder, auctionId: $auctionId, countAsView: $countAsView}, pageNumber: $pageNumber, pageLength: $pageLength, sortDirection: ASC) {
    pagedResults {
      pageLength pageNumber totalCount filteredCount
      results {
        id itemId lotNumber lead description quantity estimate pictureCount shippingOffered
        featuredPicture { fullSizeLocation }
        lotState { bidCount highBid minBid status timeLeftSeconds timeLeftTitle isClosed isHidden reserveSatisfied showReserveStatus priceRealized softCloseMinutes biddingExtended buyNow }
        auction { id eventName eventCity eventState eventZip bidType bidCloseDateTime auctioneer { id name state } }
      }
    }
  }
}`;

export const AUCTION_SEARCH_QUERY = `query AuctionSearch($pageNumber: Int!, $pageLength: Int!, $state: String = null, $status: AuctionLotStatus = null) {
  auctionSearch(input: {state: $state, status: $status}, pageNumber: $pageNumber, pageLength: $pageLength) {
    pagedResults {
      pageLength pageNumber totalCount filteredCount
      results {
        auction {
          id eventName description eventCity eventState eventZip eventAddress
          bidOpenDateTime bidCloseDateTime eventDateBegin eventDateEnd eventDateInfo previewDateInfo checkoutDateInfo
          bidType sourceType lotCount currencyAbbreviation
          buyerPremium buyerPremiumRate showBuyerPremium termsAndConditions shippingAndPickupInfo
          auctionState { auctionStatus openLotCount }
          auctioneer { id name address city state postalCode phone internetAddress }
        }
      }
    }
  }
}`;

/** Collapse whitespace so the request body is compact and byte-stable. */
export function compactQuery(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}

export interface LotSearchVars {
  pageNumber: number;
  pageLength: number;
  state?: string | null;
  status?: string | null;
  sortOrder?: string | null;
  auctionId?: number | null;
}

/** The exact request body sent for a lot page (the fixtures were captured with it). */
export function lotSearchBody(v: LotSearchVars): string {
  return JSON.stringify({
    operationName: 'LotSearch',
    variables: {
      pageNumber: v.pageNumber,
      pageLength: v.pageLength,
      state: v.state ?? null,
      status: v.status ?? null,
      sortOrder: v.sortOrder ?? null,
      auctionId: v.auctionId ?? null,
      countAsView: false,
    },
    query: compactQuery(LOT_SEARCH_QUERY),
  });
}

export interface AuctionSearchVars {
  pageNumber: number;
  pageLength: number;
  state?: string | null;
  status?: string | null;
}

export function auctionSearchBody(v: AuctionSearchVars): string {
  return JSON.stringify({
    operationName: 'AuctionSearch',
    variables: {
      pageNumber: v.pageNumber,
      pageLength: v.pageLength,
      state: v.state ?? null,
      status: v.status ?? null,
    },
    query: compactQuery(AUCTION_SEARCH_QUERY),
  });
}

// -------------------------------------------------------------- small helpers

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
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

/** HiBid money is JSON numbers in dollars. Zero and negatives mean "none" here. */
function dollarsToCents(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return parseMoneyToCents(n);
}

/** One line of display text: whitespace collapsed. */
function cleanLine(v: unknown): string | null {
  const s = str(v);
  return s ? s.replace(/\s+/g, ' ').trim() || null : null;
}

/** Multi-line text: CRLF normalised, light HTML stripped, blank runs collapsed. */
export function cleanText(v: unknown): string | null {
  let s = typeof v === 'string' ? v : null;
  if (!s) return null;
  if (/<\s*(br|p|div|li|ul|ol|span|b|strong|i|em|font|table|tr|td)\b[^>]*>/i.test(s)) {
    s = s
      .replace(/<\s*(br|\/p|\/li|\/div|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  }
  const out = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out === '' ? null : out;
}

/** "GREEN BAY" -> "Green Bay", "nekoosa" -> "Nekoosa"; mixed case ("DeForest") kept. */
function tidyCity(v: unknown): string | null {
  const s = cleanLine(v);
  if (!s) return null;
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

/** A state/province code as DECLARED: two letters, upper-cased. Anything else is null. */
function declaredState(v: unknown): string | null {
  const s = cleanLine(v);
  if (!s) return null;
  const up = s.toUpperCase();
  return /^[A-Z]{2}$/.test(up) ? up : null;
}

function postal(v: unknown): string | null {
  const s = cleanLine(v);
  if (!s) return null;
  const us = s.match(/^(\d{5})(?:-?\d{4})?$/);
  if (us) return us[1];
  return s.toUpperCase();
}

// ------------------------------------------------------------------- tenancy

/** A HiBid tenant: one auction house on the shared platform (or the portal). */
export interface HibidTenant {
  host: string;
  /** Stable slug derived from the host. */
  slug: string;
  /** True for *.hibid.com (and hibid.com itself). */
  isHibidSubdomain: boolean;
  /** True for hibid.com / www.hibid.com, the multi-auctioneer portal. */
  isPortal: boolean;
}

/** Derive a tenant from any HiBid-ish URL or bare host. Null for junk. */
export function tenantFromUrl(input: string): HibidTenant | null {
  if (!input || typeof input !== 'string') return null;
  let host: string;
  try {
    host = new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || !host.includes('.')) return null;
  const isPortal = host === 'hibid.com' || host === 'www.hibid.com';
  const isHibidSubdomain = isPortal || host.endsWith('.hibid.com');
  let slug: string;
  if (isPortal) slug = 'hibid-central';
  else if (isHibidSubdomain) slug = host.slice(0, -'.hibid.com'.length);
  else {
    const parts = host.replace(/^www\./, '').split('.');
    slug = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
  }
  return { host: isPortal ? HIBID_PORTAL_HOST : host, slug, isHibidSubdomain, isPortal };
}

export interface HibidScope {
  /** portal: state-filtered search on hibid.com. tenant: one host, all its auctions. */
  mode: 'portal' | 'tenant';
  host: string;
  endpoint: string;
  /** Upper-case two-letter states; ['WI'] when the source declares none. */
  states: string[];
  tenant: HibidTenant;
}

export function normalizeStates(states: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const s of states ?? []) {
    const up = typeof s === 'string' ? s.trim().toUpperCase() : '';
    if (/^[A-Z]{2}$/.test(up) && !out.includes(up)) out.push(up);
  }
  return out.length ? out : ['WI'];
}

/**
 * Decide what one source row means.
 *
 * api_base wins over url, because tenant rows often keep the auction house's
 * own marketing site in url (Hamele: www.hameleauctions.com) while bidding runs
 * on hameleauctions.hibid.com. A custom domain is accepted as a white-label
 * HiBid host ONLY when it is given explicitly in api_base. Guessing that a
 * marketing domain speaks HiBid GraphQL is how bids.beloitauction.com (which is
 * not HiBid at all) would have been POSTed at.
 */
export function resolveScope(
  source: Pick<SourceConfig, 'url' | 'apiBase' | 'states'>,
): { scope: HibidScope | null; error: string | null } {
  const states = normalizeStates(source.states);
  const fromApi = source.apiBase ? tenantFromUrl(source.apiBase) : null;
  if (source.apiBase && !fromApi) {
    return { scope: null, error: `api_base "${source.apiBase}" is not a usable host.` };
  }
  const tenant = fromApi ?? tenantFromUrl(source.url);
  if (!tenant) return { scope: null, error: `url "${source.url}" is not a usable host.` };
  if (!fromApi && !tenant.isHibidSubdomain) {
    return {
      scope: null,
      error:
        `url host ${tenant.host} is not a HiBid host. Set api_base to the auction house's ` +
        `HiBid host (for example https://name.hibid.com).`,
    };
  }
  return {
    scope: {
      mode: tenant.isPortal ? 'portal' : 'tenant',
      host: tenant.host,
      endpoint: `https://${tenant.host}/graphql`,
      states,
      tenant,
    },
    error: null,
  };
}

// ---------------------------------------------------------------- deep links

/** HiBid's own slug rule, verified against a live canonical link. */
export function hibidSlug(text: string | null | undefined): string {
  return (text ?? '').replace(/&/g, 'and').toLowerCase().replace(/[^a-z0-9]/g, '-');
}

export function lotUrl(id: string | number, title?: string | null, host = HIBID_LINK_HOST): string {
  const slug = hibidSlug(title);
  return `https://${host}/lot/${id}${slug ? `/${slug}` : ''}`;
}

export function catalogUrl(id: string | number, name?: string | null, host = HIBID_LINK_HOST): string {
  const slug = hibidSlug(name);
  return `https://${host}/catalog/${id}${slug ? `/${slug}` : ''}`;
}

// ---------------------------------------------------------------------- time

const dtfCache = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  if (dtfCache.has(zone)) return dtfCache.get(zone)!;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    f = null;
  }
  dtfCache.set(zone, f);
  return f;
}

/** Offset of `zone` from UTC at an instant, in ms (e.g. -18000000 for CDT). */
export function zoneOffsetMs(zone: string, utcMs: number): number | null {
  const f = zoneFormatter(zone);
  if (!f || !Number.isFinite(utcMs)) return null;
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  const wholeSecond = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return asUtc - wholeSecond;
}

/** A wall-clock time in an IANA zone -> epoch ms. DST decided by the zone's rules. */
export function zonedWallTimeToUtcMs(
  y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string,
): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) {
    return null;
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = zoneOffsetMs(zone, wall);
  if (o1 === null) return null;
  let utc = wall - o1;
  const o2 = zoneOffsetMs(zone, utc);
  if (o2 === null) return null;
  if (o2 !== o1) utc = wall - o2;
  return utc;
}

/** ISO-8601 with the zone's own offset ("2026-10-01T18:00:36-05:00"); UTC 'Z' without a zone. */
export function formatIsoInZone(ms: number, zone: string | null | undefined): string {
  const off = zone ? zoneOffsetMs(zone, ms) : null;
  if (off === null) return new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const local = new Date(Math.round(ms / 1000) * 1000 + off);
  const pad = (n: number) => String(n).padStart(2, '0');
  const abs = Math.abs(off) / 60000;
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * HiBid's naive auction datetimes are US-Eastern wall clock (trap 2). A value
 * that already carries an offset is taken at face value, in case HiBid adds one.
 */
export function hibidNaiveToMs(v: unknown): number | null {
  const t = str(v);
  if (!t) return null;
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(t)) {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return zonedWallTimeToUtcMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), HIBID_SERVER_ZONE);
}

/**
 * Abbreviation -> the zone FAMILY whose wall clock the title shows. The S/D
 * letter is ignored on purpose (trap 3), because the zone's own DST rules decide.
 */
const ZONE_BY_ABBR: Record<string, string> = {
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver',
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  AST: 'America/Halifax', ADT: 'America/Halifax',
  NST: 'America/St_Johns', NDT: 'America/St_Johns',
};

const TITLE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)\s+([A-Z]{2,4})\b/i;

/** "Internet Bidding closes at: 10/1/2026 7:00:36 PM EST" -> instant + zone family. */
export function parseTimeLeftTitle(title: unknown): { ms: number; zone: string; abbr: string } | null {
  const t = str(title);
  if (!t) return null;
  const m = t.match(TITLE_RE);
  if (!m) return null;
  const abbr = m[8].toUpperCase();
  const zone = ZONE_BY_ABBR[abbr];
  if (!zone) return null;
  const hour12 = +m[4];
  if (hour12 < 1 || hour12 > 12) return null;
  const h = (hour12 % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  const ms = zonedWallTimeToUtcMs(+m[3], +m[1], +m[2], h, +m[5], +(m[6] ?? 0), zone);
  return ms === null ? null : { ms, zone, abbr };
}

/** How far the title and timeLeftSeconds may disagree before we trust the latter. */
export const CLOSE_TIME_TOLERANCE_MS = 120_000;

export interface CloseInstant {
  ms: number;
  source: 'title' | 'timeLeftSeconds';
  /** Set when both were present and disagreed beyond tolerance. */
  disagreementMs?: number;
}

/**
 * The per-lot close instant. HiBid staggers closes (9 s apart at Hamele, 2 min
 * apart at Treasure Vault), so the auction-level time is never used for a lot.
 *
 * The title's wall-clock is exact to the second. timeLeftSeconds is exact too
 * but relative to when HiBid answered, so it carries our request latency. The
 * title wins when the two agree. When they disagree, which would mean our zone
 * reading is wrong, the relative time wins because it assumes nothing.
 */
export function lotCloseInstant(lotState: unknown, fetchedAtMs: number | null): CloseInstant | null {
  const ls = rec(lotState);
  if (!ls) return null;
  const titled = parseTimeLeftTitle(ls.timeLeftTitle);
  const secs = num(ls.timeLeftSeconds);
  const rel = secs !== null && fetchedAtMs !== null ? Math.round((fetchedAtMs + secs * 1000) / 1000) * 1000 : null;
  if (titled && rel !== null) {
    const diff = titled.ms - rel;
    if (Math.abs(diff) <= CLOSE_TIME_TOLERANCE_MS) return { ms: titled.ms, source: 'title' };
    return { ms: rel, source: 'timeLeftSeconds', disagreementMs: diff };
  }
  if (titled) return { ms: titled.ms, source: 'title' };
  if (rel !== null) return { ms: rel, source: 'timeLeftSeconds' };
  return null;
}

/**
 * IANA zone for a DECLARED state, but only where the whole state shares one
 * zone. Split states (KS, TX, FL, MI, IN, ...) return null rather than a guess:
 * Beloit KS is Central, but Sherman County KS is Mountain.
 */
const SINGLE_ZONE_STATES: Record<string, string> = {
  WI: 'America/Chicago', MN: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago',
  MO: 'America/Chicago', AR: 'America/Chicago', LA: 'America/Chicago', MS: 'America/Chicago',
  AL: 'America/Chicago', OK: 'America/Chicago',
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', GA: 'America/New_York',
  ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', NH: 'America/New_York',
  NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VT: 'America/New_York',
  VA: 'America/New_York', WV: 'America/New_York',
  CO: 'America/Denver', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver',
  WY: 'America/Denver',
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  HI: 'Pacific/Honolulu',
};

export function zoneForState(state: string | null | undefined): string | null {
  return state ? SINGLE_ZONE_STATES[state.toUpperCase()] ?? null : null;
}

// ------------------------------------------------------- premium and card fee

const PCT = '(\\d{1,2}(?:\\.\\d{1,2})?)\\s*%';
const BUYER = "(?:buyer'?s?|buyers)";
const BP_PATTERNS = [
  new RegExp(`${PCT}\\s*(?:online\\s+)?${BUYER}\\s*(?:premium|fee)`, 'gi'),
  new RegExp(`${BUYER}\\s*(?:premium|fee)\\s*(?:of|is|:|-|–)?\\s*${PCT}`, 'gi'),
  new RegExp(`${PCT}\\s*bp\\b`, 'gi'),
];
const NO_BP = new RegExp(`\\bno\\s+${BUYER}\\s*(?:premium|fee)|\\bno\\s+bp\\b`, 'i');

function normalizeTerms(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Buyer's premium from one piece of text. Returns 0 for an explicit "no
 * buyer's premium" and null when nothing unambiguous is found, because a
 * confidently wrong premium makes the total look authoritative.
 */
export function extractBuyerPremium(text: string | null | undefined): { pct: number; note: string } | null {
  if (!text) return null;
  const hay = normalizeTerms(text);
  let best: { pct: number; note: string; at: number } | null = null;
  for (const re of BP_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(hay);
    if (m) {
      const pct = Number(m[1]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 35 && (!best || m.index < best.at)) {
        best = { pct, note: m[0].trim(), at: m.index };
      }
    }
  }
  if (best) return { pct: best.pct, note: best.note };
  const none = hay.match(NO_BP);
  return none ? { pct: 0, note: none[0].trim() } : null;
}

/** Every premium percentage a text states, in order and without duplicates. */
export function extractAllBuyerPremiums(text: string | null | undefined): number[] {
  if (!text) return [];
  const hay = normalizeTerms(text);
  const found: { pct: number; at: number }[] = [];
  for (const re of BP_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hay)) !== null) {
      const pct = Number(m[1]);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 35) found.push({ pct, at: m.index });
    }
  }
  const out: number[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) if (!out.includes(f.pct)) out.push(f.pct);
  return out;
}

/**
 * Card or convenience surcharge, which stacks on the premium.
 *
 * Only sentences that mention a card are read. In them, a percentage followed
 * by buyer/premium/BP is the premium, one followed by sales/tax is tax, and one
 * followed by "if using a credit card" is the premium's CARD RATE (Hamele: "10%
 * Buyers Fee 13.5% if using a Credit Card"), so the fee is the difference.
 */
export function extractCardFee(
  text: string | null | undefined,
  premiumPct: number | null = null,
): { pct: number; note: string } | null {
  if (!text) return null;
  const sentences = text
    .replace(/[‘’ʼ]/g, "'")
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /\b(credit|debit|card|cards)\b/i.test(s));
  let cardRate: { pct: number; note: string } | null = null;
  for (const s of sentences) {
    const re = /(\d{1,2}(?:\.\d{1,2})?)\s*%/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const pct = Number(m[1]);
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 45).toLowerCase();
      const before = s.slice(Math.max(0, m.index - 25), m.index).toLowerCase();
      if (/^\s*(online\s+)?(buyer|bp\b|premium)/.test(after)) continue;
      if (/^\s*(sales|tax|county|state|down payment|of the purchase)/.test(after) || /tax\s*(of|:)?\s*$/.test(before)) continue;
      if (/per month|interest/.test(after)) continue;
      if (/^\s*if\s+(using|paying|you\s+pay)|^\s*(when|for)\s+(using|paying)/.test(after)) {
        if (Number.isFinite(pct)) cardRate = cardRate ?? { pct, note: s };
        continue;
      }
      if (/(fee|surcharge|charge|convenience|processing|additional)/.test(after) && pct > 0 && pct <= 10) {
        return { pct, note: s.length > 200 ? `${s.slice(0, 197)}...` : s };
      }
    }
  }
  if (cardRate && premiumPct !== null && cardRate.pct > premiumPct) {
    const diff = Math.round((cardRate.pct - premiumPct) * 100) / 100;
    if (diff > 0 && diff <= 10) return { pct: diff, note: cardRate.note };
  }
  return null;
}

export interface PremiumInfo {
  pct: number | null;
  source: 'rate' | 'field' | 'terms' | null;
  note: string | null;
  cardFeePct: number | null;
  /** Other premium percentages the terms state, shown rather than hidden. */
  alsoStated: number[];
}

/**
 * The auction's premium, from the most machine-like evidence down.
 *
 * buyerPremiumRate (1.15 = 15%) is what HiBid applies when showBuyerPremium is
 * true. Otherwise the auctioneer's short buyerPremium text wins, and the terms
 * are the fallback. Anything else the terms say is surfaced in the note, never
 * silently dropped. Hamele's terms say both 10% and 13.5%.
 */
export function buyerPremiumFor(auction: Rec): PremiumInfo {
  const field = str(auction.buyerPremium);
  const terms = [str(auction.termsAndConditions), str(auction.description)].filter(Boolean).join('\n');
  const rate = num(auction.buyerPremiumRate);
  const ratePct =
    auction.showBuyerPremium === true && rate !== null && rate > 1 && rate < 1.36
      ? Math.round((rate - 1) * 10000) / 100
      : null;
  const fromField = extractBuyerPremium(field);
  const fromTerms = extractBuyerPremium(terms);

  let pct: number | null = null;
  let source: PremiumInfo['source'] = null;
  if (ratePct !== null) {
    pct = ratePct;
    source = 'rate';
  } else if (fromField) {
    pct = fromField.pct;
    source = 'field';
  } else if (fromTerms) {
    pct = fromTerms.pct;
    source = 'terms';
  }

  const card = extractCardFee(terms, pct);
  const cardFeePct = card?.pct ?? null;
  const alsoStated = extractAllBuyerPremiums(terms).filter(
    (p) => p !== pct && !(cardFeePct !== null && pct !== null && Math.abs(p - (pct + cardFeePct)) < 0.001),
  );

  const parts: string[] = [];
  if (field) parts.push(field.replace(/\s+/g, ' '));
  else if (pct !== null) parts.push(`${pct}% buyer's premium`);
  if (source === 'rate' && fromField && fromField.pct !== pct) parts.push(`HiBid applies ${pct}%`);
  if (cardFeePct !== null) parts.push(`+${cardFeePct}% card fee`);
  if (alsoStated.length) parts.push(`terms also state ${alsoStated.map((p) => `${p}%`).join(', ')}`);

  return { pct, source, note: parts.length ? parts.join('; ') : null, cardFeePct, alsoStated };
}

// ------------------------------------------------------------------- parsing

export interface HibidPage {
  results: Rec[];
  pageLength: number | null;
  pageNumber: number | null;
  totalCount: number | null;
  filteredCount: number | null;
}

/**
 * One GraphQL response -> the page it holds. Never throws: a body that is not
 * JSON (an HTML challenge, a proxy error) or that carries GraphQL errors comes
 * back as `errors`, and malformed result entries are counted, not fatal.
 */
export function parseGraphqlPage(
  body: string,
  field: 'lotSearch' | 'auctionSearch',
): { page: HibidPage | null; errors: string[]; dropped: number } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    const head = (body ?? '').slice(0, 80).replace(/\s+/g, ' ');
    return { page: null, errors: [`response was not JSON (starts "${head}")`], dropped: 0 };
  }
  const root = rec(json);
  const errors: string[] = [];
  if (root && Array.isArray(root.errors)) {
    for (const e of root.errors) {
      const msg = str(rec(e)?.message);
      if (msg) errors.push(msg);
    }
  }
  const paged = rec(rec(rec(root?.data)?.[field])?.pagedResults);
  if (!paged) {
    if (!errors.length) errors.push(`response had no data.${field}.pagedResults`);
    return { page: null, errors, dropped: 0 };
  }
  const raw = Array.isArray(paged.results) ? paged.results : [];
  const results: Rec[] = [];
  let dropped = 0;
  for (const r of raw) {
    const o = rec(r);
    if (o) results.push(o);
    else dropped++;
  }
  if (!Array.isArray(paged.results)) errors.push(`data.${field}.pagedResults.results was not a list`);
  return {
    page: {
      results,
      pageLength: num(paged.pageLength),
      pageNumber: num(paged.pageNumber),
      totalCount: num(paged.totalCount),
      filteredCount: num(paged.filteredCount),
    },
    errors,
    dropped,
  };
}

/** "35.00 - 350.00 USD" -> cents. "" -> nulls. */
export function parseEstimate(v: unknown): { low: number | null; high: number | null } {
  const s = str(v);
  if (!s) return { low: null, high: null };
  const range = s.match(/([\d.,]+)\s*[-–]\s*([\d.,]+)/);
  if (range) {
    const low = parseMoneyToCents(range[1]);
    const high = parseMoneyToCents(range[2]);
    return { low: low || null, high: high || null };
  }
  const one = parseMoneyToCents(s);
  return { low: one || null, high: one || null };
}

/** HiBid bidType -> our format. SIMULCAST and ABSENTEE end in a live sale. */
export function formatFromBidType(bidType: unknown): AuctionFormat {
  const t = (str(bidType) ?? '').toUpperCase();
  if (t === 'INTERNET_ONLY' || t === 'ONLINE_ONLY') return 'online';
  if (t === 'SIMULCAST' || t === 'WEBCAST' || t === 'ABSENTEE') return 'hybrid';
  if (t.includes('LISTING') || t === 'LIVE') return 'live';
  return 'online';
}

/**
 * Pickup location exactly as the auction DECLARES it: eventCity, eventState and
 * eventZip. The state is never inferred (Beloit exists in WI and KS). The street
 * line is dropped when it is just the auctioneer's own address filed under
 * another city (trap 5), because that combination is a place that does not exist.
 */
export function pickupFromAuction(a: Rec): { pickup: NormalizedLocation | null; droppedLine1: string | null } {
  const city = tidyCity(a.eventCity);
  const state = declaredState(a.eventState);
  const postalCode = postal(a.eventZip);
  let line1 = cleanLine(a.eventAddress);
  let droppedLine1: string | null = null;
  const auctioneer = rec(a.auctioneer);
  if (line1 && auctioneer) {
    const aAddr = cleanLine(auctioneer.address)?.toLowerCase();
    const aCity = cleanLine(auctioneer.city)?.toLowerCase();
    if (aAddr && aAddr === line1.toLowerCase() && city && aCity && aCity !== city.toLowerCase()) {
      droppedLine1 = line1;
      line1 = null;
    }
  }
  if (!city && !state && !postalCode && !line1) return { pickup: null, droppedLine1 };
  return {
    pickup: { line1, city, state, postalCode, ambiguous: !!city && !state },
    droppedLine1,
  };
}

const NO_SHIP_RE =
  /\b(no shipping|shipping is not offered|not offer(?:ed)? shipping|do not ship|we do not provide shipping|does not ship|local pick-?up only|pick-?up only)\b/i;
const SHIP_RE =
  /\b(shipping (?:is )?(?:now )?availab|shipping available|will be shipped|we ship\b|ships to|shipped by)/i;
const NO_PICKUP_RE = /\b(there is no pick ?-?up|no pick ?-?up for any|all lots (?:are|will be) shipped)\b/i;

export interface AuctionNormalized {
  auction: NormalizedAuction | null;
  issues: string[];
  droppedLine1: string | null;
}

/** One auctionSearch result (or its inner auction object) -> NormalizedAuction. */
export function normalizeHibidAuction(input: unknown, opts: { linkHost?: string } = {}): AuctionNormalized {
  const wrapper = rec(input);
  const a = rec(wrapper?.auction) ?? wrapper;
  if (!a) return { auction: null, issues: ['auction entry was not an object'], droppedLine1: null };
  const id = str(a.id);
  if (!id || !/^\d+$/.test(id)) return { auction: null, issues: ['auction without a numeric id'], droppedLine1: null };

  const issues: string[] = [];
  const eventName = cleanLine(a.eventName);
  const state = declaredState(a.eventState);
  const timezone = zoneForState(state);
  const { pickup, droppedLine1 } = pickupFromAuction(a);
  if (droppedLine1) issues.push('pickup street dropped: it is the auctioneer address in another city');

  const startMs = hibidNaiveToMs(a.bidOpenDateTime);
  const closeMs = hibidNaiveToMs(a.bidCloseDateTime);
  const premium = buyerPremiumFor(a);
  const shipInfo = cleanText(a.shippingAndPickupInfo);
  const logistics = `${str(a.shippingAndPickupInfo) ?? ''}\n${str(a.termsAndConditions) ?? ''}`;
  const ships = NO_SHIP_RE.test(shipInfo ?? '') ? false
    : SHIP_RE.test(logistics) ? true
    : NO_SHIP_RE.test(logistics) ? false
    : undefined;
  const pickupRequired = NO_PICKUP_RE.test(logistics) ? false : ships === false ? true : undefined;

  const auctioneer = rec(a.auctioneer);
  const auctioneerName = cleanLine(auctioneer?.name);
  const auctionState = rec(a.auctionState);

  const auction: NormalizedAuction = {
    externalId: id,
    title: eventName ?? `HiBid auction ${id}`,
    description: cleanText(a.description),
    auctioneer: auctioneerName,
    url: catalogUrl(id, eventName, opts.linkHost),
    format: formatFromBidType(a.bidType),
    startsAt: startMs !== null ? formatIsoInZone(startMs, timezone) : null,
    // HiBid's bidCloseDateTime is when lots BEGIN closing; each lot's own
    // closesAt is authoritative. The meaning is recorded in raw._meta.
    endsAt: closeMs !== null ? formatIsoInZone(closeMs, timezone) : null,
    timezone,
    pickup,
    ...(pickupRequired !== undefined ? { pickupRequired } : {}),
    ...(ships !== undefined ? { ships } : {}),
    shipsNote: shipInfo ? (shipInfo.length > 2000 ? `${shipInfo.slice(0, 1997)}...` : shipInfo) : null,
    sellerName: auctioneerName,
    // The SELLING house's state (Treasure Vault is MN), never the pickup state.
    sellerState: declaredState(auctioneer?.state),
    lotCount: num(a.lotCount),
    currency: cleanLine(a.currencyAbbreviation)?.toUpperCase() ?? 'USD',
    buyerPremiumPct: premium.pct,
    buyerPremiumNote: premium.note,
    termsUrl: null,
    raw: {
      ...a,
      _meta: {
        source: 'hibid',
        endsAtMeaning: 'first lot close (HiBid bidCloseDateTime, US-Eastern wall clock); lots close in sequence after it',
        bidCloseDateTimeEastern: str(a.bidCloseDateTime),
        timezoneSource: timezone ? 'declared state (single-zone)' : null,
        buyerPremiumSource: premium.source,
        cardFeePct: premium.cardFeePct,
        premiumAlsoStated: premium.alsoStated,
        bidType: str(a.bidType),
        auctionStatus: str(auctionState?.auctionStatus),
        openLotCount: num(auctionState?.openLotCount),
        pickupLine1Dropped: droppedLine1,
        auctioneerId: str(auctioneer?.id),
      },
    },
  };
  return { auction, issues, droppedLine1 };
}

/**
 * A minimal auction from the few fields a lot carries, for the rare lot whose
 * auction did not come back from auctionSearch (an auction that opened
 * mid-run, or search-index lag). It stays thin rather than invented.
 */
export function auctionFromLot(lotAuction: unknown, opts: { linkHost?: string } = {}): NormalizedAuction | null {
  const a = rec(lotAuction);
  const id = str(a?.id);
  if (!a || !id) return null;
  const state = declaredState(a.eventState);
  const timezone = zoneForState(state);
  const closeMs = hibidNaiveToMs(a.bidCloseDateTime);
  const city = tidyCity(a.eventCity);
  const postalCode = postal(a.eventZip);
  const auctioneer = rec(a.auctioneer);
  const name = cleanLine(a.eventName);
  return {
    externalId: id,
    title: name ?? `HiBid auction ${id}`,
    description: null,
    auctioneer: cleanLine(auctioneer?.name),
    url: catalogUrl(id, name, opts.linkHost),
    format: formatFromBidType(a.bidType),
    startsAt: null,
    endsAt: closeMs !== null ? formatIsoInZone(closeMs, timezone) : null,
    timezone,
    pickup: city || state || postalCode ? { line1: null, city, state, postalCode, ambiguous: !!city && !state } : null,
    sellerName: cleanLine(auctioneer?.name),
    sellerState: declaredState(auctioneer?.state),
    lotCount: null,
    currency: 'USD',
    buyerPremiumPct: null,
    buyerPremiumNote: null,
    termsUrl: null,
    raw: { ...a, _meta: { source: 'hibid', builtFromLot: true } },
  };
}

export interface LotNormalized {
  lot: NormalizedLot | null;
  issues: string[];
  closeDisagreement: boolean;
  fractionalQuantity: boolean;
}

/**
 * One lotSearch result -> NormalizedLot.
 *
 * Money: highBid is the current bid only when bidCount > 0 ("no bids" is not
 * $0). minBid is HiBid's own next acceptable bid, which is the opening bid when
 * there are no bids. bidAmount is ignored because it is a placeholder (trap 1).
 */
export function normalizeHibidLot(
  input: unknown,
  opts: {
    fetchedAtMs: number | null;
    timezone?: string | null;
    pickup?: NormalizedLocation | null;
    linkHost?: string;
  },
): LotNormalized {
  const r = rec(input);
  const empty = (issue: string): LotNormalized => ({ lot: null, issues: [issue], closeDisagreement: false, fractionalQuantity: false });
  if (!r) return empty('lot entry was not an object');
  const id = str(r.id);
  if (!id || !/^\d+$/.test(id)) return empty('lot without a numeric id');

  const description = cleanText(r.description);
  const title = cleanLine(r.lead) ?? (description ? cleanLine(description.split('\n')[0].slice(0, 140)) : null);
  if (!title) return empty(`lot ${id} has no title`);

  const issues: string[] = [];
  const ls = rec(r.lotState) ?? {};
  const status = (str(ls.status) ?? '').toUpperCase();
  const closed = ls.isClosed === true || status === 'CLOSED';
  const bidCountRaw = num(ls.bidCount);
  const bidCount = bidCountRaw !== null && bidCountRaw >= 0 ? Math.trunc(bidCountRaw) : null;
  const high = dollarsToCents(ls.highBid);
  const min = dollarsToCents(ls.minBid);
  const currentBidCents = bidCount === 0 ? null : high;
  const realized = dollarsToCents(ls.priceRealized);

  const qRaw = num(r.quantity);
  const fractionalQuantity = qRaw !== null && !Number.isInteger(qRaw);
  const quantity = qRaw !== null && Number.isInteger(qRaw) && qRaw >= 1 ? qRaw : null;
  if (fractionalQuantity) issues.push(`lot ${id} quantity ${qRaw} is not a whole number (bid is per unit)`);

  const estimate = parseEstimate(r.estimate);
  const close = lotCloseInstant(ls, opts.fetchedAtMs);
  const auctionRec = rec(r.auction);
  const auctionId = str(auctionRec?.id);
  const picture = str(rec(r.featuredPicture)?.fullSizeLocation);

  const lot: NormalizedLot = {
    externalId: id,
    auctionExternalId: auctionId,
    lotNumber: cleanLine(r.lotNumber),
    title,
    description,
    quantity,
    startingBidCents: !closed && bidCount === 0 ? min : null,
    currentBidCents,
    nextBidCents: closed ? null : min,
    estimateLowCents: estimate.low,
    estimateHighCents: estimate.high,
    soldPriceCents: closed && (bidCount ?? 0) > 0 ? realized : null,
    bidCount,
    reserveMet: ls.showReserveStatus === true && typeof ls.reserveSatisfied === 'boolean' ? ls.reserveSatisfied : null,
    closesAt: close ? formatIsoInZone(close.ms, opts.timezone ?? null) : null,
    closed,
    url: lotUrl(id, title, opts.linkHost),
    pickup: opts.pickup ?? null,
    ships: r.shippingOffered === true,
    images: picture && /^https?:\/\//i.test(picture) ? [{ url: picture, position: 0 }] : [],
    raw: {
      ...r,
      _meta: {
        source: 'hibid',
        status: status || null,
        closeTimeSource: close?.source ?? null,
        closeTimeDisagreementMs: close?.disagreementMs ?? null,
        closeTimePrecise: !!close,
        softCloseMinutes: num(ls.softCloseMinutes),
        biddingExtended: ls.biddingExtended === true,
        quantity: qRaw,
        bidIsPerUnit: fractionalQuantity || (qRaw !== null && qRaw > 1),
        pictureCount: num(r.pictureCount),
        buyNowCents: dollarsToCents(ls.buyNow),
        bidAmountIgnored: 'HiBid bidAmount is a 123.45 placeholder; highBid is used',
        fetchedAt: opts.fetchedAtMs !== null ? new Date(opts.fetchedAtMs).toISOString() : null,
      },
    },
  };
  return { lot, issues, closeDisagreement: close?.disagreementMs !== undefined, fractionalQuantity };
}

// ---------------------------------------------------------------------- run

export interface HibidRunOptions {
  lotPageLength?: number;
  auctionPageLength?: number;
  maxRequests?: number;
  maxBytes?: number;
  timeBudgetMs?: number;
  /** Minimum gap between requests; defaults to 60000 / source.rateLimitRpm. */
  minIntervalMs?: number;
  /** Injected in tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

class HibidBlockedError extends Error {}

function looksLikeChallenge(status: number, headers: Record<string, string>, text: string): boolean {
  if ((headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return true;
  const head = text.slice(0, 20_000);
  return /<title>\s*(just a moment|attention required)|window\._cf_chl_opt|challenge-platform\/[^"'\s]*orchestrate\//i.test(head) ||
    ((status === 403 || status === 503) && /cloudflare/i.test(head));
}

/**
 * Ingest one source row.
 *
 * portal: for each state, auctionSearch (all open auctions, usually one
 *   request) then lotSearch ordered by time left, soonest first, until the
 *   budget runs out. Never a complete snapshot: the search stops at 10,000
 *   results, and a moving sort key lets lots slip between pages mid-run.
 * tenant: auctionSearch on the tenant host, then every in-scope auction's lots
 *   in catalogue order, which is a stable enumeration. It is a complete
 *   snapshot when every page was read.
 */
export async function runHibid(ctx: AdapterContext, options: HibidRunOptions = {}): Promise<IngestResult> {
  const { scope, error } = resolveScope(ctx.source);
  if (!scope) throw new Error(`HiBid source ${ctx.source.slug}: ${error}`);

  const o = { ...HIBID_DEFAULTS, ...options };
  const rpm = ctx.source.rateLimitRpm > 0 ? ctx.source.rateLimitRpm : 20;
  const minInterval = options.minIntervalMs ?? Math.ceil(60_000 / rpm);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const started = Date.now();
  let lastRequestAt = 0;
  let requests = 0;
  let bytes = 0;
  let succeeded = 0;

  const warnings: string[] = [];
  const auctions = new Map<string, NormalizedAuction>();
  const lots = new Map<string, NormalizedLot>();
  const tally = {
    lotIssues: 0,
    lotDropped: 0,
    fractional: 0,
    disagreements: 0,
    fallbackAuctions: 0,
    outOfScopeAuctions: new Map<string, number>(),
    outOfScopeLots: 0,
    undeclaredState: 0,
    droppedStreets: 0,
    entryDropped: 0,
  };
  let complete = scope.mode === 'tenant';
  let stopReason: string | null = null;

  const budgetLeft = (): string | null => {
    if (requests >= o.maxRequests) return `request budget (${o.maxRequests})`;
    if (bytes >= o.maxBytes) return `byte budget (${Math.round(o.maxBytes / 1e6)} MB)`;
    if (Date.now() - started >= o.timeBudgetMs) return `time budget (${Math.round(o.timeBudgetMs / 1000)} s)`;
    return null;
  };

  async function post(field: 'lotSearch' | 'auctionSearch', body: string, what: string) {
    const wait = lastRequestAt + minInterval - Date.now();
    if (lastRequestAt && wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await ctx.fetch(scope!.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
    });
    requests++;
    bytes += res.text.length;
    const fetchedAtMs = ctx.now().getTime();
    if (res.status === 429) throw new Error(`HiBid rate limit (HTTP 429) on ${what}; back off.`);
    if (res.status === 401 || res.status === 403 || looksLikeChallenge(res.status, res.headers ?? {}, res.text)) {
      // A refusal of our honest identity is an answer, not a problem to solve.
      throw new HibidBlockedError(
        `HiBid refused WaystockBot on ${what} (HTTP ${res.status}${looksLikeChallenge(res.status, res.headers ?? {}, res.text) ? ', challenge page' : ''}). ` +
          'Treat as blocked: do not retry; record it and route the source to deeplink_only.',
      );
    }
    const parsed = parseGraphqlPage(res.text, field);
    if (res.status >= 500 || (res.status >= 400 && !parsed.errors.length)) parsed.errors.unshift(`HTTP ${res.status}`);
    if (parsed.page) succeeded++;
    tally.entryDropped += parsed.dropped;
    return { ...parsed, fetchedAtMs };
  }

  /** Page through one query. Returns whether the listing was read to its end. */
  async function pageThrough(
    field: 'lotSearch' | 'auctionSearch',
    body: (pageNumber: number) => string,
    pageLength: number,
    label: string,
    onPage: (page: HibidPage, fetchedAtMs: number) => void,
    requestCap = Infinity,
  ): Promise<{ ended: boolean; capped: boolean; seen: number; total: number | null }> {
    let seen = 0;
    let total: number | null = null;
    for (let pageNumber = 1; pageNumber <= Math.ceil(HIBID_SEARCH_WINDOW / pageLength); pageNumber++) {
      const over = budgetLeft() ?? (requests >= requestCap ? 'this scope\'s share of the request budget' : null);
      if (over) {
        stopReason = stopReason ?? over;
        return { ended: false, capped: total !== null && total >= HIBID_SEARCH_WINDOW, seen, total };
      }
      const r = await post(field, body(pageNumber), `${label} page ${pageNumber}`);
      if (!r.page) {
        const msg = `${label} page ${pageNumber}: ${r.errors.join('; ')}`;
        if (succeeded === 0) throw new Error(`HiBid ${msg}`);
        warnings.push(`${msg}. Stopped paging ${label}; this run is not complete.`);
        return { ended: false, capped: false, seen, total };
      }
      if (r.errors.length) warnings.push(`${label} page ${pageNumber} returned errors alongside data: ${r.errors.join('; ')}`);
      onPage(r.page, r.fetchedAtMs);
      seen += r.page.results.length;
      total = r.page.filteredCount ?? r.page.totalCount ?? total;
      const capped = total !== null && total >= HIBID_SEARCH_WINDOW;
      if (r.page.results.length < pageLength) {
        if (total !== null && seen < Math.min(total, HIBID_SEARCH_WINDOW)) {
          warnings.push(`${label}: HiBid reported ${total} but the last page ended after ${seen}; treated as incomplete.`);
          return { ended: false, capped, seen, total };
        }
        return { ended: true, capped, seen, total };
      }
      if (total !== null && pageNumber * pageLength >= Math.min(total, HIBID_SEARCH_WINDOW)) {
        return { ended: !capped, capped, seen, total };
      }
    }
    return { ended: false, capped: true, seen, total };
  }

  const inScope = (state: string | null) => state !== null && scope.states.includes(state);

  function addAuction(entry: Rec): NormalizedAuction | null {
    const n = normalizeHibidAuction(entry);
    if (!n.auction) {
      tally.entryDropped++;
      return null;
    }
    const st = n.auction.pickup?.state ?? null;
    if (!st) {
      tally.undeclaredState++;
      return null;
    }
    if (!inScope(st)) {
      tally.outOfScopeAuctions.set(st, (tally.outOfScopeAuctions.get(st) ?? 0) + 1);
      return null;
    }
    if (n.droppedLine1) tally.droppedStreets++;
    auctions.set(n.auction.externalId, n.auction);
    return n.auction;
  }

  function addLots(page: HibidPage, fetchedAtMs: number) {
    for (const entry of page.results) {
      const lotAuction = rec(entry.auction);
      if (!lotAuction) {
        // Without its auction a lot has no declared state, so it cannot be scoped.
        tally.lotDropped++;
        continue;
      }
      const aid = str(lotAuction.id);
      let auction = aid ? auctions.get(aid) ?? null : null;
      if (!auction) {
        const declared = declaredState(lotAuction.eventState);
        if (!inScope(declared)) {
          tally.outOfScopeLots++;
          continue;
        }
        auction = auctionFromLot(lotAuction);
        if (auction) {
          auctions.set(auction.externalId, auction);
          tally.fallbackAuctions++;
        }
      }
      const n = normalizeHibidLot(entry, {
        fetchedAtMs,
        timezone: auction?.timezone ?? null,
        pickup: auction?.pickup ?? null,
      });
      if (!n.lot) {
        tally.lotDropped++;
        continue;
      }
      if (n.issues.length) tally.lotIssues++;
      if (n.fractionalQuantity) tally.fractional++;
      if (n.closeDisagreement) tally.disagreements++;
      lots.set(n.lot.externalId, n.lot); // later pages win: they are fresher
    }
  }

  if (scope.mode === 'portal') {
    for (let i = 0; i < scope.states.length; i++) {
      const state = scope.states[i];
      const a = await pageThrough(
        'auctionSearch',
        (p) => auctionSearchBody({ pageNumber: p, pageLength: o.auctionPageLength, state, status: 'OPEN' }),
        o.auctionPageLength,
        `${state} auctions`,
        (page) => page.results.forEach(addAuction),
      );
      if (!a.ended && a.total !== null && a.seen < a.total) {
        warnings.push(`${state}: read ${a.seen} of ${a.total} open auctions.`);
      }
      const share = requests + Math.floor((o.maxRequests - requests) / (scope.states.length - i));
      const l = await pageThrough(
        'lotSearch',
        (p) => lotSearchBody({ pageNumber: p, pageLength: o.lotPageLength, state, status: 'OPEN', sortOrder: 'TIME_LEFT' }),
        o.lotPageLength,
        `${state} lots`,
        addLots,
        share,
      );
      if (l.capped) {
        warnings.push(
          `${state}: HiBid reports ${l.total} open lots, its search maximum; lots beyond the first ` +
            `${HIBID_SEARCH_WINDOW} by closing time are unreachable in one pass.`,
        );
      }
      if (!l.ended && stopReason) {
        warnings.push(
          `${state}: read ${l.seen} open lots (soonest-closing first) of ${l.total ?? 'unknown'}; ` +
            `stopped at the ${stopReason}. Later-closing lots are picked up as they approach their close.`,
        );
      }
    }
    complete = false; // see the doc comment: a portal pass is never a full snapshot
  } else {
    const a = await pageThrough(
      'auctionSearch',
      (p) => auctionSearchBody({ pageNumber: p, pageLength: o.auctionPageLength, status: 'OPEN' }),
      o.auctionPageLength,
      `${scope.host} auctions`,
      (page) => page.results.forEach(addAuction),
    );
    if (!a.ended) complete = false;
    const ordered = [...auctions.values()].sort(
      (x, y) => (x.endsAt ? Date.parse(x.endsAt) : Infinity) - (y.endsAt ? Date.parse(y.endsAt) : Infinity),
    );
    for (const auction of ordered) {
      const l = await pageThrough(
        'lotSearch',
        (p) => lotSearchBody({ pageNumber: p, pageLength: o.lotPageLength, auctionId: Number(auction.externalId) }),
        o.lotPageLength,
        `auction ${auction.externalId} lots`,
        addLots,
      );
      if (!l.ended) complete = false;
    }
    if (!complete && stopReason) {
      warnings.push(`${scope.host}: stopped at the ${stopReason}; soonest-closing auctions were read first.`);
    }
  }

  // One aggregated warning per kind of problem, never one per lot.
  if (tally.outOfScopeAuctions.size) {
    const list = [...tally.outOfScopeAuctions.entries()].map(([s, n]) => `${s}×${n}`).join(', ');
    warnings.push(`Skipped auctions declared outside [${scope.states.join(', ')}]: ${list}. State is taken as declared, never inferred.`);
  }
  if (tally.undeclaredState) {
    warnings.push(`${tally.undeclaredState} auction(s) declare no event state and were excluded from this state-scoped run.`);
  }
  if (tally.outOfScopeLots) warnings.push(`${tally.outOfScopeLots} lot(s) belonged to auctions outside this run's states and were skipped.`);
  if (tally.lotDropped) warnings.push(`${tally.lotDropped} lot(s) skipped: no numeric id or no title.`);
  if (tally.entryDropped) warnings.push(`${tally.entryDropped} malformed search entr(ies) skipped.`);
  if (tally.fractional) {
    warnings.push(
      `${tally.fractional} lot(s) have a fractional quantity (e.g. acres bid per acre); quantity left null, ` +
        'raw._meta.quantity keeps the value and the bid is per unit.',
    );
  }
  if (tally.disagreements) {
    warnings.push(`${tally.disagreements} lot(s): the title close time disagreed with timeLeftSeconds by >2 min; used timeLeftSeconds.`);
  }
  if (tally.fallbackAuctions) {
    warnings.push(`${tally.fallbackAuctions} auction(s) were not in auctionSearch; built minimal records from lot fields.`);
  }
  if (tally.droppedStreets) {
    warnings.push(`${tally.droppedStreets} auction(s): pickup street dropped because it is the auctioneer's address in another city.`);
  }

  ctx.log('info', 'HiBid ingest complete', {
    mode: scope.mode,
    host: scope.host,
    states: scope.states,
    auctions: auctions.size,
    lots: lots.size,
    requests,
    bytes,
    completeSnapshot: complete,
  });

  return {
    auctions: [...auctions.values()],
    lots: [...lots.values()],
    bids: [], // HiBid exposes bid counts, not per-bid history, without an account.
    stats: { httpRequests: requests, bytesIn: bytes },
    warnings,
    completeSnapshot: complete,
  };
}

export const hibidAdapter: Adapter = {
  key: 'hibid',
  method: 'internal_json',
  run: (ctx: AdapterContext) => runHibid(ctx),
};
