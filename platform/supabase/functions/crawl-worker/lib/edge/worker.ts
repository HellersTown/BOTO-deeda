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
//   crawl_run_start -> adapter.run() -> ingest_batch (chunked) -> crawl_run_finish
// A thrown adapter error still finishes the run as failed/rate_limited, so the
// source's backoff and health stay truthful.
//
// Every request an adapter makes goes through the crawl gate (../gate.ts):
// robots.txt checked per URL, requests to a host spaced by the source's rate
// limit or the site's Crawl-delay, and a stop at the first bot-manager
// challenge. Sources are claimed one at a time while the invocation's time
// budget lasts, so a slow source cannot push the next one past the limit.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { politeFetch, CRAWLER_UA } from '../http.ts';
import { gateFetcher } from '../gate.ts';
import type { RawFetch } from '../gate.ts';
import type { Adapter, AdapterContext, NormalizedLot, SourceConfig } from '../types.ts';

const CHUNK = 200;

// Wall-clock budget for one invocation. The Edge runtime allows about 150 s;
// new sources are not started after CLAIM_UNTIL_MS, and the gate refuses new
// requests after RUN_DEADLINE_MS so results can still be written.
const CLAIM_UNTIL_MS = 60_000;
const RUN_DEADLINE_MS = 115_000;
// Hard cap on requests per source per run, whatever the adapter asks for.
const MAX_REQUESTS_PER_RUN = 150;

const rawFetch: RawFetch = async (url, init) => {
  const r = await politeFetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
    timeoutMs: 60_000,
    // Full catalogue responses are large (GSA: ~2.2 MB). Cap well above that.
    maxBytes: 25_000_000,
  });
  if (r.status === 0) throw new Error(`network error fetching ${new URL(url).host}: ${r.error}`);
  if (r.truncated) throw new Error(`response from ${new URL(url).host} exceeded 25 MB; refusing a partial snapshot`);
  return { status: r.status, headers: r.headers, text: r.body };
};

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

  async function crawl(source: Row, deadline: number) {
    const adapter = adapters[source.platform];
    const fetcher = gateFetcher({
      rawFetch,
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

    const warnings: string[] = [];
    const ctx: AdapterContext = {
      source: toConfig(source),
      fetch: fetcher,
      now: () => new Date(),
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
      // record it as partial so it can never trigger the snapshot close.
      const gate = fetcher.stats();
      for (const r of gate.refusals) warnings.push(`gate refused ${r.url}: ${r.message}`);
      const status = result.lots.length === 0 && warnings.length ? 'partial' : 'ok';
      const { data: fin, error: finErr } = await db.rpc('crawl_run_finish', {
        p_run_id: runId,
        p_status: status,
        p_http_requests: gate.requests,
        p_warnings: warnings,
        p_error: null,
        p_complete_snapshot: !!result.completeSnapshot,
      });
      if (finErr) throw new Error(`crawl_run_finish: ${finErr.message}`);
      return { slug: source.slug, run_id: runId, ...totals, requests: gate.requests, finish: fin, warnings };
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
    }
  }

  Deno.serve(async () => {
    const started = Date.now();
    const deadline = started + RUN_DEADLINE_MS;
    const results = [];
    // One source at a time, while there is time to finish it.
    while (Date.now() - started < CLAIM_UNTIL_MS) {
      const { data: claimed, error } = await db.rpc('claim_due_sources', {
        p_platforms: Object.keys(adapters),
        p_limit: 1,
        p_lease_minutes: 10,
      });
      if (error) return Response.json({ worker: workerName, error: error.message, results }, { status: 500 });
      const s = ((claimed ?? []) as Row[])[0];
      if (!s) break;
      if (!adapters[s.platform]) break;
      results.push(await crawl(s, deadline));
    }
    return Response.json({ worker: workerName, crawler: CRAWLER_UA, claimed: results.length, ms: Date.now() - started, results });
  });
}
