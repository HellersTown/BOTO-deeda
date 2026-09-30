import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitTurn,
  cachedRobotsObservation,
  crawlDelayOf,
  hostState,
  isCacheableRobots,
  turnGapSec,
  type Rpc,
} from '../src/politeness.ts';
import { detectBlock } from '../src/block.ts';
import { concludeProbe, type ProbeObservation } from '../src/probe.ts';

const T = 'WaystockBot';

/** crawl_host_turn in memory, with the database's rule (migration 0024), on a fake clock. */
function fakeHosts() {
  let now = 0; // ms
  const last = new Map<string, number>();
  const turn = async (host: string, gapSec: number): Promise<number> => {
    const l = last.get(host);
    if (l !== undefined) {
      const wait = gapSec - (now - l) / 1000;
      if (wait > 0) return wait;
    }
    last.set(host, now);
    return 0;
  };
  const sleep = async (ms: number) => {
    now += ms;
  };
  return { turn, sleep, last, advance: (ms: number) => void (now += ms) };
}

test('crawlDelayOf reads our token\'s Crawl-delay, and only from robots.txt rules', () => {
  assert.equal(crawlDelayOf(200, 'User-agent: *\nCrawl-delay: 120\n', T), 120);
  // www.hansenauctiongroup.com, as its robots.txt read on 2026-09-30.
  const hansen = 'User-agent: *\nDisallow: /.well-known\nDisallow: /ajax\nCrawl-delay: 10\n'
    + 'Host: www.hansenauctiongroup.com\nSitemap: https://www.hansenauctiongroup.com/sitemap/feed\n';
  assert.equal(crawlDelayOf(200, hansen, T), 10);
  // A group naming our token governs us instead of the * group.
  assert.equal(crawlDelayOf(200, 'User-agent: *\nCrawl-delay: 120\n\nUser-agent: WaystockBot\nCrawl-delay: 2\n', T), 2);
  assert.equal(crawlDelayOf(200, 'User-agent: *\nDisallow: /admin\n', T), null);
  // A 4xx or 5xx body is an error page, not rules, whatever it says.
  assert.equal(crawlDelayOf(404, 'User-agent: *\nCrawl-delay: 30\n', T), null);
  assert.equal(crawlDelayOf(503, 'User-agent: *\nCrawl-delay: 30\n', T), null);
  assert.equal(crawlDelayOf(0, '', T), null);
});

test('the gap between two requests to a host is our floor or the Crawl-delay, whichever is longer', () => {
  assert.equal(turnGapSec(5, null), 5);
  assert.equal(turnGapSec(5, 2), 5);
  assert.equal(turnGapSec(5, 120), 120);
  assert.equal(turnGapSec(1, null), 1);
  assert.equal(turnGapSec(1, 10), 10);
});

test('three calls 20 s apart to a Crawl-delay: 120 host send one request, not three', async () => {
  // The incident: an agent called inspect-page for shopgoodwill.com three times,
  // about 20 s apart, and each call fetched the page.
  const f = fakeHosts();
  const gap = turnGapSec(5, 120);
  const first = await awaitTurn(f.turn, 'shopgoodwill.com', gap, { sleep: f.sleep });
  f.advance(20_000);
  const second = await awaitTurn(f.turn, 'shopgoodwill.com', gap, { sleep: f.sleep });
  f.advance(20_000);
  const third = await awaitTurn(f.turn, 'shopgoodwill.com', gap, { sleep: f.sleep });

  assert.deepEqual([first.granted, second.granted, third.granted], [true, false, false]);
  // Refused outright, without sleeping: the wait is longer than 20 s.
  assert.equal(second.retryAfterSec, 100);
  assert.equal(third.retryAfterSec, 80);
  assert.equal(second.waitedMs + third.waitedMs, 0);

  f.advance(80_000);
  assert.equal((await awaitTurn(f.turn, 'shopgoodwill.com', gap, { sleep: f.sleep })).granted, true);
});

test('a wait of up to 20 s is slept, and the turn is then taken and recorded', async () => {
  const f = fakeHosts();
  await awaitTurn(f.turn, 'www.invaluable.com', 10, { sleep: f.sleep }); // robots.txt at t=0
  f.advance(300);
  const page = await awaitTurn(f.turn, 'www.invaluable.com', 10, { sleep: f.sleep });
  assert.equal(page.granted, true);
  assert.equal(page.waitedMs, 9700);
  assert.equal(f.last.get('www.invaluable.com'), 10_000);

  // Exactly 20 s is still waited out; the cap is inclusive.
  const g = fakeHosts();
  await awaitTurn(g.turn, 'h.example', 20, { sleep: g.sleep });
  assert.deepEqual(await awaitTurn(g.turn, 'h.example', 20, { sleep: g.sleep }), { granted: true, waitedMs: 20_000, retryAfterSec: 0 });
});

test('hosts are paced independently', async () => {
  const f = fakeHosts();
  await awaitTurn(f.turn, 'shopgoodwill.com', 120, { sleep: f.sleep });
  const other = await awaitTurn(f.turn, 'www.auctionguide.com', 5, { sleep: f.sleep });
  assert.deepEqual(other, { granted: true, waitedMs: 0, retryAfterSec: 0 });
});

test('the 20 s cap is on the total wait, so a busy host cannot keep a caller looping', async () => {
  const f = fakeHosts();
  await f.turn('busy.example', 15); // another invocation holds the slot
  // Each time our sleep ends, another invocation has just taken the slot again.
  const sleep = async (ms: number) => {
    await f.sleep(ms);
    await f.turn('busy.example', 15);
  };
  const t = await awaitTurn(f.turn, 'busy.example', 15, { sleep });
  assert.equal(t.granted, false);
  assert.equal(t.waitedMs, 15_000); // slept once; a second 15 s would pass 20
  assert.equal(t.retryAfterSec, 15);
});

test('a turn that answers anything but a number fails closed', async () => {
  await assert.rejects(awaitTurn(async () => NaN, 'h.example', 5, { sleep: async () => {} }));
});

test('hostState.turn calls crawl_host_turn and never reads a bad answer as "go ahead"', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const answering = (data: unknown, error: { message: string } | null = null): Rpc => async (fn, args) => {
    calls.push([fn, args]);
    return { data, error };
  };
  assert.equal(await hostState(answering(4.25)).turn('shopgoodwill.com', 120), 4.25);
  assert.deepEqual(calls[0], ['crawl_host_turn', { p_host: 'shopgoodwill.com', p_gap_sec: 120 }]);
  assert.equal(await hostState(answering(0)).turn('h.example', 5), 0);
  assert.equal(await hostState(answering('2.500000')).turn('h.example', 5), 2.5);
  for (const bad of [null, undefined, '', 'soon', {}, []]) {
    await assert.rejects(hostState(answering(bad)).turn('h.example', 5), undefined, `answer ${JSON.stringify(bad)}`);
  }
  await assert.rejects(
    hostState(answering(null, { message: 'permission denied for function crawl_host_turn' })).turn('h.example', 5),
    /permission denied/,
  );
});

test('hostState.robots maps the cached row, and no row to null', async () => {
  const body = 'User-agent: *\nCrawl-delay: 120\n';
  const rpc: Rpc = async (fn, args) => {
    assert.equal(fn, 'crawl_host_robots');
    const rows = args.p_host === 'shopgoodwill.com' ? [{ robots_status: 200, robots_body: body, age_sec: 61.5 }] : [];
    return { data: rows, error: null };
  };
  assert.deepEqual(await hostState(rpc).robots('shopgoodwill.com'), { status: 200, body, ageSec: 61.5 });
  assert.equal(await hostState(rpc).robots('www.example.com'), null);

  // A malformed row reads as expired and unreachable, so it is fetched again.
  const odd = await hostState(async () => ({ data: [{ robots_status: null, robots_body: null, age_sec: null }], error: null }))
    .robots('h.example');
  assert.ok(odd);
  assert.equal(odd.body, '');
  assert.equal(odd.ageSec < 3600, false);
  assert.equal(crawlDelayOf(odd.status, odd.body, T), null);

  await assert.rejects(hostState(async () => ({ data: null, error: { message: 'boom' } })).robots('h.example'), /boom/);
});

test('hostState.storeRobots calls crawl_host_store_robots and surfaces errors', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const ok: Rpc = async (fn, args) => {
    calls.push([fn, args]);
    return { data: null, error: null };
  };
  await hostState(ok).storeRobots('www.auctionguide.com', 200, 'User-agent: *\n');
  assert.deepEqual(calls, [['crawl_host_store_robots', { p_host: 'www.auctionguide.com', p_status: 200, p_body: 'User-agent: *\n' }]]);
  await assert.rejects(
    hostState(async () => ({ data: null, error: { message: 'boom' } })).storeRobots('h.example', 200, ''),
    /boom/,
  );
});

test('only definitive robots.txt answers are cached; bot-manager and unreachable ones are fetched again', () => {
  assert.equal(isCacheableRobots(200, { 'content-type': 'text/plain' }, 'User-agent: *\nDisallow:\n'), true);
  assert.equal(isCacheableRobots(404, {}, '<h1>Not Found</h1>'), true); // no robots.txt: crawl freely
  assert.equal(isCacheableRobots(403, { server: 'awselb/2.0' }, ''), true); // a plain 4xx, as k-bid.com answers

  // Akamai, as govdeals.com answered on 2026-09-30: recognisable by its server header alone.
  const body = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1></BODY></HTML>';
  assert.equal(isCacheableRobots(403, { server: 'AkamaiGHost' }, body), false);
  // Why: stored without its headers, the same answer would read as "no robots.txt".
  assert.equal(detectBlock(403, {}, body).blockedBy, null);

  assert.equal(isCacheableRobots(403, { 'cf-mitigated': 'challenge', server: 'cloudflare' }, ''), false);
  for (const status of [0, 429, 500, 503]) {
    assert.equal(isCacheableRobots(status, {}, ''), false, `HTTP ${status}`);
  }
});

test('a cached robots.txt gives the probe the same verdict as a fetched one, about the same host', () => {
  const url = 'https://bid.hansenauctiongroup.com/robots.txt';
  const body = 'User-agent: *\nDisallow: /docs\nDisallow: /accounts\n';
  const page = (target: ProbeObservation['target'], u: string): ProbeObservation => ({
    target, url: u, status: 200, finalUrl: u, headers: { 'content-type': 'text/html' },
    body: '<html><head><title>Hansen Auction Group</title></head></html>', bytes: 60, latencyMs: 90, error: null,
  });
  const pages = [page('home', 'https://www.hansenauctiongroup.com'), page('listing', 'https://bid.hansenauctiongroup.com/')];
  const fetched: ProbeObservation = {
    target: 'robots', url, status: 200, finalUrl: url, headers: { 'content-type': 'text/plain', server: 'nginx' },
    body, bytes: body.length, latencyMs: 80, error: null,
  };
  const cached = cachedRobotsObservation(url, 200, body);
  assert.equal(cached.url, url);
  assert.equal(cached.latencyMs, 0);
  assert.deepEqual(cached.headers, {});

  const a = concludeProbe('https://www.hansenauctiongroup.com', T, [fetched, ...pages]);
  const b = concludeProbe('https://www.hansenauctiongroup.com', T, [cached, ...pages]);
  assert.equal(b.accessStatus, 'open');
  assert.equal(b.accessStatus, a.accessStatus);
  assert.equal(b.robotsAllows, a.robotsAllows);
  assert.equal(b.note, a.note); // judged on bid.hansenauctiongroup.com, the robots host
  assert.equal(b.rows[0].robots_verdict, 'allowed');

  // The cached row still carries the Crawl-delay.
  const sg = concludeProbe('https://shopgoodwill.com', T, [
    cachedRobotsObservation('https://shopgoodwill.com/robots.txt', 200, 'User-agent: *\nCrawl-delay: 120\n'),
  ]);
  assert.equal(sg.rows[0].crawl_delay_s, 120);

  // bytes counts UTF-8, as a fetch does.
  assert.equal(cachedRobotsObservation(url, 200, '# caf\xe9\n').bytes, 8);
});
