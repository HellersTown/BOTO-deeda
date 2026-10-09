import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateFetcher, CrawlRefused } from '../src/gate.ts';
import type { RawResponse } from '../src/gate.ts';

/** A fake network: robots.txt and pages per URL, with a log of every request made. */
function fakeNet(pages: Record<string, RawResponse>) {
  const log: string[] = [];
  const rawFetch = async (url: string) => {
    log.push(url);
    return pages[url] ?? { status: 404, headers: {}, text: 'not found' };
  };
  return { rawFetch, log };
}

/** A fake clock: sleep advances time instantly and records how long it would have waited. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { waits.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    waits,
  };
}

const ok = (text: string): RawResponse => ({ status: 200, headers: { 'content-type': 'text/html' }, text });

test('robots.txt is fetched once per host and every URL is checked against it', async () => {
  const net = fakeNet({
    'https://a.test/robots.txt': ok('User-agent: *\nDisallow: /search\nAllow: /search/help\n'),
    'https://a.test/lots': ok('<html>lots</html>'),
    'https://a.test/search/help': ok('<html>help</html>'),
  });
  const clock = fakeClock();
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, sleep: clock.sleep, now: clock.now });

  assert.equal((await f('https://a.test/lots')).status, 200);
  assert.equal((await f('https://a.test/search/help')).status, 200);
  await assert.rejects(f('https://a.test/search?q=drone'), (e: unknown) => e instanceof CrawlRefused && e.reason === 'robots');
  assert.deepEqual(net.log.filter((u) => u.endsWith('/robots.txt')), ['https://a.test/robots.txt']);
  assert.ok(!net.log.includes('https://a.test/search?q=drone'), 'a disallowed URL is never requested');
  assert.equal(f.stats().refusals.length, 1);
});

test('rules for our own token win over the * group', async () => {
  const net = fakeNet({
    'https://b.test/robots.txt': ok('User-agent: WaystockBot\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n'),
    'https://b.test/lots': ok('lots'),
  });
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, sleep: async () => {} });
  assert.equal((await f('https://b.test/lots')).status, 200);
  await assert.rejects(f('https://b.test/private/x'), CrawlRefused);
});

test('an unreachable robots.txt means complete disallow (RFC 9309)', async () => {
  const net = fakeNet({ 'https://c.test/robots.txt': { status: 503, headers: {}, text: 'down' } });
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, sleep: async () => {} });
  await assert.rejects(f('https://c.test/lots'), (e: unknown) => e instanceof CrawlRefused && e.reason === 'robots');
  assert.deepEqual(net.log, ['https://c.test/robots.txt']);
});

test('a missing robots.txt (404) permits crawling', async () => {
  const net = fakeNet({ 'https://d.test/lots': ok('lots') });
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, sleep: async () => {} });
  assert.equal((await f('https://d.test/lots')).status, 200);
});

test('requests to one host are spaced by the rate limit, and by a longer Crawl-delay', async () => {
  const net = fakeNet({
    'https://e.test/robots.txt': ok('User-agent: *\nCrawl-delay: 5\n'),
    'https://e.test/1': ok('1'), 'https://e.test/2': ok('2'), 'https://e.test/3': ok('3'),
    'https://f.test/1': ok('1'), 'https://f.test/2': ok('2'),
  });
  const clock = fakeClock();
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 30, sleep: clock.sleep, now: clock.now });
  // e.test asks for 5 s; the rate limit is 2 s. Three fired at once must still be paced.
  await Promise.all([f('https://e.test/1'), f('https://e.test/2'), f('https://e.test/3')]);
  // f.test has no robots.txt: 2 s apart.
  await f('https://f.test/1');
  await f('https://f.test/2');
  const eWaits = clock.waits.filter((w) => w === 5000).length;
  assert.ok(eWaits >= 2, `expected two 5 s waits on e.test, saw ${JSON.stringify(clock.waits)}`);
  assert.ok(clock.waits.includes(2000), 'f.test paced at 60/30 = 2 s');
});

test('a bot-manager challenge stops the run and is never retried', async () => {
  const net = fakeNet({
    'https://g.test/robots.txt': ok('User-agent: *\nAllow: /\n'),
    'https://g.test/lots': { status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' }, text: '<title>Just a moment...</title>' },
  });
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, sleep: async () => {} });
  await assert.rejects(f('https://g.test/lots'), (e: unknown) => e instanceof CrawlRefused && e.reason === 'blocked');
  assert.equal(net.log.filter((u) => u === 'https://g.test/lots').length, 1);
});

test('official APIs skip robots.txt but are still paced', async () => {
  const net = fakeNet({ 'https://api.h.test/v1/items': ok('{"items":[]}') });
  const clock = fakeClock();
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 60, exemptFromRobots: true, sleep: clock.sleep, now: clock.now });
  await f('https://api.h.test/v1/items');
  await f('https://api.h.test/v1/items');
  assert.ok(!net.log.some((u) => u.endsWith('/robots.txt')));
  assert.deepEqual(clock.waits, [1000]);
});

test('the request budget and the deadline are enforced', async () => {
  const net = fakeNet({ 'https://i.test/robots.txt': ok(''), 'https://i.test/a': ok('a') });
  const f = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, maxRequests: 2, sleep: async () => {} });
  await f('https://i.test/a'); // robots.txt + page = 2 requests
  await assert.rejects(f('https://i.test/a'), (e: unknown) => e instanceof CrawlRefused && e.reason === 'budget');

  const clock = fakeClock(0);
  const g = gateFetcher({ rawFetch: net.rawFetch, rateLimitRpm: 600, deadline: 10, sleep: clock.sleep, now: clock.now });
  await g('https://i.test/a');
  clock.advance(20);
  await assert.rejects(g('https://i.test/a'), (e: unknown) => e instanceof CrawlRefused && e.reason === 'budget');
});
