/**
 * schema.org JSON-LD extraction.
 *
 * THE POINT, because it is easy to miss how much this changes:
 *
 * Auction sites want Google to index their lots. So they voluntarily embed clean,
 * structured, machine-readable data in every lot page:
 *
 *   <script type="application/ld+json">
 *   {"@type":"Product","name":"DJI Mavic 3T Thermal",
 *    "offers":{"@type":"Offer","price":"1450.00","priceCurrency":"USD",
 *              "availabilityEnds":"2026-10-04T23:00:00-05:00"}}
 *   </script>
 *
 * That is not scraping. That is consuming a published feed that happens to live
 * inside an HTML document, placed there deliberately for machines to read. It is
 * versioned, it is typed, and it does not break when the site restyles its
 * markup — because the site's own SEO depends on it staying valid.
 *
 * ALWAYS check for this before writing a single CSS selector. A site with JSON-LD
 * needs no HTML parsing at all, which moves it from ingest rung 5 (brittle) to
 * rung 2 (durable) for free.
 *
 * This module intentionally does no network I/O. It takes HTML text and returns
 * normalized records, which makes it exhaustively testable offline.
 */

import type { NormalizedLot, NormalizedImage } from './types.ts';
import { parseMoneyToCents } from './money.ts';

/** Minimal, dependency-free extraction of ld+json script bodies. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  // Tolerant of attribute order, extra attributes, and single or double quotes.
  const re =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let body = m[1].trim();
    if (!body) continue;

    // Real pages wrap JSON in CDATA, and some CMSs HTML-escape the quotes.
    body = body
      .replace(/^<!\[CDATA\[/, '')
      .replace(/\]\]>$/, '')
      .trim();

    const candidates = [body];
    if (body.includes('&quot;') || body.includes('&amp;')) {
      candidates.push(
        body
          .replace(/&quot;/g, '"')
          .replace(/&#34;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&'),
      );
    }

    for (const c of candidates) {
      try {
        out.push(JSON.parse(c));
        break;
      } catch {
        // One malformed block must never discard the rest of the page. Sites ship
        // broken JSON-LD constantly; the other blocks are usually fine.
      }
    }
  }
  return out;
}

/** Flatten @graph containers and arrays into a single list of nodes. */
export function flattenNodes(parsed: unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (v: unknown, depth = 0) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    const obj = v as Record<string, unknown>;
    nodes.push(obj);
    if ('@graph' in obj) visit(obj['@graph'], depth + 1);
    // Nested products appear under itemListElement on catalogue pages.
    if ('itemListElement' in obj) visit(obj['itemListElement'], depth + 1);
    if ('item' in obj) visit(obj['item'], depth + 1);
  };
  for (const p of parsed) visit(p);
  return nodes;
}

function typeOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

function firstString(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = firstString(item);
      if (s) return s;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // ImageObject / Person / Organization / Brand all use `name` or `url`.
    return firstString(o['name']) ?? firstString(o['url']) ?? firstString(o['contentUrl']);
  }
  return null;
}

function collectImages(v: unknown): NormalizedImage[] {
  const urls: string[] = [];
  const visit = (x: unknown, depth = 0) => {
    if (depth > 4 || x === null || x === undefined) return;
    if (typeof x === 'string') {
      const s = x.trim();
      if (s) urls.push(s);
      return;
    }
    if (Array.isArray(x)) {
      for (const i of x) visit(i, depth + 1);
      return;
    }
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      visit(o['url'] ?? o['contentUrl'], depth + 1);
    }
  };
  visit(v);
  // Dedupe while preserving order; the first image is the one the site chose to
  // lead with, and that ordering is worth keeping.
  const seen = new Set<string>();
  const out: NormalizedImage[] = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ url: u, position: out.length });
  }
  return out;
}

/** schema.org condition IRIs -> our plain vocabulary. */
function mapCondition(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const tail = s.split('/').pop()!.toLowerCase();
  if (tail.includes('new')) return 'new';
  if (tail.includes('used')) return 'used';
  if (tail.includes('refurbish')) return 'refurbished';
  if (tail.includes('damaged')) return 'damaged';
  return s.length <= 40 ? s : null;
}

function pickOffer(node: Record<string, unknown>): Record<string, unknown> | null {
  const raw = node['offers'];
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const o of list) {
    if (o && typeof o === 'object') return o as Record<string, unknown>;
  }
  return null;
}

/** ISO-ish date validation. Refuses anything we cannot trust as a close time. */
function parseDate(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // A close time in 1970 or 2200 means we misread a field, not that the auction
  // is unusual. Reject rather than publish a nonsense countdown.
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return d.toISOString();
}

export interface JsonLdLotOptions {
  /** Page URL, used to resolve the lot's own link when the markup omits it. */
  pageUrl?: string;
  /** Fallback external id when the markup has no sku/productID. */
  fallbackId?: string;
}

/**
 * Pull every Product-shaped node out of a page and normalize it.
 *
 * Returns an array because catalogue pages carry many products, and lot pages
 * sometimes carry a primary product plus related ones.
 */
export function lotsFromJsonLd(html: string, opts: JsonLdLotOptions = {}): NormalizedLot[] {
  const nodes = flattenNodes(extractJsonLdBlocks(html));
  const out: NormalizedLot[] = [];
  const seenIds = new Set<string>();

  for (const node of nodes) {
    const types = typeOf(node).map((t) => t.toLowerCase());
    const isProduct =
      types.includes('product') ||
      types.includes('individualproduct') ||
      types.includes('vehicle') ||
      types.includes('productmodel');
    if (!isProduct) continue;

    const title = firstString(node['name']);
    if (!title) continue; // A product with no name is not a usable lot.

    const offer = pickOffer(node);
    const url =
      firstString(node['url']) ??
      (offer ? firstString(offer['url']) : null) ??
      opts.pageUrl ??
      null;

    const externalId =
      firstString(node['sku']) ??
      firstString(node['productID']) ??
      firstString(node['mpn']) ??
      firstString(node['@id']) ??
      opts.fallbackId ??
      url ??
      title;

    // Two nodes describing the same product (common: one for the page, one for a
    // widget) must not become two lots.
    if (seenIds.has(externalId)) continue;
    seenIds.add(externalId);

    const priceRaw = offer
      ? (offer['price'] ?? offer['lowPrice'] ?? offer['highPrice'] ?? null)
      : null;

    const currentBidCents = parseMoneyToCents(priceRaw);

    const closesAt = offer
      ? (parseDate(offer['availabilityEnds']) ??
         parseDate(offer['validThrough']) ??
         parseDate(offer['priceValidUntil']))
      : null;

    const images = collectImages(node['image']);

    out.push({
      externalId,
      lotNumber: firstString(node['sku']) ?? null,
      title,
      description: firstString(node['description']),
      brand: firstString(node['brand']),
      model: firstString(node['model']) ?? firstString(node['mpn']),
      condition: mapCondition(offer?.['itemCondition'] ?? node['itemCondition']),
      currentBidCents,
      bidCount: null,
      closesAt,
      closed: closesAt ? new Date(closesAt).getTime() < Date.now() : false,
      url,
      images,
      raw: node,
    });
  }

  return out;
}

/**
 * Does this page carry usable JSON-LD?
 *
 * Run this during source onboarding to decide which ingest rung a source belongs
 * on, instead of assuming the worst and writing selectors nobody needed.
 */
export function assessJsonLd(html: string): {
  blocks: number;
  productNodes: number;
  usableLots: number;
  withPrice: number;
  withCloseTime: number;
  withImages: number;
  verdict: 'json_ld' | 'partial' | 'none';
} {
  const blocks = extractJsonLdBlocks(html);
  const nodes = flattenNodes(blocks);
  const productNodes = nodes.filter((n) =>
    typeOf(n).some((t) => t.toLowerCase().includes('product')),
  ).length;
  const lots = lotsFromJsonLd(html);
  const withPrice = lots.filter((l) => l.currentBidCents !== null).length;
  const withCloseTime = lots.filter((l) => l.closesAt).length;
  const withImages = lots.filter((l) => l.images.length > 0).length;

  // "Partial" is the honest verdict when the markup exists but omits the fields
  // that make a lot actionable. A lot without a close time cannot drive an alert,
  // so such a source still needs supplementary parsing.
  let verdict: 'json_ld' | 'partial' | 'none' = 'none';
  if (lots.length > 0) {
    verdict = withPrice > 0 && withCloseTime > 0 ? 'json_ld' : 'partial';
  }

  return {
    blocks: blocks.length,
    productNodes,
    usableLots: lots.length,
    withPrice,
    withCloseTime,
    withImages,
    verdict,
  };
}
