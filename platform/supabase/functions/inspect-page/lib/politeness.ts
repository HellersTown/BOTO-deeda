// GENERATED from packages/ingest/src/politeness.ts by scripts/sync-function-libs.mjs. Do not edit here.
/**
 * Per-host politeness that holds ACROSS invocations: the robots.txt cache and
 * Crawl-delay pacing shared by the Edge Functions that contact sources outside
 * the crawl gate (the hourly probe and the inspect-page developer tool).
 *
 * WHY. WaystockBot promises to obey robots.txt, Crawl-delay included. The gate
 * (gate.ts) paces requests within one run, but these tools kept no memory
 * between calls: three inspect-page calls to shopgoodwill.com, whose robots.txt
 * says Crawl-delay: 120, went out about 20 s apart. The memory now lives in the
 * database (migration 0024): when any invocation last sent a host a request,
 * claimed through crawl_host_turn(), and the host's last robots.txt.
 *
 * No I/O here: the database call is passed in, so the waiting logic is tested
 * with a fake clock and the RPC glue with a fake client.
 */

import { groupFor, parseRobots, robotsVerdictFromStatus } from './robots.ts';
import { detectBlock } from './block.ts';
import type { ProbeObservation } from './probe.ts';

/** The longest a caller sleeps for a host's turn before giving up on that request. */
export const MAX_TURN_WAIT_SEC = 20;

/** Our token's Crawl-delay under a robots.txt answer. Only a 2xx body holds rules. */
export function crawlDelayOf(status: number, body: string, token: string): number | null {
  if (robotsVerdictFromStatus(status) !== 'rules') return null;
  return groupFor(parseRobots(body), token)?.crawlDelaySec ?? null;
}

/** Seconds between two requests to one host: our own floor, or the site's Crawl-delay if longer. */
export function turnGapSec(floorSec: number, crawlDelaySec: number | null): number {
  return Math.max(floorSec, crawlDelaySec ?? 0);
}

/**
 * May this robots.txt answer be cached? Only a definitive one: rules (2xx) or
 * none (4xx). Two kinds are fetched again next time instead, on the host's turn:
 *
 *   - An answer the block detector flags. The cache keeps status and body but
 *     not headers, and a bot manager is often recognisable only by its headers
 *     (Akamai's `server: AkamaiGHost`, Cloudflare's `cf-mitigated`). Cached
 *     without them, its 403 would read as "no robots.txt, crawl freely".
 *   - An unreachable robots.txt (network error, 5xx, 429). It means "assume
 *     complete disallow" only while it lasts; cached, one timeout would hold a
 *     source at do-not-crawl for the cache's whole lifetime.
 *
 * Without headers the detector can only find less, never more, so a cached
 * answer is judged exactly as it was when fetched.
 */
export function isCacheableRobots(status: number, headers: Record<string, string>, body: string): boolean {
  if (detectBlock(status, headers, body).blockedBy) return false;
  return robotsVerdictFromStatus(status) !== 'unreachable';
}

/**
 * The probe's robots observation for a robots.txt served from the cache. The URL
 * is the one the probe would have fetched, so the verdict is about the same host.
 */
export function cachedRobotsObservation(url: string, status: number, body: string): ProbeObservation {
  return {
    target: 'robots',
    url,
    status,
    finalUrl: url,
    headers: {},
    body,
    bytes: new TextEncoder().encode(body).length,
    latencyMs: 0,
    error: null,
  };
}

export interface CachedRobots {
  status: number;
  body: string;
  ageSec: number;
}

/** A Supabase client's rpc(), reduced to what these calls use. */
export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** The shared per-host state (migration 0024). Every error throws: callers fail closed. */
export interface HostState {
  /** crawl_host_turn: 0 = the request slot is ours and recorded; otherwise seconds still to wait. */
  turn(host: string, gapSec: number): Promise<number>;
  /** crawl_host_robots: the cached robots.txt with its age, or null when none is cached. */
  robots(host: string): Promise<CachedRobots | null>;
  storeRobots(host: string, status: number, body: string): Promise<void>;
}

/** A JSON number, or a numeric string; anything else (null, "", junk) is NaN. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

export function hostState(rpc: Rpc): HostState {
  return {
    async turn(host, gapSec) {
      const { data, error } = await rpc('crawl_host_turn', { p_host: host, p_gap_sec: gapSec });
      if (error) throw new Error(`crawl_host_turn(${host}): ${error.message}`);
      // A missing or malformed answer must never read as 0, "go ahead".
      const wait = toNumber(data);
      if (!Number.isFinite(wait)) throw new Error(`crawl_host_turn(${host}) returned ${JSON.stringify(data)}`);
      return wait;
    },
    async robots(host) {
      const { data, error } = await rpc('crawl_host_robots', { p_host: host });
      if (error) throw new Error(`crawl_host_robots(${host}): ${error.message}`);
      const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      if (!row) return null;
      return {
        // A malformed status reads as unreachable (NaN is no 2xx or 4xx), and a
        // malformed age as expired (NaN is younger than nothing): both refetch.
        status: toNumber(row.robots_status),
        body: typeof row.robots_body === 'string' ? row.robots_body : '',
        ageSec: toNumber(row.age_sec),
      };
    },
    async storeRobots(host, status, body) {
      const { error } = await rpc('crawl_host_store_robots', { p_host: host, p_status: status, p_body: body });
      if (error) throw new Error(`crawl_host_store_robots(${host}): ${error.message}`);
    },
  };
}

export interface TurnOutcome {
  granted: boolean;
  /** Time spent sleeping for the turn. */
  waitedMs: number;
  /** When refused: seconds until the host's next turn, as of the last try. */
  retryAfterSec: number;
}

/**
 * Claim a request slot on `host`, sleeping for it when the wait is short.
 *
 * The wait is capped IN TOTAL (maxWaitSec, default 20 s): after a sleep another
 * invocation may have taken the slot, and a busy host must not keep a caller
 * looping. Past the cap the request is refused and the caller skips it or tells
 * its own caller when to come back.
 */
export async function awaitTurn(
  turn: (host: string, gapSec: number) => Promise<number>,
  host: string,
  gapSec: number,
  opts: { maxWaitSec?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TurnOutcome> {
  const maxWaitMs = (opts.maxWaitSec ?? MAX_TURN_WAIT_SEC) * 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waitedMs = 0;
  for (;;) {
    const wait = await turn(host, gapSec);
    if (!Number.isFinite(wait)) throw new Error(`turn for ${host} returned ${wait}`);
    if (wait <= 0) return { granted: true, waitedMs, retryAfterSec: 0 };
    const ms = Math.ceil(wait * 1000);
    if (waitedMs + ms > maxWaitMs) return { granted: false, waitedMs, retryAfterSec: wait };
    await sleep(ms);
    waitedMs += ms;
  }
}
