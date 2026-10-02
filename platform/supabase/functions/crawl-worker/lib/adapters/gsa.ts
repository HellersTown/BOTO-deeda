// GENERATED from packages/ingest/src/adapters/gsa.ts by scripts/sync-function-libs.mjs. Do not edit here.
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
 *   Shape:     documented { results: [...] }; LIVE { Results: [...] } — see below
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

/**
 * THE LIVE API DOES NOT MATCH ITS OWN DOCUMENTATION.
 *
 * Verified 2026-09-27 by calling the real endpoint from a Supabase Edge Function
 * (678 records). Built against openapi.yaml alone, this adapter returned ZERO
 * lots in production while passing all 24 of its tests — every test used a
 * fixture written from the same wrong documentation. That is the exact failure
 * this project was restarted to avoid, and it is why fixtures now come from
 * captured live responses (test/fixtures/gsa-live-*.json).
 *
 *   documented (openapi.yaml)             live API (reality)
 *   ─────────────────────────────────     ─────────────────────────────────
 *   envelope   results                    Results
 *   fields     PascalCase (SaleNo)        camelCase (saleNo)
 *   LotNo      integer 1                  string "001"
 *   Reserve    dollar amount              boolean: "a reserve exists"
 *   LotInfo    [{LotSequence,LotDescript}] one HTML string
 *   Instruction1/2/3                      one `instruction` string
 *   AuctionStatus  'A' | 'P' | ' '        "Active" | "Preview" | ...
 *   dates      MM/DD/YYYY                 YYYY-MM-DD
 *
 * Plus data-quality defects in the live feed itself:
 *   locationZip  "85007null"   (the literal word null appended)
 *   locationCity "Phoenix                       "   (fixed-width padding)
 *   lotInfo      ~150 words of identical legal boilerplate on every lot
 *
 * Both shapes are accepted: `field()` reads the live camelCase name and falls
 * back to the documented PascalCase one, so this keeps working whichever way GSA
 * goes next.
 */
export type GsaRecord = Record<string, unknown>;

/** Read a field by its live camelCase name, falling back to documented PascalCase. */
export function field(r: GsaRecord, camel: string): unknown {
  const v = r[camel];
  if (v !== undefined) return v;
  return r[camel.charAt(0).toUpperCase() + camel.slice(1)];
}

export type GsaSaleStatus = 'active' | 'preview' | 'scheduled' | 'closed' | 'unknown';

/**
 * Decode AuctionStatus WITHOUT trimming first.
 *
 * ' ' means Scheduled per the spec. A naive `.trim()` turns that into '' and the
 * sale silently becomes 'unknown'. Order matters here.
 */
export function decodeStatus(raw: string | undefined): GsaSaleStatus {
  if (raw === undefined || raw === null) return 'unknown';
  // Documented form: a single character where a SPACE means Scheduled. Checked
  // before anything trims it.
  if (raw === ' ' || raw === '') return 'scheduled';

  // Live form: whole words ("Active"). Matching whole words first matters: the
  // old first-letter rule only decoded "Active" correctly by accident, and would
  // have read "Scheduled" as unknown and "Sold" as scheduled.
  const word = raw.trim().toLowerCase();
  if (word === 'active') return 'active';
  if (word === 'preview') return 'preview';
  if (word === 'scheduled') return 'scheduled';
  if (word === 'closed') return 'closed';

  // Documented single-letter codes. Anything else is unknown, not a guess.
  if (raw.length === 1) {
    const c = raw.toUpperCase();
    if (c === 'A') return 'active';
    if (c === 'P') return 'preview';
    if (c === 'S') return 'scheduled';
    if (c === 'C') return 'closed';
  }
  return 'unknown';
}

/** Decode HTML to plain text: tags stripped, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Sections of a GSA lotInfo that are identical boilerplate on every lot.
 *
 * They are kept (the buyer needs the removal rules) but NOT counted as
 * description. Counted naively, ~150 identical words make every federal lot look
 * richly catalogued, which would silence the sleeper signal for all of GSA.
 */
const BOILERPLATE_SECTIONS = [
  'inspection and removal',
  'disclaimer',
  'vehicle documentation',
];

export interface ParsedLotInfo {
  /** Meaningful description: overview, specifications, condition. */
  description: string | null;
  /** Removal rules, disclaimers: shown to buyers, excluded from scoring. */
  terms: string | null;
  /** "Make: Dell" style pairs from a Specifications section. */
  specs: Record<string, string>;
  /** A disclosed extra cost, e.g. "$23,000 to $25,000" removal fees. */
  feeNote: string | null;
}

/**
 * Split a GSA lotInfo HTML string into what describes the item and what doesn't.
 *
 * Two real shapes exist: structured (<h4> sections: Overview, Specifications,
 * Condition, Inspection and Removal, Disclaimer) and free-form (the aircraft
 * listings are one long run of <p><strong>). Structured listings are split by
 * section; free-form ones are kept whole, since everything in them is specific.
 */
export function parseLotInfo(html: string | null | undefined): ParsedLotInfo {
  const empty: ParsedLotInfo = { description: null, terms: null, specs: {}, feeNote: null };
  if (!html || typeof html !== 'string') return empty;

  const specs: Record<string, string> = {};
  const describe: string[] = [];
  const terms: string[] = [];

  const parts = html.split(/<h4[^>]*>/i);
  const structured = parts.length > 1;

  if (structured) {
    // parts[0] is anything before the first heading (usually empty).
    if (parts[0].trim()) describe.push(htmlToText(parts[0]));
    for (const part of parts.slice(1)) {
      const [headingHtml, ...rest] = part.split(/<\/h4>/i);
      const heading = htmlToText(headingHtml).toLowerCase();
      const bodyHtml = rest.join('');
      const body = htmlToText(bodyHtml);
      if (!body) continue;

      if (heading.startsWith('specification')) {
        for (const li of bodyHtml.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? []) {
          const text = htmlToText(li).replace(/^•\s*/, '');
          const m = text.match(/^([^:]{1,40}):\s*(.+)$/);
          if (m) specs[m[1].trim().toLowerCase()] = m[2].trim();
        }
        describe.push(body);
      } else if (BOILERPLATE_SECTIONS.some((b) => heading.startsWith(b))) {
        terms.push(body);
      } else {
        describe.push(body);
      }
    }
  } else {
    describe.push(htmlToText(html));
  }

  const fullText = htmlToText(html);
  const fee = fullText.match(
    /(?:additional|extra)[^.]{0,120}?\$\s?[\d,]+(?:\.\d{2})?(?:\s*(?:to|-|–)\s*\$\s?[\d,]+(?:\.\d{2})?)?/i,
  );

  const description = describe.join('\n').trim();
  const termText = terms.join('\n').trim();
  return {
    description: description || null,
    terms: termText || null,
    specs,
    feeNote: fee ? fee[0].trim() : null,
  };
}

/**
 * Keep only the first five digits of a ZIP.
 *
 * The live feed contains values like "85007null" — a zip with the literal word
 * "null" appended — and ZIP+4 forms. Anything without five leading digits is
 * treated as absent rather than guessed at.
 */
export function sanitizeZip(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const m = String(raw).trim().match(/^(\d{5})/);
  return m ? m[1] : null;
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

/**
 * Describe the lot, and separately collect the logistics text.
 *
 * Handles both real shapes of lotInfo: the live API's single HTML string, and the
 * documented array of {LotSequence, LotDescript}.
 *
 * Inspection and removal instructions go to `terms`, NOT the description. An
 * earlier version appended them to the description. Live data showed why that is
 * wrong: they are near-identical logistics on every lot, so counting them makes a
 * two-word listing look richly catalogued (killing the sleeper signal) and makes
 * every lot match searches for words like "removal". The buyer still sees them.
 */
export function describeGsaLot(r: GsaRecord): {
  description: string | null;
  terms: string | null;
  specs: Record<string, string>;
  feeNote: string | null;
} {
  const info = field(r, 'lotInfo');
  const describe: string[] = [];
  const terms: string[] = [];
  let specs: Record<string, string> = {};
  let feeNote: string | null = null;

  if (typeof info === 'string') {
    const parsed = parseLotInfo(info);
    if (parsed.description) describe.push(parsed.description);
    if (parsed.terms) terms.push(parsed.terms);
    specs = parsed.specs;
    feeNote = parsed.feeNote;
  } else if (Array.isArray(info)) {
    const entries = info as { LotSequence?: number; LotDescript?: string }[];
    entries
      .slice()
      .sort((a, b) => (a.LotSequence ?? 0) - (b.LotSequence ?? 0))
      .map((l) => str(l.LotDescript))
      .filter((s): s is string => !!s)
      .forEach((s) => describe.push(s));
  }

  // Live: one `instruction` field. Documented: Instruction1..3.
  const instructions = [
    field(r, 'instruction'),
    r.Instruction1, r.Instruction2, r.Instruction3,
  ]
    .map((v) => (typeof v === 'string' ? v.replace(/[•\t]+/g, ' ') : v))
    .map(str)
    .filter((s): s is string => !!s);
  if (instructions.length) terms.push(`Inspection: ${instructions.join(' ').replace(/\s+/g, ' ')}`);

  const d = describe.join('\n').trim();
  const t = terms.join('\n').trim();
  return { description: d || null, terms: t || null, specs, feeNote };
}

/**
 * PROPERTY location = where the item is = what the buyer drives to.
 *
 * `ambiguous` is set when we have a city but no state. We refuse to infer the
 * state from the city, because there is a Beloit in Wisconsin and a Beloit in
 * Kansas, and a confidently wrong location is far more damaging than a missing one.
 */
export function propertyLocation(r: GsaRecord): NormalizedLocation | null {
  const city = str(field(r, 'propertyCity'));
  const state = str(field(r, 'propertyState'));
  const zip = sanitizeZip(field(r, 'propertyZip'));
  // Live data puts the street in addr2 ("310 W. Wisconsin Avenue") and the
  // occupant in addr1 ("U.S. Dept. of HUD"), and sometimes a unit in addr3
  // ("309th AMARG"). Prefer whichever line starts with a street number.
  const lines = [field(r, 'propertyAddr1'), field(r, 'propertyAddr2'), field(r, 'propertyAddr3')]
    .map(str)
    .filter((s): s is string => !!s);
  // "A number, then a space" — so "4730 S SAFFORD AVE" qualifies but the unit name
  // "309th AMARG" (same record, addr3) does not.
  const line1 = lines.find((l) => /^\d+[A-Za-z]?\s+\S/.test(l)) ?? lines[lines.length - 1] ?? null;

  if (!city && !state && !zip && !line1) return null;

  return {
    line1,
    city,
    state: state ? state.toUpperCase().slice(0, 2) : null,
    postalCode: zip,
    ambiguous: !!city && !state,
  };
}

/** Normalize one API record into an auction + its lot. Pure; no I/O. */
export function normalizeGsaRecord(
  r: GsaRecord,
): { auction: NormalizedAuction; lot: NormalizedLot } | null {
  const saleNo = str(field(r, 'saleNo'));
  const itemName = str(field(r, 'itemName'));
  // Without a sale number we cannot build a stable id, and without a name the row
  // is not a usable lot. Both are hard requirements.
  if (!saleNo || !itemName) return null;

  // Live lotNo is a zero-padded string ("040"); documented LotNo is an integer.
  // The id uses the integer so "040" and 40 are the same lot; the display keeps
  // the source's own form, which is what the buyer sees on gsaauctions.gov.
  const rawLotNo = field(r, 'lotNo');
  const lotNo = int(rawLotNo);
  const lotExternalId = lotNo === null ? saleNo : `${saleNo}/${lotNo}`;

  const status = decodeStatus(field(r, 'auctionStatus') as string | undefined);
  const close = gsaCloseInstant(field(r, 'aucEndDt') as string | undefined);
  const startParts = parseGsaDate(field(r, 'aucStartDt') as string | undefined);
  const startsAt = startParts
    ? new Date(Date.UTC(startParts.y, startParts.m - 1, startParts.d, 12, 0, 0)).toISOString()
    : null;

  // Closure is derived from the date. The documented status vocabulary had no
  // closed value; the live one might, and either way the date is authoritative.
  const closed = status === 'closed'
    || (close ? new Date(close.iso).getTime() < Date.now() : false);

  const currentBidCents = parseMoneyToCents(field(r, 'highBidAmount'));
  const incrementCents = parseMoneyToCents(field(r, 'aucIncrement'));

  // Documented Reserve is a dollar amount; live `reserve` is a boolean meaning
  // "a reserve exists" with the amount undisclosed. Treating the boolean as money
  // would be wrong, and parseMoneyToCents(true) returns null anyway -- but the
  // distinction is kept explicitly so reserve_met is never computed from a guess.
  const rawReserve = field(r, 'reserve');
  const hasReserve = typeof rawReserve === 'boolean' ? rawReserve : null;
  const reserveCents = typeof rawReserve === 'boolean' ? null : parseMoneyToCents(rawReserve);

  const pickup = propertyLocation(r);
  const described = describeGsaLot(r);

  const imageUrl = str(field(r, 'imageURL'));
  const itemUrl = str(field(r, 'itemDescURL'));
  const agencyName = str(field(r, 'agencyName'));
  const bureauName = str(field(r, 'bureauName'));

  // Structured specs from lotInfo ("Make: Dell", "Model: 5320") give hunts a real
  // brand and model to match, instead of only a two-word title.
  const brand = described.specs['make'] ?? null;
  const modelYear = described.specs['model year'] ?? null;
  const model = described.specs['model']
    ? (modelYear ? `${modelYear} ${described.specs['model']}` : described.specs['model'])
    : null;

  const auction: NormalizedAuction = {
    externalId: saleNo,
    title: `GSA sale ${saleNo}${agencyName ? ` — ${agencyName}` : ''}`,
    description: str(field(r, 'saleLocation')),
    auctioneer: agencyName ?? 'U.S. General Services Administration',
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
    sellerName: agencyName ?? bureauName,
    sellerState: str(field(r, 'locationST'))?.toUpperCase().slice(0, 2) ?? null,
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
    lotNumber: str(rawLotNo),
    title: itemName,
    description: described.description,
    brand,
    model,
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
    bidCount: int(field(r, 'biddersCount')),
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
        inactivityMinutes: int(field(r, 'inactivityTime')),
        sellerState: str(field(r, 'locationST')),
        agencyCode: str(field(r, 'agencyCode')),
        bureauCode: str(field(r, 'bureauCode')),
        contractOfficer: str(field(r, 'contractOfficer')),
        hasReserve,
        // Shown to buyers, excluded from search text and the sleeper score.
        terms: described.terms,
        // A disclosed extra cost the hammer price does not include. The T-34C
        // listings disclose $23,000-$25,000 of removal fees on a ~$100k bid.
        feeNote: described.feeNote,
        vin: described.specs['vin'] ?? null,
        mileage: described.specs['mileage'] ?? null,
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

  // The LIVE envelope is { Results: [...] }; the documented one is { results: [...] }.
  // Checking only the documented key is what made this adapter return zero lots
  // in production: the whole live envelope fell through to the bare-object branch
  // below and was treated as a single record with no SaleNo. Both keys are
  // accepted, plus a bare array and a single object, which government feeds emit.
  const envelope =
    body && typeof body === 'object' && !Array.isArray(body)
      ? ((body as any).Results ?? (body as any).results)
      : undefined;

  let records: unknown[];
  if (Array.isArray(body)) {
    records = body;
  } else if (Array.isArray(envelope)) {
    records = envelope;
  } else if (body && typeof body === 'object') {
    records = [body];
    warnings.push('Response was a bare object, not a { Results: [...] } envelope.');
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
      // One unfiltered request returns every live listing, so absence means gone.
      completeSnapshot: true,
    };
  },
};
