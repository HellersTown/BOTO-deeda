// probe-sources: contact every monitored source as our honest crawler, and
// record what each one actually does.
//
// For each source (deep-link-only sources are never contacted):
//   1. GET /robots.txt       -> RFC 9309 verdict for our token (read from the per-host
//                               cache shared with inspect-page while under 6 hours old)
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
//
// CRAWL-DELAY ACROSS INVOCATIONS. Every request waits for its host's turn:
// max(1 s, the host's Crawl-delay) since the last request ANY invocation sent
// that host, inspect-page included (migration 0024). Up to 20 s is waited out.
// A longer wait skips the request this run, says so in the note, and keeps the
// source's previous verdict: a skipped page is not evidence about the site.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { politeFetch, CRAWLER_TOKEN, CRAWLER_UA, type PoliteFetchOptions } from './lib/http.ts';
import { concludeProbe, type ProbeObservation } from './lib/probe.ts';
import { awaitTurn, cachedRobotsObservation, crawlDelayOf, hostState, isCacheableRobots, turnGapSec } from './lib/politeness.ts';

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
// robots.txt is re-read at most every 6 hours (RFC 9309 allows up to 24).
const ROBOTS_MAX_AGE_SEC = 6 * 3600;
// Our floor between two requests to one host; a longer Crawl-delay wins.
const MIN_GAP_SEC = 1;

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
  access_status: string | null;
  robots_allows: boolean | null;
}

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
  const skipped: string[] = [];
  const robotsUrl = robotsUrlFor(s);
  const robotsHost = new URL(robotsUrl).host;

  // Fetch on the host's turn, or skip the request this run if that is over 20 s away.
  async function onTurn(target: ProbeObservation['target'], url: string, crawlDelaySec: number | null, opts: PoliteFetchOptions) {
    const host = new URL(url).host;
    const t = await awaitTurn(hosts.turn, host, turnGapSec(MIN_GAP_SEC, crawlDelaySec));
    if (!t.granted) {
      skipped.push(`${target} skipped this run to honour Crawl-delay ${crawlDelaySec ?? MIN_GAP_SEC} s at ${host} (next turn in ${Math.ceil(t.retryAfterSec)} s)`);
      return null;
    }
    const r = await politeFetch(url, opts);
    observations.push(toObservation(target, r));
    return r;
  }

  // robots.txt: from the shared cache while under 6 hours old, else fetched and cached.
  const cached = await hosts.robots(robotsHost);
  // An expired entry's Crawl-delay still paces the refetch.
  let crawlDelaySec = cached ? crawlDelayOf(cached.status, cached.body, CRAWLER_TOKEN) : null;
  let robotsCacheMin: number | null = null;
  if (cached && cached.ageSec < ROBOTS_MAX_AGE_SEC) {
    observations.push(cachedRobotsObservation(robotsUrl, cached.status, cached.body));
    robotsCacheMin = Math.floor(cached.ageSec / 60);
  } else {
    const r = await onTurn('robots', robotsUrl, crawlDelaySec, {
      timeoutMs: PER_REQUEST_TIMEOUT_MS, maxBytes: 200_000, headers: { Accept: 'text/plain,*/*;q=0.5' },
    });
    if (r && isCacheableRobots(r.status, r.headers, r.body)) {
      await hosts.storeRobots(robotsHost, r.status, r.body);
      crawlDelaySec = crawlDelayOf(r.status, r.body, CRAWLER_TOKEN);
    }
  }

  // A robots.txt governs its own host only: a page elsewhere is paced by that
  // host's own Crawl-delay, known when another invocation cached its robots.txt.
  const crawlDelayFor = async (url: string): Promise<number | null> => {
    const host = new URL(url).host;
    if (host === robotsHost) return crawlDelaySec;
    const other = await hosts.robots(host);
    return other ? crawlDelayOf(other.status, other.body, CRAWLER_TOKEN) : null;
  };

  const isApi = s.ingest === 'official_api';
  const proven = isApi && !!s.last_ok_at && Date.now() - new Date(s.last_ok_at).getTime() < API_PROOF_MAX_AGE_MS;

  // Without robots.txt (its turn was skipped) nothing else is fetched this run.
  if (observations.length > 0) {
    await onTurn('home', s.url, await crawlDelayFor(s.url), { timeoutMs: PER_REQUEST_TIMEOUT_MS, maxBytes: 600_000 });

    // A robots.txt on another host governs THAT host, so fetch its root too: the
    // verdict (and any bot manager there) must be about the host we would crawl.
    if (robotsHost !== new URL(s.url).host) {
      await onTurn('listing', new URL('/', robotsUrl).toString(), crawlDelaySec, {
        timeoutMs: PER_REQUEST_TIMEOUT_MS, maxBytes: 600_000,
      });
    }

    if (isApi && !proven && s.platform === 'gsa' && s.api_base) {
      const key = Deno.env.get('GSA_API_KEY') ?? 'DEMO_KEY';
      const apiUrl = `${s.api_base.replace(/\/+$/, '')}/auctions?format=JSON`;
      await onTurn('api', apiUrl, await crawlDelayFor(apiUrl), {
        timeoutMs: 30_000, maxBytes: 65_536, headers: { 'X-API-KEY': key, Accept: 'application/json' },
      });
    }
  }

  const c = concludeProbe(s.url, CRAWLER_TOKEN, observations);
  let access: string = c.accessStatus;
  let robotsAllows = c.robotsAllows;
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

  // A request skipped for Crawl-delay is no evidence about the site: keep the
  // previous verdict rather than let the gap read as "unknown".
  if (skipped.length) {
    if (s.access_status) {
      access = s.access_status;
      robotsAllows = s.robots_allows;
      note = `${skipped.join('; ')}. Access verdict kept from the previous probe (${s.access_status}).`;
    } else {
      note = `${skipped.join('; ')}. ${note}`;
    }
  }
  if (robotsCacheMin !== null) {
    note += ` robots.txt from a cache of ${robotsCacheMin} min.`;
    const row = c.rows.find((r) => r.target === 'robots');
    if (row) (row.detail as Record<string, unknown>).cached_min = robotsCacheMin;
  }

  const { error } = await db().rpc('record_source_probe', {
    p_source_id: s.id,
    p_rows: c.rows,
    p_access_status: access,
    p_robots_allows: robotsAllows,
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
const hosts = hostState((fn, args) => db().rpc(fn, args));

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
    .select('id, slug, name, url, api_base, ingest, platform, robots_url, access_checked_at, last_ok_at, access_status, robots_allows')
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
