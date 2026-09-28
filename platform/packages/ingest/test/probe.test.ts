import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBlock,
  jsonLdTypes,
  feedLinks,
  robotsPathOf,
  concludeProbe,
  type ProbeObservation,
} from '../src/probe.ts';

// Response bodies below reproduce the distinguishing markup of each vendor's real
// block pages (titles, script paths, reference formats), trimmed to what the
// detector keys on.

const CF_CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"></head><body><div class="main-wrapper">
<script>(function(){window._cf_chl_opt={cvId: '3',cZone: 'hibid.com'};
var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=8c1f';
document.getElementsByTagName('head')[0].appendChild(a);}());</script></body></html>`;

const AKAMAI_DENIED = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;www&#46;govdeals&#46;com&#47;" on this server.<P>
Reference&#32;&#35;18&#46;4b2f1602&#46;1727400000&#46;1a2b3c4d\n<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;4b2f1602</P>\n</BODY>\n</HTML>`;

const AKAMAI_PLAIN = `<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>
Reference #18.4b2f1602.1727400000.1a2b3c4d</BODY></HTML>`;

const DATADOME = `<html><head><title>example.com</title></head><body>
<script src="https://ct.captcha-delivery.com/c.js"></script>
<iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMA"></iframe></body></html>`;

const PERIMETERX = `<html><head><title>Access to this page has been denied</title></head><body>
<div id="px-captcha"></div><script src="/px/client/main.min.js"></script></body></html>`;

const INCAPSULA = `<html><head><META NAME="robots" CONTENT="noindex,nofollow"></head><body>
<iframe src="/_Incapsula_Resource?SWUDNSAI=31&xinfo=10-1234"></iframe>Incapsula incident ID: 123</body></html>`;

const AWS_WAF = `<!DOCTYPE html><html><head><script>window.awsWafCookieDomainList = [];
window.gokuProps = {};</script><script src="https://abc.token.awswaf.com/abc/challenge.js"></script></head>
<body><script>AwsWafIntegration.checkForceRefresh().then(() => {});</script></body></html>`;

const NORMAL_PAGE = `<!DOCTYPE html><html><head><title>Wisconsin Surplus Online Auction</title>
<link rel="alternate" type="application/rss+xml" title="New auctions" href="/feeds/new.xml">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","name":"Wisconsin Surplus"},
 {"@type":"Event","name":"Online Auction #25-832","startDate":"2026-10-01"}]}</script>
</head><body>Welcome. Server is behind Cloudflare but serving real content.</body></html>`;

test('a Cloudflare challenge is detected, including when served with HTTP 200', () => {
  const s403 = detectBlock(403, { server: 'cloudflare' }, CF_CHALLENGE);
  assert.equal(s403.blockedBy, 'cloudflare');
  assert.equal(s403.challenge, true);

  // The Turnstile shell arrives as 200. Status alone would call this a success.
  const s200 = detectBlock(200, { server: 'cloudflare' }, CF_CHALLENGE);
  assert.equal(s200.blockedBy, 'cloudflare');

  assert.equal(detectBlock(200, { 'cf-mitigated': 'challenge' }, '').blockedBy, 'cloudflare');
});

test('a site merely served THROUGH Cloudflare is not blocked', () => {
  const s = detectBlock(200, { server: 'cloudflare', 'cf-ray': '8c1f-ORD' }, NORMAL_PAGE);
  assert.equal(s.blockedBy, null);
  assert.equal(s.challenge, false);
});

test('Akamai Access Denied is detected with and without the AkamaiGHost header', () => {
  assert.equal(detectBlock(403, { server: 'AkamaiGHost' }, AKAMAI_DENIED).blockedBy, 'akamai');
  assert.equal(detectBlock(403, {}, AKAMAI_PLAIN).blockedBy, 'akamai');
});

test('DataDome, PerimeterX, Incapsula and AWS WAF interstitials are identified', () => {
  assert.equal(detectBlock(403, { 'x-datadome': 'protected' }, DATADOME).blockedBy, 'datadome');
  assert.equal(detectBlock(403, {}, PERIMETERX).blockedBy, 'perimeterx');
  assert.equal(detectBlock(200, {}, INCAPSULA).blockedBy, 'incapsula');
  // AWS WAF challenges commonly return 202.
  assert.equal(detectBlock(202, {}, AWS_WAF).blockedBy, 'aws_waf');
});

test('ordinary errors are not mistaken for bot protection', () => {
  assert.equal(detectBlock(404, { server: 'nginx' }, '<h1>Not Found</h1>').blockedBy, null);
  assert.equal(detectBlock(500, {}, 'Internal Server Error').blockedBy, null);
  // A page that merely mentions a CAPTCHA with HTTP 200 is not a wall.
  assert.equal(detectBlock(200, {}, 'We use reCAPTCHA on our contact form. g-recaptcha').blockedBy, null);
});

test('JSON-LD types and advertised feeds are extracted', () => {
  assert.deepEqual(jsonLdTypes(NORMAL_PAGE), ['Event', 'Organization']);
  assert.deepEqual(feedLinks(NORMAL_PAGE, 'https://wisconsinsurplus.com/'), [
    'https://wisconsinsurplus.com/feeds/new.xml',
  ]);
  assert.deepEqual(jsonLdTypes('<html>no structured data</html>'), []);
});

test('robots rules are matched against path plus query', () => {
  assert.equal(robotsPathOf('https://www.govdeals.com/wisconsin'), '/wisconsin');
  assert.equal(robotsPathOf('https://hibid.com/lots?q=drone'), '/lots?q=drone');
  assert.equal(robotsPathOf('https://hibid.com'), '/');
  assert.equal(robotsPathOf('not a url'), '/');
});

const obs = (target: ProbeObservation['target'], status: number, body = '', headers: Record<string, string> = {}): ProbeObservation => ({
  target, url: `https://x.test/${target}`, status, finalUrl: `https://x.test/${target}`,
  headers, body, bytes: body.length, latencyMs: 10, error: status === 0 ? 'TimeoutError' : null,
});

test('open: robots allows us and the page loads cleanly', () => {
  const c = concludeProbe('https://x.test/', 'WaystockBot', [
    obs('robots', 200, 'User-agent: *\nDisallow: /account\nCrawl-delay: 3\nSitemap: https://x.test/sitemap.xml\n'),
    obs('home', 200, NORMAL_PAGE),
  ]);
  assert.equal(c.accessStatus, 'open');
  assert.equal(c.robotsAllows, true);
  assert.equal(c.crawlDelaySec, 3);
  assert.deepEqual(c.sitemaps, ['https://x.test/sitemap.xml']);
  assert.deepEqual(c.rows[1].jsonld_types, ['Event', 'Organization']);
  assert.equal((c.rows[1].detail as any).title, 'Wisconsin Surplus Online Auction');
  assert.match((c.rows[0].detail as any).excerpt, /Disallow: \/account/);
});

test('open: no robots.txt (404) permits crawling per RFC 9309', () => {
  const c = concludeProbe('https://x.test/', 'WaystockBot', [obs('robots', 404), obs('home', 200, NORMAL_PAGE)]);
  assert.equal(c.accessStatus, 'open');
  assert.equal(c.robotsAllows, true);
  assert.match(c.note, /No robots\.txt/);
});

test('robots_disallowed: the source path is disallowed for us', () => {
  const c = concludeProbe('https://x.test/wisconsin', 'WaystockBot', [
    obs('robots', 200, 'User-agent: *\nDisallow: /wisconsin\n'),
    obs('home', 200, NORMAL_PAGE),
  ]);
  assert.equal(c.accessStatus, 'robots_disallowed');
  assert.equal(c.robotsAllows, false);
});

test('robots_disallowed: robots.txt erroring while pages load means assume disallow', () => {
  const c = concludeProbe('https://x.test/', 'WaystockBot', [obs('robots', 503), obs('home', 200, NORMAL_PAGE)]);
  assert.equal(c.accessStatus, 'robots_disallowed');
  assert.equal(c.robotsAllows, false);
});

test('blocked: a bot manager anywhere wins over everything else', () => {
  const c = concludeProbe('https://hibid.com/', 'WaystockBot', [
    obs('robots', 403, CF_CHALLENGE, { server: 'cloudflare' }),
    obs('home', 403, CF_CHALLENGE, { server: 'cloudflare' }),
  ]);
  assert.equal(c.accessStatus, 'blocked');
  assert.equal(c.robotsAllows, false);
  assert.match(c.note, /do not work around/);
  assert.equal(c.rows[0].blocked_by, 'cloudflare');
  assert.equal((c.rows[1].detail as any).title, 'Just a moment...');
});

test('blocked: a bare 403 on the home page is a refusal even without vendor markup', () => {
  const c = concludeProbe('https://x.test/', 'WaystockBot', [obs('robots', 404), obs('home', 403, '<h1>Forbidden</h1>')]);
  assert.equal(c.accessStatus, 'blocked');
  assert.match(c.note, /HTTP 403 refusal/);
});

test('unreachable: every page failed at the network level', () => {
  const c = concludeProbe('https://x.test/', 'WaystockBot', [obs('robots', 0), obs('home', 0)]);
  assert.equal(c.accessStatus, 'unreachable');
  assert.equal(c.robotsAllows, false);
});
