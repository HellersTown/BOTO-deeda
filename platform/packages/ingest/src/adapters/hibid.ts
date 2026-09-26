/**
 * HiBid platform adapter.
 *
 * THE HIGHEST-LEVERAGE ADAPTER IN THE PROJECT. Nearly every small and mid-size
 * Wisconsin auction house runs on HiBid/AuctionFlex, so one working parser here is
 * worth more than a dozen bespoke site scrapers.
 *
 * TENANCY IS THE WHOLE POINT. Observed hosts, all the same platform:
 *
 *   hameleauctions.hibid.com          Hamele Auction Service      (Central WI)
 *   hansenonlineauction.hibid.com     Hansen Auction & Realty     (Beloit, KANSAS)
 *   auctionwi.hibid.com               Wisconsin Auction Company
 *   bids.beloitauction.com            Beloit Auction & Realty (WI) <- WHITE LABEL
 *   hibid.com/company/72559/...       the same houses, indexed centrally
 *
 * A naive crawler sees five websites. This sees one platform with five tenants.
 * That is why the adapter keys on PLATFORM and takes the host as configuration:
 * onboarding a new Wisconsin auction house becomes a database INSERT.
 *
 * Verified URL shapes (from live search results, not guessed):
 *   {host}/auctions                     current auction list
 *   {host}/auctions/past                closed auctions
 *   {host}/catalog/{catalogId}/{slug}   one auction's lot catalogue
 *   hibid.com/{state}/auctions          state-scoped index
 *   hibid.com/{state}/companysearch     auctioneer enumeration (source discovery)
 *
 * ---------------------------------------------------------------------------
 * HONEST LIMITATION, STATED UP FRONT
 *
 * This container's egress policy blocks outbound HTTP, so no live HiBid page could
 * be fetched while writing this. The DOM-level specifics of HiBid's markup are
 * therefore UNVERIFIED.
 *
 * The response is not to guess selectors and hope. It is to make the adapter
 * DISCOVER its own capabilities at runtime: `probeTenant()` fetches one page and
 * reports whether JSON-LD is usable, whether RSS exists, and what the markup
 * actually offers. The verdict is written to sources.ingest, so the adapter
 * upgrades itself from brittle to durable the first time it sees real HTML.
 *
 * That design is better than a verified hardcoded parser anyway: HiBid can change
 * its markup, and a probe notices while a hardcoded selector silently returns zero
 * rows for three weeks.
 * ---------------------------------------------------------------------------
 */

import type {
  Adapter,
  AdapterContext,
  IngestResult,
  IngestMethod,
  NormalizedAuction,
  NormalizedLot,
} from '../types.ts';
import { lotsFromJsonLd, assessJsonLd } from '../jsonld.ts';
import { parseMoneyToCents } from '../money.ts';

/** A HiBid tenant: one auction house on the shared platform. */
export interface HibidTenant {
  /** Hostname serving this tenant, subdomain or custom domain. */
  host: string;
  /** Stable slug for ids. Derived from the host. */
  slug: string;
  /** True when the host is *.hibid.com rather than a white-label domain. */
  isHibidSubdomain: boolean;
}

/**
 * Derive a tenant from any HiBid-ish URL.
 *
 * Handles the subdomain form and the white-label form identically, which is the
 * behaviour that makes `bids.beloitauction.com` and `hameleauctions.hibid.com`
 * cost the same to support.
 */
export function tenantFromUrl(input: string): HibidTenant | null {
  let host: string;
  try {
    host = new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  const isHibidSubdomain = host.endsWith('.hibid.com') || host === 'hibid.com';

  let slug: string;
  if (host === 'hibid.com' || host === 'www.hibid.com') {
    slug = 'hibid-central';
  } else if (isHibidSubdomain) {
    // hameleauctions.hibid.com -> hameleauctions
    slug = host.slice(0, -'.hibid.com'.length);
  } else {
    // bids.beloitauction.com -> beloitauction
    const parts = host.replace(/^www\./, '').split('.');
    slug = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
  }

  return { host, slug, isHibidSubdomain };
}

/** Candidate entry points for a tenant, cheapest and most durable first. */
export function tenantUrls(t: HibidTenant): {
  auctions: string;
  pastAuctions: string;
  rss: string[];
  robots: string;
} {
  const base = `https://${t.host}`;
  return {
    auctions: `${base}/auctions`,
    pastAuctions: `${base}/auctions/past`,
    // RSS paths are the plausible candidates; probeTenant() determines which (if
    // any) actually resolve rather than assuming.
    rss: [`${base}/rss`, `${base}/auctions/rss`, `${base}/feed`],
    robots: `${base}/robots.txt`,
  };
}

/** Catalogue URL for one auction, per the verified /catalog/{id}/{slug} shape. */
export function catalogUrl(t: HibidTenant, catalogId: string | number, slug = 'catalog'): string {
  return `https://${t.host}/catalog/${catalogId}/${slug}`;
}

/**
 * Extract catalogue ids from an auction-list page.
 *
 * Deliberately pattern-based on the URL shape rather than on CSS classes: a link
 * href is far more stable than a class name across a restyle, and /catalog/{id}/
 * is a routing contract the site cannot change without breaking its own links.
 */
export function catalogIdsFromHtml(html: string): string[] {
  const ids = new Set<string>();
  const re = /\/catalog\/(\d{3,12})(?:\/|["'?#])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

/**
 * Buyer's premium, pulled from terms prose.
 *
 * This matters more than it looks. Hamele's published terms are a 10% online
 * premium plus 3.5% for card payment, so a $100 hammer is $113.50 out the door.
 * Showing only the hammer price is the standard quiet deception of the auction
 * world, and carrying this field is how the app avoids repeating it.
 *
 * Returns null when nothing unambiguous is found — a wrong premium is worse than
 * an absent one, because it makes the total look authoritative.
 */
export function extractBuyerPremium(text: string): { pct: number; note: string } | null {
  if (!text) return null;
  const haystack = text.replace(/\s+/g, ' ');

  // "10% buyer's premium", "buyer premium of 13%", "15% BP"
  const patterns = [
    /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:online\s+)?buyer'?s?\s*premium/i,
    /buyer'?s?\s*premium\s*(?:of\s*)?(\d{1,2}(?:\.\d{1,2})?)\s*%/i,
    /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*BP\b/i,
  ];

  for (const re of patterns) {
    const m = haystack.match(re);
    if (m) {
      const pct = Number(m[1]);
      // A premium above 30% is almost certainly a misparse of some other number.
      if (Number.isFinite(pct) && pct > 0 && pct <= 30) {
        return { pct, note: m[0].trim() };
      }
    }
  }
  return null;
}

/** Card / convenience surcharge, which stacks on top of the premium. */
export function extractCardFee(text: string): number | null {
  if (!text) return null;
  const haystack = text.replace(/\s+/g, ' ');
  const m = haystack.match(
    /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:additional\s*)?(?:fee\s*)?(?:for\s*)?(?:credit\s*card|card|convenience)/i,
  );
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) && pct > 0 && pct <= 15 ? pct : null;
}

/** What a capability probe learned about one tenant. */
export interface TenantProbe {
  host: string;
  slug: string;
  httpStatus: number;
  /** The rung this tenant should be assigned. */
  recommendedIngest: IngestMethod;
  jsonLd: ReturnType<typeof assessJsonLd>;
  catalogIdsFound: number;
  buyerPremiumPct: number | null;
  cardFeePct: number | null;
  notes: string[];
}

/**
 * Probe one tenant and decide how to ingest it.
 *
 * Run this at source-onboarding time. It replaces the guesswork of "which rung
 * does this site belong on" with a measurement, and it is the mechanism that lets
 * the adapter be written without ever having seen the live markup.
 */
export async function probeTenant(ctx: AdapterContext, hostOrUrl: string): Promise<TenantProbe> {
  const tenant = tenantFromUrl(hostOrUrl);
  if (!tenant) throw new Error(`Not a usable HiBid host: ${hostOrUrl}`);

  const urls = tenantUrls(tenant);
  const notes: string[] = [];

  const res = await ctx.fetch(urls.auctions, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });

  const html = res.status >= 200 && res.status < 300 ? res.text : '';
  const jsonLd = assessJsonLd(html);
  const catalogIds = catalogIdsFromHtml(html);
  const premium = extractBuyerPremium(html);
  const cardFee = extractCardFee(html);

  // The ladder, applied as a decision rather than an assumption.
  let recommendedIngest: IngestMethod;
  if (jsonLd.verdict === 'json_ld') {
    recommendedIngest = 'json_ld';
    notes.push('Lot pages carry usable schema.org Product markup: durable ingestion, no selectors needed.');
  } else if (jsonLd.verdict === 'partial') {
    recommendedIngest = 'html';
    notes.push(
      'JSON-LD is present but incomplete (missing price or close time), so it cannot drive alerts alone. ' +
        'Supplement with HTML extraction for the missing fields.',
    );
  } else if (catalogIds.length > 0) {
    recommendedIngest = 'html';
    notes.push('No JSON-LD, but /catalog/{id}/ links are present, so auction discovery works.');
  } else if (html.length > 0) {
    recommendedIngest = 'headless';
    notes.push(
      'Page returned HTML but neither JSON-LD nor catalogue links were found, which usually means ' +
        'the lot grid is rendered client-side. A headless fetch is likely required.',
    );
  } else {
    recommendedIngest = 'manual';
    notes.push(`Fetch failed with HTTP ${res.status}; nothing could be determined.`);
  }

  if (premium) notes.push(`Buyer's premium detected: ${premium.pct}% ("${premium.note}").`);
  else notes.push("No buyer's premium found on this page; check the terms page before trusting totals.");

  return {
    host: tenant.host,
    slug: tenant.slug,
    httpStatus: res.status,
    recommendedIngest,
    jsonLd,
    catalogIdsFound: catalogIds.length,
    buyerPremiumPct: premium?.pct ?? null,
    cardFeePct: cardFee,
    notes,
  };
}

/**
 * Normalize a catalogue page into one auction plus its lots.
 *
 * Built on the JSON-LD extractor, which is separately and exhaustively tested, so
 * this function only has to handle the HiBid-shaped wrapping around it.
 */
export function normalizeCatalogPage(
  html: string,
  opts: {
    tenant: HibidTenant;
    catalogId: string;
    pageUrl: string;
    auctionTitle?: string | null;
    auctioneer?: string | null;
    timezone?: string | null;
  },
): { auction: NormalizedAuction; lots: NormalizedLot[]; warnings: string[] } {
  const warnings: string[] = [];
  const jsonLdLots = lotsFromJsonLd(html, { pageUrl: opts.pageUrl });

  const premium = extractBuyerPremium(html);
  const cardFee = extractCardFee(html);

  const auctionExternalId = `${opts.tenant.slug}/${opts.catalogId}`;

  // Auction-level close time is the latest lot close we can see. HiBid staggers lot
  // closes ("soft close"), so an auction-level ends_at is a summary, never the
  // thing that should drive a per-lot alert.
  const closeTimes = jsonLdLots
    .map((l) => l.closesAt)
    .filter((s): s is string => !!s)
    .map((s) => new Date(s).getTime())
    .filter((n) => Number.isFinite(n));
  const endsAt = closeTimes.length ? new Date(Math.max(...closeTimes)).toISOString() : null;

  if (jsonLdLots.length === 0) {
    warnings.push(
      `No JSON-LD products found on ${opts.pageUrl}. Either the catalogue is empty or this tenant ` +
        'needs HTML or headless extraction; re-run probeTenant() to reclassify it.',
    );
  }
  if (jsonLdLots.length > 0 && closeTimes.length === 0) {
    warnings.push(
      'Lots parsed but none carried a close time, so snipe alerts cannot be armed for this auction.',
    );
  }

  const auction: NormalizedAuction = {
    externalId: auctionExternalId,
    title: opts.auctionTitle?.trim() || `${opts.tenant.slug} catalogue ${opts.catalogId}`,
    description: null,
    auctioneer: opts.auctioneer ?? null,
    url: opts.pageUrl,
    format: 'online',
    startsAt: null,
    endsAt,
    // Wisconsin houses are Central. This is a default, not a discovery: the tenant
    // record should override it, and a wrong zone shifts every countdown by an hour.
    timezone: opts.timezone ?? 'America/Chicago',
    pickup: null,
    pickupRequired: true,
    ships: false,
    lotCount: jsonLdLots.length || null,
    currency: 'USD',
    buyerPremiumPct: premium?.pct ?? null,
    buyerPremiumNote: [premium?.note, cardFee ? `${cardFee}% card fee` : null]
      .filter(Boolean)
      .join('; ') || null,
    termsUrl: null,
    raw: { tenant: opts.tenant, catalogId: opts.catalogId, cardFeePct: cardFee },
  };

  const lots: NormalizedLot[] = jsonLdLots.map((l) => ({
    ...l,
    // Namespace the id by tenant and catalogue. Lot numbers repeat across auctions
    // and across houses, so a bare "147" would collide constantly and make upserts
    // overwrite unrelated lots.
    externalId: `${auctionExternalId}/${l.lotNumber ?? l.externalId}`,
    auctionExternalId,
    // Per-lot close time is authoritative because of soft close; never inherit the
    // auction-level value.
    closesAt: l.closesAt ?? null,
    nextBidCents:
      l.currentBidCents !== null && l.currentBidCents !== undefined
        ? nextBidFor(l.currentBidCents)
        : null,
  }));

  return { auction, lots, warnings };
}

/** Local re-export so callers do not have to reach into money.ts for the ladder. */
function nextBidFor(currentCents: number): number | null {
  // HiBid increments are per-auction and published on the terms page. Until a
  // tenant's real table is captured, fall back to the common ladder.
  const c = currentCents;
  let step: number;
  if (c < 2500) step = 250;
  else if (c < 10000) step = 500;
  else if (c < 50000) step = 1000;
  else if (c < 100000) step = 2500;
  else if (c < 500000) step = 5000;
  else if (c < 1000000) step = 10000;
  else step = 25000;
  return c + step;
}

/** Parse a HiBid RSS feed into auction stubs. Used for cheap change detection. */
export function parseRssAuctions(xml: string): { title: string; link: string; guid: string }[] {
  const out: { title: string; link: string; guid: string }[] = [];
  if (!xml) return out;

  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const pick = (tag: string): string | null => {
      const m = item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i'));
      if (!m) return null;
      return m[1]
        .replace(/^<!\[CDATA\[/, '')
        .replace(/\]\]>$/, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
    };
    const title = pick('title');
    const link = pick('link');
    if (!title || !link) continue;
    out.push({ title, link, guid: pick('guid') ?? link });
  }
  return out;
}

export const hibidAdapter: Adapter = {
  key: 'hibid',
  method: 'json_ld',

  async run(ctx: AdapterContext): Promise<IngestResult> {
    const tenant = tenantFromUrl(ctx.source.url);
    if (!tenant) throw new Error(`Source ${ctx.source.slug} has no usable HiBid host.`);

    const urls = tenantUrls(tenant);
    const warnings: string[] = [];
    let httpRequests = 0;
    let bytesIn = 0;

    // 1. Discover current auctions.
    const listRes = await ctx.fetch(urls.auctions, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    httpRequests++;
    bytesIn += listRes.text.length;

    if (listRes.status < 200 || listRes.status >= 300) {
      throw new Error(`HiBid tenant ${tenant.host} returned HTTP ${listRes.status} for /auctions`);
    }

    const catalogIds = catalogIdsFromHtml(listRes.text);
    if (catalogIds.length === 0) {
      warnings.push(
        `No /catalog/{id}/ links on ${urls.auctions}. The tenant may have no live auctions, or the ` +
          'page may be client-rendered. Re-run probeTenant() to reclassify.',
      );
      return {
        auctions: [],
        lots: [],
        bids: [],
        stats: { httpRequests, bytesIn },
        warnings,
      };
    }

    // 2. Fetch each catalogue. Bounded per run: a tenant with 40 live auctions must
    //    not turn one crawl into 40 sequential requests against a small host. The
    //    scheduler will pick up the remainder on the next pass, prioritised by
    //    closing time.
    const MAX_CATALOGS_PER_RUN = 8;
    const auctions: NormalizedAuction[] = [];
    const lots: NormalizedLot[] = [];

    for (const catalogId of catalogIds.slice(0, MAX_CATALOGS_PER_RUN)) {
      const pageUrl = catalogUrl(tenant, catalogId);
      const res = await ctx.fetch(pageUrl, { headers: { Accept: 'text/html' } });
      httpRequests++;
      bytesIn += res.text.length;

      if (res.status < 200 || res.status >= 300) {
        warnings.push(`Catalogue ${catalogId} returned HTTP ${res.status}; skipped.`);
        continue;
      }

      const norm = normalizeCatalogPage(res.text, {
        tenant,
        catalogId,
        pageUrl,
        auctioneer: ctx.source.name,
      });
      auctions.push(norm.auction);
      lots.push(...norm.lots);
      warnings.push(...norm.warnings);
    }

    if (catalogIds.length > MAX_CATALOGS_PER_RUN) {
      warnings.push(
        `${catalogIds.length} catalogues found; fetched ${MAX_CATALOGS_PER_RUN} this run to stay polite. ` +
          'Remainder will be picked up on subsequent passes.',
      );
    }

    ctx.log('info', 'HiBid ingest complete', {
      tenant: tenant.slug,
      catalogues: Math.min(catalogIds.length, MAX_CATALOGS_PER_RUN),
      lots: lots.length,
    });

    return {
      auctions,
      lots,
      bids: [], // Bid history lives on individual lot pages; a later pass.
      stats: { httpRequests, bytesIn },
      warnings,
    };
  },
};
