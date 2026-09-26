import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePoll, backoffMinutes, estimateDailyRequests } from '../src/schedule.ts';

const NOW = new Date('2026-09-26T18:00:00Z');
const inSeconds = (s: number) => new Date(NOW.getTime() + s * 1000);

test('crawl budget follows closing time', () => {
  assert.equal(decidePoll({ closesAt: inSeconds(300), now: NOW }).intervalSeconds, 30);
  assert.equal(decidePoll({ closesAt: inSeconds(1800), now: NOW }).intervalSeconds, 120);
  assert.equal(decidePoll({ closesAt: inSeconds(3 * 3600), now: NOW }).intervalSeconds, 900);
  assert.equal(decidePoll({ closesAt: inSeconds(24 * 3600), now: NOW }).intervalSeconds, 3600);
  assert.equal(decidePoll({ closesAt: inSeconds(7 * 86400), now: NOW }).intervalSeconds, 6 * 3600);
  assert.equal(decidePoll({ closesAt: inSeconds(60 * 86400), now: NOW }).intervalSeconds, 86400);
});

test('rung labels are stable, since crawl volume is explained by them', () => {
  assert.equal(decidePoll({ closesAt: inSeconds(120), now: NOW }).label, 'snipe-window');
  assert.equal(decidePoll({ closesAt: inSeconds(90 * 86400), now: NOW }).label, 'distant');
});

test('a never-polled lot is immediately due', () => {
  const d = decidePoll({ closesAt: inSeconds(3600), now: NOW });
  assert.equal(d.due, true);
});

test('a recently-polled lot is not due, and says why', () => {
  const d = decidePoll({
    closesAt: inSeconds(1800),          // 'live' rung -> 120s interval
    lastPolledAt: inSeconds(-30),       // polled 30s ago
    now: NOW,
  });
  assert.equal(d.due, false);
  assert.match(d.reason!, /polled 30s ago, interval 120s/);
});

test('a stale lot becomes due exactly at the interval boundary', () => {
  const justUnder = decidePoll({
    closesAt: inSeconds(1800),
    lastPolledAt: inSeconds(-119),
    now: NOW,
  });
  const justOver = decidePoll({
    closesAt: inSeconds(1800),
    lastPolledAt: inSeconds(-120),
    now: NOW,
  });
  assert.equal(justUnder.due, false);
  assert.equal(justOver.due, true);
});

test('a closed lot is polled once more to capture the final hammer price', () => {
  // This record is the only ground truth the system ever gets about real value,
  // so skipping it would break price comparison permanently.
  const needsFinal = decidePoll({
    closesAt: inSeconds(-600),
    lastPolledAt: inSeconds(-900),   // last read BEFORE it closed
    now: NOW,
  });
  assert.equal(needsFinal.due, true);
  assert.equal(needsFinal.label, 'final-price-capture');
});

test('...and then never polled again', () => {
  const settled = decidePoll({
    closesAt: inSeconds(-600),
    lastPolledAt: inSeconds(-300),   // already read AFTER it closed
    now: NOW,
  });
  assert.equal(settled.due, false);

  const flagged = decidePoll({
    closed: true,
    closesAt: inSeconds(-600),
    lastPolledAt: inSeconds(-300),
    now: NOW,
  });
  assert.equal(flagged.due, false);
  assert.equal(flagged.label, 'settled');
  assert.equal(flagged.intervalSeconds, Number.POSITIVE_INFINITY);
});

test('an unknown close time is treated conservatively, not aggressively', () => {
  // Pounding a source will not fix a parser that failed to find the close time.
  const d = decidePoll({ closesAt: null, now: NOW });
  assert.equal(d.intervalSeconds, 86400);
});

test('backoff is generous, because most sources are small auction houses', () => {
  assert.equal(backoffMinutes(0, 60), 60);
  assert.equal(backoffMinutes(1, 60), 120);
  assert.equal(backoffMinutes(2, 60), 240);
  assert.equal(backoffMinutes(3, 60), 360);
  // Capped at six hours so a recovered source is picked up the same day.
  assert.equal(backoffMinutes(10, 60), 360);
  assert.equal(backoffMinutes(10, 5), 320);
});

test('the adaptive ladder is what makes 24/7 monitoring affordable', () => {
  // A realistic mix: a few closing imminently, most sitting days out.
  const lots = [
    ...Array.from({ length: 20 }, () => ({ closesAt: inSeconds(300).toISOString() })),
    ...Array.from({ length: 200 }, () => ({ closesAt: inSeconds(30 * 3600).toISOString() })),
    ...Array.from({ length: 5000 }, () => ({ closesAt: inSeconds(9 * 86400).toISOString() })),
  ];

  const adaptive = estimateDailyRequests(lots, NOW);

  // Uniform 5-minute polling over the same 5,220 lots, for comparison.
  const uniform = lots.length * (86400 / 300);

  assert.ok(
    adaptive.total < uniform / 10,
    `adaptive (${adaptive.total}) should be an order of magnitude below uniform (${uniform})`,
  );

  // The imminent lots are polled hard; that is the point, not a bug.
  assert.equal(adaptive.byLabel['snipe-window'].lots, 20);
  assert.equal(adaptive.byLabel['this-fortnight'].lots, 5000);

  // And the snipe window is bounded by time-to-close, not by a full day, so 20
  // lots closing in 5 minutes cost 20 x 10 requests, not 20 x 2,880.
  assert.equal(adaptive.byLabel['snipe-window'].requests, 200);
});
