// inspect-page: fetch ONE page from a registered source, as our crawler, and
// describe how it publishes its data. A development tool for writing adapters.
//
// WHY IT EXISTS. The GSA adapter was first written from the API's documentation
// and returned zero lots in production: the live API did not match its docs.
// Adapters are now written against what a site actually serves. The build
// container has no route to auction sites, so this function is how a developer
// sees a real lot page, sitemap or API response.
//
// IT IS NOT A PROXY. Every call must:
//   - carry the x-inspect-token header, checked against private.function_tokens
//     (readable only by the service role; public.inspect_url() adds it from SQL);
//   - target a host belonging to a registered, contactable source (deep-link-only
//     and wholesale sources are refused);
//   - be permitted by that host's robots.txt for our token (checked per call);
//   - wait for the host's turn: max(5 s, its Crawl-delay) since the last request
//     ANY invocation sent it, the probe included (migration 0024). Up to 20 s is
//     waited out; a longer wait is refused with HTTP 429 and retryAfterSec;
// and it is one request per call, with our honest User-Agent. robots.txt comes
// from the per-host cache it shares with the probe while under an hour old.
//
//   POST { url, method?, postBody?, headers?, pattern?, maxLinks?, slice?: [from, len],
//          find?, context?, textSlice?: [from, len] }
//
// `find` is a regular expression searched in the page's visible text: every
// match comes back with `context` characters either side, so one request can
// quote each clause of a terms page that mentions robots or scraping.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { politeFetch, CRAWLER_TOKEN } from './lib/http.ts';
import { isAllowed, parseRobots, robotsVerdictFromStatus } from './lib/robots.ts';
import { detectBlock, feedLinks, jsonLdTypes, pageTitle, robotsPathOf } from './lib/probe.ts';
import { extractJsonLdBlocks, flattenNodes } from './lib/jsonld.ts';
import { awaitTurn, crawlDelayOf, hostState, isCacheableRobots, turnGapSec, type TurnOutcome } from './lib/politeness.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
  (JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>).default;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const hosts = hostState((fn, args) => db.rpc(fn, args));

// Our floor between two requests to one host; a longer Crawl-delay wins.
const MIN_GAP_SEC = 5;
// robots.txt is read from the shared cache while younger than this.
const ROBOTS_MAX_AGE_SEC = 3600;

/** Politeness state is unreadable: fail closed, without contacting the site. */
function unavailable(slug: string, e: unknown): Response {
  return Response.json({ slug, error: `host politeness state unavailable: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
}

function tooSoon(body: Record<string, unknown>, retryAfterSec: number): Response {
  return Response.json({ ...body, retryAfterSec }, { status: 429, headers: { 'Retry-After': String(retryAfterSec) } });
}

/** "bids.beloitauction.com" -> "beloitauction.com"; good enough for .com/.org/.gov/.edu hosts. */
function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  return parts.slice(-2).join('.');
}

interface InspectRequest {
  url: string;
  method?: 'GET' | 'POST';
  postBody?: string;
  headers?: Record<string, string>;
  pattern?: string;
  maxLinks?: number;
  slice?: [number, number];
  /** Searched in the visible text, case-insensitively; each match returns with its surroundings. */
  find?: string;
  /** Characters of visible text kept either side of a `find` match: default 400, at most 1,500. */
  context?: number;
  /** A window of the visible text, [from, len], len at most 20,000. */
  textSlice?: [number, number];
}

// Embedded state blobs that single-page apps ship with their HTML. Finding one
// usually means the data is already in the page and no HTML parsing is needed.
const STATE_MARKERS: [string, RegExp][] = [
  ['__NEXT_DATA__', /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]{0,4000})/i],
  ['ng-state', /<script[^>]*id=["'](?:ng-state|serverApp-state|[\w-]*-state)["'][^>]*>([\s\S]{0,4000})/i],
  ['__NUXT__', /window\.__NUXT__\s*=\s*([\s\S]{0,4000})/i],
  ['__INITIAL_STATE__', /window\.__(?:INITIAL|PRELOADED)_STATE__\s*=\s*([\s\S]{0,4000})/i],
  ['__APOLLO_STATE__', /window\.__APOLLO_STATE__\s*=\s*([\s\S]{0,4000})/i],
];

// Named entities common in legal text; any numeric entity is decoded too.
const NAMED_ENTITIES: Record<string, number> = {
  nbsp: 0x20, amp: 0x26, quot: 0x22, apos: 0x27, lt: 0x3c, gt: 0x3e,
  lsquo: 0x2018, rsquo: 0x2019, ldquo: 0x201c, rdquo: 0x201d, ndash: 0x2013, mdash: 0x2014,
  hellip: 0x2026, sect: 0xa7, para: 0xb6, copy: 0xa9, reg: 0xae, trade: 0x2122, bull: 0x2022,
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, e: string) => {
    const code = e[0] !== '#'
      ? NAMED_ENTITIES[e.toLowerCase()]
      : e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code !== undefined && Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Each `find` match with its surroundings; a match inside the previous window is not repeated. */
function findInText(text: string, re: RegExp, context: number, max = 12): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let shownTo = -1;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (m[0].length === 0 || at < shownTo) continue;
    const from = Math.max(0, at - context);
    shownTo = Math.min(text.length, at + m[0].length + context);
    out.push({ at, text: text.slice(from, shownTo) });
    if (out.length >= max) break;
  }
  return out;
}

Deno.serve(async (req) => {
  const token = req.headers.get('x-inspect-token') ?? '';
  const { data: ok } = await db.rpc('check_function_token', { p_name: 'inspect-page', p_token: token });
  if (ok !== true) return Response.json({ error: 'forbidden' }, { status: 403 });

  let body: InspectRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'body must be JSON' }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(body.url);
  } catch {
    return Response.json({ error: 'invalid url' }, { status: 400 });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return Response.json({ error: 'http(s) only' }, { status: 400 });
  }
  // The link filter is compiled before anything is fetched: a pattern that
  // does not compile must not cost the site a request.
  let linkRe: RegExp | null = null;
  if (body.pattern) {
    try {
      linkRe = new RegExp(body.pattern, 'i');
    } catch {
      return Response.json({ error: 'invalid pattern: a JavaScript regular expression, matched case-insensitively' }, { status: 400 });
    }
  }
  let findRe: RegExp | null = null;
  if (body.find) {
    try {
      findRe = new RegExp(body.find, 'gi');
    } catch {
      return Response.json({ error: 'invalid find: a JavaScript regular expression, matched case-insensitively' }, { status: 400 });
    }
  }

  // Host must belong to a registered, contactable source.
  const { data: sources } = await db.from('sources').select('slug, url, robots_url, api_base, ingest, tier');
  let slug: string | null = null;
  for (const s of (sources ?? []) as Record<string, string | null>[]) {
    if (s.ingest === 'deeplink_only' || s.tier === 'wholesale') continue;
    for (const u of [s.url, s.robots_url, s.api_base]) {
      if (!u) continue;
      try {
        if (registrable(new URL(u).host) === registrable(target.host)) slug = s.slug;
      } catch { /* ignore malformed stored urls */ }
    }
  }
  if (!slug) return Response.json({ error: `host ${target.host} is not a registered contactable source` }, { status: 400 });

  // robots.txt for this exact host, per RFC 9309: from the shared cache while
  // under an hour old, otherwise fetched on the host's turn and cached.
  const host = target.host;
  let robots: { status: number; headers: Record<string, string>; body: string };
  let robotsAgeSec: number | null = null;
  try {
    const cached = await hosts.robots(host);
    if (cached && cached.ageSec < ROBOTS_MAX_AGE_SEC) {
      robots = { status: cached.status, headers: {}, body: cached.body };
      robotsAgeSec = cached.ageSec;
    } else {
      // An expired entry's Crawl-delay still paces the refetch.
      const staleDelay = cached ? crawlDelayOf(cached.status, cached.body, CRAWLER_TOKEN) : null;
      const wait = await hosts.turn(host, turnGapSec(MIN_GAP_SEC, staleDelay));
      if (wait > 0) return tooSoon({ slug, refused: 'host busy' }, Math.ceil(wait));
      robots = await politeFetch(`${target.protocol}//${host}/robots.txt`, {
        timeoutMs: 10_000, maxBytes: 300_000, headers: { Accept: 'text/plain,*/*;q=0.5' },
      });
      if (isCacheableRobots(robots.status, robots.headers, robots.body)) {
        await hosts.storeRobots(host, robots.status, robots.body);
      }
    }
  } catch (e) {
    return unavailable(slug, e);
  }
  const robotsBlock = detectBlock(robots.status, robots.headers, robots.body);
  const verdict = robotsBlock.blockedBy ? 'unreachable' : robotsVerdictFromStatus(robots.status);
  if (verdict === 'unreachable') {
    return Response.json({ slug, refused: 'robots.txt unreachable or refused: RFC 9309 says assume disallow', robotsStatus: robots.status }, { status: 409 });
  }
  if (verdict === 'rules' && !isAllowed(parseRobots(robots.body), CRAWLER_TOKEN, robotsPathOf(target.toString()))) {
    return Response.json({ slug, refused: `robots.txt disallows ${CRAWLER_TOKEN} on ${robotsPathOf(target.toString())}` }, { status: 409 });
  }

  // The host's turn: max(5 s, its Crawl-delay) since the last request any
  // invocation sent it. Up to 20 s is waited out; longer, the caller comes back.
  const crawlDelaySec = crawlDelayOf(robots.status, robots.body, CRAWLER_TOKEN);
  const gapSec = turnGapSec(MIN_GAP_SEC, crawlDelaySec);
  let slot: TurnOutcome;
  try {
    slot = await awaitTurn(hosts.turn, host, gapSec);
  } catch (e) {
    return unavailable(slug, e);
  }
  if (!slot.granted) return tooSoon({ slug, refused: 'crawl-delay', crawlDelaySec }, Math.ceil(slot.retryAfterSec));

  const r = await politeFetch(target.toString(), {
    method: body.method ?? 'GET',
    headers: body.headers,
    body: body.postBody,
    timeoutMs: 25_000,
    maxBytes: 3_000_000,
  });

  const html = r.body;
  const ctype = r.headers['content-type'] ?? '';
  const block = detectBlock(r.status, r.headers, html);

  let links: string[] = [];
  if (linkRe) {
    const re = linkRe;
    const seen = new Set<string>();
    for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      try {
        const abs = new URL(m[1], r.finalUrl || target.toString()).toString();
        if (re.test(abs) && !seen.has(abs)) seen.add(abs);
      } catch { /* skip */ }
      if (seen.size >= Math.min(body.maxLinks ?? 60, 300)) break;
    }
    links = [...seen];
  }

  const xmlLocs = /xml/i.test(ctype) || html.trimStart().startsWith('<?xml')
    ? [...html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].slice(0, 200).map((m) => m[1])
    : [];

  const nodes = flattenNodes(extractJsonLdBlocks(html));
  const interesting = nodes
    .filter((n) => /product|event|offer|vehicle|item|sale/i.test(JSON.stringify(n['@type'] ?? '')))
    .slice(0, 4)
    .map((n) => JSON.stringify(n).slice(0, 3000));

  const states: Record<string, string> = {};
  for (const [name, re] of STATE_MARKERS) {
    const m = html.match(re);
    if (m) states[name] = m[1].slice(0, 2500);
  }

  let jsonPreview: unknown = null;
  if (/json/i.test(ctype)) {
    jsonPreview = html.slice(0, 12_000);
  }

  const [from, len] = body.slice ?? [0, 0];
  const text = /html/i.test(ctype) ? visibleText(html) : null;
  const [tFrom, tLen] = body.textSlice ?? [0, 0];
  const context = Math.min(Math.max(Math.trunc(body.context ?? 400), 50), 1500);
  return Response.json({
    slug,
    request: { url: target.toString(), method: body.method ?? 'GET' },
    status: r.status,
    finalUrl: r.finalUrl,
    contentType: ctype,
    bytes: r.bytes,
    truncated: r.truncated,
    block,
    title: pageTitle(html),
    jsonLdTypes: jsonLdTypes(html),
    jsonLdItems: interesting,
    feeds: feedLinks(html, r.finalUrl || target.toString()),
    states,
    links,
    xmlLocs,
    jsonPreview,
    text: text === null ? null : text.slice(0, 3000),
    textLength: text === null ? null : text.length,
    found: text !== null && findRe ? findInText(text, findRe, context) : null,
    textSlice: text !== null && tLen > 0 ? text.slice(tFrom, tFrom + Math.min(tLen, 20_000)) : null,
    slice: len > 0 ? html.slice(from, from + Math.min(len, 20_000)) : null,
    politeness: {
      robots: robotsAgeSec === null ? 'fetched' : `cached ${Math.floor(robotsAgeSec / 60)} min ago`,
      crawlDelaySec,
      gapSec,
      waitedMs: slot.waitedMs,
    },
  });
});
