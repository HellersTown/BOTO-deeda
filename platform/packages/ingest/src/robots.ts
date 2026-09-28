/**
 * robots.txt, per RFC 9309 (the Robots Exclusion Protocol, 2022), plus the
 * widely honoured non-standard Crawl-delay.
 *
 * This is the politeness gate for every request the crawler makes, so the rules
 * that decide it are implemented to the letter rather than approximated:
 *
 *   - Group selection: the group(s) whose user-agent matches our product token,
 *     case-insensitively. Several matching groups are COMBINED (RFC 9309 §2.2.1).
 *     Only if none match does the `*` group apply. No group at all: allow.
 *   - Rule selection: the MOST SPECIFIC match wins, measured in octets of the
 *     pattern. On a tie between allow and disallow, allow wins (§2.2.2).
 *   - `*` matches any sequence and `$` anchors the end (§2.2.3).
 *   - `/robots.txt` itself is always allowed.
 *   - An empty `Disallow:` disallows nothing.
 *
 * What an HTTP status on robots.txt MEANS is decided by the caller (see
 * robotsVerdictFromStatus): 4xx means "no rules, crawl freely"; 5xx, 429 and
 * network errors mean "unreachable, assume complete disallow" (§2.3.1.3–4).
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec: number | null;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** Parse robots.txt text. Never throws: malformed lines are ignored, as the RFC requires. */
export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  // True while we are still reading the user-agent lines that open a group.
  let inAgentRun = false;

  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      if (!current || !inAgentRun) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value);
      inAgentRun = true;
      continue;
    }

    if (key === 'sitemap') {
      // Sitemaps are global, not group members.
      if (value) sitemaps.push(value);
      continue;
    }

    // Any other line ends the run of user-agent lines.
    inAgentRun = false;
    if (!current) continue; // rules before any user-agent line are ignored

    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "nothing is disallowed": it is not a rule.
      if (!value) continue;
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }

  return { groups, sitemaps };
}

/** The product token part of a user-agent line: "Googlebot/2.1 (+...)" -> "googlebot". */
function tokenOf(agent: string): string {
  return agent.split(/[\/\s]/)[0].toLowerCase();
}

/** The group that governs `token`, with multiple matching groups combined. */
export function groupFor(parsed: ParsedRobots, token: string): RobotsGroup | null {
  const want = token.toLowerCase();
  const specific = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && tokenOf(a) === want));
  const chosen = specific.length
    ? specific
    : parsed.groups.filter((g) => g.agents.some((a) => a.trim() === '*'));
  if (!chosen.length) return null;

  const delays = chosen.map((g) => g.crawlDelaySec).filter((d): d is number => d !== null);
  return {
    agents: chosen.flatMap((g) => g.agents),
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySec: delays.length ? Math.max(...delays) : null,
  };
}

/** Does a robots pattern match this path? `*` is any sequence, `$` anchors the end. */
export function patternMatches(pattern: string, path: string): boolean {
  let p = pattern;
  let anchored = false;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  // Escape regex metacharacters except *, then turn * into .*
  const re = '^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    + (anchored ? '$' : '');
  try {
    return new RegExp(re).test(path);
  } catch {
    return false;
  }
}

/**
 * May `token` fetch `pathAndQuery`?
 *
 * pathAndQuery is the URL path plus query string (e.g. "/search?q=drone"),
 * which is what RFC 9309 says rules are matched against.
 */
export function isAllowed(parsed: ParsedRobots, token: string, pathAndQuery: string): boolean {
  const path = pathAndQuery || '/';
  if (path === '/robots.txt') return true;
  const group = groupFor(parsed, token);
  if (!group) return true;

  let best: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      // Tie: the least restrictive rule wins.
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

export type RobotsVerdict = 'rules' | 'absent' | 'unreachable';

/**
 * What an HTTP status on /robots.txt means (RFC 9309 §2.3.1).
 *
 *   2xx           -> 'rules'        parse and obey
 *   4xx (not 429) -> 'absent'       no rules: crawling is permitted
 *   429, 5xx, 0   -> 'unreachable'  assume COMPLETE disallow until it recovers
 *
 * A 403 served by a bot manager is NOT 'absent' in any practical sense: it means
 * the site is refusing us. Callers must run the block detector first and treat a
 * detected block as a block, whatever this function says.
 */
export function robotsVerdictFromStatus(status: number): RobotsVerdict {
  if (status >= 200 && status < 300) return 'rules';
  if (status === 429) return 'unreachable';
  if (status >= 400 && status < 500) return 'absent';
  return 'unreachable';
}
