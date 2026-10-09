// GENERATED from packages/ingest/src/edge/worker.ts by scripts/sync-function-libs.mjs. Do not edit here.
// The crawl worker's engine, shared by every crawl-* Edge Function.
//
// DENO ONLY. This file imports supabase-js through an npm: specifier, so it runs
// inside Edge Functions and is never imported by the Node tests. Everything it
// relies on (the gate, the adapters, the types) is tested in Node.
//
// Each crawl-* function is a few lines: it names the adapters it carries and
// calls serveWorker(). Functions are split by platform family so each deploys
// on its own, carries only its own adapters, and gets its own time budget per
// invocation, running in parallel with the others.
//
// The worker does not choose what to crawl. claim_due_sources() does, applying
// every gate at once (active, legal ingest decision, robots, no observed block,
// cadence due, not leased by another worker). Invoking a worker more often
// therefore cannot crawl any source faster than its cadence: a call with
// nothing due does no outbound I/O at all.
//
// Per claimed source:
//   crawl_run_start -> [crawl_known_state] -> adapter.run() -> ingest_batch (chunked) -> crawl_run_finish
// crawl_known_state (0055) is read only for an adapter that asks for it: what
// the database already holds, so the run refreshes known lots for price and
// bids instead of re-reading every sale.
// A thrown adapter error still finishes the run as failed/rate_limited, so the
// source's backoff and health stay truthful.
//
// Every request an adapter makes goes through the crawl gate (../gate.ts):
// robots.txt checked per URL, requests to a host spaced by the source's rate
// limit or the site's Crawl-delay, and a stop at the first bot-manager
// challenge. Sources are claimed one at a time while the invocation's time
// budget lasts, so a slow source cannot push the next one past the limit, and
// only while what it has crawled is small (../claimBudget.ts), so a large house
// never runs second and takes the invocation past its 2 s of CPU.
//
// BACKGROUND RUNS. Supabase must answer an Edge Function request within 150 s,
// but on the Pro plan the worker itself may live 400 s. A scheduled invocation
// therefore answers at once (202) and crawls in the background under
// EdgeRuntime.waitUntil, which is what lets a source with a hundred detail
// pages be read in one run at a polite pace. ?sync=1 crawls inline on a short
// budget and answers with the results, for manual verification.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { politeFetch, CRAWLER_UA } from '../http.ts';
import { gateFetcher } from '../gate.ts';
import type { RawFetch } from '../gate.ts';
import { parseKnownState } from '../known.ts';
import { mayClaimAnother } from '../claimBudget.ts';
import type { Adapter, AdapterContext, KnownState, NormalizedLot, SourceConfig } from '../types.ts';

const CHUNK = 200;

/** Budgets, in ms from the start of the invocation. */
interface Budget {
  /** No new source is claimed after this. */
  claimUntilMs: number;
  /** The gate refuses new requests after this, so results can still be written. */
  deadlineMs: number;
  /** Every request's timeout ends by this, whenever it started. */
  hardStopMs: number;
}

// Cron invokes each worker every 5 minutes. A background run stops starting
// requests at 225 s and every request has ended by 285 s, so the writes finish
// before the next tick and a worker never overlaps itself on a host.
const BACKGROUND: Budget = { claimUntilMs: 150_000, deadlineMs: 225_000, hardStopMs: 285_000 };
// Inline runs must answer inside the 150 s request limit.
const INLINE: Budget = { claimUntilMs: 30_000, deadlineMs: 90_000, hardStopMs: 135_000 };

// Hard cap on requests per source per run, whatever the adapter asks for.
const MAX_REQUESTS_PER_RUN = 150;
const MAX_FETCH_MS = 60_000;

// Supabase's Edge Runtime keeps a worker alive for a promise handed to
// waitUntil, up to the plan's wall-clock limit. Absent elsewhere.
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;

/** The network, bounded so no request outlives the invocation's budget. */
function rawFetchUntil(hardStop: number): RawFetch {
  return async (url, init) => {
    const host = new URL(url).host;
    const timeoutMs = Math.min(MAX_FETCH_MS, hardStop - Date.now());
    if (timeoutMs < 5_000) throw new Error(`no time left in this run for a request to ${host}`);
    const r = await politeFetch(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      timeoutMs,
      // Full catalogue responses are large (GSA: ~2.2 MB). Cap well above that.
      maxBytes: 25_000_000,
    });
    if (r.status === 0) throw new Error(`network error fetching ${host}: ${r.error}`);
    if (r.truncated) throw new Error(`response from ${host} exceeded 25 MB; refusing a partial snapshot`);
    return { status: r.status, headers: r.headers, text: r.body };
  };
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export function toConfig(s: Row): SourceConfig {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    url: s.url,
    apiBase: s.api_base,
    robotsUrl: s.robots_url,
    tier: s.tier,
    ingest: s.ingest,
    platform: s.platform,
    states: s.states,
    rateLimitRpm: s.rate_limit_rpm ?? 20,
    ingestAllowed: !!s.ingest_allowed,
    robotsAllows: s.robots_allows,
    crawlCadenceMin: s.crawl_cadence_min ?? 60,
    consecutiveFailures: s.consecutive_failures ?? 0,
  };
}

export function serveWorker(workerName: string, adapters: Record<string, Adapter>) {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
    (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const log = (level: string, msg: string, extra?: unknown) =>
    console.log(JSON.stringify({ level, worker: workerName, msg, extra }));

  // Runs in flight, so a shutdown can at least name them. A run the runtime
  // kills is closed as abandoned by the next crawl_run_start for its source.
  const inFlight = new Set<string>();
  addEventListener('beforeunload', () => {
    if (inFlight.size) log('warn', 'worker shutting down with runs in flight', [...inFlight]);
  });

  async function crawl(source: Row, deadline: number, hardStop: number) {
    const adapter = adapters[source.platform];
    const fetcher = gateFetcher({
      rawFetch: rawFetchUntil(hardStop),
      rateLimitRpm: source.rate_limit_rpm ?? 20,
      // robots.txt governs crawling websites, not a keyed API published for programs.
      exemptFromRobots: source.ingest === 'official_api',
      maxRequests: MAX_REQUESTS_PER_RUN,
      deadline,
    });
    const { data: runId, error: startErr } = await db.rpc('crawl_run_start', {
      p_source_id: source.id,
      p_method: source.ingest,
    });
    if (startErr) throw new Error(`crawl_run_start: ${startErr.message}`);
    const tag = `${source.slug}#${runId}`;
    inFlight.add(tag);

    const warnings: string[] = [];
    const ctx: AdapterContext = {
      source: toConfig(source),
      fetch: fetcher,
      now: () => new Date(),
      deadline,
      log: (level, msg, extra) => console.log(JSON.stringify({ level, worker: workerName, source: source.slug, msg, extra })),
      secrets: {
        // DEMO_KEY works but is rate-limited per IP, and Edge Function IPs are
        // shared. Set a real key with: supabase secrets set GSA_API_KEY=...
        GSA_API_KEY: Deno.env.get('GSA_API_KEY') ?? 'DEMO_KEY',
      },
    };
    if (!Deno.env.get('GSA_API_KEY') && source.platform === 'gsa') {
      warnings.push('Using GSA DEMO_KEY: set the GSA_API_KEY secret for reliable hourly runs.');
    }

    try {
      // What the database already holds, for adapters that plan around it
      // (0055). Without it the adapter still runs, the way it did before.
      if (adapter.wantsKnownState) {
        const { data, error } = await db.rpc('crawl_known_state', { p_source_id: source.id });
        const known: KnownState | null = error ? null : parseKnownState(data);
        if (known) ctx.known = known;
        else warnings.push(`crawl_known_state: ${error?.message ?? 'unreadable answer'}; this run reads without it.`);
      }

      const result = await adapter.run(ctx);
      warnings.push(...result.warnings);

      // All auctions travel with the first chunk, so every lot in every later
      // chunk finds its auction already stored when ingest_batch resolves it.
      const totals = { auctions: 0, lots: 0, lots_new: 0, lots_updated: 0, images: 0 };
      const chunks = Math.max(1, Math.ceil(result.lots.length / CHUNK));
      for (let c = 0; c < chunks; c++) {
        const lots: NormalizedLot[] = result.lots.slice(c * CHUNK, (c + 1) * CHUNK);
        const { data, error } = await db.rpc('ingest_batch', {
          p_run_id: runId,
          p_auctions: c === 0 ? result.auctions : [],
          p_lots: lots,
        });
        if (error) throw new Error(`ingest_batch chunk ${c + 1}/${chunks}: ${error.message}`);
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += (data as Row)?.[k] ?? 0;
      }

      // Zero lots WITH warnings is a parser in trouble, not an empty catalogue:
      // record it as partial so it can never trigger the snapshot close. Any
      // request the gate refused means something went unread, so the run is
      // not a complete snapshot whatever the adapter concluded.
      const gate = fetcher.stats();
      for (const r of gate.refusals) warnings.push(`gate refused ${r.url}: ${r.message}`);
      const status = result.lots.length === 0 && warnings.length ? 'partial' : 'ok';
      const { data: fin, error: finErr } = await db.rpc('crawl_run_finish', {
        p_run_id: runId,
        p_status: status,
        p_http_requests: gate.requests,
        p_warnings: warnings,
        p_error: null,
        p_complete_snapshot: !!result.completeSnapshot && gate.refusals.length === 0,
      });
      if (finErr) throw new Error(`crawl_run_finish: ${finErr.message}`);
      return {
        slug: source.slug,
        run_id: runId,
        ...totals,
        known_lots: ctx.known?.lots.length ?? 0,
        requests: gate.requests,
        finish: fin,
        warnings,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.rpc('crawl_run_finish', {
        p_run_id: runId,
        p_status: /rate limit|429/i.test(msg) ? 'rate_limited' : 'failed',
        p_http_requests: Math.max(1, fetcher.stats().requests),
        p_warnings: warnings,
        p_error: msg.slice(0, 2000),
        p_complete_snapshot: false,
      });
      return { slug: source.slug, run_id: runId, error: msg };
    } finally {
      inFlight.delete(tag);
    }
  }

  /** Claim and crawl due sources, one at a time, while the budget lasts. */
  async function crawlDue(started: number, budget: Budget) {
    const results: Row[] = [];
    while (Date.now() - started < budget.claimUntilMs && mayClaimAnother(results)) {
      const { data: claimed, error } = await db.rpc('claim_due_sources', {
        p_platforms: Object.keys(adapters),
        p_limit: 1,
        p_lease_minutes: 10,
      });
      if (error) {
        results.push({ error: `claim_due_sources: ${error.message}` });
        break;
      }
      const s = ((claimed ?? []) as Row[])[0];
      if (!s || !adapters[s.platform]) break;
      try {
        results.push(await crawl(s, started + budget.deadlineMs, started + budget.hardStopMs));
      } catch (e) {
        // Only crawl_run_start can land here; the source's lease expires on its own.
        results.push({ slug: s.slug, error: e instanceof Error ? e.message : String(e) });
        break;
      }
    }
    return results;
  }

  Deno.serve((req) => {
    const started = Date.now();
    const inline = new URL(req.url).searchParams.get('sync') === '1' || !edgeRuntime;
    if (inline) {
      return crawlDue(started, INLINE).then((results) =>
        Response.json({ worker: workerName, crawler: CRAWLER_UA, mode: 'inline', claimed: results.length, ms: Date.now() - started, results }),
      );
    }
    edgeRuntime!.waitUntil(
      crawlDue(started, BACKGROUND).then(
        (results) =>
          log('info', 'background crawl finished', {
            claimed: results.length,
            ms: Date.now() - started,
            results: results.map((r) => ({
              slug: r.slug,
              run_id: r.run_id,
              lots: r.lots,
              known_lots: r.known_lots,
              requests: r.requests,
              error: r.error,
            })),
          }),
        (e) => log('error', 'background crawl crashed', e instanceof Error ? e.message : String(e)),
      ),
    );
    return Response.json({ worker: workerName, crawler: CRAWLER_UA, mode: 'background', accepted: true }, { status: 202 });
  });
}
