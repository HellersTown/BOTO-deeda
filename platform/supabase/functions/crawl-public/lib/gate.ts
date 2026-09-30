// GENERATED from packages/ingest/src/gate.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * The crawl gate: every request an adapter makes passes through here.
 *
 * Adapters never touch the network directly. The crawl worker hands each one a
 * Fetcher built by gateFetcher(), and this is where the crawler's conduct is
 * enforced, once, for every adapter:
 *
 *   ROBOTS.TXT, PER URL. The source-level probe only proves the home page and
 *   one listing path are allowed. Adapters fetch deeper paths (search pages,
 *   JSON endpoints, sitemaps), each of which robots.txt may govern differently.
 *   So robots.txt is fetched once per host per run and every URL is checked
 *   against it (RFC 9309, via robots.ts). An unreachable robots.txt (5xx, 429,
 *   network error, or a bot manager in front of it) means complete disallow.
 *
 *   SPEED, PER HOST. Requests to one host are spaced at least 60 / rpm seconds
 *   apart, or by the site's Crawl-delay if that is longer. Requests are
 *   serialised per host, so an adapter that fires several at once is still
 *   paced.
 *
 *   BOT PROTECTION. A response that carries a bot manager's challenge or
 *   refusal (probe.ts detectBlock) stops the run. The crawler never retries a
 *   refusal and never works around one.
 *
 *   BUDGET. An optional cap on requests and a wall-clock deadline, so one run
 *   fits inside an Edge Function invocation.
 *
 * Official APIs (a keyed API the operator publishes for programmatic use) are
 * exempt from robots.txt, which governs crawling websites; they are still paced.
 */

import { CRAWLER_TOKEN } from './http.ts';
import { groupFor, isAllowed, parseRobots, robotsVerdictFromStatus } from './robots.ts';
import type { ParsedRobots } from './robots.ts';
import { detectBlock, robotsPathOf } from './probe.ts';
import type { Fetcher } from './types.ts';

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export type RawFetch = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string; body?: string },
) => Promise<RawResponse>;

export interface GateOptions {
  rawFetch: RawFetch;
  /** Requests per minute to any one host. */
  rateLimitRpm: number;
  /** True only for keyed official APIs. */
  exemptFromRobots?: boolean;
  /** Stop after this many requests in the run, robots.txt fetches included. */
  maxRequests?: number;
  /** Stop starting new requests after this moment (ms since epoch). */
  deadline?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type RefusalReason = 'robots' | 'blocked' | 'budget';

/** Thrown when the gate will not make a request. Adapters should stop or skip, not retry. */
export class CrawlRefused extends Error {
  reason: RefusalReason;
  constructor(message: string, reason: RefusalReason) {
    super(message);
    this.name = 'CrawlRefused';
    this.reason = reason;
  }
}

/**
 * True when the gate refused a request because the run's request or time budget
 * is spent. The run is not broken: an adapter should stop fetching, keep what it
 * has, and report the run as incomplete. Checked by name so an adapter needs no
 * class identity across bundles.
 */
export function isBudgetRefusal(e: unknown): boolean {
  return e instanceof Error && e.name === 'CrawlRefused' && (e as CrawlRefused).reason === 'budget';
}

interface HostRobots {
  verdict: 'rules' | 'absent' | 'unreachable';
  parsed: ParsedRobots | null;
  crawlDelaySec: number | null;
  note: string | null;
}

export interface GateStats {
  requests: number;
  robotsFetches: number;
  refusals: { url: string; reason: RefusalReason; message: string }[];
}

export type GatedFetcher = Fetcher & { stats: () => GateStats };

export function gateFetcher(opts: GateOptions): GatedFetcher {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const baseGapMs = Math.ceil(60_000 / Math.max(1, opts.rateLimitRpm));

  const robotsByOrigin = new Map<string, Promise<HostRobots>>();
  const lastStart = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();
  const stats: GateStats = { requests: 0, robotsFetches: 0, refusals: [] };

  function refuse(url: string, reason: RefusalReason, message: string): never {
    stats.refusals.push({ url, reason, message });
    throw new CrawlRefused(message, reason);
  }

  function checkBudget(url: string) {
    if (opts.maxRequests !== undefined && stats.requests >= opts.maxRequests) {
      refuse(url, 'budget', `request budget of ${opts.maxRequests} reached`);
    }
    if (opts.deadline !== undefined && now() >= opts.deadline) {
      refuse(url, 'budget', 'time budget for this run is used up');
    }
  }

  /** Wait for this host's turn, then record the start. Serialised per host. */
  function paced(host: string, gapMs: number): Promise<void> {
    const prev = chains.get(host) ?? Promise.resolve();
    const turn = prev.then(async () => {
      const last = lastStart.get(host);
      const t = now();
      if (last !== undefined && t - last < gapMs) await sleep(gapMs - (t - last));
      lastStart.set(host, now());
    });
    chains.set(host, turn.catch(() => {}));
    return turn;
  }

  function robotsFor(origin: string, host: string): Promise<HostRobots> {
    let pending = robotsByOrigin.get(origin);
    if (!pending) {
      pending = (async (): Promise<HostRobots> => {
        await paced(host, baseGapMs);
        stats.requests++;
        stats.robotsFetches++;
        let r: RawResponse;
        try {
          r = await opts.rawFetch(`${origin}/robots.txt`, { headers: { Accept: 'text/plain,*/*;q=0.5' } });
        } catch (e) {
          return { verdict: 'unreachable', parsed: null, crawlDelaySec: null, note: e instanceof Error ? e.message : String(e) };
        }
        const block = detectBlock(r.status, r.headers, r.text);
        if (block.blockedBy) {
          return { verdict: 'unreachable', parsed: null, crawlDelaySec: null, note: `robots.txt behind ${block.blockedBy}` };
        }
        const verdict = robotsVerdictFromStatus(r.status);
        if (verdict !== 'rules') return { verdict, parsed: null, crawlDelaySec: null, note: `robots.txt HTTP ${r.status}` };
        const parsed = parseRobots(r.text);
        return { verdict, parsed, crawlDelaySec: groupFor(parsed, CRAWLER_TOKEN)?.crawlDelaySec ?? null, note: null };
      })();
      robotsByOrigin.set(origin, pending);
    }
    return pending;
  }

  const fetcher = (async (url, init) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    checkBudget(url);

    let gapMs = baseGapMs;
    if (!opts.exemptFromRobots) {
      const rb = await robotsFor(u.origin, u.host);
      if (rb.verdict === 'unreachable') {
        refuse(url, 'robots', `robots.txt for ${u.host} is unreachable (${rb.note ?? 'no detail'}); RFC 9309 says assume disallow`);
      }
      if (rb.verdict === 'rules' && rb.parsed && !isAllowed(rb.parsed, CRAWLER_TOKEN, robotsPathOf(url))) {
        refuse(url, 'robots', `robots.txt disallows ${CRAWLER_TOKEN} on ${robotsPathOf(url)} at ${u.host}`);
      }
      if (rb.crawlDelaySec) gapMs = Math.max(gapMs, Math.ceil(rb.crawlDelaySec * 1000));
      checkBudget(url);
    }

    await paced(u.host, gapMs);
    stats.requests++;
    const r = await opts.rawFetch(url, init);
    const block = detectBlock(r.status, r.headers, r.text);
    if (block.blockedBy) {
      refuse(url, 'blocked', `${u.host} answered with ${block.blockedBy}: ${block.reason ?? 'refusal'}`);
    }
    return r;
  }) as GatedFetcher;

  fetcher.stats = () => ({ ...stats, refusals: [...stats.refusals] });
  return fetcher;
}
