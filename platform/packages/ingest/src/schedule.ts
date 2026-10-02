/**
 * The adaptive scheduler.
 *
 * This is the piece that makes "monitors 24/7" affordable and well-behaved at the
 * same time, and it is one short function.
 *
 * Uniform polling is the mistake. Poll everything every five minutes and you are
 * simultaneously (a) hammering small auctioneers' servers, (b) getting yourself
 * rate-limited or IP-banned, and (c) STILL stale on the only lots that matter,
 * because a lot closing in ninety seconds changes faster than any uniform
 * interval you can afford.
 *
 * The fix: crawl budget follows closing time. A lot closing in eight minutes gets
 * polled every thirty seconds. A lot closing in nine days gets polled daily. The
 * request volume collapses, and the freshness goes UP precisely where freshness is
 * the entire product.
 *
 * Pleasant side effect: this is also what a polite crawler looks like from the far
 * end. The interests align, which is usually the sign of a correct design.
 */

/** Ladder rungs, longest-lived first. `maxSecondsToClose` of null is the catch-all. */
const LADDER: { maxSecondsToClose: number | null; intervalSeconds: number; label: string }[] = [
  { maxSecondsToClose: 10 * 60, intervalSeconds: 30, label: 'snipe-window' },
  { maxSecondsToClose: 60 * 60, intervalSeconds: 120, label: 'live' },
  { maxSecondsToClose: 6 * 3600, intervalSeconds: 900, label: 'today' },
  { maxSecondsToClose: 48 * 3600, intervalSeconds: 3600, label: 'soon' },
  { maxSecondsToClose: 14 * 86400, intervalSeconds: 6 * 3600, label: 'this-fortnight' },
  { maxSecondsToClose: null, intervalSeconds: 86400, label: 'distant' },
];

export interface PollDecision {
  /** Seconds to wait between polls of this lot. */
  intervalSeconds: number;
  /** Which rung matched, for logging and for explaining crawl volume. */
  label: string;
  /** True when this lot should be polled right now. */
  due: boolean;
  /** Why not, when it is not due. */
  reason?: string;
}

export interface PollInput {
  closesAt: Date | string | null | undefined;
  lastPolledAt?: Date | string | null;
  closed?: boolean;
  now?: Date;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decide whether and how often to poll a single lot.
 *
 * A closed lot is polled exactly once more, to capture the final hammer price —
 * that record is what makes future price comparison and the sleeper score's
 * "below comparable sold price" component possible at all. Skipping it throws away
 * the only ground truth the system ever gets.
 */
export function decidePoll(input: PollInput): PollDecision {
  const now = input.now ?? new Date();
  const closesAt = toDate(input.closesAt);
  const lastPolled = toDate(input.lastPolledAt);

  // Already closed AND already recorded: never poll again.
  if (input.closed && lastPolled && closesAt && lastPolled > closesAt) {
    return {
      intervalSeconds: Number.POSITIVE_INFINITY,
      label: 'settled',
      due: false,
      reason: 'closed and final price already captured',
    };
  }

  // Closed but not yet re-read since closing: poll once, now, for the final price.
  if (closesAt && closesAt <= now) {
    const needsFinal = !lastPolled || lastPolled <= closesAt;
    return {
      intervalSeconds: Number.POSITIVE_INFINITY,
      label: 'final-price-capture',
      due: needsFinal,
      reason: needsFinal ? undefined : 'final price already captured',
    };
  }

  // No close time known. Treat conservatively rather than aggressively: an unknown
  // close time usually means a listing page we have not fully parsed, and pounding
  // it will not fix the parser.
  const secondsToClose = closesAt
    ? Math.max(0, Math.floor((closesAt.getTime() - now.getTime()) / 1000))
    : null;

  const rung =
    secondsToClose === null
      ? LADDER[LADDER.length - 1]
      : LADDER.find((r) => r.maxSecondsToClose === null || secondsToClose <= r.maxSecondsToClose)!;

  if (!lastPolled) {
    return { intervalSeconds: rung.intervalSeconds, label: rung.label, due: true };
  }

  const elapsed = (now.getTime() - lastPolled.getTime()) / 1000;
  const due = elapsed >= rung.intervalSeconds;
  return {
    intervalSeconds: rung.intervalSeconds,
    label: rung.label,
    due,
    reason: due ? undefined : `polled ${Math.round(elapsed)}s ago, interval ${rung.intervalSeconds}s`,
  };
}

/**
 * Exponential backoff for a source that is failing.
 *
 * Deliberately generous, because most of the interesting sources are small
 * auction houses running modest hosting. If their site is struggling, the correct
 * response is to back away, not to retry harder. Capped at six hours so a source
 * that recovers is picked up the same day.
 */
export function backoffMinutes(consecutiveFailures: number, baseCadenceMin: number): number {
  if (consecutiveFailures <= 0) return baseCadenceMin;
  const factor = Math.min(2 ** consecutiveFailures, 64);
  return Math.min(baseCadenceMin * factor, 360);
}

/**
 * Estimate daily request volume for a set of lots. Worth having in code rather
 * than on a whiteboard: it is the number that decides whether a source's rate
 * limit is survivable before you find out in production.
 */
export function estimateDailyRequests(
  lots: { closesAt: Date | string | null }[],
  now = new Date(),
): { total: number; byLabel: Record<string, { lots: number; requests: number }> } {
  const byLabel: Record<string, { lots: number; requests: number }> = {};
  let total = 0;

  for (const lot of lots) {
    const d = decidePoll({ closesAt: lot.closesAt, now });
    if (!Number.isFinite(d.intervalSeconds)) continue;

    // A lot only sits on a given rung until it drops to the next one, so counting
    // a full day at the snipe-window rate would wildly overstate volume. Bound the
    // window by whichever is shorter: a day, or the time left until it closes.
    const closesAt = toDate(lot.closesAt);
    const secondsRemaining = closesAt
      ? Math.max(0, (closesAt.getTime() - now.getTime()) / 1000)
      : 86400;
    const window = Math.min(86400, secondsRemaining);
    const requests = Math.ceil(window / d.intervalSeconds);

    byLabel[d.label] ??= { lots: 0, requests: 0 };
    byLabel[d.label].lots += 1;
    byLabel[d.label].requests += requests;
    total += requests;
  }

  return { total, byLabel };
}
