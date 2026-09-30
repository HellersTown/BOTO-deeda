/**
 * The canonical shapes every adapter must produce.
 *
 * An adapter's ONLY job is to turn whatever a source gives us into these types.
 * Nothing downstream — scoring, geo, search, alerts — knows or cares which source
 * a row came from. That boundary is what keeps a twelve-adapter system from
 * becoming twelve subtly different products.
 *
 * Money is integer cents throughout. Never a float, never a formatted string.
 * Times are ISO-8601 with an explicit offset, plus a separate IANA zone name,
 * because "closes at 6:00 PM" is meaningless without knowing whose 6:00 PM.
 */

export type IngestMethod =
  | 'official_api'
  | 'json_ld'
  | 'internal_json'
  | 'rss'
  | 'sitemap'
  | 'html'
  | 'headless'
  | 'deeplink_only'
  | 'manual';

export type SourceTier =
  | 'federal'
  | 'state'
  | 'county'
  | 'municipal'
  | 'school'
  | 'private'
  | 'estate'
  | 'wholesale'
  | 'marketplace'
  | 'dealer';

export type AuctionFormat = 'live' | 'online' | 'hybrid' | 'sealed_bid' | 'fixed_price';

/** A source as the crawler sees it. Mirrors public.sources. */
export interface SourceConfig {
  id: string;
  slug: string;
  name: string;
  url: string;
  apiBase?: string | null;
  /**
   * Where the source's robots.txt lives. For white-label and tenant-hosted
   * sites this names the host the bidding actually happens on (a HiBid tenant
   * such as bids.beloitauction.com), which is often not the host in `url`.
   */
  robotsUrl?: string | null;
  tier: SourceTier;
  ingest: IngestMethod;
  platform?: string | null;
  states?: string[] | null;
  /** Requests per minute ceiling. Politeness is a per-source property. */
  rateLimitRpm: number;
  /** Our own legal determination. False means construct deep links only. */
  ingestAllowed: boolean;
  /** robots.txt verdict. null = not yet checked, which blocks crawling. */
  robotsAllows: boolean | null;
  crawlCadenceMin: number;
  consecutiveFailures: number;
}

/**
 * A location as a source reports it — deliberately permissive, because sources
 * are inconsistent and we would rather carry an unresolved location than a
 * confidently wrong one.
 *
 * `state` must be a two-letter code that the source ACTUALLY DECLARED. Never
 * infer it from a city name: there is a Beloit in both Wisconsin and Kansas, and
 * Hansen auction houses in both. Guessing puts Kansas lots in Wisconsin results.
 */
export interface NormalizedLocation {
  line1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** True when the source gave a city but no state and we refused to guess. */
  ambiguous?: boolean;
}

export interface NormalizedAuction {
  externalId: string;
  title: string;
  description?: string | null;
  auctioneer?: string | null;
  url?: string | null;
  format: AuctionFormat;
  startsAt?: string | null;
  endsAt?: string | null;
  /** IANA zone, e.g. "America/Chicago". Required for honest time rendering. */
  timezone?: string | null;
  pickup?: NormalizedLocation | null;
  pickupRequired?: boolean;
  ships?: boolean;
  shipsNote?: string | null;
  sellerName?: string | null;
  /**
   * Two-letter state of the SELLING organisation, which is not where the item is.
   * GSA's LocationST is the classic case: a Phoenix office selling laptops that
   * sit in Milwaukee. Kept separately so it can never leak into pickup.
   */
  sellerState?: string | null;
  lotCount?: number | null;
  currency?: string;
  /**
   * Buyer's premium as a percentage. Carrying this is not optional: a 10% premium
   * plus a 3.5% card fee is the difference between a good buy and a bad one, and
   * showing the hammer price alone is how auction sites quietly mislead people.
   */
  buyerPremiumPct?: number | null;
  buyerPremiumNote?: string | null;
  termsUrl?: string | null;
  raw: unknown;
}

export interface NormalizedImage {
  url: string;
  position?: number;
  width?: number | null;
  height?: number | null;
}

export interface NormalizedLot {
  externalId: string;
  auctionExternalId?: string | null;
  lotNumber?: string | null;
  title: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  condition?: string | null;
  quantity?: number | null;

  startingBidCents?: number | null;
  currentBidCents?: number | null;
  nextBidCents?: number | null;
  estimateLowCents?: number | null;
  estimateHighCents?: number | null;
  soldPriceCents?: number | null;
  bidCount?: number | null;
  reserveMet?: boolean | null;

  closesAt?: string | null;
  closed?: boolean;

  /** The deep link a user taps to go bid direct. Absolutely required. */
  url?: string | null;

  pickup?: NormalizedLocation | null;
  ships?: boolean;

  images: NormalizedImage[];
  raw: unknown;
}

/** A single bid, where the source publishes bid history. */
export interface NormalizedBid {
  lotExternalId: string;
  /** The pseudonymous label the platform displays. Never resolved to a person. */
  bidderAlias?: string | null;
  amountCents: number;
  bidAt?: string | null;
  isProxy?: boolean | null;
}

export interface FetchStats {
  httpRequests: number;
  bytesIn: number;
}

/** What one adapter run returns. */
export interface IngestResult {
  auctions: NormalizedAuction[];
  lots: NormalizedLot[];
  bids: NormalizedBid[];
  stats: FetchStats;
  /**
   * Non-fatal problems. A run that returns rows AND warnings is the normal case;
   * silently dropping malformed records is how data quality dies unnoticed.
   */
  warnings: string[];
  /**
   * True when the source returned its ENTIRE live catalogue in this run (GSA's
   * API does). Only then may lots missing from the run be marked closed, and even
   * then behind the drift guard in crawl_run_finish.
   */
  completeSnapshot?: boolean;
}

/**
 * The fetch primitive is injected rather than imported.
 *
 * This is what makes every adapter testable with no network at all: tests pass a
 * function that returns a saved fixture. It also centralises rate limiting,
 * retries and robots enforcement in one place instead of in twelve adapters.
 */
export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string },
) => Promise<{ status: number; headers: Record<string, string>; text: string }>;

export interface AdapterContext {
  source: SourceConfig;
  fetch: Fetcher;
  /** Injected so tests can pin "now" and assert on relative close times. */
  now: () => Date;
  /**
   * When this run stops starting requests (ms since epoch). The fetcher enforces
   * it by refusing later requests; an adapter that plans work up front (a list
   * of detail pages) plans to it, so everything it plans can be finished.
   */
  deadline?: number;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: unknown) => void;
  secrets: Record<string, string | undefined>;
}

export interface Adapter {
  /** Stable identifier, matching sources.platform or sources.slug. */
  readonly key: string;
  readonly method: IngestMethod;
  /** Discover and normalize. Must be idempotent and safe to replay. */
  run(ctx: AdapterContext): Promise<IngestResult>;
}
