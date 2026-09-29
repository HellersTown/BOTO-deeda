// probe-sources: contact every monitored source as our honest crawler, and
// record what each one actually does.
//
// For each source (deep-link-only sources are never contacted):
//   1. GET /robots.txt       -> RFC 9309 verdict for our token
//   2. GET the source URL    -> did a bot manager intercept us? what does the page publish?
//   3. robots on another host (lots on bids.example.com behind www.example.com)
//                            -> GET that host's root too: robots.txt governs its own host
//   4. official APIs only    -> is the API answering? (skipped while a recent crawl
//                               already proved it, so the probe never spends API quota)
// The analysis lives in lib/probe.ts (unit-tested); this file only does I/O.
//
// SAFE TO INVOKE REPEATEDLY. The URL is reachable with the public anon key, so
// the function must not become a way to hammer small websites. A source probed
// within the last 30 minutes is skipped, whoever asks. Hourly scheduling
// satisfies the owner's "ping every monitored site at least once an hour" while
// this floor caps the worst case at two probes per hour per site.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { politeFetch, CRAWLER_TOKEN, CRAWLER_UA } from './lib/http.ts';
import { concludeProbe, type ProbeObservation } from './lib/probe.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;

const MIN_REPROBE_MINUTES = 30;
const CONCURRENCY = 6;
const PER_REQUEST_TIMEOUT_MS = 10_000;
// Stop starting new probes after this long; the rest are picked up next run.
const WALL_BUDGET_MS = 100_000;
// A successful crawl this recent already proves an official API answers.
const API_PROOF_MAX_AGE_MS = 2 * 3600_000;

interface SourceRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  api_base: string | null;
  ingest: string | null;
  platform: string | null;
  robots_url: string | null;
  access_checked_at: string | null;
  last_ok_at: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function robotsUrlFor(s: SourceRow): string {
  if (s.robots_url) return s.robots_url;
  return new URL('/robots.txt', s.url).toString();
}

function toObservation(target: ProbeObservation['target'], r: Awaited<ReturnType<typeof politeFetch>>): ProbeObservation {
  return {
    target,
    url: r.url,
    status: r.status,
    finalUrl: r.finalUrl,
    headers: r.headers,
    body: r.body,
    bytes: r.bytes,
    latencyMs: r.latencyMs,
    error: r.error,
  };
}

async function probeOne(s: SourceRow): Promise<{ slug: string; access: string; note: string; statuses: Record<string, number> }> {
  const observations: ProbeObservation[] = [];
  const robotsUrl = robotsUrlFor(s);

  observations.push(toObservation('robots', await politeFetch(robotsUrl, {
    timeoutMs: PER_REQUEST_TIMEOUT_MS, maxBytes: 200_000, headers: { Accept: 'text/plain,*/*;q=0.5' },
  })));
  await sleep(400); // be gentle even within one site

  observations.push(toObservation('home', await politeFetch(s.url, {
    timeoutMs: PER_REQUEST_TIMEOUT_MS, maxBytes: 600_000,
  })));

  // A robots.txt on another host governs THAT host, so fetch its root too: the
  // verdict (and any bot manager there) must be about the host we would crawl.
  if (new URL(robotsUrl).host !== new URL(s.url).host) {
    await sleep(400);
    observations.push(toObservation('listing', await politeFetch(new URL('/', robotsUrl).toString(), {
      timeoutMs: PER_REQUEST_TIMEOUT_MS, maxBytes: 600_000,
    })));
  }

  const isApi = s.ingest === 'official_api';
  const proven = isApi && !!s.last_ok_at && Date.now() - new Date(s.last_ok_at).getTime() < API_PROOF_MAX_AGE_MS;
  if (isApi && !proven && s.platform === 'gsa' && s.api_base) {
    await sleep(400);
    const key = Deno.env.get('GSA_API_KEY') ?? 'DEMO_KEY';
    observations.push(toObservation('api', await politeFetch(`${s.api_base.replace(/\/+$/, '')}/auctions?format=JSON`, {
      timeoutMs: 30_000, maxBytes: 65_536, headers: { 'X-API-KEY': key, Accept: 'application/json' },
    })));
  }

  const c = concludeProbe(s.url, CRAWLER_TOKEN, observations);
  let access: string = c.accessStatus;
  let note = c.note;

  // An official API is governed by its API terms, not by robots.txt or by the bot
  // manager in front of the public website (eBay's website refuses crawlers; its
  // Browse API exists for exactly this use). The website verdict stays in the
  // note and the probe rows as evidence; the API alone decides access.
  if (isApi) {
    const website = `Website: ${c.accessStatus}. ${c.note}`;
    const api = observations.find((o) => o.target === 'api');
    if (api && api.status >= 200 && api.status < 300) {
      access = 'open';
      note = `Official API answered HTTP ${api.status}. ${website}`;
    } else if (api && (api.status === 401 || api.status === 403)) {
      access = 'blocked';
      note = `Official API refused our key (HTTP ${api.status}). ${website}`;
    } else if (api && api.status === 429) {
      access = 'unknown';
      note = `Official API rate-limited the probe (HTTP 429); crawls back off on their own. ${website}`;
    } else if (api) {
      access = 'unreachable';
      note = `Official API failed (${api.status ? `HTTP ${api.status}` : api.error}). ${website}`;
    } else if (proven) {
      access = 'open';
      note = `Official API served a successful crawl at ${s.last_ok_at}; not re-called, to save API quota. ${website}`;
    } else {
      access = 'unknown';
      note = `Ingested only through its official API, which the probe cannot call without credentials. ${website}`;
    }
  }

  const { error } = await db().rpc('record_source_probe', {
    p_source_id: s.id,
    p_rows: c.rows,
    p_access_status: access,
    p_robots_allows: c.robotsAllows,
    p_note: note,
  });
  if (error) throw new Error(`record_source_probe(${s.slug}): ${error.message}`);

  const statuses: Record<string, number> = {};
  for (const o of observations) statuses[o.target] = o.status;
  return { slug: s.slug, access, note, statuses };
}

let _db: ReturnType<typeof createClient> | null = null;
function db() {
  _db ??= createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  return _db;
}

Deno.serve(async (req) => {
  const started = Date.now();
  const params = new URL(req.url).searchParams;
  const only = params.get('slug');
  // Batches keep each invocation inside the Edge runtime's per-request CPU
  // budget (the ZIP loader showed how hard that limit is). The 30-minute
  // re-probe floor means consecutive calls pick up where the last one stopped.
  const limit = Math.max(1, Math.min(Number(params.get('limit') ?? 12) || 12, 50));

  const cutoff = new Date(Date.now() - MIN_REPROBE_MINUTES * 60_000).toISOString();
  let q = db()
    .from('sources')
    .select('id, slug, name, url, api_base, ingest, platform, robots_url, access_checked_at, last_ok_at')
    .neq('ingest', 'deeplink_only')
    // Wholesale is on hold by the owner's decision: registered, never contacted.
    .neq('tier', 'wholesale')
    .or(`access_checked_at.is.null,access_checked_at.lt.${cutoff}`)
    .order('access_checked_at', { ascending: true, nullsFirst: true });
  if (only) q = q.eq('slug', only);
  const { data, error } = await q.limit(limit);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const queue = [...((data ?? []) as SourceRow[])];
  const results: unknown[] = [];
  const failures: unknown[] = [];

  async function worker() {
    for (;;) {
      if (Date.now() - started > WALL_BUDGET_MS) return;
      const s = queue.shift();
      if (!s) return;
      try {
        results.push(await probeOne(s));
      } catch (e) {
        failures.push({ slug: s.slug, error: String(e) });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return Response.json({
    crawler: CRAWLER_UA,
    probed: results.length,
    deferred: queue.map((s) => s.slug),
    failures,
    ms: Date.now() - started,
    results,
  });
});
