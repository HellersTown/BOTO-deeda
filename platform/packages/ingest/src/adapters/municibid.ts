/**
 * Municibid adapter: towns, villages, counties, school districts and police
 * departments selling surplus on municibid.com (a Next.js App Router site).
 *
 * VERIFIED SHAPES (captured live 2026-09-30 as WaystockBot; fixtures in
 * test/fixtures/municibid-*-2026-09-30.html):
 *
 *   /auctions/{st}          State landing page (listed in /sitemaps/geo-state.xml).
 *                           Server-rendered stats ("N live now", sold all time,
 *                           agencies), a "Live now" list (link, title, price, bid
 *                           count, agency, city), a "Recently sold" table and the
 *                           agencies selling in the state. Wisconsin on 2026-09-30:
 *                           0 live now, 13 sold all time, 16 agencies.
 *   /listing/{id}/{slug}    One listing. Besides schema.org Product JSON-LD, its
 *                           React Server Components payload (self.__next_f.push)
 *                           carries the machine values the page renders from:
 *                             header props  {listingId, agencyName, state,
 *                                            startsAtUtc, endsAtUtc, bidCount, ...}
 *                             bid box       {initial: {currentPrice, bidCount,
 *                                            endsAtUtc, status, increment,
 *                                            serverNowUtc, reserveMet},
 *                                            buyerFeeTiers: [{from, percent}], ...}
 *                             map props     {lat, lng, label, zip, others: [...]}
 *                           `others` is every other active listing on the site
 *                           (id, title, currentPrice, bidCount, endsAtUtc,
 *                           "City, ST", seller), which is what lets one listing
 *                           page fill in a state whose "Live now" list is capped.
 *
 * robots.txt: "Allow: /", "Disallow: /search", "Disallow: /*?*search=". Nothing
 * here is under /search or carries a search= parameter.
 *
 * TIMES. The site states times in Eastern ("End Date Tuesday, October 6, 2026
 * 3:00 PM ET"); the payload carries the same instant as endsAtUtc
 * ("2026-10-06T19:00:00", UTC by name, no designator). The UTC value is used; the
 * ET text is converted with Intl (DST-aware) only as a fallback.
 *
 * BUYER'S PREMIUM. Municibid calls it the "Buyer's Fee" and publishes it per
 * listing as tiers, e.g. [{from:0, percent:9}, {from:100000, percent:6}]. The tier
 * that applies to the current price is carried as buyerPremiumPct, and all tiers
 * are spelled out in buyerPremiumNote.
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
import { extractJsonLdBlocks, flattenNodes } from '../jsonld.ts';
// Shared helpers from the sibling adapter (same author, same conventions).
import { decodeEntities, htmlToText, scopeStates, squish, stateTimezone } from './public-surplus.ts';

export const MUNICIBID_ORIGIN = 'https://municibid.com';

// --------------------------------------------------------------------- URLs

export function stateUrl(origin: string, state: string): string {
  return `${origin}/auctions/${state.toLowerCase()}`;
}

/**
 * The site's listing slug. Every slug observed on 2026-09-30 is the title
 * lower-cased with each run of non-alphanumerics turned into one hyphen
 * ("2019 Rhino TS12 Brush Hog. Model #TS12-3" -> "2019-rhino-ts12-brush-hog-model-ts12-3").
 * Used only when a listing is known from the map payload and no real link was seen.
 */
export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function listingUrl(origin: string, id: string, slug: string): string {
  return `${origin}/listing/${id}/${slug}`;
}

// ------------------------------------------------------------ small parsers

const US_STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const US_STATE_CODES = new Set(Object.values(US_STATE_NAMES));

/**
 * "Fenton, MI" / "CATASAUQUA, PA" / "Clinton, Connecticut" -> city + declared
 * state. The state must be written out by the source; an unrecognised tail is
 * kept as unknown rather than guessed.
 */
export function parseLocation(text: string | null | undefined): { city: string | null; state: string | null } {
  if (!text) return { city: null, state: null };
  const t = squish(text).replace(/\s+US$/i, '');
  const m = t.match(/^(.*?),\s*([A-Za-z .]+?)(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (!m) return { city: t || null, state: null };
  const tail = m[2].trim();
  const code = tail.length === 2 ? tail.toUpperCase() : US_STATE_NAMES[tail.toLowerCase()] ?? null;
  return { city: m[1].trim() || null, state: code && US_STATE_CODES.has(code) ? code : null };
}

/** "2026-10-06T19:00:00" (UTC by field name, no designator) -> ISO with Z. */
export function utcFieldToIso(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  const s = /(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const y = new Date(ms).getUTCFullYear();
  return y >= 2000 && y <= 2100 ? new Date(ms).toISOString() : null;
}

function tzOffsetMinutes(utcMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUtc - utcMs) / 60_000);
  } catch {
    return null;
  }
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

/**
 * "Tuesday, October 6, 2026 3:00 PM ET" -> ISO. "ET" is the generic Eastern
 * zone, so the offset (EDT or EST) is resolved for that date with Intl rather
 * than assumed.
 */
export function parseEtText(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = squish(text).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP])M\s+ET\b/i);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  let hour = Number(m[4]);
  if (hour < 1 || hour > 12) return null;
  if (m[6].toUpperCase() === 'P' && hour !== 12) hour += 12;
  if (m[6].toUpperCase() === 'A' && hour === 12) hour = 0;
  const wall = Date.UTC(Number(m[3]), month - 1, Number(m[2]), hour, Number(m[5]));
  const off1 = tzOffsetMinutes(wall, 'America/New_York');
  if (off1 === null) return null;
  let utc = wall - off1 * 60_000;
  const off2 = tzOffsetMinutes(utc, 'America/New_York');
  if (off2 !== null && off2 !== off1) utc = wall - off2 * 60_000;
  return new Date(utc).toISOString();
}

export interface FeeTier { from: number; percent: number }

/** The tier that applies at `priceCents`, and every tier spelled out. */
export function premiumFromTiers(tiers: FeeTier[] | null | undefined, priceCents: number | null): { pct: number; note: string } | null {
  const valid = (tiers ?? [])
    .filter((t) => t && Number.isFinite(t.from) && Number.isFinite(t.percent) && t.percent >= 0 && t.percent <= 50)
    .sort((a, b) => a.from - b.from);
  if (valid.length === 0) return null;
  const price = priceCents ?? 0;
  let applies = valid[0];
  for (const t of valid) if (t.from * 100 <= price) applies = t;
  const money = (d: number) => `$${d.toLocaleString('en-US')}`;
  const note =
    "Municibid buyer's fee, as published on the listing: " +
    valid.map((t) => `${t.percent}% from ${money(t.from)}`).join('; ') + '.';
  return { pct: applies.percent, note };
}

// ------------------------------------------------------------- state pages

export interface MbLiveItem {
  id: string;
  url: string;
  title: string;
  priceCents: number | null;
  bidCount: number | null;
  agencyName: string | null;
  city: string | null;
}

export interface MbSoldItem {
  id: string;
  url: string;
  title: string;
  sellerUserName: string | null;
  agencyName: string | null;
  bidCount: number | null;
  soldPriceCents: number | null;
}

export interface MbAgency {
  userName: string;
  name: string;
  city: string | null;
  live: number;
  sold: number;
}

export interface MbStatePage {
  liveCount: number | null;
  soldCount: number | null;
  agencyCount: number | null;
  live: MbLiveItem[];
  sold: MbSoldItem[];
  agencies: MbAgency[];
  warnings: string[];
}

function textOf(fragment: string | null | undefined): string | null {
  if (!fragment) return null;
  const t = squish(decodeEntities(fragment.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')));
  return t === '' ? null : t;
}

function absolute(href: string, origin: string): string | null {
  try {
    return new URL(decodeEntities(href), origin).toString();
  } catch {
    return null;
  }
}

function statValue(html: string, label: string): string | null {
  const m = html.match(new RegExp(`<span class="geo__stat">([^<]*)</span><span class="geo__statlabel">${label}</span>`, 'i'));
  return m ? squish(decodeEntities(m[1])) : null;
}

function sectionAfterHeading(html: string, heading: string): string | null {
  const m = html.match(new RegExp(`<h2>\\s*${heading}\\s*</h2>([\\s\\S]*?)</section>`, 'i'));
  return m ? m[1] : null;
}

function intOrNull(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const m = s.replace(/,/g, '').match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function parseStatePage(html: string, origin: string = MUNICIBID_ORIGIN): MbStatePage {
  const warnings: string[] = [];
  const liveCount = intOrNull(statValue(html, 'live now'));
  const soldCount = intOrNull(statValue(html, 'sold all time'));
  const agencyCount = intOrNull(statValue(html, 'agencies'));
  if (liveCount === null) warnings.push('Municibid: state page has no "live now" count; markup may have changed.');

  const live: MbLiveItem[] = [];
  const liveBlock = sectionAfterHeading(html, 'Live now');
  if (liveBlock) {
    for (const li of liveBlock.match(/<li\b[\s\S]*?<\/li>/gi) ?? []) {
      const a = li.match(/<a\b[^>]*href="(\/listing\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const title = a ? textOf(a[3]) : null;
      const url = a ? absolute(a[1], origin) : null;
      if (!a || !title || !url) {
        warnings.push('Municibid: a "Live now" entry had no listing link or title; skipped.');
        continue;
      }
      const meta = textOf(li.match(/<span class="geo__meta">([\s\S]*)<\/span>/i)?.[1]) ?? '';
      // "$8,100.00 · 3 bids · City of Fenton, Fenton"
      const pm = meta.match(/^(\$[\d,]+(?:\.\d{2})?)\s*·\s*(\d+)\s*bids?\s*·\s*(.*)$/i);
      let agencyName: string | null = null;
      let city: string | null = null;
      if (pm) {
        const rest = pm[3];
        const comma = rest.lastIndexOf(',');
        agencyName = (comma >= 0 ? rest.slice(0, comma) : rest).trim() || null;
        city = comma >= 0 ? rest.slice(comma + 1).trim() || null : null;
      }
      live.push({
        id: a[2],
        url,
        title,
        priceCents: pm ? parseMoneyToCents(pm[1]) : null,
        bidCount: pm ? Number(pm[2]) : null,
        agencyName,
        city,
      });
    }
  } else if (liveCount !== null && liveCount > 0) {
    warnings.push(`Municibid: state page says ${liveCount} live but has no "Live now" list.`);
  }

  const sold: MbSoldItem[] = [];
  const soldBlock = sectionAfterHeading(html, 'Recently sold');
  for (const tr of soldBlock?.match(/<tr>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 4) continue;
    const a = cells[0].match(/href="(\/listing\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const seller = cells[1].match(/href="\/seller\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const url = a ? absolute(a[1], origin) : null;
    const title = a ? textOf(a[3]) : null;
    if (!a || !url || !title) continue;
    sold.push({
      id: a[2],
      url,
      title,
      sellerUserName: seller ? decodeURIComponent(seller[1]) : null,
      agencyName: seller ? textOf(seller[2]) : textOf(cells[1]),
      bidCount: intOrNull(textOf(cells[2])),
      soldPriceCents: parseMoneyToCents(textOf(cells[3])),
    });
  }

  const agencies: MbAgency[] = [];
  const agencyBlock = sectionAfterHeading(html, 'Agencies selling here');
  for (const li of agencyBlock?.match(/<li\b[\s\S]*?<\/li>/gi) ?? []) {
    const a = li.match(/href="\/seller\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const name = a ? textOf(a[2]) : null;
    if (!a || !name) continue;
    const meta = textOf(li.match(/<span class="geo__meta">([\s\S]*?)<\/span>/i)?.[1]) ?? '';
    const [cityPart, ...counts] = meta.split('·').map((s) => s.trim());
    const count = (label: string) => {
      const c = counts.find((x) => new RegExp(`\\b${label}$`, 'i').test(x));
      return c ? Number(c.replace(/\D/g, '')) || 0 : 0;
    };
    agencies.push({
      userName: decodeURIComponent(a[1]),
      name,
      city: cityPart || null,
      live: count('live'),
      sold: count('sold'),
    });
  }

  if (liveCount !== null && live.length > liveCount) {
    warnings.push(`Municibid: "Live now" lists ${live.length} items but the page counts ${liveCount}.`);
  }
  return { liveCount, soldCount, agencyCount, live, sold, agencies, warnings };
}

// ------------------------------------------------------------ listing pages

/**
 * Concatenate the React Server Components payload a Next.js page streams as
 * self.__next_f.push([1,"..."]) script tags. Each argument is a JSON string
 * literal, so JSON.parse decodes it exactly (including &-style escapes).
 */
export function decodeNextFlight(html: string): string {
  const out: string[] = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]) as string);
    } catch {
      // A malformed chunk loses only that chunk.
    }
  }
  return out.join('');
}

/** From an opening { or [ at `start`, return the balanced JSON text, strings respected. */
export function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the JSON value that starts right after `marker` (e.g. '"others":'). */
export function jsonAfter(text: string, marker: string, from = 0): unknown {
  const i = text.indexOf(marker, from);
  if (i < 0) return undefined;
  let j = i + marker.length;
  while (j < text.length && /\s/.test(text[j])) j++;
  const raw = sliceBalanced(text, j);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Find the first object literal that starts with `prefix` (e.g. '{"listingId":123,'). */
function objectStartingWith(text: string, prefix: string): Record<string, unknown> | null {
  const i = text.indexOf(prefix);
  if (i < 0) return null;
  const raw = sliceBalanced(text, i);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** React escapes a leading "$" in RSC strings as "$$". */
function unRsc(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  return s.startsWith('$$') ? s.slice(1) : s;
}

export interface MbMapListing {
  id: string;
  title: string;
  currentPriceCents: number | null;
  bidCount: number | null;
  endsAt: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lon: number | null;
  imageUrl: string | null;
  sellerUserName: string | null;
  agencyName: string | null;
}

export function parseMapEntries(value: unknown): { entries: MbMapListing[]; skipped: number } {
  const entries: MbMapListing[] = [];
  let skipped = 0;
  for (const e of Array.isArray(value) ? value : []) {
    const r = e as Record<string, unknown>;
    const id = typeof r?.id === 'number' || typeof r?.id === 'string' ? String(r.id) : null;
    const title = typeof r?.title === 'string' ? squish(r.title) : null;
    if (!id || !/^\d+$/.test(id) || !title) {
      skipped++;
      continue;
    }
    const loc = parseLocation(typeof r.location === 'string' ? r.location : null);
    entries.push({
      id,
      title,
      currentPriceCents: parseMoneyToCents(r.currentPrice),
      bidCount: typeof r.bidCount === 'number' ? r.bidCount : null,
      endsAt: utcFieldToIso(r.endsAtUtc),
      city: loc.city,
      state: loc.state,
      lat: typeof r.lat === 'number' ? r.lat : null,
      lon: typeof r.lng === 'number' ? r.lng : null,
      imageUrl: typeof r.primaryImageUrl === 'string' ? r.primaryImageUrl : null,
      sellerUserName: typeof r.sellerUserName === 'string' ? r.sellerUserName : null,
      agencyName: typeof r.agencyName === 'string' ? r.agencyName : null,
    });
  }
  return { entries, skipped };
}

export interface MbListing {
  id: string;
  title: string | null;
  url: string | null;
  state: string | null;
  city: string | null;
  postalCode: string | null;
  lat: number | null;
  lon: number | null;
  agencyName: string | null;
  sellerUserName: string | null;
  category: string | null;
  subCategory: string | null;
  startsAt: string | null;
  endsAt: string | null;
  endsText: string | null;
  status: string | null;
  ended: boolean | null;
  serverNow: string | null;
  currentPriceCents: number | null;
  bidCount: number | null;
  incrementCents: number | null;
  startingBidCents: number | null;
  reserveMet: boolean | null;
  isNoReserve: boolean | null;
  buyerFeeTiers: FeeTier[];
  buyerFeeText: string | null;
  images: string[];
  paymentTerms: string | null;
  description: string | null;
  /** "Additional Information on this Auction": Make, Model, VIN, shipping... */
  specs: Record<string, string>;
  ships: boolean | null;
  pickupDetails: string | null;
  pickupLine1: string | null;
}

/** Walk parsed RSC trees for "adet-item" label/value pairs ("Starting Bid" -> "$7,500.00"). */
function detailPairs(text: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  const re = /"className":"adet-item__label","children":"([^"]+)"\}\],\["\$","span",null,\{"className":"adet-item__value[^"]*","children":/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const valueStart = m.index + m[0].length;
    let value: string | null = null;
    if (text[valueStart] === '"') {
      const end = text.indexOf('"', valueStart + 1);
      value = unRsc(JSON.parse(text.slice(valueStart, end + 1)));
    } else {
      const raw = sliceBalanced(text, valueStart);
      if (raw) {
        try {
          value = flattenRsc(JSON.parse(raw));
        } catch {
          value = null;
        }
      }
    }
    if (value) pairs[m[1]] = squish(value);
  }
  return pairs;
}

/** Visible text of an RSC element tree ("$"-tagged arrays), for small values only. */
function flattenRsc(node: unknown): string {
  if (typeof node === 'string') return node.startsWith('$L') || node === '$' ? '' : unRsc(node) ?? '';
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    if (node[0] === '$' && typeof node[1] === 'string' && node.length >= 4) {
      const props = node[3] as Record<string, unknown> | null;
      return props && 'children' in props ? flattenRsc(props.children) : '';
    }
    return node.map(flattenRsc).join('');
  }
  return '';
}

function productJsonLd(html: string, flight: string): Record<string, unknown> | null {
  const fromHtml = flattenNodes(extractJsonLdBlocks(html)).find((n) => n['@type'] === 'Product');
  if (fromHtml) return fromHtml;
  const i = flight.indexOf('{"@context":"https://schema.org","@type":"Product"');
  if (i < 0) return null;
  const raw = sliceBalanced(flight, i);
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse one listing page. `others` (the site-wide active listings behind the
 * map) is returned separately because it describes OTHER listings.
 */
export function parseListingPage(
  html: string,
  origin: string = MUNICIBID_ORIGIN,
  expectedId?: string,
): { listing: MbListing | null; others: MbMapListing[]; warnings: string[] } {
  const warnings: string[] = [];
  const flight = decodeNextFlight(html);
  const canonical = html.match(/<link rel="canonical" href="([^"]+\/listing\/(\d+)\/[^"]*)"/i);
  const product = productJsonLd(html, flight);
  const id = expectedId ?? canonical?.[2] ?? (typeof product?.sku === 'string' ? product.sku : null);

  const othersRaw = jsonAfter(flight, '"others":');
  const { entries: others, skipped } = parseMapEntries(othersRaw);
  if (skipped > 0) warnings.push(`Municibid: ${skipped} map entries had no id or title and were skipped.`);

  if (!id) {
    warnings.push('Municibid: page has no listing id; not a listing page.');
    return { listing: null, others, warnings };
  }
  const pageId = canonical?.[2] ?? (typeof product?.sku === 'string' ? product.sku : null);
  if (expectedId && pageId && pageId !== expectedId) {
    // A redirect to another listing, parsed as the one we asked for, would put a
    // stranger's price and close time on this lot.
    warnings.push(`Municibid: asked for listing ${expectedId}, page is listing ${pageId}.`);
    return { listing: null, others, warnings };
  }
  const header = objectStartingWith(flight, `{"listingId":${id},"title":`);
  const bidBox = objectStartingWith(flight, `{"listingId":${id},"initial":`);
  const initial = (bidBox?.initial ?? null) as Record<string, unknown> | null;
  const mapIdx = flight.indexOf('"others":');
  const mapProps = mapIdx >= 0 ? objectAround(flight, mapIdx) : null;

  if (!header && !bidBox && !product) {
    warnings.push(`Municibid: listing ${id} page carries neither the RSC listing data nor Product JSON-LD.`);
    return { listing: null, others, warnings };
  }
  if (!bidBox) warnings.push(`Municibid: listing ${id} has no bid box data; price and bids fall back to JSON-LD.`);

  const offers = (product?.offers ?? null) as Record<string, unknown> | null;
  const address = ((offers?.availableAtOrFrom as Record<string, unknown> | undefined)?.address ?? null) as Record<string, unknown> | null;
  const seller = (offers?.seller ?? null) as Record<string, unknown> | null;
  const pairs = detailPairs(flight);

  const gallery = jsonAfter(flight, '"images":');
  const images = (Array.isArray(gallery) ? gallery : Array.isArray(product?.image) ? (product!.image as unknown[]) : [])
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));

  const terms = flight.match(/"className":"detail-terms listing-prose","dangerouslySetInnerHTML":\{"__html":("(?:[^"\\]|\\.)*")/);
  const sellerLink = flight.match(/"href":"\/seller\/([^"]+)","className":"detail-meta__chip detail-meta__seller"/);
  const tiers = Array.isArray(bidBox?.buyerFeeTiers) ? (bidBox!.buyerFeeTiers as FeeTier[]) : [];

  const endsAt = utcFieldToIso(initial?.endsAtUtc) ?? utcFieldToIso(header?.endsAtUtc) ?? parseEtText(pairs['End Date']);
  if (!endsAt) warnings.push(`Municibid: listing ${id} has no parseable close time.`);
  const loc = parseLocation(typeof mapProps?.label === 'string' ? mapProps.label : null);
  const specs = listingSpecs(html, flight);
  const description = listingDescription(html, flight);
  const shipAnswer = specs['Will you ship this item'] ?? null;
  const ships = shipAnswer === null ? null : /^\s*yes\b/i.test(shipAnswer) ? true : /^\s*no\b/i.test(shipAnswer) ? false : null;
  const pickupDetails = specs['Pickup Location Details'] ?? null;

  const listing: MbListing = {
    id,
    title: typeof header?.title === 'string' ? header.title : typeof product?.name === 'string' ? product.name : null,
    url: canonical?.[1] ?? (typeof offers?.url === 'string' ? offers.url : null),
    state: (typeof header?.state === 'string' ? header.state : null)
      ?? (typeof address?.addressRegion === 'string' ? address.addressRegion : null)
      ?? loc.state,
    city: (typeof address?.addressLocality === 'string' ? address.addressLocality : null) ?? loc.city,
    postalCode: (typeof address?.postalCode === 'string' ? address.postalCode : null)
      ?? (typeof mapProps?.zip === 'string' ? mapProps.zip : null),
    lat: typeof mapProps?.lat === 'number' ? mapProps.lat : null,
    lon: typeof mapProps?.lng === 'number' ? mapProps.lng : null,
    agencyName: (typeof header?.agencyName === 'string' ? header.agencyName : null)
      ?? (typeof seller?.name === 'string' ? seller.name : null),
    sellerUserName: sellerLink ? decodeURIComponent(sellerLink[1]) : null,
    category: typeof header?.category === 'string' ? header.category : null,
    subCategory: typeof header?.subCategory === 'string' ? header.subCategory : null,
    startsAt: utcFieldToIso(bidBox?.startsAtUtc) ?? utcFieldToIso(header?.startsAtUtc) ?? parseEtText(pairs['Start Date']),
    endsAt,
    endsText: pairs['End Date'] ?? null,
    status: typeof initial?.status === 'string' ? initial.status : null,
    ended: /"currentPrice":[\d.]+,"bidCount":\d+,"ended":true/.test(flight) ? true
      : /"currentPrice":[\d.]+,"bidCount":\d+,"ended":false/.test(flight) ? false : null,
    serverNow: typeof initial?.serverNowUtc === 'string' ? utcFieldToIso(initial.serverNowUtc) : null,
    currentPriceCents: parseMoneyToCents(initial?.currentPrice ?? offers?.price),
    bidCount: typeof initial?.bidCount === 'number' ? initial.bidCount
      : typeof header?.bidCount === 'number' ? header.bidCount : null,
    incrementCents: parseMoneyToCents(initial?.increment ?? bidBox?.increment),
    startingBidCents: parseMoneyToCents(pairs['Starting Bid']),
    reserveMet: typeof initial?.reserveMet === 'boolean' ? initial.reserveMet : null,
    isNoReserve: typeof bidBox?.isNoReserve === 'boolean' ? bidBox.isNoReserve
      : typeof header?.isNoReserve === 'boolean' ? header.isNoReserve : null,
    buyerFeeTiers: tiers,
    buyerFeeText: (pairs['Buyer’s Fee'] ?? pairs["Buyer's Fee"] ?? null)?.replace(/\s*More info\s*$/i, '') || null,
    images,
    paymentTerms: terms ? htmlToText(JSON.parse(terms[1]) as string) || null : null,
    description,
    specs,
    ships,
    pickupDetails,
    pickupLine1: null,
  };
  listing.pickupLine1 = streetFromPickupDetails(pickupDetails, listing.city, listing.state);
  return { listing, others, warnings };
}

/**
 * "Additional Information on this Auction" as label -> value. The RSC rows are
 * read first; the streamed HTML (<dt>/<dd>) is the fallback.
 */
export function listingSpecs(html: string, flight: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const rsc = /\["\$","dt",null,\{"children":("(?:[^"\\]|\\.)*")\}\],\["\$","dd",null,\{"children":("(?:[^"\\]|\\.)*")\}\]/g;
  let m: RegExpExecArray | null;
  while ((m = rsc.exec(flight)) !== null) {
    try {
      const k = squish(JSON.parse(m[1]) as string);
      const v = squish(unRsc(JSON.parse(m[2])) ?? '');
      if (k && v) specs[k] = v;
    } catch {
      // skip one malformed pair
    }
  }
  if (Object.keys(specs).length > 0) return specs;
  const dl = html.match(/<dl class="kv-list[^"]*">([\s\S]*?)<\/dl>/i)?.[1] ?? '';
  for (const p of dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi)) {
    const k = textOf(p[1]);
    const v = textOf(p[2]);
    if (k && v) specs[k] = v;
  }
  return specs;
}

/** The seller's item description: RSC "listing-prose" row, else the streamed HTML. */
export function listingDescription(html: string, flight: string): string | null {
  const rsc = flight.match(/"className":"listing-prose","dangerouslySetInnerHTML":\{"__html":("(?:[^"\\]|\\.)*")/);
  if (rsc) {
    try {
      return htmlToText(JSON.parse(rsc[1]) as string) || null;
    } catch {
      // fall through to HTML
    }
  }
  const div = html.match(/<div class="listing-prose">([\s\S]*?)<\/div>/i);
  return div ? htmlToText(div[1]) || null : null;
}

/**
 * The street from "City of Fenton DPW, 200 N. Alloy Drive, Fenton, MI 48430" --
 * only when the text ends in the listing's own city and state, so a free-text
 * note is never mistaken for an address.
 */
export function streetFromPickupDetails(text: string | null, city: string | null, state: string | null): string | null {
  if (!text || !city || !state) return null;
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const last = parts[parts.length - 1];
  const cityPart = parts[parts.length - 2];
  if (!new RegExp(`^${state}\\s+\\d{5}(?:-\\d{4})?$`, 'i').test(last)) return null;
  if (cityPart.toLowerCase() !== city.toLowerCase()) return null;
  const street = parts[parts.length - 3];
  return /^\d+\s+\S/.test(street) ? street : null;
}

/** The object literal that contains position `idx` (walks back to its "{"). */
function objectAround(text: string, idx: number): Record<string, unknown> | null {
  // The map props object is flat up to "others": find its opening brace.
  const open = text.lastIndexOf('{"lat":', idx);
  if (open < 0) return null;
  const raw = sliceBalanced(text, open);
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- normalize

export interface MbSources {
  detail?: MbListing | null;
  map?: MbMapListing | null;
  live?: MbLiveItem | null;
  /** The state page the listing was found under (its declared state). */
  pageState?: string | null;
}

/** One Municibid listing -> an auction and its single lot (1:1, same id). */
export function normalizeMunicibid(id: string, src: MbSources, origin: string = MUNICIBID_ORIGIN): { auction: NormalizedAuction; lot: NormalizedLot } | null {
  const d = src.detail ?? null;
  const m = src.map ?? null;
  const l = src.live ?? null;
  const title = d?.title ?? l?.title ?? m?.title ?? null;
  if (!title) return null;

  const url = d?.url ?? l?.url ?? listingUrl(origin, id, slugify(title));
  const state = d?.state ?? m?.state ?? src.pageState ?? null;
  const city = d?.city ?? m?.city ?? l?.city ?? null;
  const pickup: NormalizedLocation | null = state || city
    ? {
        line1: d?.pickupLine1 ?? null,
        city,
        state,
        postalCode: d?.postalCode ?? null,
        lat: d?.lat ?? m?.lat ?? null,
        lon: d?.lon ?? m?.lon ?? null,
        ambiguous: !!city && !state,
      }
    : null;

  const closesAt = d?.endsAt ?? m?.endsAt ?? null;
  const serverNow = d?.serverNow ? Date.parse(d.serverNow) : null;
  const closed = (d?.status && d.status.toLowerCase() !== 'active') || d?.ended === true
    || (closesAt !== null && serverNow !== null && Date.parse(closesAt) <= serverNow);

  const price = d?.currentPriceCents ?? m?.currentPriceCents ?? l?.priceCents ?? null;
  const bids = d?.bidCount ?? m?.bidCount ?? l?.bidCount ?? null;
  // "Current price" is the opening price until someone bids.
  const currentBidCents = bids === 0 ? null : price;
  const startingBidCents = d?.startingBidCents ?? (bids === 0 ? price : null);
  const nextBidCents = bids === 0
    ? price
    : price !== null && d?.incrementCents !== null && d?.incrementCents !== undefined ? price + d.incrementCents : null;

  const premium = d ? premiumFromTiers(d.buyerFeeTiers, price) : null;
  const feeFromText = d?.buyerFeeText?.match(/(\d{1,2}(?:\.\d+)?)\s*%/);
  const buyerPremiumPct = premium?.pct ?? (feeFromText ? Number(feeFromText[1]) : null);

  const imageUrls = d && d.images.length > 0 ? d.images : m?.imageUrl ? [m.imageUrl] : [];
  const images: NormalizedImage[] = imageUrls.map((u, position) => ({ url: u, position }));
  const agencyName = d?.agencyName ?? m?.agencyName ?? l?.agencyName ?? null;

  const meta = {
    source: 'municibid',
    enriched: !!d,
    from: d ? 'listing-page' : m ? 'map-payload' : 'state-page',
    sellerUserName: d?.sellerUserName ?? m?.sellerUserName ?? null,
    statedZone: 'ET',
    sourceEndsText: d?.endsText ?? null,
    status: d?.status ?? null,
    isNoReserve: d?.isNoReserve ?? null,
    buyerFeeTiers: d?.buyerFeeTiers ?? null,
    category: d?.category ?? null,
    subCategory: d?.subCategory ?? null,
    urlSource: d?.url || l?.url ? 'source' : 'derived-slug',
    softClose: 'May be extended by 2 minutes to prevent bid sniping (site-wide rule).',
    paymentTerms: d?.paymentTerms ?? null,
    pickupDetails: d?.pickupDetails ?? null,
    vin: d?.specs['VIN'] ?? null,
  };

  const auction: NormalizedAuction = {
    externalId: id,
    title,
    description: null,
    auctioneer: 'Municibid',
    url,
    format: 'online',
    startsAt: d?.startsAt ?? null,
    endsAt: closesAt,
    timezone: stateTimezone(state) ?? 'America/New_York',
    pickup,
    pickupRequired: d?.ships !== true,
    ships: d?.ships === true,
    shipsNote: d?.specs['Will you ship this item'] ?? null,
    sellerName: agencyName,
    sellerState: state,
    lotCount: 1,
    currency: 'USD',
    buyerPremiumPct,
    buyerPremiumNote: premium?.note ?? (d?.buyerFeeText ? `Municibid buyer's fee: ${d.buyerFeeText}` : null),
    termsUrl: 'https://info.municibid.com/fees',
    raw: { _meta: meta },
  };

  const lot: NormalizedLot = {
    externalId: id,
    auctionExternalId: id,
    lotNumber: id,
    title,
    description: d?.description ?? null,
    brand: d?.specs['Make'] ?? null,
    model: d?.specs['Model'] ? (d.specs['Year'] ? `${d.specs['Year']} ${d.specs['Model']}` : d.specs['Model']) : null,
    condition: null,
    quantity: null,
    startingBidCents,
    currentBidCents,
    nextBidCents,
    estimateLowCents: null,
    estimateHighCents: null,
    soldPriceCents: null,
    bidCount: bids,
    reserveMet: d?.isNoReserve === true ? true : d?.reserveMet ?? null,
    closesAt,
    closed: !!closed,
    url,
    pickup,
    ships: d?.ships === true,
    images,
    raw: { detail: d, map: m, live: l, _meta: meta },
  };
  return { auction, lot };
}

// ------------------------------------------------------------------ adapter

export interface MunicibidOptions {
  maxRequests?: number;
  /** Listing pages per run. They are ~350 KB each (the map payload), so few. */
  maxDetailPages?: number;
  timeBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS: Required<Omit<MunicibidOptions, 'sleep'>> = {
  maxRequests: 30,
  maxDetailPages: 12,
  timeBudgetMs: 120_000,
};

class BudgetExhausted extends Error {}

function originOf(url: string | null | undefined): string {
  try {
    return url ? new URL(url).origin : MUNICIBID_ORIGIN;
  } catch {
    return MUNICIBID_ORIGIN;
  }
}

export function createMunicibidAdapter(options: MunicibidOptions = {}): Adapter {
  const opts = { ...DEFAULTS, ...options };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    key: 'municibid',
    method: 'internal_json',

    async run(ctx: AdapterContext): Promise<IngestResult> {
      const origin = originOf(ctx.source.url);
      const states = scopeStates(ctx.source.states);
      const warnings: string[] = [];
      const stats = { httpRequests: 0, bytesIn: 0 };
      const started = ctx.now().getTime();
      const gapMs = Math.ceil(60_000 / Math.max(1, ctx.source.rateLimitRpm || 20));
      let lastAt: number | null = null;

      const get = async (url: string) => {
        if (stats.httpRequests >= opts.maxRequests) throw new BudgetExhausted(url);
        if (lastAt !== null) {
          const wait = lastAt + gapMs - ctx.now().getTime();
          if (wait > 0) await sleep(wait);
        }
        lastAt = ctx.now().getTime();
        stats.httpRequests++;
        const res = await ctx.fetch(url, { headers: { Accept: 'text/html' } });
        stats.bytesIn += res.text.length;
        return res;
      };

      // ---- 1. State pages: live count and live list per state.
      let complete = true;
      const live = new Map<string, MbLiveItem>();
      const liveState = new Map<string, string>();
      const expected = new Map<string, number>();
      const counts: Record<string, unknown> = {};

      for (const st of states) {
        const res = await get(stateUrl(origin, st));
        if (res.status === 429) throw new Error('Municibid rate limit (HTTP 429).');
        if (res.status === 404) {
          // No state page means Municibid has never had a seller there: nothing live.
          expected.set(st, 0);
          counts[st] = { live: 0, note: 'no state page (HTTP 404)' };
          continue;
        }
        if (res.status !== 200) {
          if (res.status >= 500 && states.length === 1) throw new Error(`Municibid returned HTTP ${res.status} for ${st}.`);
          warnings.push(`Municibid ${st}: state page returned HTTP ${res.status}; run is not a complete snapshot.`);
          complete = false;
          continue;
        }
        const page = parseStatePage(res.text, origin);
        warnings.push(...page.warnings.map((w) => `${w} (${st})`));
        counts[st] = { live: page.liveCount, sold: page.soldCount, agencies: page.agencyCount };
        if (page.liveCount === null) {
          complete = false;
        } else {
          expected.set(st, page.liveCount);
        }
        for (const item of page.live) {
          live.set(item.id, item);
          liveState.set(item.id, st);
        }
      }

      // ---- 2. Listing pages, lowest id first (monotonic enrichment, as for
      // Public Surplus: new listings get higher ids, so the set never reshuffles).
      const ids = new Set(live.keys());
      const details = new Map<string, MbListing>();
      const withheld = new Set<string>();
      let map: Map<string, MbMapListing> | null = null;

      const plan = [...ids].sort((a, b) => Number(a) - Number(b)).slice(0, opts.maxDetailPages);
      for (const id of plan) {
        if (ctx.now().getTime() - started > opts.timeBudgetMs) {
          withheld.add(id);
          continue;
        }
        let res: { status: number; text: string };
        try {
          res = await get(live.get(id)!.url);
        } catch (e) {
          if (!(e instanceof BudgetExhausted)) {
            warnings.push(`Municibid: listing ${id} fetch failed (${e instanceof Error ? e.message : String(e)}).`);
          }
          withheld.add(id);
          continue;
        }
        if (res.status === 429) throw new Error('Municibid rate limit (HTTP 429).');
        if (res.status !== 200) {
          warnings.push(`Municibid: listing ${id} returned HTTP ${res.status}.`);
          withheld.add(id);
          continue;
        }
        const parsed = parseListingPage(res.text, origin, id);
        warnings.push(...parsed.warnings);
        if (!parsed.listing) {
          withheld.add(id);
          continue;
        }
        details.set(id, parsed.listing);
        if (!map && parsed.others.length > 0) map = new Map(parsed.others.map((o) => [o.id, o]));
      }

      // ---- 3. A capped "Live now" list is completed from the site-wide map
      // payload that every listing page carries.
      for (const st of states) {
        const want = expected.get(st);
        const have = [...ids].filter((id) => liveState.get(id) === st).length;
        if (want === undefined || have >= want) continue;
        if (!map) {
          warnings.push(`Municibid ${st}: ${want} live but only ${have} listed, and no listing page was available to complete the list.`);
          complete = false;
          continue;
        }
        for (const entry of map.values()) {
          if (entry.state === st && !ids.has(entry.id)) {
            ids.add(entry.id);
            liveState.set(entry.id, st);
          }
        }
        const now = [...ids].filter((id) => liveState.get(id) === st).length;
        if (now < want) {
          warnings.push(`Municibid ${st}: ${want} live, found ${now} after consulting the map payload.`);
          complete = false;
        }
      }

      if (withheld.size > 0) {
        complete = false;
        warnings.push(`Municibid: ${withheld.size} listing page(s) not fetched or not parseable; those lots keep their stored values this run.`);
      }

      // ---- 4. Normalize.
      const auctions: NormalizedAuction[] = [];
      const lots: NormalizedLot[] = [];
      for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
        if (withheld.has(id)) continue;
        const norm = normalizeMunicibid(id, {
          detail: details.get(id) ?? null,
          map: map?.get(id) ?? null,
          live: live.get(id) ?? null,
          pageState: liveState.get(id) ?? null,
        }, origin);
        if (!norm) {
          warnings.push(`Municibid: listing ${id} had no title in any source; skipped.`);
          complete = false;
          continue;
        }
        // Scope guard: a listing whose own page declares another state is not
        // emitted under this source's states.
        const declared = norm.lot.pickup?.state ?? null;
        if (declared && !states.includes(declared)) {
          warnings.push(`Municibid: listing ${id} declares ${declared}, outside ${states.join(',')}; skipped.`);
          continue;
        }
        auctions.push(norm.auction);
        lots.push(norm.lot);
      }

      ctx.log('info', 'Municibid ingest complete', { states, counts, lots: lots.length, requests: stats.httpRequests, complete });

      return { auctions, lots, bids: [], stats, warnings, completeSnapshot: complete };
    },
  };
}

export const municibidAdapter: Adapter = createMunicibidAdapter();
