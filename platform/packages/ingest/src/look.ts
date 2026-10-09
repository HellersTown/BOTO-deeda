/**
 * Looking at lot photos (0057): what the model is told, the photos it is
 * shown, the JSON it must return, and how that answer becomes lot_looks rows.
 *
 * Pure apart from the injected fetch in photoFetcher: no clock, no Deno APIs.
 * The look-at-lots Edge Function carries a generated copy
 * (scripts/sync-function-libs.mjs); the tests run here.
 *
 * WHY. A title is what the seller typed; a photo shows what the lot is. On
 * 2026-10-05, 1,273 of 11,098 open lots (11.5%) had titles the search
 * vocabulary could not place ("Lot 19", "Garage items", "Assortment of
 * Parts"), and none of the 85,590 stored photos had ever been looked at. A
 * look names the kinds of items a lot's photos show, in the vocabulary's own
 * ids, so search finds a bookcase sold as "Furniture", and it says when a
 * photo contradicts the title.
 *
 * PHOTOS. Fetched by our crawler, like any page: our User-Agent, the photo
 * host's robots.txt read first (RFC 9309: a 4xx means no rules, an unreachable
 * one means no fetching), requests to one host spaced out, at most
 * MAX_PHOTO_BYTES each, and only JPEG, PNG, GIF or WebP, sniffed from the bytes
 * (a CDN may answer AVIF, which the model does not read). Only lots of sources
 * whose terms allow Skeuos to use their listings are looked at; the database
 * picks them (next_lots_to_look).
 */
import { isAllowed, parseRobots, robotsVerdictFromStatus } from './robots.ts';
import type { ParsedRobots } from './robots.ts';

/** One vocabulary concept, as search_concepts holds it. */
export interface LookConcept {
  readonly id: string;
  readonly label: string;
  readonly parent: string | null;
}

/** One lot to look at. */
export interface LookLot {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  /** The lot's photos, in the source's order. */
  readonly imageUrls: readonly string[];
  /** The kinds its title already names (lots.item_heads); empty when it names none. */
  readonly titleKinds: readonly string[];
}

export const LOOK_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type LookConfidence = (typeof LOOK_CONFIDENCE)[number];

/** Lots per model call: their photos travel together, so a request stays a few megabytes. */
export const LOOK_BATCH = 8;
/** Description characters sent per lot: what it is comes first; the tail is terms and pickup notes. */
export const LOOK_DESCRIPTION_CHARS = 400;
/** Kinds kept per lot. */
export const LOOK_MAX_KINDS = 5;
/** The largest photo fetched. */
export const MAX_PHOTO_BYTES = 5_000_000;

/**
 * The photos looked at for a lot: the first, and the second too when the title
 * names no kind, because then the photos have to say everything.
 */
export function photosFor(lot: LookLot): string[] {
  const urls = lot.imageUrls.filter((u) => /^https?:\/\//i.test(u));
  return urls.slice(0, lot.titleKinds.length === 0 ? 2 : 1);
}

/** The instructions, with the vocabulary. The same for every call, so it is cached. */
export function buildLookSystem(concepts: readonly LookConcept[]): string {
  const byParent = new Map<string | null, LookConcept[]>();
  for (const c of concepts) {
    const list = byParent.get(c.parent) ?? [];
    list.push(c);
    byParent.set(c.parent, list);
  }
  const sorted = (list: LookConcept[] | undefined) => [...(list ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [];
  const walk = (c: LookConcept, depth: number) => {
    lines.push(`${'  '.repeat(depth)}${c.id}: ${c.label}`);
    for (const child of sorted(byParent.get(c.id))) walk(child, depth + 1);
  };
  const ids = new Set(concepts.map((c) => c.id));
  // Roots, and any concept whose parent is not in the list, start a tree.
  for (const c of sorted(concepts.filter((c) => c.parent === null || !ids.has(c.parent)))) walk(c, 0);

  return `You look at the photos of auction lots and say what each lot is, for the search engine of a buyer in Wisconsin who buys at auction to resell and for their own use.

For each lot you get its number, the title and description its seller wrote, and one or two photos. Most titles are right; some are vague ("Lot 19", "Garage items", "Contents of shelf") and some are wrong.

Say what a buyer of the lot takes home: the item or items being sold. Ignore the room, the floor, the table or shelf a thing is photographed on, other lots in the background, packaging and price tags, unless the title says they are part of the lot.

For each lot, answer:
- kinds: the kinds of items in the lot, from the list below, the most important first, at most ${LOOK_MAX_KINDS}. Name a kind only when the photos show it, or when the title states it and the photos do not contradict it. An empty list when nothing in the list fits.
- main: the one kind that says what the lot is, or null when the lot is a mix with no main item or nothing in the list fits. Prefer the most specific kind that is true ("bookcases" over "furniture").
- caption: one line of at most 15 words naming what is visible: the item, its material or colour when that matters to a buyer, and how many when there are several ("Oak bookcase, five shelves, about six feet tall"; "Tote of hand tools: wrenches, pliers, two hammers").
- brand and model: only when legible in a photo (a badge, a nameplate, a label) or stated in the title; otherwise null. Never guess a brand from how a thing looks.
- agrees: true when the photos show what the title says, false when they show something else, null when the title says too little to tell.
- confidence: high, medium or low, for main (or for kinds when main is null).

Answer for every lot, by its number.

The kinds, each under its parent kind:
${lines.join('\n')}`;
}

/** The answer's shape, with kinds limited to the vocabulary's ids. */
export function lookSchema(conceptIds: readonly string[]): Record<string, unknown> {
  const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
  return {
    type: 'object',
    $defs: { kind: { type: 'string', enum: [...conceptIds] } },
    properties: {
      lots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lot: { type: 'integer' },
            kinds: { type: 'array', items: { $ref: '#/$defs/kind' } },
            main: nullable({ $ref: '#/$defs/kind' }),
            caption: { type: 'string' },
            brand: nullable({ type: 'string' }),
            model: nullable({ type: 'string' }),
            agrees: nullable({ type: 'boolean' }),
            confidence: { type: 'string', enum: [...LOOK_CONFIDENCE] },
          },
          required: ['lot', 'kinds', 'main', 'caption', 'brand', 'model', 'agrees', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['lots'],
    additionalProperties: false,
  };
}

export type PhotoMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface LookPhoto {
  readonly url: string;
  readonly mediaType: PhotoMediaType;
  readonly base64: string;
}

/** A content block of the user message, in the Messages API's shape. */
export type LookBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: PhotoMediaType; data: string } };

/** Collapse whitespace and cut to `max` characters at a word boundary. */
function clip(text: string | null, max: number): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The user message: each lot's number, title and description, then its
 * photos. A lot whose photos could not be fetched is not sent at all.
 */
export function buildLookContent(lots: readonly LookLot[], photos: ReadonlyMap<string, readonly LookPhoto[]>): LookBlock[] {
  const blocks: LookBlock[] = [];
  lots.forEach((lot, i) => {
    const mine = photos.get(lot.id) ?? [];
    if (mine.length === 0) return;
    const description = clip(lot.description, LOOK_DESCRIPTION_CHARS);
    blocks.push({
      type: 'text',
      text: `Lot ${i + 1}\nTitle: ${clip(lot.title, 300) ?? '(none)'}\nDescription: ${description ?? '(none)'}\n${
        mine.length === 1 ? 'Its photo:' : `Its ${mine.length} photos:`
      }`,
    });
    for (const p of mine) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } });
    }
  });
  if (blocks.length > 0) blocks.push({ type: 'text', text: 'Answer for every lot above, by its number.' });
  return blocks;
}

/** One lot_looks row. */
export interface LookRow {
  readonly lot_id: string;
  readonly kinds: string[];
  readonly main_kind: string | null;
  readonly caption: string;
  readonly brand: string | null;
  readonly model_number: string | null;
  readonly title_agrees: boolean | null;
  readonly confidence: LookConfidence;
  readonly image_urls: string[];
  readonly model: string;
}

export interface ParsedLooks {
  readonly rows: LookRow[];
  readonly problems: string[];
}

const shortText = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
};

/**
 * The model's answer as rows, checked: a lot number must be one that was
 * sent, kinds must be vocabulary ids (unknown ones are dropped and reported),
 * and a lot answered twice keeps its first answer.
 */
export function parseLooks(
  answer: string,
  lots: readonly LookLot[],
  photos: ReadonlyMap<string, readonly LookPhoto[]>,
  conceptIds: readonly string[],
  model: string,
): ParsedLooks {
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return { rows: [], problems: ['the answer was not JSON'] };
  }
  const list = (parsed as { lots?: unknown })?.lots;
  if (!Array.isArray(list)) return { rows: [], problems: ['the answer has no lots list'] };

  const known = new Set(conceptIds);
  const sent = new Set(lots.filter((l) => (photos.get(l.id) ?? []).length > 0).map((l) => l.id));
  const rows: LookRow[] = [];
  const done = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const n = typeof e.lot === 'number' && Number.isInteger(e.lot) ? e.lot : null;
    const lot = n !== null && n >= 1 && n <= lots.length ? lots[n - 1] : undefined;
    if (!lot || !sent.has(lot.id)) {
      problems.push(`an answer for lot ${String(e.lot)}, which was not sent`);
      continue;
    }
    if (done.has(lot.id)) continue;
    const rawKinds = Array.isArray(e.kinds) ? e.kinds.filter((k): k is string => typeof k === 'string') : [];
    const unknown = rawKinds.filter((k) => !known.has(k));
    if (unknown.length) problems.push(`lot ${n}: unknown kind(s) ${unknown.slice(0, 3).join(', ')}`);
    const kinds = [...new Set(rawKinds.filter((k) => known.has(k)))].slice(0, LOOK_MAX_KINDS);
    const main = typeof e.main === 'string' && known.has(e.main) ? e.main : null;
    // The main kind is one of the kinds, first.
    const withMain = main && !kinds.includes(main) ? [main, ...kinds].slice(0, LOOK_MAX_KINDS) : kinds;
    const confidence = LOOK_CONFIDENCE.find((c) => c === e.confidence) ?? 'low';
    rows.push({
      lot_id: lot.id,
      kinds: withMain,
      main_kind: main,
      caption: shortText(e.caption, 200) ?? '',
      brand: shortText(e.brand, 80),
      model_number: shortText(e.model, 80),
      title_agrees: typeof e.agrees === 'boolean' ? e.agrees : null,
      confidence,
      image_urls: (photos.get(lot.id) ?? []).map((p) => p.url),
      model,
    });
    done.add(lot.id);
  }
  const missing = [...sent].filter((id) => !done.has(id)).length;
  if (missing) problems.push(`${missing} lot(s) sent but not answered`);
  return { rows, problems };
}

/** The image type from the file's first bytes; null for anything the model does not read (AVIF, SVG, HTML). */
export function sniffImageType(bytes: Uint8Array): PhotoMediaType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64, without Buffer or btoa (neither is in both Node and Deno the same way). */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

export type PhotoResult = { ok: true; photo: LookPhoto } | { ok: false; why: string };

export interface PhotoFetchOptions {
  fetch: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** Our crawler's User-Agent, and the token robots.txt rules are read for. */
  userAgent: string;
  robotsToken: string;
  /** Least time between two requests to one host. */
  spacingMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * A photo fetcher with our crawler's manners: robots.txt read once per host
 * (no rules on a 4xx, no fetching when it cannot be read), one request at a
 * time per host and spacingMs apart, a byte cap, and image types sniffed.
 */
export function photoFetcher(opts: PhotoFetchOptions): (url: string) => Promise<PhotoResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const headers = (accept: string) => ({ 'User-Agent': opts.userAgent, Accept: accept });
  const signal = () => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(opts.timeoutMs ?? 20_000) : undefined);
  const robots = new Map<string, Promise<ParsedRobots | 'none' | 'all'>>();
  const queue = new Map<string, Promise<unknown>>();
  const lastAt = new Map<string, number>();

  /** Run `task` after every earlier request to this host, spaced. */
  const onHost = <T>(host: string, task: () => Promise<T>): Promise<T> => {
    const before = queue.get(host) ?? Promise.resolve();
    const run = before.then(async () => {
      const wait = (lastAt.get(host) ?? -Infinity) + opts.spacingMs - now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        lastAt.set(host, now());
      }
    });
    queue.set(host, run.catch(() => {}));
    return run;
  };

  const rulesFor = (origin: string, host: string) => {
    let p = robots.get(origin);
    if (!p) {
      p = onHost(host, async () => {
        try {
          const res = await opts.fetch(`${origin}/robots.txt`, { headers: headers('text/plain,*/*;q=0.5'), signal: signal() });
          const verdict = robotsVerdictFromStatus(res.status);
          if (verdict === 'unreachable') return 'none' as const;
          if (verdict === 'absent') return 'all' as const;
          return parseRobots(await res.text());
        } catch {
          return 'none' as const;
        }
      });
      robots.set(origin, p);
    }
    return p;
  };

  return async (url: string): Promise<PhotoResult> => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, why: 'not a URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, why: 'not http(s)' };
    const rules = await rulesFor(u.origin, u.host);
    if (rules === 'none') return { ok: false, why: `robots.txt of ${u.host} could not be read` };
    if (rules !== 'all' && !isAllowed(rules, opts.robotsToken, u.pathname + u.search)) {
      return { ok: false, why: `robots.txt of ${u.host} disallows it` };
    }
    return onHost(u.host, async (): Promise<PhotoResult> => {
      try {
        const res = await opts.fetch(url, {
          headers: headers('image/jpeg,image/png,image/webp,image/gif;q=0.9'),
          signal: signal(),
        });
        if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MAX_PHOTO_BYTES) return { ok: false, why: 'larger than the photo cap' };
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, why: 'larger than the photo cap' };
        const mediaType = sniffImageType(bytes);
        if (!mediaType) return { ok: false, why: 'not a JPEG, PNG, GIF or WebP' };
        return { ok: true, photo: { url, mediaType, base64: toBase64(bytes) } };
      } catch (e) {
        return { ok: false, why: e instanceof Error ? e.message : String(e) };
      }
    });
  };
}
