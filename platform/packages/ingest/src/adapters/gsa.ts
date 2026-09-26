/**
 * GSA Auctions adapter — federal surplus, rung 1 (official API).
 *
 * Spec source: https://github.com/GSA/auctions_api (openapi.yaml + fields.html),
 * read directly rather than guessed. Field types and lengths below are quoted from
 * that repo.
 *
 *   Base:      https://api.gsa.gov/assets/gsaauctions/v2/
 *   Endpoint:  GET /auctions
 *   Auth:      X-API-KEY header, or ?api_key= query param
 *   Params:    format=JSON|XML  ... and nothing else
 *   Limits:    5,000 calls/day, 5 calls per 5 seconds
 *   Shape:     { results: [ auction, ... ] }
 *
 * THREE THINGS THE SPEC FORCED, each of which would have been a silent bug:
 *
 * 1. `PropertyState` AND `LocationST` ARE DIFFERENT FIELDS.
 *    Property* is where the item physically sits — what a buyer drives to.
 *    Location* is where the SALE is administered, i.e. the selling agency.
 *    A pallet of generators in Milwaukee can be sold by an agency in Virginia.
 *    Mapping the wrong one into pickup_state is exactly how a Wisconsin buyer
 *    never sees Wisconsin inventory. Property* is pickup; Location* is seller.
 *
 * 2. `AuctionStatus` IS A ONE-CHARACTER FIELD WHERE A SPACE IS MEANINGFUL:
 *    'A' = Active, 'P' = Preview, ' ' (space) = Scheduled.
 *    So `status.trim()` destroys the Scheduled signal by turning it into "".
 *    We branch before trimming. Note also that NO value means "closed" — closure
 *    must be derived from AucEndDt, never from this field.
 *
 * 3. `AucEndDt` IS 10 CHARACTERS — A DATE WITH NO TIME.
 *    Combined with `InactivityTime` (the soft-close window, in minutes, during
 *    which any new bid extends the sale), the true close moment is genuinely
 *    indeterminate from this API. See closesAt handling below. This is the one
 *    real limitation of the source and it must not be papered over: promising a
 *    30-second snipe alert on a close time we only know to the day would be
 *    lying to the user at the worst possible moment.
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  NormalizedAuction,
  NormalizedLot,
  NormalizedLocation,
} from '../types.ts';
import { parseMoneyToCents } from '../money.ts';

export const GSA_API_BASE = 'https://api.gsa.gov/assets/gsaauctions/v2';

/** Raw record shape, as documented. Everything optional: it is someone else's API. */
export interface GsaRecord {
  SaleNo?: string;
  LotNo?: number | string;
  AucStartDt?: string;
  AucEndDt?: string;
  ItemName?: string;
  PropertyAddr1?: string;
  PropertyAddr2?: string;
  PropertyAddr3?: string;
  PropertyCity?: string;
  PropertyState?: string;
  PropertyZip?: string;
  AuctionStatus?: string;
  SaleLocation?: string;
  LocationOrg?: string;
  LocationStAddr?: string;
  LocationCity?: string;
  LocationST?: string;
  LocationZip?: string;
  BiddersCount?: number | string;
  LotInfo?: { LotSequence?: number; LotDescript?: string }[];
  Instruction1?: string;
  Instruction2?: string;
  Instruction3?: string;
  ContractOfficer?: string;
  COEmail?: string;
  COPhone?: string;
  Reserve?: number | string;
  AucIncrement?: number | string;
  HighBidAmount?: number | string;
  InactivityTime?: number | string;
  AgencyCode?: string;
  BureauCode?: string;
  AgencyName?: string;
  BureauName?: string;
  ItemDescURL?: string;
  ImageURL?: string;
}

export type GsaSaleStatus = 'active' | 'preview' | 'scheduled' | 'unknown';

/**
 * Decode AuctionStatus WITHOUT trimming first.
 *
 * ' ' means Scheduled per the spec. A naive `.trim()` turns that into '' and the
 * sale silently becomes 'unknown'. Order matters here.
 */
export function decodeStatus(raw: string | undefined): GsaSaleStatus {
  if (raw === undefined || raw === null) return 'unknown';
  if (raw === ' ' || raw === '') return 'scheduled';
  const c = raw.charAt(0).toUpperCase();
  if (c === 'A') return 'active';
  if (c === 'P') return 'preview';
  if (c === ' ') return 'scheduled';
  return 'unknown';
}

/**
 * Parse a GSA 10-character date.
 *
 * Accepts MM/DD/YYYY and YYYY-MM-DD, which are the two ways a 10-char date is
 * written in US government feeds. Anything else returns null rather than a guess.
 */
export function parseGsaDate(raw: string | undefined): { y: number; m: number; d: number } | null {
  if (!raw) return null;
  const s = raw.trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return { y: +y, m: +mo, d: +d };
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return { y: +y, m: +mo, d: +d };
  }
  return null;
}

/**
 * Turn a date-only close into a usable instant.
 *
 * GSA gives us a day, not a moment. We resolve it to 23:59:59 US Eastern, because
 * GSA is a federal program administered on Eastern time, and we record the
 * imprecision explicitly on the lot's raw payload so downstream code can refuse to
 * render a false countdown.
 *
 * -0400 (EDT) vs -0500 (EST) is decided by US DST rules: second Sunday in March to
 * first Sunday in November. Getting this wrong shifts every federal close time by
 * an hour, which matters most on exactly the lots a user cares about.
 */
export function gsaCloseInstant(raw: string | undefined): { iso: string; precise: false } | null {
  const parts = parseGsaDate(raw);
  if (!parts) return null;
  const { y, m, d } = parts;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;

  const offsetHours = isUsEasternDst(y, m, d) ? 4 : 5;
  // 23:59:59 local Eastern, expressed as UTC.
  const utc = Date.UTC(y, m - 1, d, 23 + offsetHours, 59, 59);
  const dt = new Date(utc);
  if (Number.isNaN(dt.getTime())) return null;
  return { iso: dt.toISOString(), precise: false };
}

/** Second Sunday in March 02:00 -> first Sunday in November 02:00. */
export function isUsEasternDst(y: number, m: number, d: number): boolean {
  const nthSunday = (year: number, monthIdx: number, n: number): number => {
    const firstDow = new Date(Date.UTC(year, monthIdx, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDow) % 7);
    return firstSunday + (n - 1) * 7;
  };
  const dstStart = nthSunday(y, 2, 2); // March, 2nd Sunday
  const dstEnd = nthSunday(y, 10, 1);  // November, 1st Sunday
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  if (m === 3) return d >= dstStart;
  return d < dstEnd;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number') return String(v);
  return null;
}

function int(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

/** Join the multi-line instruction and lot-description fields into prose. */
function buildDescription(r: GsaRecord): string | null {
  const lotDescs = (r.LotInfo ?? [])
    .slice()
    .sort((a, b) => (a.LotSequence ?? 0) - (b.LotSequence ?? 0))
    .map((l) => str(l.LotDescript))
    .filter((s): s is string => !!s);

  const instructions = [r.Instruction1, r.Instruction2, r.Instruction3]
    .map(str)
    .filter((s): s is string => !!s);

  const parts = [...lotDescs];
  if (instructions.length) parts.push(`Inspection: ${instructions.join(' ')}`);

  const joined = parts.join('\n').trim();
  return joined === '' ? null : joined;
}

/**
 * PROPERTY location = where the item is = what the buyer drives to.
 *
 * `ambiguous` is set when we have a city but no state. We refuse to infer the
 * state from the city, because there is a Beloit in Wisconsin and a Beloit in
 * Kansas, and a confidently wrong location is far more damaging than a missing one.
 */
export function propertyLocation(r: GsaRecord): NormalizedLocation | null {
  const city = str(r.PropertyCity);
  const state = str(r.PropertyState);
  const zip = str(r.PropertyZip);
  const line1 = [str(r.PropertyAddr3), str(r.PropertyAddr2), str(r.PropertyAddr1)]
    .filter((s): s is string => !!s)[0] ?? null;

  if (!city && !state && !zip && !line1) return null;

  return {
    line1,
    city,
    state: state ? state.toUpperCase().slice(0, 2) : null,
    postalCode: zip ? zip.slice(0, 5) : null,
    ambiguous: !!city && !state,
  };
}

/** Normalize one API record into an auction + its lot. Pure; no I/O. */
export function normalizeGsaRecord(
  r: GsaRecord,
): { auction: NormalizedAuction; lot: NormalizedLot } | null {
  const saleNo = str(r.SaleNo);
  const itemName = str(r.ItemName);
  // Without a sale number we cannot build a stable id, and without a name the row
  // is not a usable lot. Both are hard requirements.
  if (!saleNo || !itemName) return null;

  const lotNo = int(r.LotNo);
  const lotExternalId = lotNo === null ? saleNo : `${saleNo}/${lotNo}`;

  const status = decodeStatus(r.AuctionStatus);
  const close = gsaCloseInstant(r.AucEndDt);
  const startParts = parseGsaDate(r.AucStartDt);
  const startsAt = startParts
    ? new Date(Date.UTC(startParts.y, startParts.m - 1, startParts.d, 12, 0, 0)).toISOString()
    : null;

  // Closure is derived from the date, NOT from AuctionStatus: the status vocabulary
  // ('A'/'P'/' ') has no closed value at all.
  const closed = close ? new Date(close.iso).getTime() < Date.now() : false;

  const currentBidCents = parseMoneyToCents(r.HighBidAmount);
  const reserveCents = parseMoneyToCents(r.Reserve);
  const incrementCents = parseMoneyToCents(r.AucIncrement);

  const pickup = propertyLocation(r);

  const imageUrl = str(r.ImageURL);
  const itemUrl = str(r.ItemDescURL);

  const auction: NormalizedAuction = {
    externalId: saleNo,
    title: `GSA sale ${saleNo}${r.AgencyName ? ` — ${str(r.AgencyName)}` : ''}`,
    description: str(r.SaleLocation),
    auctioneer: str(r.AgencyName) ?? 'U.S. General Services Administration',
    url: itemUrl,
    format: 'online',
    startsAt,
    endsAt: close?.iso ?? null,
    // Federal program administered on Eastern time; see gsaCloseInstant.
    timezone: 'America/New_York',
    pickup,
    pickupRequired: true,
    // GSA surplus is overwhelmingly pickup-only. Claiming otherwise would put
    // undeliverable lots in a shipping-inclusive search, so default to false and
    // let a later, more specific signal override it.
    ships: false,
    // LocationST is the SELLING AGENCY's state, deliberately NOT pickup state.
    sellerName: str(r.AgencyName) ?? str(r.BureauName),
    lotCount: null,
    currency: 'USD',
    // GSA publishes no buyer's premium on surplus sales.
    buyerPremiumPct: null,
    termsUrl: null,
    raw: r,
  };

  const lot: NormalizedLot = {
    externalId: lotExternalId,
    auctionExternalId: saleNo,
    lotNumber: lotNo === null ? null : String(lotNo),
    title: itemName,
    description: buildDescription(r),
    condition: null,
    quantity: 1,
    startingBidCents: null,
    currentBidCents,
    // A real increment from the source beats our generic ladder, so prefer it.
    nextBidCents:
      currentBidCents !== null && incrementCents !== null
        ? currentBidCents + incrementCents
        : null,
    estimateLowCents: reserveCents,
    estimateHighCents: null,
    bidCount: int(r.BiddersCount),
    reserveMet:
      reserveCents !== null && currentBidCents !== null ? currentBidCents >= reserveCents : null,
    closesAt: close?.iso ?? null,
    closed,
    url: itemUrl,
    pickup,
    ships: false,
    images: imageUrl ? [{ url: imageUrl, position: 0 }] : [],
    raw: {
      ...r,
      // Provenance for downstream consumers. `closeTimePrecise: false` is the
      // contract that stops the UI rendering a second-by-second countdown on a
      // close time we only know to the day.
      _meta: {
        source: 'gsa',
        saleStatus: status,
        closeTimePrecise: false,
        closeTimeNote:
          'GSA publishes AucEndDt as a date only (10 chars). Resolved to 23:59:59 America/New_York. ' +
          'Sale also soft-closes after InactivityTime minutes without a bid, so the true close may be later.',
        inactivityMinutes: int(r.InactivityTime),
        sellerState: str(r.LocationST),
        agencyCode: str(r.AgencyCode),
        bureauCode: str(r.BureauCode),
        contractOfficer: str(r.ContractOfficer),
      },
    },
  };

  return { auction, lot };
}

/** Deduplicate auctions by externalId, keeping the first occurrence. */
function dedupeAuctions(list: NormalizedAuction[]): NormalizedAuction[] {
  const byId = new Map<string, NormalizedAuction>();
  for (const a of list) {
    const existing = byId.get(a.externalId);
    if (!existing) {
      byId.set(a.externalId, a);
      continue;
    }
    // Many item records share one SaleNo. Keep the richest pickup location rather
    // than whichever record happened to arrive first.
    if (!existing.pickup?.postalCode && a.pickup?.postalCode) byId.set(a.externalId, a);
  }
  return [...byId.values()];
}

/** Transform a whole API response body. Pure; exported for testing. */
export function normalizeGsaResponse(body: unknown): {
  auctions: NormalizedAuction[];
  lots: NormalizedLot[];
  warnings: string[];
} {
  const warnings: string[] = [];

  // The documented envelope is { results: [...] }, but be tolerant of a bare array
  // and of the single-object case, both of which government feeds do emit.
  let records: unknown[];
  if (Array.isArray(body)) {
    records = body;
  } else if (body && typeof body === 'object' && Array.isArray((body as any).results)) {
    records = (body as any).results;
  } else if (body && typeof body === 'object') {
    records = [body];
    warnings.push('Response was a bare object, not the documented { results: [...] } envelope.');
  } else {
    return { auctions: [], lots: [], warnings: ['Response body was not an object or array.'] };
  }

  const auctions: NormalizedAuction[] = [];
  const lots: NormalizedLot[] = [];
  let skipped = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') {
      skipped++;
      continue;
    }
    const norm = normalizeGsaRecord(rec as GsaRecord);
    if (!norm) {
      skipped++;
      continue;
    }
    auctions.push(norm.auction);
    lots.push(norm.lot);
  }

  // Report drops rather than swallowing them. A parser that silently discards half
  // its input looks healthy right up until someone notices the catalogue is thin.
  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} of ${records.length} records (missing SaleNo or ItemName).`);
  }

  return { auctions: dedupeAuctions(auctions), lots, warnings };
}

export const gsaAdapter: Adapter = {
  key: 'gsa',
  method: 'official_api',

  async run(ctx: AdapterContext): Promise<IngestResult> {
    const apiKey = ctx.secrets.GSA_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GSA_API_KEY is required. A key already exists on the Vercel project; ' +
          'a personal key can be requested at https://api.data.gov/signup/.',
      );
    }

    const base = ctx.source.apiBase ?? GSA_API_BASE;
    // The API takes no filter parameters, so a single call returns every listing
    // from every participating agency. Filtering happens in our own database. That
    // is a feature: one request per crawl cycle, no pagination, trivially inside
    // the 5,000/day and 5-per-5-seconds limits.
    const url = `${base.replace(/\/+$/, '')}/auctions?format=JSON`;

    // Key in the header, not the query string: a query-string key ends up in access
    // logs, proxy logs and error reports. The API accepts both.
    const res = await ctx.fetch(url, {
      headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
    });

    if (res.status === 429) {
      throw new Error('GSA rate limit hit (5,000/day, 5 per 5s). Back off and retry.');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GSA API returned HTTP ${res.status}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new Error('GSA API returned a body that is not valid JSON.');
    }

    const { auctions, lots, warnings } = normalizeGsaResponse(body);

    ctx.log('info', 'GSA ingest complete', {
      auctions: auctions.length,
      lots: lots.length,
      warnings: warnings.length,
    });

    return {
      auctions,
      lots,
      bids: [], // GSA exposes BiddersCount but no per-bid history.
      stats: { httpRequests: 1, bytesIn: res.text.length },
      warnings,
    };
  },
};
