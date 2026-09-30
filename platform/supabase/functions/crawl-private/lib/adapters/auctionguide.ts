// GENERATED from packages/ingest/src/adapters/auctionguide.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * AuctionGuide adapter. Platform key: 'auctionguide'.
 *
 * AuctionGuide (www.auctionguide.com) is a directory of sales run by
 * professional auctioneers: 1,309 current auctions and 2,756 auctioneers
 * nationwide on 2026-09-30. It lists SALES, not lots, so each sale becomes one
 * NormalizedAuction and one NormalizedLot with saleLevel: true (types.ts).
 *
 * TERMS. None published (/terms/ answers 404). robots.txt opens "As a condition
 * of accessing this website, you agree to abide by the following content
 * signals" and gives every user agent `Content-Signal: search=yes,
 * ai-train=no, use=reference`, where search is "building a search index and
 * providing search results (e.g., returning hyperlinks and short excerpts from
 * your website's contents)". That is this adapter's whole use: one row per sale,
 * a link back to the sale's AuctionGuide page, and a short excerpt (at most
 * AG_EXCERPT_MAX characters) of the site's own summary. Street addresses, phone
 * numbers and map coordinates on the page are not kept, including those inside
 * the summary itself (redactContacts).
 *
 * VERIFIED 2026-09-30 through inspect_url (our crawler, Supabase egress):
 *
 *   robots.txt (1,921 bytes): `Allow: /` for *, then a second * group with
 *   Disallow /cb/, /fb/, /search/, /calendar/ (RFC 9309 merges the two). No
 *   Crawl-delay, no Sitemap. This adapter requests only /dir/Locations/USA/{State}/.
 *
 *   /dir/Locations/USA/{State}/   multi-word names use underscores (New_York,
 *   Washington_DC). ONE page holds a state's whole list: Wisconsin 31 sales in
 *   151,421 bytes, Minnesota 13 in 87,889; no pager and no "next" link.
 *     <h2>(31)  Wisconsin WI auctions</h2>          the site's own count
 *     <div id="ias-posts"> cards </div>
 *     <h2>Wisconsin Auctioneers</h2>                 follows the list
 *   A card is <div class="ias-post LCT_auction_list_view" id="ias-post{id}">:
 *     h3 > a[href=/auction/{slug}/]    title and link; the slug ends in the id
 *     div.AuctionDescription           the site's summary, already cut at ~120 chars
 *     div.ends                         "30th Sep" or "Ends 30th Sep", then icons
 *                                      titled "Live auction", "Internet-only
 *                                      (timed) auction", "Internet bidding"
 *     status                           "Live auction (today)", "Bidding online now
 *                                      (1 day left)", "Online auction (starts in 3 days)"
 *     Lots: / By: / At:                "421 lots", "Mathies Auction Services",
 *                                      "Greenleaf, WI, USA." (never a ZIP)
 *     img.lazy[data-original]          one thumbnail, often on cdn.hibid.com; a
 *                                      no_image_icon placeholder when there is none.
 *                                      Parsed for provenance, never emitted as an
 *                                      image (see normalize)
 *   Ad slots sit among the cards as <div class="ias-post margin-b ..."> and are
 *   not sales. The page's map script, before the list, holds one point per sale:
 *     [lat, lon, "<popup>", id, color], popup lines: title, "street, city",
 *     "Wisconsin, 54126. USA", "Date: 3rd Sep - 30th Sep", "Lots: 533",
 *     "Type: Internet-only (timed) auction"
 *   It is the only place a ZIP or an online sale's START date appears, so it is
 *   read for those, matched to cards by id.
 *
 *   /auction/{slug}/ adds the year ("Started: 3rd Sep, 2026", "Ends: 30th Sep,
 *   2026 …") and nothing more precise, so the adapter never fetches it.
 *
 * DATES. The site gives days, never times, and no year. What a card's date means
 * depends on its prefix and format:
 *     "Ends 30th Sep"                      the close date (online, bidding open)
 *     "30th Sep", live or live+webcast     the sale day
 *     "4th Oct", online                    the START date of a sale not yet open;
 *                                          its close comes only from the map range
 * The year is the one that puts the date in [today - 60 days, today + 305 days]
 * in the sale's zone ("24th Feb" read on 30 Sep 2026 is 2027-02-24); a start
 * date is the latest one on or before the close. The card's own "N days left" /
 * "starts in N days" is compared with the result and a disagreement is warned.
 *
 * The convention (the one GSA's date-only closes already use, and that 0013 and
 * the app read): a close date becomes 23:59:59 local time on that date, with
 * raw._meta.closeTimePrecise = false. The app then shows the date with "time not
 * published" and no countdown, and a watch reminder fires at 08:00 that morning.
 * 23:59:59 is the last moment the sale can still be open, so the row is never
 * closed while the sale may be running; it is NOT a claim about the time, and the
 * real close is earlier that day. A start date becomes 00:00:00 local, the
 * earliest moment it can open (raw._meta.startTimePrecise = false). The zone is
 * the declared state's (Wisconsin: America/Chicago); for a state that spans
 * zones it is the zone most of the state keeps, marked 'state-primary'.
 *
 * COMPLETENESS. completeSnapshot is true only when every state page in scope was
 * read to its end (the "... Auctioneers" heading follows the last card, and no
 * next-page link) AND the cards on each page, every one parsed, number exactly
 * the page's own "(N)". Anything short of that is reported and makes no claim,
 * because a complete snapshot lets the pipeline close every sale it did not see.
 *
 * BUDGET. One request per state in scope (Wisconsin alone: the page, plus the
 * crawl gate's robots.txt). Starts are spaced by 60000 / rate_limit_rpm, and a
 * page that could not finish before ctx.deadline is not started. A budget
 * refusal from the gate keeps the pages already read and makes no snapshot
 * claim; a robots or bot-protection refusal fails the run.
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
  SourceConfig,
} from '../types.ts';
import { isBudgetRefusal } from '../gate.ts';

export const AG_BASE = 'https://www.auctionguide.com';
/** Longest description stored: the robots.txt content signals allow short excerpts. */
export const AG_EXCERPT_MAX = 300;
/** Dates resolve into [today - this, today - this + 365) days, in the sale's zone. */
export const AG_YEAR_WINDOW_PAST_DAYS = 60;
/** How far the site's "N days left" may sit from our date before it is reported. */
export const AG_RELATIVE_TOLERANCE_DAYS = 2;
/** Rough time for one state page (~150 KB), for planning to the deadline. */
export const AG_EST_FETCH_MS = 3_000;

const BUYER_PREMIUM_NOTE =
  'AuctionGuide lists the sale, not its terms; check the auctioneer’s own terms for a buyer’s premium before bidding.';

// ------------------------------------------------------------------ states

export interface AgState {
  /** Display name, as in the page heading and the map popups. */
  name: string;
  /** Path segment of the state page: spaces become underscores. */
  page: string;
  /** IANA zone the site's dates are read in. */
  zone: string;
  /** False when the state spans zones and `zone` is the one most of it keeps. */
  zoneExact: boolean;
}

const st = (name: string, zone: string, zoneExact = true): AgState => ({
  name,
  page: name.replace(/ /g, '_'),
  zone,
  zoneExact,
});

/** Every state page the site links from its footer on 2026-09-30, by code. */
export const AG_STATES: Readonly<Record<string, AgState>> = {
  AL: st('Alabama', 'America/Chicago'),
  AK: st('Alaska', 'America/Anchorage', false),
  AZ: st('Arizona', 'America/Phoenix'),
  AR: st('Arkansas', 'America/Chicago'),
  CA: st('California', 'America/Los_Angeles'),
  CO: st('Colorado', 'America/Denver'),
  CT: st('Connecticut', 'America/New_York'),
  DE: st('Delaware', 'America/New_York'),
  DC: st('Washington DC', 'America/New_York'),
  FL: st('Florida', 'America/New_York', false),
  GA: st('Georgia', 'America/New_York'),
  HI: st('Hawaii', 'Pacific/Honolulu'),
  ID: st('Idaho', 'America/Boise', false),
  IL: st('Illinois', 'America/Chicago'),
  IN: st('Indiana', 'America/Indiana/Indianapolis', false),
  IA: st('Iowa', 'America/Chicago'),
  KS: st('Kansas', 'America/Chicago', false),
  KY: st('Kentucky', 'America/New_York', false),
  LA: st('Louisiana', 'America/Chicago'),
  ME: st('Maine', 'America/New_York'),
  MD: st('Maryland', 'America/New_York'),
  MA: st('Massachusetts', 'America/New_York'),
  MI: st('Michigan', 'America/Detroit', false),
  MN: st('Minnesota', 'America/Chicago'),
  MS: st('Mississippi', 'America/Chicago'),
  MO: st('Missouri', 'America/Chicago'),
  MT: st('Montana', 'America/Denver'),
  NE: st('Nebraska', 'America/Chicago', false),
  NV: st('Nevada', 'America/Los_Angeles', false),
  NH: st('New Hampshire', 'America/New_York'),
  NJ: st('New Jersey', 'America/New_York'),
  NM: st('New Mexico', 'America/Denver'),
  NY: st('New York', 'America/New_York'),
  NC: st('North Carolina', 'America/New_York'),
  ND: st('North Dakota', 'America/Chicago', false),
  OH: st('Ohio', 'America/New_York'),
  OK: st('Oklahoma', 'America/Chicago'),
  OR: st('Oregon', 'America/Los_Angeles', false),
  PA: st('Pennsylvania', 'America/New_York'),
  RI: st('Rhode Island', 'America/New_York'),
  SC: st('South Carolina', 'America/New_York'),
  SD: st('South Dakota', 'America/Chicago', false),
  TN: st('Tennessee', 'America/Chicago', false),
  TX: st('Texas', 'America/Chicago', false),
  UT: st('Utah', 'America/Denver'),
  VT: st('Vermont', 'America/New_York'),
  VA: st('Virginia', 'America/New_York'),
  WA: st('Washington', 'America/Los_Angeles'),
  WV: st('West Virginia', 'America/New_York'),
  WI: st('Wisconsin', 'America/Chicago'),
  WY: st('Wyoming', 'America/Denver'),
};

const STATE_BY_NAME: ReadonlyMap<string, string> = new Map([
  ...Object.entries(AG_STATES).map(([code, s]) => [s.name.toLowerCase(), code] as [string, string]),
  ['district of columbia', 'DC'],
]);

/** "Wisconsin" -> "WI". Only a name the site uses; never a guess. */
export function stateCodeOf(name: string | null | undefined): string | null {
  if (!name) return null;
  return STATE_BY_NAME.get(name.trim().replace(/\s+/g, ' ').toLowerCase()) ?? null;
}

/** The states a run is scoped to: sources.states, or Wisconsin when unset. */
export function scopeStates(source: Pick<SourceConfig, 'states'>): string[] {
  const list = (source.states ?? [])
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
  return list.length ? [...new Set(list)] : ['WI'];
}

/** The state directory page, e.g. https://www.auctionguide.com/dir/Locations/USA/Wisconsin/. */
export function agStateUrl(base: string, code: string): string | null {
  const s = AG_STATES[code];
  return s ? `${base.replace(/\/+$/, '')}/dir/Locations/USA/${s.page}/` : null;
}

/** Milliseconds between request starts for a requests-per-minute ceiling. */
export function spacingMs(rateLimitRpm: number | null | undefined): number {
  const rpm = typeof rateLimitRpm === 'number' && Number.isFinite(rateLimitRpm) && rateLimitRpm > 0 ? rateLimitRpm : 10;
  return Math.ceil(60_000 / rpm);
}

// ------------------------------------------------------------------ text

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', deg: '°',
  frac12: '½', reg: '®', copy: '©', trade: '™', times: '×',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags stripped, entities decoded, every whitespace run (tabs included) collapsed. */
export function textOf(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  const t = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function absoluteUrl(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A JavaScript string literal's body, unescaped. */
function unescapeJs(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_w, e: string) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    return e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '' : e;
  });
}

function intOf(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * A description short enough to be an excerpt: whitespace collapsed, at most
 * `max` characters, cut at a word boundary with an ellipsis when it is longer.
 */
export function shortExcerpt(text: string | null | undefined, max = AG_EXCERPT_MAX): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-]+$/, '')}…`;
}

const sameText = (a: string | null, b: string | null) =>
  !!a && !!b && a.replace(/\W+/g, '').toLowerCase() === b.replace(/\W+/g, '').toLowerCase();

// ------------------------------------------------------------------ privacy

/** Stands in for a street address the site's summary gave. */
export const AG_ADDRESS_MARK = '(address on the sale page)';
/** Stands in for a phone number the site's summary gave. */
export const AG_PHONE_MARK = '(phone on the sale page)';

const withUpper = (words: string[]) => words.flatMap((w) => [w, w.toUpperCase()]).join('|');
const STREET_SUFFIX = withUpper(['Avenue', 'Ave', 'Street', 'St', 'Drive', 'Dr', 'Lane', 'Ln', 'Boulevard', 'Blvd',
  'Court', 'Ct', 'Circle', 'Cir', 'Way', 'Place', 'Pl', 'Parkway', 'Pkwy', 'Trail', 'Trl', 'Terrace', 'Ter', 'Pike']);
const ROAD_SUFFIX = withUpper(['Road', 'Rd', 'Highway', 'Hwy', 'Route', 'Rte']);
// A house number: "33243", "12B", or a Wisconsin rural grid number, "N5678".
// Never the tail of a time, date, price or range ("2:00", "1-200", "$5").
const HOUSE = String.raw`(?<![\w:.,$#/-])(?:[NSEW]\d{1,6}|\d{1,6}[A-Za-z]?)`;
const WORD = String.raw`[A-Za-z][A-Za-z.'-]*`;
// "County Road E", "Hwy 33": a road's letter or number designator.
const DESIGNATOR = String.raw`(?:[A-Z]{1,2}|\d{1,4})\b`;
const STREET_ADDRESS = new RegExp(
  `${HOUSE}\\s+(?:(?:${WORD}\\s+){1,4}?(?:(?:${STREET_SUFFIX})\\b\\.?|(?:${ROAD_SUFFIX})\\b\\.?(?:\\s+${DESIGNATOR})?)` +
  `|(?:${ROAD_SUFFIX})\\b\\.?\\s+${DESIGNATOR})`,
  'g',
);
// A summary the site cut short inside an address: "... at 33243 Oxbow Av...".
const CUT_ADDRESS = new RegExp(String.raw`((?:^|[\s(])(?:at|AT|@|[Ll]ocation:?|LOCATION:?|[Aa]ddress:?|ADDRESS:?)\s+)${HOUSE}\s+(?:${WORD}\s*){0,4}(?:\.{3}|…)\s*$`);
const PHONE = /(?<![\d-])(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}(?![\d-])/g;

/**
 * The site's summary with street addresses and phone numbers replaced by a
 * pointer to the sale page. Rows keep a sale's city, state and ZIP only: a
 * summary often names the preview address, which for an estate sale is a
 * family's home. Errs toward redacting.
 */
export function redactContacts(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text
    .replace(PHONE, AG_PHONE_MARK)
    .replace(STREET_ADDRESS, AG_ADDRESS_MARK)
    .replace(CUT_ADDRESS, `$1${AG_ADDRESS_MARK}…`);
}

const SMALL_CITY_WORDS = new Set(['de', 'du', 'la', 'le', 'of', 'the', 'on', 'in']);

/**
 * "nekoosa" -> "Nekoosa", "FOND DU LAC" -> "Fond du Lac", "MCFARLAND" ->
 * "McFarland". Only a city typed all in one case is changed: mixed case is
 * the source's own and is kept.
 */
export function tidyCity(city: string | null | undefined): string | null {
  if (!city) return city ?? null;
  const letters = city.replace(/[^A-Za-z]/g, '');
  if (!letters || (letters !== letters.toLowerCase() && letters !== letters.toUpperCase())) return city;
  return city.toLowerCase().replace(/[a-z][a-z']*/g, (w, at: number) => {
    if (at > 0 && SMALL_CITY_WORDS.has(w)) return w;
    if (w.length > 2 && w.startsWith('mc')) return `Mc${w[2].toUpperCase()}${w.slice(3)}`;
    return w[0].toUpperCase() + w.slice(1);
  });
}

// ------------------------------------------------------------------ dates

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** A calendar day as the site writes it; the year is usually absent. */
export interface DayMonth {
  day: number;
  month: number;
  year: number | null;
}

/** A local calendar date. */
export interface LocalDate {
  y: number;
  m: number;
  d: number;
}

/** "30th Sep", "1st Oct", "24th Feb", "3rd Sep, 2026". Null for anything else. */
export function parseDayMonth(text: string | null | undefined): DayMonth | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?$/i);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month || day < 1 || day > 31) return null;
  // February 29 is checked against the year once one is chosen.
  if (day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null;
  const year = m[3] ? Number(m[3]) : null;
  if (year !== null && validDate(year, month, day) === null) return null;
  return { day, month, year };
}

/** The map's "3rd Sep - 30th Sep" (start and close) or "30th Sep" (one day). */
export function parseDateRange(text: string | null | undefined): { start: DayMonth; end: DayMonth | null } | null {
  if (!text) return null;
  const parts = text.trim().split(/\s+-\s+/);
  if (parts.length === 1) {
    const one = parseDayMonth(parts[0]);
    return one ? { start: one, end: null } : null;
  }
  if (parts.length !== 2) return null;
  const start = parseDayMonth(parts[0]);
  const end = parseDayMonth(parts[1]);
  return start && end ? { start, end } : null;
}

function validDate(y: number, m: number, d: number): LocalDate | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null;
}

/** Days since the epoch, for comparing calendar dates. */
export function dayNumber(ld: LocalDate): number {
  return Math.round(Date.UTC(ld.y, ld.m - 1, ld.d) / 86_400_000);
}

export function isoDate(ld: LocalDate | null): string | null {
  return ld ? `${ld.y}-${pad(ld.m)}-${pad(ld.d)}` : null;
}

/**
 * The year for a day-month with none: the one that puts the date in
 * [today - 60 days, today + 305 days). A listing is current, so its dates sit
 * in that window; "24th Feb" read on 30 Sep is next February, "3rd Sep" is this
 * one. Null only when no candidate exists (29th Feb far from a leap year).
 */
export function resolveYear(dm: DayMonth, today: LocalDate): LocalDate | null {
  if (dm.year !== null) return validDate(dm.year, dm.month, dm.day);
  const lo = dayNumber(today) - AG_YEAR_WINDOW_PAST_DAYS;
  for (const y of [today.y - 1, today.y, today.y + 1]) {
    const ld = validDate(y, dm.month, dm.day);
    if (ld && dayNumber(ld) >= lo && dayNumber(ld) < lo + 365) return ld;
  }
  return null;
}

/** A start date: the latest date with this day and month on or before the close. */
export function resolveOnOrBefore(dm: DayMonth, end: LocalDate): LocalDate | null {
  if (dm.year !== null) return validDate(dm.year, dm.month, dm.day);
  for (const y of [end.y, end.y - 1, end.y - 2]) {
    const ld = validDate(y, dm.month, dm.day);
    if (ld && dayNumber(ld) <= dayNumber(end)) return ld;
  }
  return null;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(zone: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormats.set(zone, f);
  }
  return f;
}

function wallClock(utcMs: number, zone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of zoneFormat(zone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}

/** The zone's offset from UTC, in minutes, at an instant (CDT is -300). */
export function zoneOffsetMinutes(utcMs: number, zone: string): number {
  const w = wallClock(utcMs, zone);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** Today's date in a zone. */
export function localDate(at: Date, zone: string): LocalDate {
  const w = wallClock(at.getTime(), zone);
  return { y: w.y, m: w.m, d: w.d };
}

/**
 * A local wall-clock time as ISO-8601 with its offset, e.g.
 * "2026-09-30T23:59:59-05:00". Midnight and 23:59:59 are never inside a US DST
 * gap (clocks change at 02:00), so the time always exists exactly once.
 */
export function zonedIso(ld: LocalDate, h: number, mi: number, s: number, zone: string): string {
  const wall = Date.UTC(ld.y, ld.m - 1, ld.d, h, mi, s);
  let off = zoneOffsetMinutes(wall, zone);
  const again = zoneOffsetMinutes(wall - off * 60_000, zone);
  if (again !== off) off = again;
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${isoDate(ld)}T${pad(h)}:${pad(mi)}:${pad(s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The site's own relative note, "(ends today)", "(3 days left)", "(2 days to
 * go)", "(starts in 28 days)", and which of the sale's dates it counts to.
 */
export function parseRelative(note: string | null | undefined): { anchor: 'start' | 'end'; days: number } | null {
  if (!note) return null;
  const t = note.trim().toLowerCase();
  const n = (s: string) => (s === 'today' ? 0 : s === 'tomorrow' ? 1 : Number(s.match(/\d+/)?.[0] ?? NaN));
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^ends (today|tomorrow)$/)) || (m = t.match(/^(\d+) days? left$/))) {
    return { anchor: 'end', days: n(m[1]) };
  }
  if ((m = t.match(/^starts (today|tomorrow)$/)) || (m = t.match(/^starts in (\d+) days?$/))) {
    return { anchor: 'start', days: n(m[1]) };
  }
  if ((m = t.match(/^(today|tomorrow)$/)) || (m = t.match(/^(\d+) days? to go$/))) {
    return { anchor: 'start', days: n(m[1]) };
  }
  return null;
}

// ------------------------------------------------------------------ parsing

export interface AgCard {
  /** The site's auction id, from id="ias-post{id}" (also the slug's tail). */
  id: string | null;
  slug: string;
  url: string;
  title: string;
  /** The site's own summary text, as listed (it is already cut short). */
  summary: string | null;
  /** div.ends text: "30th Sep" or "Ends 30th Sep". */
  dateText: string | null;
  /** The date carries "Ends": it is the close date. */
  dateIsEnd: boolean;
  /** Titles of the type icons: "Live auction", "Internet bidding", ... */
  typeIcons: string[];
  /** "Bidding online now", "Live auction", "Online auction". */
  statusLabel: string | null;
  /** The parenthesised note: "ends today", "1 day left", "starts in 3 days". */
  statusNote: string | null;
  lotCount: number | null;
  auctioneer: string | null;
  auctioneerUrl: string | null;
  /** "Greenleaf, WI, USA." as listed. */
  atText: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  category: string | null;
  imageUrl: string | null;
}

export interface AgMapPoint {
  id: string;
  /** The city of the popup's "street, city" line; the street is not kept. */
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** "3rd Sep - 30th Sep" or "30th Sep". */
  dateText: string | null;
  lotCount: number | null;
  /** "Internet-only (timed) auction", "Live auction with webcast bidding". */
  typeText: string | null;
  statusText: string | null;
}

export interface AgStatePage {
  /** The page's "(31)  Wisconsin WI auctions" heading. */
  heading: { count: number; stateName: string | null; stateCode: string | null } | null;
  cards: AgCard[];
  /** Sale cards found, parsed or not. Ad slots are not counted. */
  found: number;
  mapPoints: Map<string, AgMapPoint>;
  /** The "... Auctioneers" heading that follows the list was seen after the last card. */
  listEnded: boolean;
  /** A next-page link inside the list: never seen on 2026-09-30. */
  hasNextPage: boolean;
  warnings: string[];
}

/** "Greenleaf, WI, USA." -> city, declared state and country. A ZIP only if shown. */
export function parseAt(text: string | null | undefined): Pick<AgCard, 'city' | 'state' | 'postalCode' | 'country'> {
  const out = { city: null as string | null, state: null as string | null, postalCode: null as string | null, country: null as string | null };
  if (!text) return out;
  const parts = text.replace(/\.\s*$/, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && /^(USA|US|United States)$/i.test(parts[parts.length - 1])) {
    out.country = 'USA';
    parts.pop();
  } else if (parts.length > 1 && /^(Canada|United Kingdom|UK)$/i.test(parts[parts.length - 1])) {
    out.country = parts.pop()!;
  }
  if (parts.length > 0) {
    const sz = parts[parts.length - 1].match(/^([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?$/);
    if (sz && out.country !== null && out.country !== 'USA') {
      parts.pop(); // a province: not a US state, and never read as one
    } else if (sz && AG_STATES[sz[1]]) {
      out.state = sz[1];
      out.postalCode = sz[2] ?? null;
      parts.pop();
    }
  }
  const city = parts.join(', ').trim();
  out.city = city && !/^(online|internet|tba|tbd|various|multiple)$/i.test(city) ? city : null;
  return out;
}

const CARD_TAG = /<div\b[^>]*\bclass="[^"]*\bLCT_auction_list_view\b[^"]*"[^>]*>/gi;
const LIST_ITEM = /<div\b[^>]*\bclass="[^"]*\bias-post\b/gi;
const END_HEADING = /<h2\b[^>]*>\s*([^<]*?)\s+Auctioneers\s*<\/h2>/gi;

function nextIndex(re: RegExp, s: string, from: number): number {
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index : s.length;
}

function indexOrEnd(s: string, needle: string, from: number): number {
  const i = s.indexOf(needle, from);
  return i < 0 ? s.length : i;
}

function parseCard(tag: string, body: string, base: string): AgCard | null {
  const g = (re: RegExp) => body.match(re)?.[1] ?? null;
  const idAttr = attr(tag, 'id')?.match(/^ias-post(\d+)$/)?.[1] ?? null;

  // Title and link: the h3's anchor, which must be an AuctionGuide sale page.
  const h3 = body.match(/<h3\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h3>/i);
  const url = absoluteUrl(h3 ? attr(` ${h3[1]}`, 'href') : null, base);
  const title = textOf(h3?.[2] ?? null);
  let slug: string | null = null;
  if (url) {
    const u = new URL(url);
    if (/(^|\.)auctionguide\.com$/i.test(u.hostname)) slug = u.pathname.match(/^\/auction\/([^/]+)\/?$/)?.[1] ?? null;
  }
  if (!url || !slug || !title) return null;
  const id = idAttr ?? slug.match(/-(\d+)$/)?.[1] ?? null;

  const endsHtml = g(/<div\s+class="ends"\s*>([\s\S]*?)<\/div>/i);
  const dateRaw = endsHtml === null ? null : textOf(endsHtml.split(/<span\b/i)[0]);
  const dateIsEnd = !!dateRaw && /^ends\b/i.test(dateRaw);
  const typeIcons = endsHtml ? [...endsHtml.matchAll(/\btitle="([^"]+)"/gi)].map((m) => decodeEntities(m[1]).trim()) : [];

  const status = body.match(/<span\s+class="[^"]*\bb\b[^"]*"\s*>([^<]*)<\/span>\s*<span\s+class="nowrap"\s*>\s*\(([^)]*)\)\s*<\/span>/i);

  const lotsText = g(/<div>\s*Lots:\s*<\/div>\s*<div>([\s\S]*?)<\/div>/i)
    ?? g(/View Auction\s*<span>\s*<span>\s*([\d,]+)\s*<\/span>\s*lots?/i);

  const byHtml = g(/<div>\s*By:\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i);
  const atText = textOf(g(/<div>\s*At:\s*<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i));
  const catHtml = g(/<div\s+class="cat"\s*>[\s\S]*?<div\s+class="b"\s*>([\s\S]*?)<\/div>/i);

  // One thumbnail: the lazy image's real source, or none for the placeholder.
  let imageUrl: string | null = null;
  const img = body.match(/<img\b[^>]*>/i)?.[0] ?? null;
  if (img && !/no_image_icon/i.test(img)) {
    const src = attr(img, 'data-original') ?? attr(img, 'src');
    if (src && !/^data:/i.test(src)) imageUrl = absoluteUrl(src, base);
  }

  return {
    id,
    slug,
    url,
    title,
    summary: textOf(g(/<div\s+class="AuctionDescription"\s*>([\s\S]*?)<\/div>/i)),
    dateText: dateRaw,
    dateIsEnd,
    typeIcons,
    statusLabel: status ? textOf(status[1]) : null,
    statusNote: status ? textOf(status[2]) : null,
    lotCount: intOf(lotsText),
    auctioneer: textOf(byHtml),
    auctioneerUrl: absoluteUrl(byHtml?.match(/\bhref="([^"]+)"/i)?.[1] ?? null, base),
    atText,
    ...parseAt(atText),
    category: textOf(catHtml),
    imageUrl,
  };
}

function parseMapPopup(id: string, popupJs: string): AgMapPoint {
  const lines = unescapeJs(popupJs).split(/<br\s*\/?>/i).map((l) => textOf(l) ?? '');
  const point: AgMapPoint = { id, city: null, state: null, postalCode: null, dateText: null, lotCount: null, typeText: null, statusText: null };
  lines.forEach((line, i) => {
    if (i === 0 || !line) return; // the title link
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Date:\s*(.*)$/i))) point.dateText = m[1].trim() || null;
    else if ((m = line.match(/^Lots:\s*(.*)$/i))) point.lotCount = intOf(m[1]);
    else if ((m = line.match(/^Type:\s*(.*)$/i))) point.typeText = m[1].trim() || null;
    else if ((m = line.match(/^(.+?)(?:,\s*(\d{5})(?:-\d{4})?)?\s*\.?\s*USA\.?$/))) {
      point.state = stateCodeOf(m[1]);
      point.postalCode = m[2] ?? null;
    } else if (i === 1) {
      // "street, city": the city follows the last comma; the street is not kept.
      const city = line.slice(line.lastIndexOf(',') + 1).trim();
      point.city = city || null;
    } else if (i === lines.length - 1) {
      point.statusText = line;
    }
  });
  return point;
}

/** The page's map points, `var addressPoints = [[lat, lon, "popup", id, "color"], ...]`, by id. */
export function parseMapPoints(html: string): Map<string, AgMapPoint> {
  const out = new Map<string, AgMapPoint>();
  const at = html.search(/var\s+addressPoints\s*=\s*\[/);
  if (at < 0) return out;
  const entry = /\s*\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*"((?:[^"\\]|\\[\s\S])*)"\s*,\s*(\d+)\s*,\s*"(?:[^"\\]|\\[\s\S])*"\s*\]\s*([,\]])/y;
  entry.lastIndex = html.indexOf('[', at) + 1;
  let m: RegExpExecArray | null;
  while ((m = entry.exec(html)) !== null) {
    out.set(m[2], parseMapPopup(m[2], m[1]));
    if (m[3] === ']') break;
  }
  return out;
}

/** Parse one state directory page. Pure; never throws on bad markup. */
export function parseAgStatePage(html: string, base: string = AG_BASE): AgStatePage {
  const empty: AgStatePage = { heading: null, cards: [], found: 0, mapPoints: new Map(), listEnded: false, hasNextPage: false, warnings: [] };
  if (typeof html !== 'string') return { ...empty, warnings: ['Response body was not text.'] };

  const h = html.match(/<h2\b[^>]*>\s*\((\d[\d,]*)\)\s*([^<]*?)\s*<\/h2>/i);
  let heading: AgStatePage['heading'] = null;
  if (h) {
    const label = decodeEntities(h[2]).replace(/\s+/g, ' ').replace(/\s*auctions?$/i, '').trim();
    const code = label.match(/\b([A-Z]{2})$/)?.[1] ?? null;
    heading = {
      count: Number(h[1].replace(/,/g, '')),
      stateName: (code ? label.slice(0, -2).trim() : label) || null,
      stateCode: code,
    };
  }

  const cards: AgCard[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let found = 0;
  let skipped = 0;
  let duplicates = 0;
  let lastCardAt = h ? (h.index ?? 0) : 0;

  CARD_TAG.lastIndex = 0;
  const tags = [...html.matchAll(CARD_TAG)];
  for (const t of tags) {
    found++;
    const start = t.index ?? 0;
    lastCardAt = start;
    // A card runs to the next list item (sale or ad), heading or script.
    const from = start + t[0].length;
    const end = Math.min(nextIndex(LIST_ITEM, html, from), indexOrEnd(html, '<h2', from), indexOrEnd(html, '<script', from));
    const card = parseCard(t[0], html.slice(from, end), base);
    if (!card) {
      skipped++;
      continue;
    }
    const key = card.id ?? card.slug;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    cards.push(card);
  }

  END_HEADING.lastIndex = lastCardAt;
  const endMatch = END_HEADING.exec(html);
  const listEnded = !!endMatch;
  const listRegion = html.slice(h?.index ?? 0, endMatch ? endMatch.index : html.length);
  const hasNextPage = /<a\b[^>]*(?:\brel="next"|\bclass="[^"]*\b(?:next|ias-next|next-page)\b[^"]*")/i.test(listRegion)
    || /\bclass="[^"]*\b(?:pagination|ias-pagination|pager)\b/i.test(listRegion);

  if (skipped) warnings.push(`Skipped ${skipped} of ${found} sale cards with no title or no AuctionGuide sale link.`);
  if (duplicates) warnings.push(`${duplicates} sale card(s) appeared twice on the page and were read once.`);

  return { heading, cards, found, mapPoints: parseMapPoints(html), listEnded, hasNextPage, warnings };
}

// ------------------------------------------------------------------ normalize

/** live, online or hybrid, from the card's type icons, the map's type and the status. */
export function agFormat(signals: (string | null | undefined)[]): AuctionFormat | null {
  const t = signals.filter(Boolean).join(' | ').toLowerCase();
  const live = /\blive auction\b/.test(t);
  const remote = /internet bidding|webcast|online bidding|bid online/.test(t);
  if (live && remote) return 'hybrid';
  if (live) return 'live';
  if (/internet-only|\btimed\b|online auction|online only|bidding online/.test(t)) return 'online';
  if (/sealed/.test(t)) return 'sealed_bid';
  return null;
}

export interface AgDates {
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  startBasis: 'card' | 'map' | null;
  endBasis: 'card' | 'map' | null;
  /** The card's date and the map's range disagree. */
  conflict: boolean;
  /** The site's "N days left" agrees with the dates (true), disagrees (false), or is absent (null). */
  relativeAgrees: boolean | null;
}

/** What the card's and the map's dates mean, with years chosen. See the header. */
export function agDates(card: AgCard, point: AgMapPoint | null, format: AuctionFormat, today: LocalDate): AgDates {
  const cardDm = parseDayMonth(card.dateText?.replace(/^ends\s+/i, '') ?? null);
  const range = parseDateRange(point?.dateText ?? null);
  const same = (a: DayMonth | null, b: DayMonth | null) => !!a && !!b && a.day === b.day && a.month === b.month;
  let startDm: DayMonth | null = null;
  let endDm: DayMonth | null = null;
  let startBasis: AgDates['startBasis'] = null;
  let endBasis: AgDates['endBasis'] = null;
  let conflict = false;

  if (cardDm && card.dateIsEnd) {
    endDm = cardDm;
    endBasis = 'card';
    if (range?.end) {
      startDm = range.start;
      startBasis = 'map';
      conflict = !same(range.end, cardDm);
    }
  } else if (cardDm) {
    // A day with no "Ends": the sale day of a live sale, or the day an online
    // sale opens. An online sale's close is then only in the map's range.
    startDm = cardDm;
    startBasis = 'card';
    if (range?.end) {
      endDm = range.end;
      endBasis = 'map';
      conflict = !same(range.start, cardDm);
    } else if (format !== 'online') {
      endDm = cardDm;
      endBasis = 'card';
      conflict = !!range && !same(range.start, cardDm);
    }
  } else if (range) {
    startDm = range.start;
    startBasis = 'map';
    endDm = range.end ?? (format !== 'online' ? range.start : null);
    endBasis = endDm ? 'map' : null;
  }

  const endDate = endDm ? resolveYear(endDm, today) : null;
  const startDate = startDm ? (endDate ? resolveOnOrBefore(startDm, endDate) : resolveYear(startDm, today)) : null;

  let relativeAgrees: boolean | null = null;
  const rel = parseRelative(card.statusNote);
  const anchor = rel ? (rel.anchor === 'end' ? endDate : startDate) : null;
  if (rel && anchor) {
    relativeAgrees = Math.abs(dayNumber(anchor) - dayNumber(today) - rel.days) <= AG_RELATIVE_TOLERANCE_DAYS;
  }
  return { startDate, endDate, startBasis, endBasis, conflict, relativeAgrees };
}

export interface AgNormalizeOptions {
  /** The state whose directory page listed the card. */
  directoryState: string;
  now: Date;
  /** The card's map point, when the page has one for its id. */
  point?: AgMapPoint | null;
}

export interface AgNormalized {
  auction: NormalizedAuction;
  lot: NormalizedLot;
  /** For the page's summary warnings. */
  flags: { noClose: boolean; conflict: boolean; relativeDisagrees: boolean; formatUnknown: boolean; zipConflict: boolean };
}

/** One AuctionGuide sale as an auction and its one sale-level lot. */
export function normalizeAgCard(card: AgCard, opts: AgNormalizeOptions): AgNormalized {
  const point = opts.point ?? null;

  // Location: only what the source declares. The card's "At:" first; the map
  // point's city, state and ZIP fill gaps only where its state agrees.
  const declaredState = card.state ?? point?.state ?? null;
  const pointAgrees = !!point && (!point.state || !declaredState || point.state === declaredState);
  const postalCode = card.postalCode ?? (pointAgrees ? point?.postalCode ?? null : null);
  const city = tidyCity(card.city ?? (pointAgrees ? point?.city ?? null : null));
  const pickup: NormalizedLocation | null = city || declaredState || postalCode
    ? { line1: null, city, state: declaredState, postalCode, ambiguous: !declaredState }
    : null;

  const zoneState = declaredState && AG_STATES[declaredState] ? declaredState : opts.directoryState;
  const stateInfo = AG_STATES[zoneState] ?? AG_STATES.WI;
  const zone = stateInfo.zone;
  const timezoneBasis = zoneState !== declaredState ? 'directory' : stateInfo.zoneExact ? 'state' : 'state-primary';

  const detected = agFormat([...card.typeIcons, point?.typeText, card.statusLabel]);
  const format: AuctionFormat = detected ?? 'online';

  const today = localDate(opts.now, zone);
  const dates = agDates(card, point, format, today);
  const closesAt = dates.endDate ? zonedIso(dates.endDate, 23, 59, 59, zone) : null;
  const startsAt = dates.startDate ? zonedIso(dates.startDate, 0, 0, 0, zone) : null;
  const closed = closesAt ? Date.parse(closesAt) <= opts.now.getTime() : false;

  const description = sameText(card.summary, card.title) ? null : shortExcerpt(redactContacts(card.summary));
  const lotCount = card.lotCount ?? point?.lotCount ?? null;
  // No images. AuctionGuide's content signals allow search use: links and short
  // excerpts. Most of its thumbnails are HiBid's (cdn.hibid.com), whose terms
  // forbid reusing its content (docs/08 section 3.1), so none is shown; the
  // card's imageUrl stays in raw for provenance only.
  const images: NormalizedImage[] = [];
  const id = card.id ?? card.slug;
  const listedStatus = card.statusLabel
    ? `${card.statusLabel}${card.statusNote ? ` (${card.statusNote})` : ''}`
    : point?.statusText ?? null;

  const meta = {
    source: 'auctionguide',
    saleLevel: true,
    directoryState: opts.directoryState,
    // The site gives dates, never times: see the file header for the convention.
    closeTimePrecise: false,
    closeTimeNote: dates.endDate
      ? `AuctionGuide lists this sale's close as a date with no time ("${card.dateIsEnd ? card.dateText : point?.dateText ?? card.dateText}"). ` +
        `Stored as 23:59:59 ${zone} on ${isoDate(dates.endDate)}, the last moment of that day; the real close is earlier that day.`
      : 'AuctionGuide does not list this sale’s close date yet (an online sale not open, with no date range on the map).',
    startTimePrecise: false,
    startDate: isoDate(dates.startDate),
    endDate: isoDate(dates.endDate),
    startDateBasis: dates.startBasis,
    endDateBasis: dates.endBasis,
    // Directory dates carry no year; it is chosen as described in the header.
    yearInferred: !/\b\d{4}\b/.test(`${card.dateText ?? ''} ${point?.dateText ?? ''}`),
    datesConflict: dates.conflict,
    relativeCheck: dates.relativeAgrees === null ? null : dates.relativeAgrees ? 'agrees' : 'disagrees',
    listedStatus,
    typeText: card.typeIcons.length ? card.typeIcons.join(' + ') : point?.typeText ?? null,
    formatStated: detected !== null,
    category: card.category,
    timezoneBasis,
    postalCodeSource: card.postalCode ? 'card' : postalCode ? 'map' : null,
    mapPoint: !!point,
  };

  const raw = {
    id,
    slug: card.slug,
    title: card.title,
    summary: description,
    dateText: card.dateText,
    listedStatus,
    lotCount,
    auctioneer: card.auctioneer,
    auctioneerUrl: card.auctioneerUrl,
    at: card.atText,
    imageUrl: card.imageUrl,
    map: point
      ? { city: point.city, state: point.state, postalCode: point.postalCode, dateText: point.dateText, lotCount: point.lotCount, typeText: point.typeText }
      : null,
    _meta: meta,
  };

  const auction: NormalizedAuction = {
    externalId: id,
    title: card.title,
    description,
    auctioneer: card.auctioneer,
    url: card.url,
    format,
    startsAt,
    endsAt: closesAt,
    timezone: zone,
    pickup,
    sellerName: null,
    sellerState: null,
    lotCount,
    currency: 'USD',
    buyerPremiumPct: null,
    buyerPremiumNote: BUYER_PREMIUM_NOTE,
    termsUrl: null,
    raw: { id, slug: card.slug, _meta: meta },
  };

  const lot: NormalizedLot = {
    externalId: `sale:${id}`,
    auctionExternalId: id,
    lotNumber: null,
    title: card.title,
    description,
    brand: null,
    model: null,
    condition: null,
    quantity: null,
    startingBidCents: null,
    currentBidCents: null,
    nextBidCents: null,
    estimateLowCents: null,
    estimateHighCents: null,
    soldPriceCents: null,
    bidCount: null,
    reserveMet: null,
    closesAt,
    closed,
    url: card.url,
    pickup,
    images,
    raw,
    saleLevel: true,
  };

  return {
    auction,
    lot,
    flags: {
      noClose: !closesAt,
      conflict: dates.conflict,
      relativeDisagrees: dates.relativeAgrees === false,
      formatUnknown: detected === null,
      zipConflict: !!point && !pointAgrees,
    },
  };
}

// ------------------------------------------------------------------ run

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return /(^|\.)auctionguide\.com$/i.test(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}

/** A refusal is an answer: never retried, always reported. */
const REFUSAL_STATUSES = new Set([401, 403, 405, 429, 503]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface AgRunOptions {
  /** Injected so tests do not wait out the politeness spacing. */
  sleep?: (ms: number) => Promise<void>;
}

export async function runAuctionGuide(ctx: AdapterContext, opts: AgRunOptions = {}): Promise<IngestResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const base = originOf(ctx.source.url) ?? AG_BASE;
  const states = scopeStates(ctx.source);
  const spacing = spacingMs(ctx.source.rateLimitRpm);

  const warnings: string[] = [];
  const auctions = new Map<string, NormalizedAuction>();
  const lots = new Map<string, NormalizedLot>();
  let httpRequests = 0;
  let bytesIn = 0;
  let pagesRead = 0;
  let outOfScope = 0;
  let complete = true;
  const httpErrors: string[] = [];
  let lastStart: number | null = null;

  for (const code of states) {
    const info = AG_STATES[code];
    const url = agStateUrl(base, code);
    if (!info || !url) {
      warnings.push(`AuctionGuide has no state page for "${code}"; it was skipped and the run is not a complete snapshot.`);
      complete = false;
      continue;
    }

    // Plan to the worker's deadline: a page that cannot finish is not started.
    const wait = lastStart === null ? 0 : Math.max(0, lastStart + spacing - ctx.now().getTime());
    if (ctx.deadline !== undefined && ctx.now().getTime() + wait + AG_EST_FETCH_MS > ctx.deadline) {
      warnings.push(`Run time budget reached before the ${info.name} page; kept the pages already read.`);
      complete = false;
      break;
    }
    if (wait > 0) await sleep(wait);
    lastStart = ctx.now().getTime();

    let res: { status: number; text: string };
    try {
      res = await ctx.fetch(url, { headers: { Accept: 'text/html' } });
    } catch (e) {
      // Out of budget after a page was read: keep it, as a partial run. Robots or
      // bot-protection refusals, and a budget refusal before anything was read,
      // fail the run so the source's backoff stays truthful.
      if (isBudgetRefusal(e) && pagesRead > 0) {
        warnings.push(`Run budget ran out before the ${info.name} page; kept the pages already read.`);
        complete = false;
        break;
      }
      throw e;
    }
    httpRequests++;
    bytesIn += res.text.length;

    if (REFUSAL_STATUSES.has(res.status)) {
      throw new Error(`AuctionGuide ${info.name} page: HTTP ${res.status}. Not retried.`);
    }
    if (res.status < 200 || res.status >= 300) {
      httpErrors.push(`${info.name}: HTTP ${res.status}`);
      warnings.push(`AuctionGuide ${info.name} page: HTTP ${res.status}; skipped, so the run is not a complete snapshot.`);
      complete = false;
      continue;
    }
    pagesRead++;

    const page = parseAgStatePage(res.text, base);
    const label = `AuctionGuide ${info.name}`;
    for (const w of page.warnings) warnings.push(`${label}: ${w}`);

    // The page's own claims about itself, each of which a snapshot needs.
    let pageComplete = page.cards.length === page.found;
    if (!page.heading) {
      warnings.push(`${label}: no "(N) ... auctions" heading, so the list cannot be confirmed whole.`);
      pageComplete = false;
    } else {
      if (page.heading.stateCode !== code) {
        const named = [page.heading.stateName, page.heading.stateCode].filter(Boolean).join(' ') || 'no state';
        warnings.push(`${label}: the page's heading names ${named}, not ${info.name}; its list is not taken as ${info.name}'s.`);
        pageComplete = false;
      }
      if (page.heading.count !== page.found) {
        warnings.push(`${label}: the page says (${page.heading.count}) and lists ${page.found} sale card(s).`);
        pageComplete = false;
      }
    }
    if (!page.listEnded) {
      warnings.push(`${label}: the page ended before its list did (no "Auctioneers" heading after the last card).`);
      pageComplete = false;
    }
    if (page.hasNextPage) {
      warnings.push(`${label}: the list links to a further page, which this adapter does not follow.`);
      pageComplete = false;
    }
    if (!pageComplete) complete = false;

    const counts = { noClose: 0, conflict: 0, relative: 0, format: 0, zip: 0, noPoint: 0 };
    const now = ctx.now();
    for (const card of page.cards) {
      const point = card.id ? page.mapPoints.get(card.id) ?? null : null;
      if (!point && page.mapPoints.size > 0) counts.noPoint++;
      // A sale the site places in another state is not ours, whatever page lists it.
      const declared = card.state ?? point?.state ?? null;
      if ((card.country && card.country !== 'USA') || (declared && !states.includes(declared))) {
        outOfScope++;
        continue;
      }
      const n = normalizeAgCard(card, { directoryState: code, now, point });
      if (n.flags.noClose) counts.noClose++;
      if (n.flags.conflict) counts.conflict++;
      if (n.flags.relativeDisagrees) counts.relative++;
      if (n.flags.formatUnknown) counts.format++;
      if (n.flags.zipConflict) counts.zip++;
      auctions.set(n.auction.externalId, n.auction);
      lots.set(n.lot.externalId, n.lot);
    }
    if (counts.noClose) warnings.push(`${label}: ${counts.noClose} sale(s) list no close date yet; stored with no close time.`);
    if (counts.conflict) warnings.push(`${label}: ${counts.conflict} sale(s) whose card date and map dates disagree; the card was used.`);
    if (counts.relative) warnings.push(`${label}: ${counts.relative} sale(s) whose date disagrees with the site's own "N days" note.`);
    if (counts.format) warnings.push(`${label}: ${counts.format} sale(s) state no live or online format; stored as online.`);
    if (counts.zip) warnings.push(`${label}: ${counts.zip} map point(s) name a different state than their card; their ZIP was not used.`);
    if (counts.noPoint) warnings.push(`${label}: ${counts.noPoint} sale(s) have no map point, so no ZIP.`);
  }

  if (pagesRead === 0 && httpErrors.length > 0) {
    throw new Error(`AuctionGuide: no state page could be read (${httpErrors.join('; ')}).`);
  }
  if (outOfScope) {
    warnings.push(`${outOfScope} sale(s) located outside ${states.join(', ')} were left out.`);
  }

  const lotList = [...lots.values()];
  ctx.log('info', 'AuctionGuide ingest complete', {
    states,
    pagesRead,
    sales: lotList.length,
    outOfScope,
    httpRequests,
    complete,
    warnings: warnings.length,
  });

  return {
    auctions: [...auctions.values()],
    lots: lotList,
    bids: [],
    stats: { httpRequests, bytesIn },
    warnings,
    completeSnapshot: complete && pagesRead > 0,
  };
}

export const auctionguideAdapter: Adapter = {
  key: 'auctionguide',
  method: 'html',
  run: (ctx: AdapterContext) => runAuctionGuide(ctx),
};
