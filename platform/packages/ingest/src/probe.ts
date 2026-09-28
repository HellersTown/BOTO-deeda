/**
 * Live-site probe: pure analysis of what a site returned to our honest crawler.
 *
 * WHY THIS EXISTS. The earlier attempt at this project "always got blocked", and
 * the research for this one (docs/08) found third-party reports that the biggest
 * Wisconsin platforms refuse datacenter clients. Reports are not evidence. This
 * module turns our own requests into evidence: for every source, what did
 * robots.txt say, did a bot manager intercept us, and what structured data does
 * the page publish?
 *
 * No I/O here: the Edge Function does the fetching and passes results in, so
 * every judgement below is unit-tested against captured responses.
 */

import { extractJsonLdBlocks, flattenNodes } from './jsonld.ts';
import { groupFor, isAllowed, parseRobots, robotsVerdictFromStatus, type ParsedRobots } from './robots.ts';

export type BlockVendor =
  | 'cloudflare'
  | 'akamai'
  | 'perimeterx'
  | 'datadome'
  | 'incapsula'
  | 'aws_waf'
  | 'sucuri'
  | 'captcha';

export interface BlockSignal {
  blockedBy: BlockVendor | null;
  /** A challenge page was served (a JS or CAPTCHA interstitial), whatever the status. */
  challenge: boolean;
  /** Human-readable reason, stored with the probe for later audit. */
  reason: string | null;
}

/**
 * Did a bot manager intercept this response?
 *
 * The distinction that matters: a site SERVED THROUGH Cloudflare (server:
 * cloudflare, HTTP 200, real content) is not blocking anyone. Only a challenge or
 * a refusal counts. And a challenge can arrive with HTTP 200: Cloudflare's
 * Turnstile shell does exactly that, which is why status alone is never enough.
 */
export function detectBlock(
  status: number,
  headers: Record<string, string>,
  body: string,
): BlockSignal {
  const h = (k: string) => headers[k.toLowerCase()] ?? '';
  const server = h('server').toLowerCase();
  const b = body.slice(0, 200_000);
  const refused = status === 401 || status === 403 || status === 405 || status === 429 || status === 503;

  // Cloudflare: the explicit header is authoritative; otherwise the challenge markup.
  if (h('cf-mitigated').toLowerCase() === 'challenge') {
    return { blockedBy: 'cloudflare', challenge: true, reason: 'cf-mitigated: challenge' };
  }
  if (
    /<title>\s*(just a moment\.\.\.|attention required! \| cloudflare)\s*<\/title>/i.test(b) ||
    /\/cdn-cgi\/challenge-platform\//i.test(b) ||
    /window\._cf_chl_opt/i.test(b)
  ) {
    return { blockedBy: 'cloudflare', challenge: true, reason: 'Cloudflare challenge page' };
  }
  if (server.includes('cloudflare') && refused && /cloudflare/i.test(b) && /(ray id|error code: 10\d\d)/i.test(b)) {
    return { blockedBy: 'cloudflare', challenge: false, reason: `Cloudflare refusal HTTP ${status}` };
  }

  // Akamai: "Access Denied ... Reference #18.xxxx" from AkamaiGHost.
  if ((server.includes('akamaighost') || /errors\.edgesuite\.net/i.test(b)) && refused) {
    return { blockedBy: 'akamai', challenge: false, reason: `Akamai refusal HTTP ${status}` };
  }
  if (refused && /<title>\s*access denied\s*<\/title>/i.test(b) && /reference\s*#\d+\.[0-9a-f.]+/i.test(b)) {
    return { blockedBy: 'akamai', challenge: false, reason: 'Akamai Access Denied page' };
  }

  // PerimeterX / HUMAN.
  if (/(px-captcha|_pxCaptcha|perimeterx|human security)/i.test(b) && (refused || /px-captcha/i.test(b))) {
    return { blockedBy: 'perimeterx', challenge: true, reason: 'PerimeterX challenge' };
  }

  // DataDome.
  if (h('x-datadome') || server.includes('datadome') || /geo\.captcha-delivery\.com/i.test(b)) {
    if (refused || /captcha-delivery/i.test(b)) {
      return { blockedBy: 'datadome', challenge: true, reason: 'DataDome challenge' };
    }
  }

  // Imperva / Incapsula.
  if (/(incapsula incident id|_incapsula_resource)/i.test(b) || (h('x-iinfo') && refused)) {
    return { blockedBy: 'incapsula', challenge: true, reason: 'Imperva/Incapsula interstitial' };
  }

  // AWS WAF: challenge responses are often HTTP 202 with an integration script.
  if (h('x-amzn-waf-action') || /(awswafintegration|aws-waf-token|challenge\.js.*awswaf)/i.test(b)) {
    if (refused || status === 202 || /awswafintegration/i.test(b)) {
      return { blockedBy: 'aws_waf', challenge: true, reason: `AWS WAF challenge HTTP ${status}` };
    }
  }

  // Sucuri.
  if (h('x-sucuri-block') || /sucuri website firewall - access denied/i.test(b)) {
    return { blockedBy: 'sucuri', challenge: false, reason: 'Sucuri firewall block' };
  }

  // A CAPTCHA wall with a refusal status, vendor unknown.
  if (refused && /(g-recaptcha|hcaptcha\.com|cf-turnstile|captcha)/i.test(b)) {
    return { blockedBy: 'captcha', challenge: true, reason: `CAPTCHA wall HTTP ${status}` };
  }

  return { blockedBy: null, challenge: false, reason: null };
}

/** Every schema.org @type published in the page's JSON-LD (Product, Event, Offer...). */
export function jsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  for (const node of flattenNodes(extractJsonLdBlocks(html))) {
    const t = node['@type'];
    for (const v of Array.isArray(t) ? t : [t]) {
      if (typeof v === 'string' && v) types.add(v);
    }
  }
  return [...types].sort();
}

/** RSS/Atom feeds the page itself advertises via <link rel="alternate">. */
export function feedLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html.slice(0, 300_000))) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      out.add(new URL(href, baseUrl).toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...out];
}

/** The page's <title>, whitespace-collapsed and capped, or null. */
export function pageTitle(html: string): string | null {
  const m = html.slice(0, 100_000).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 160) : null;
}

/** The path+query of a URL as robots rules are matched against it. */
export function robotsPathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || '/') + (u.search || '');
  } catch {
    return '/';
  }
}

export type AccessStatus = 'open' | 'blocked' | 'robots_disallowed' | 'unreachable' | 'deeplink_only' | 'unknown';

export interface ProbeObservation {
  target: 'robots' | 'home' | 'listing' | 'api';
  url: string;
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  latencyMs: number;
  error: string | null;
}

export interface ProbeConclusion {
  accessStatus: AccessStatus;
  /** Robots permission for the source's own URL path. null = no verdict possible. */
  robotsAllows: boolean | null;
  crawlDelaySec: number | null;
  sitemaps: string[];
  note: string;
  /** One row per request, shaped for record_source_probe. */
  rows: Record<string, unknown>[];
}

/**
 * Turn a source's probe observations into a verdict.
 *
 * Precedence, most severe first: blocked > unreachable > robots_disallowed > open.
 * A single detected block anywhere wins, because it tells us how the site treats
 * our identity, and that is the one thing we will not argue with.
 */
export function concludeProbe(
  sourceUrl: string,
  token: string,
  observations: ProbeObservation[],
): ProbeConclusion {
  let parsed: ParsedRobots | null = null;
  let robotsVerdict: 'allowed' | 'disallowed' | 'unreachable' | 'absent' | null = null;
  let crawlDelaySec: number | null = null;
  let sitemaps: string[] = [];
  const blocks: string[] = [];
  const rows: Record<string, unknown>[] = [];

  for (const o of observations) {
    const block = detectBlock(o.status, o.headers, o.body);
    if (block.blockedBy || block.challenge) blocks.push(`${o.target}: ${block.reason}`);

    const row: Record<string, unknown> = {
      target: o.target,
      url: o.url,
      status: o.status,
      final_url: o.finalUrl,
      latency_ms: o.latencyMs,
      bytes: o.bytes,
      content_type: o.headers['content-type'] ?? null,
      server: o.headers['server'] ?? null,
      blocked_by: block.blockedBy,
      challenge: block.challenge,
      error: o.error,
      detail: {
        reason: block.reason,
        cf_ray: o.headers['cf-ray'] ?? null,
        x_cache: o.headers['x-cache'] ?? null,
        // Evidence that we saw the real page (or the real refusal), kept short.
        title: pageTitle(o.body),
        excerpt: o.target === 'robots' ? o.body.slice(0, 2000) : null,
      },
    };

    if (o.target === 'robots') {
      const v = block.blockedBy ? 'unreachable' : robotsVerdictFromStatus(o.status);
      if (v === 'rules') {
        parsed = parseRobots(o.body);
        const allowed = isAllowed(parsed, token, robotsPathOf(sourceUrl));
        robotsVerdict = allowed ? 'allowed' : 'disallowed';
        sitemaps = parsed.sitemaps.slice(0, 20);
        crawlDelaySec = groupFor(parsed, token)?.crawlDelaySec ?? null;
      } else {
        robotsVerdict = v; // 'absent' or 'unreachable'
      }
      row.robots_verdict = robotsVerdict;
      row.crawl_delay_s = crawlDelaySec;
      row.sitemaps = sitemaps;
    } else if (o.status >= 200 && o.status < 300 && !block.blockedBy) {
      const types = jsonLdTypes(o.body);
      const feeds = feedLinks(o.body, o.finalUrl || o.url);
      row.jsonld_types = types;
      row.feed_urls = feeds;
    }
    rows.push(row);
  }

  const pages = observations.filter((o) => o.target !== 'robots');
  // A bare 401/403/429 on a PAGE is a refusal of our identity even when no vendor
  // markup is recognisable (an nginx IP deny list looks exactly like this). On
  // robots.txt the same status means "no rules" (RFC 9309), which is why the
  // two are judged differently.
  for (const o of pages) {
    if ((o.status === 401 || o.status === 403 || o.status === 429) && !detectBlock(o.status, o.headers, o.body).blockedBy) {
      blocks.push(`${o.target}: HTTP ${o.status} refusal (vendor not identified)`);
    }
  }
  const reachablePage = pages.some((o) => o.status >= 200 && o.status < 400);
  const allPagesDown = pages.length > 0 && pages.every((o) => o.status === 0 || o.status >= 500);

  let accessStatus: AccessStatus;
  let robotsAllows: boolean | null;
  let note: string;

  if (blocks.length) {
    accessStatus = 'blocked';
    robotsAllows = false;
    note = `Bot protection refused our crawler identity: ${blocks.join('; ')}. Route to deep links; do not work around.`;
  } else if (allPagesDown || (!reachablePage && robotsVerdict === 'unreachable')) {
    accessStatus = 'unreachable';
    robotsAllows = false;
    note = 'Site unreachable or erroring (network error or 5xx). Treated as do-not-crawl until it recovers.';
  } else if (robotsVerdict === 'unreachable') {
    // Pages load but robots.txt errors: RFC 9309 says assume complete disallow.
    accessStatus = 'robots_disallowed';
    robotsAllows = false;
    note = 'robots.txt unreachable (5xx/429) while pages load: RFC 9309 requires assuming complete disallow.';
  } else if (robotsVerdict === 'disallowed') {
    accessStatus = 'robots_disallowed';
    robotsAllows = false;
    note = `robots.txt disallows ${token} on ${robotsPathOf(sourceUrl)}.`;
  } else if (reachablePage) {
    accessStatus = 'open';
    robotsAllows = true;
    note = robotsVerdict === 'absent'
      ? 'No robots.txt (4xx): crawling permitted per RFC 9309. Pages load without a challenge.'
      : 'robots.txt permits our crawler and pages load without a challenge.';
  } else {
    accessStatus = 'unknown';
    robotsAllows = null;
    note = 'Inconclusive: pages returned client errors without a recognisable block.';
  }

  return { accessStatus, robotsAllows, crawlDelaySec, sitemaps, note, rows };
}
