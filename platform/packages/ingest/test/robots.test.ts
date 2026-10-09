import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRobots,
  isAllowed,
  groupFor,
  patternMatches,
  robotsVerdictFromStatus,
} from '../src/robots.ts';

const T = 'WaystockBot';
const allowed = (txt: string, path: string, token = T) => isAllowed(parseRobots(txt), token, path);

test('most specific rule wins, measured in pattern length (RFC 9309 2.2.2)', () => {
  const txt = 'User-agent: *\nDisallow: /\nAllow: /auctions\n';
  assert.equal(allowed(txt, '/auctions/123'), true);  // /auctions (9) beats / (1)
  assert.equal(allowed(txt, '/account'), false);
  assert.equal(allowed(txt, '/'), false);
});

test('an allow/disallow tie resolves to allow, the least restrictive', () => {
  const txt = 'User-agent: *\nDisallow: /folder\nAllow: /folder\n';
  assert.equal(allowed(txt, '/folder/page'), true);
});

test('* matches any sequence and $ anchors the end', () => {
  const txt = 'User-agent: *\nDisallow: /*.php$\nDisallow: /fish*\n';
  assert.equal(allowed(txt, '/index.php'), false);
  assert.equal(allowed(txt, '/index.php?x=1'), true);   // $ anchors: query breaks the match
  assert.equal(allowed(txt, '/filename.php5'), true);
  assert.equal(allowed(txt, '/fishheads/yummy.html'), false);
  assert.equal(allowed(txt, '/Fish.asp'), true);         // paths are case-sensitive
  assert.equal(patternMatches('/a.b', '/aXb'), false);   // "." is literal, not regex
});

test('a group naming our token overrides the * group', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: WaystockBot\nAllow: /\n';
  assert.equal(allowed(txt, '/anything'), true);
  assert.equal(allowed(txt, '/anything', 'OtherBot'), false);
});

test('user-agent matching is case-insensitive and ignores version suffixes', () => {
  assert.equal(allowed('User-agent: waystockbot\nDisallow: /x\n', '/x/1'), false);
  assert.equal(allowed('User-agent: WaystockBot/1.0\nDisallow: /x\n', '/x/1'), false);
  // A different bot that merely CONTAINS our name is not us.
  assert.equal(allowed('User-agent: NotWaystockBot\nDisallow: /\n', '/x'), true);
});

test('several groups for the same token are combined, not first-wins', () => {
  const txt = 'User-agent: WaystockBot\nDisallow: /a\n\nUser-agent: WaystockBot\nDisallow: /b\n';
  assert.equal(allowed(txt, '/a/1'), false);
  assert.equal(allowed(txt, '/b/1'), false);
  assert.equal(allowed(txt, '/c/1'), true);
});

test('consecutive user-agent lines share one group', () => {
  const txt = 'User-agent: Googlebot\nUser-agent: WaystockBot\nDisallow: /private\n';
  assert.equal(allowed(txt, '/private/x'), false);
  assert.equal(allowed(txt, '/public'), true);
});

test('an empty Disallow allows everything; no groups allows everything', () => {
  assert.equal(allowed('User-agent: *\nDisallow:\n', '/anything'), true);
  assert.equal(allowed('# nothing here\n', '/anything'), true);
  assert.equal(allowed('', '/anything'), true);
});

test('/robots.txt itself is always allowed', () => {
  assert.equal(allowed('User-agent: *\nDisallow: /\n', '/robots.txt'), true);
});

test('rules before any user-agent line are ignored', () => {
  assert.equal(allowed('Disallow: /\nUser-agent: *\nAllow: /\n', '/x'), true);
});

test('comments, CRLF line endings and a BOM are handled', () => {
  const txt = '﻿User-agent: * # everyone\r\nDisallow: /tmp # scratch\r\n';
  assert.equal(allowed(txt, '/tmp/x'), false);
  assert.equal(allowed(txt, '/ok'), true);
});

test('crawl-delay is parsed, and combined groups take the most polite value', () => {
  const p = parseRobots('User-agent: WaystockBot\nCrawl-delay: 5\n\nUser-agent: WaystockBot\nCrawl-delay: 10\n');
  assert.equal(groupFor(p, T)!.crawlDelaySec, 10);
  assert.equal(groupFor(parseRobots('User-agent: *\nCrawl-delay: nope\n'), T)!.crawlDelaySec, null);
});

test('sitemaps are collected globally, even from inside a group', () => {
  const p = parseRobots('Sitemap: https://a.test/s1.xml\nUser-agent: *\nDisallow: /x\nSitemap: https://a.test/s2.xml\n');
  assert.deepEqual(p.sitemaps, ['https://a.test/s1.xml', 'https://a.test/s2.xml']);
});

test('patterns without a leading slash still match (Purple Wave style "*filters=")', () => {
  // Reported Purple Wave rules (docs/08): /auction/*/bids and *filters=.
  const txt = 'User-agent: *\nDisallow: /auction/*/bids\nDisallow: *filters=\n';
  assert.equal(allowed(txt, '/auction/260101/item/123'), true);
  assert.equal(allowed(txt, '/auction/260101/bids'), false);
  assert.equal(allowed(txt, '/search?filters=abc'), false);
  assert.equal(allowed(txt, '/search?search[keyword]=tractor'), true);
});

test('HTTP status on robots.txt maps to RFC 9309 semantics', () => {
  assert.equal(robotsVerdictFromStatus(200), 'rules');
  assert.equal(robotsVerdictFromStatus(404), 'absent');   // no file: crawl permitted
  assert.equal(robotsVerdictFromStatus(403), 'absent');   // 4xx: "unavailable"
  assert.equal(robotsVerdictFromStatus(429), 'unreachable');
  assert.equal(robotsVerdictFromStatus(500), 'unreachable'); // assume complete disallow
  assert.equal(robotsVerdictFromStatus(0), 'unreachable');
});
