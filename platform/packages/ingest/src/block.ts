/**
 * Bot-manager detection and robots path matching: the part of the probe the
 * crawl gate needs on every request.
 *
 * Kept apart from probe.ts so the crawl workers carry only this, not the whole
 * probe and its JSON-LD reading. probe.ts re-exports both names, so callers of
 * the probe are unchanged.
 *
 * No I/O here: every judgement is unit-tested against captured responses.
 */

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
  /**
   * The header, or the markup with a little context, that produced the verdict.
   * Stored so a verdict can be audited without fetching the page again: the first
   * live run marked a working site blocked, and only the evidence shows why.
   */
  evidence: string | null;
}

const NO_BLOCK: BlockSignal = { blockedBy: null, challenge: false, reason: null, evidence: null };

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

  // The matched markup plus ~60 characters either side, whitespace-collapsed.
  const find = (re: RegExp): string | null => {
    const m = re.exec(b);
    if (!m) return null;
    return b.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim();
  };
  const block = (blockedBy: BlockVendor, challenge: boolean, reason: string, evidence: string | null): BlockSignal =>
    ({ blockedBy, challenge, reason, evidence: evidence ? evidence.slice(0, 240) : null });

  // Cloudflare: the explicit header is authoritative; otherwise the interstitial's
  // own markup. NOT the bare /cdn-cgi/challenge-platform/ path: Cloudflare injects
  // its passive "JavaScript detections" script (.../scripts/jsd/main.js) into
  // ordinary pages, and matching that marked a live, working site as blocked
  // (Beloit Auction & Realty, first live probe, 2026-09-29). A real interstitial
  // loads an .../orchestrate/... script and sets window._cf_chl_opt.
  if (h('cf-mitigated').toLowerCase() === 'challenge') {
    return block('cloudflare', true, 'cf-mitigated: challenge', 'cf-mitigated: challenge');
  }
  const cfChallenge = find(
    /<title>\s*(?:just a moment\.\.\.|attention required! \| cloudflare)\s*<\/title>|\/cdn-cgi\/challenge-platform\/[^"'\s]*orchestrate\/|window\._cf_chl_opt/i,
  );
  if (cfChallenge) return block('cloudflare', true, 'Cloudflare challenge page', cfChallenge);
  if (server.includes('cloudflare') && refused && /cloudflare/i.test(b)) {
    const ray = find(/ray id|error code: 10\d\d/i);
    if (ray) return block('cloudflare', false, `Cloudflare refusal HTTP ${status}`, ray);
  }

  // Akamai: "Access Denied ... Reference #18.xxxx" from AkamaiGHost.
  if (refused && server.includes('akamaighost')) {
    return block('akamai', false, `Akamai refusal HTTP ${status}`, `server: ${h('server')}`);
  }
  if (refused) {
    const edgesuite = find(/errors\.edgesuite\.net/i);
    if (edgesuite) return block('akamai', false, `Akamai refusal HTTP ${status}`, edgesuite);
    if (/<title>\s*access denied\s*<\/title>/i.test(b)) {
      const ref = find(/reference\s*#\d+\.[0-9a-f.]+/i);
      if (ref) return block('akamai', false, 'Akamai Access Denied page', ref);
    }
  }

  // PerimeterX / HUMAN.
  const px = find(/px-captcha|_pxCaptcha|perimeterx|human security/i);
  if (px && (refused || /px-captcha/i.test(b))) return block('perimeterx', true, 'PerimeterX challenge', px);

  // DataDome.
  if (h('x-datadome') || server.includes('datadome') || /geo\.captcha-delivery\.com/i.test(b)) {
    if (refused || /captcha-delivery/i.test(b)) {
      const dd = find(/captcha-delivery\.com/i) ?? (h('x-datadome') ? `x-datadome: ${h('x-datadome')}` : `server: ${h('server')}`);
      return block('datadome', true, 'DataDome challenge', dd);
    }
  }

  // Imperva / Incapsula.
  const incapsula = find(/incapsula incident id|_incapsula_resource/i);
  if (incapsula) return block('incapsula', true, 'Imperva/Incapsula interstitial', incapsula);
  if (h('x-iinfo') && refused) return block('incapsula', true, 'Imperva/Incapsula interstitial', `x-iinfo: ${h('x-iinfo')}`);

  // AWS WAF: challenge responses are often HTTP 202 with an integration script.
  const waf = find(/awswafintegration|aws-waf-token|challenge\.js.*awswaf/i);
  if (h('x-amzn-waf-action') || waf) {
    if (refused || status === 202 || /awswafintegration/i.test(b)) {
      return block('aws_waf', true, `AWS WAF challenge HTTP ${status}`, waf ?? `x-amzn-waf-action: ${h('x-amzn-waf-action')}`);
    }
  }

  // Sucuri.
  const sucuri = find(/sucuri website firewall - access denied/i);
  if (h('x-sucuri-block') || sucuri) {
    return block('sucuri', false, 'Sucuri firewall block', sucuri ?? `x-sucuri-block: ${h('x-sucuri-block')}`);
  }

  // A CAPTCHA wall with a refusal status, vendor unknown.
  if (refused) {
    const captcha = find(/g-recaptcha|hcaptcha\.com|cf-turnstile|captcha/i);
    if (captcha) return block('captcha', true, `CAPTCHA wall HTTP ${status}`, captcha);
  }

  return NO_BLOCK;
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
