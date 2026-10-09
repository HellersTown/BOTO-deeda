import { describe, expect, it } from 'vitest';
import {
  cadenceWords,
  describeClose,
  describeCloseLong,
  formatAgo,
  formatCountdown,
  formatRelativeTime,
  latencyWords,
  reminderInstant,
  zonedWallTimeToInstant,
} from './dates';

const CHICAGO = 'America/Chicago';
// Tue 29 Sep 2026, 12:00 in Chicago (CDT, UTC-5).
const NOW = new Date('2026-09-29T17:00:00Z');
// GSA publishes only the date: ingest resolves Oct 2 to 23:59:59 America/New_York.
const GSA_CLOSE = '2026-10-03T03:59:59+00:00';

describe('close time on cards: date-only (GSA) versus precise', () => {
  it('never counts down to a date-only close, and says the time is not published', () => {
    const label = describeClose({ closesAt: GSA_CLOSE, precision: 'date_only', timeZone: 'America/New_York' }, NOW, CHICAGO);
    expect(label.text).toBe('Closes Oct 2 · time not published');
    expect(label.tone).toBe('notice');
    expect(label.countdown).toBe(false);
    expect(label.dateTime).toBe('2026-10-02');
  });

  it('states the date in the auction zone, not the viewer zone', () => {
    // In Tokyo the same instant is already Oct 3; the close DATE is still Oct 2.
    const label = describeClose({ closesAt: GSA_CLOSE, precision: 'date_only', timeZone: null }, NOW, 'Asia/Tokyo');
    expect(label.text).toBe('Closes Oct 2 · time not published');
  });

  it('counts down to a precise close within a day', () => {
    const label = describeClose(
      { closesAt: '2026-09-29T19:14:00Z', precision: 'precise', timeZone: CHICAGO },
      NOW,
      CHICAGO,
    );
    expect(label.text).toBe('Closes in 2h 14m');
    expect(label.countdown).toBe(true);
    expect(label.tone).toBe('normal');
  });

  it('marks the last hour as urgent', () => {
    const label = describeClose({ closesAt: '2026-09-29T17:42:00Z', precision: 'precise', timeZone: null }, NOW, CHICAGO);
    expect(label.text).toBe('Closes in 42m');
    expect(label.tone).toBe('urgent');
  });

  it('shows day and time for a precise close further out', () => {
    const label = describeClose({ closesAt: '2026-10-06T23:00:00Z', precision: 'precise', timeZone: null }, NOW, CHICAGO);
    expect(label.text).toBe('Closes Tue, Oct 6, 6:00 PM');
    expect(label.countdown).toBe(false);
  });

  it('shows only the date when precision is unknown', () => {
    const label = describeClose({ closesAt: '2026-09-29T19:14:00Z', precision: 'unknown', timeZone: null }, NOW, CHICAGO);
    expect(label.text).toBe('Closes Sep 29');
    expect(label.countdown).toBe(false);
  });

  it('handles closed, past and missing times', () => {
    expect(describeClose({ closesAt: GSA_CLOSE, precision: 'precise', timeZone: null, closed: true }, NOW).text).toBe('Closed');
    expect(describeClose({ closesAt: null, precision: 'precise', timeZone: null }, NOW).text).toBe('Close time not listed');
    expect(describeClose({ closesAt: '2026-09-29T16:00:00Z', precision: 'precise', timeZone: null }, NOW).text).toBe('Close time has passed');
    expect(describeClose({ closesAt: '2026-09-28T03:59:59Z', precision: 'date_only', timeZone: 'America/New_York' }, NOW).text).toBe(
      'Close date Sep 27 has passed',
    );
  });
});

describe('close time on the lot page', () => {
  it('gives the weekday and no countdown for a date-only close', () => {
    const s = describeCloseLong({ closesAt: GSA_CLOSE, precision: 'date_only', timeZone: 'America/New_York' }, NOW, CHICAGO);
    expect(s.headline).toBe('Closes Friday, Oct 2.');
    expect(s.countdown).toBeNull();
    expect(s.tone).toBe('notice');
    expect(s.precise).toBe(false);
  });

  it('gives the time, the zone and a countdown for a precise close', () => {
    const s = describeCloseLong({ closesAt: '2026-10-01T23:00:00Z', precision: 'precise', timeZone: null }, NOW, CHICAGO);
    expect(s.headline).toBe('Closes Thursday, Oct 1 at 6:00 PM CDT.');
    expect(s.countdown).toBe('in 2d 6h');
    expect(s.precise).toBe(true);
  });
});

describe('reminders (what 0013 queue_watch_alerts does)', () => {
  it('reminds at 08:00 on the close date, in the auction zone, for a date-only close', () => {
    const at = reminderInstant({ closesAt: GSA_CLOSE, precise: false, timeZone: 'America/New_York', remindSecondsBefore: 600 });
    expect(at?.toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });

  it('reminds remind_seconds_before ahead of a precise close (default 600)', () => {
    expect(
      reminderInstant({ closesAt: '2026-10-01T23:00:00Z', precise: true, timeZone: null, remindSecondsBefore: null })?.toISOString(),
    ).toBe('2026-10-01T22:50:00.000Z');
    expect(
      reminderInstant({ closesAt: '2026-10-01T23:00:00Z', precise: true, timeZone: null, remindSecondsBefore: 3600 })?.toISOString(),
    ).toBe('2026-10-01T22:00:00.000Z');
  });

  it('converts wall-clock times across daylight-saving changes', () => {
    expect(zonedWallTimeToInstant(2026, 1, 15, 8, 0, CHICAGO).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedWallTimeToInstant(2026, 7, 15, 8, 0, CHICAGO).toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });
});

describe('relative times and words', () => {
  it('formats a countdown', () => {
    expect(formatCountdown(30_000)).toBe('under a minute');
    expect(formatCountdown(42 * 60_000)).toBe('42m');
    expect(formatCountdown((5 * 60 + 12) * 60_000)).toBe('5h 12m');
    expect(formatCountdown((2 * 24 + 3) * 3_600_000)).toBe('2d 3h');
  });

  it('formats alert times the way the design does', () => {
    expect(formatRelativeTime('2026-09-29T16:59:40Z', NOW, CHICAGO)).toBe('Just now');
    expect(formatRelativeTime('2026-09-29T16:48:00Z', NOW, CHICAGO)).toBe('12 min ago');
    expect(formatRelativeTime('2026-09-29T13:00:00Z', NOW, CHICAGO)).toBe('8:00 AM');
    expect(formatRelativeTime('2026-09-28T13:00:00Z', NOW, CHICAGO)).toBe('Yesterday');
    expect(formatRelativeTime('2026-09-26T13:00:00Z', NOW, CHICAGO)).toBe('Sat');
    expect(formatRelativeTime('2026-09-10T13:00:00Z', NOW, CHICAGO)).toBe('Sep 10');
    expect(formatRelativeTime('2025-12-10T13:00:00Z', NOW, CHICAGO)).toBe('Dec 10, 2025');
  });

  it('says how long ago a hunt was checked', () => {
    expect(formatAgo('2026-09-29T16:57:00Z', NOW, CHICAGO)).toBe('3 min ago');
    expect(formatAgo('2026-09-29T14:00:00Z', NOW, CHICAGO)).toBe('3 h ago');
    expect(formatAgo(null, NOW)).toBeNull();
  });

  it('puts tier latency into words', () => {
    expect(latencyWords(3600)).toBe('within the hour');
    expect(latencyWords(60)).toBe('within a minute');
    expect(latencyWords(30)).toBe('within 30 seconds');
    expect(cadenceWords(3600)).toBe('every hour');
    expect(cadenceWords(30)).toBe('every 30 seconds');
  });
});
