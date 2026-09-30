/**
 * Close times and other dates, rendered honestly.
 *
 * The one rule that matters: when a source publishes only a close DATE (GSA,
 * lots.raw->'_meta'->>'closeTimePrecise' = 'false'), closes_at is the end of
 * that day in the auction's zone, and the real close can be hours earlier. For
 * those lots there is never a countdown and never a time of day: only
 * "Closes <date> · time not published", in the amber notice style.
 *
 * Every function takes `now` (and optionally the viewer's zone) so tests can pin
 * them; nothing here reads the clock.
 */
import type { ClosePrecision } from '../data/lotSummary';

/** 0013 states a date-only GSA close in America/New_York when the auction row has no zone. */
export const DATE_ONLY_DEFAULT_ZONE = 'America/New_York';

export type CloseTone = 'notice' | 'urgent' | 'normal' | 'muted';

export interface CloseInput {
  readonly closesAt: string | null;
  readonly precision: ClosePrecision;
  /** The auction's IANA zone. */
  readonly timeZone: string | null;
  readonly closed?: boolean;
}

export interface CloseLabel {
  /** Card text: "Closes Oct 2 · time not published", "Closes in 2h 14m", "Closes Tue, Oct 7, 6:00 PM". */
  readonly text: string;
  readonly tone: CloseTone;
  /** True only when the text counts down to a precise close. */
  readonly countdown: boolean;
  /** For <time dateTime>: an instant for precise closes, a plain date for date-only ones. */
  readonly dateTime: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeZone(zone: string | null | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch {
    return undefined;
  }
}

function fmt(date: Date, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: safeZone(timeZone) }).format(date);
}

/** Year, month and day of an instant as seen in a zone. */
export function zonedDate(date: Date, timeZone?: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone(timeZone),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** "2026-10-02": the calendar date of an instant in a zone. */
export function isoDateIn(date: Date, timeZone?: string): string {
  const { year, month, day } = zonedDate(date, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The instant a wall-clock time in `timeZone` happens (DST-correct for real wall times). */
export function zonedWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(instant));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - instant;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  return new Date(guess);
}

/** "2d 3h", "5h 12m", "42m", "under a minute". */
export function formatCountdown(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** The zone a date-only close date is stated in. */
function dateOnlyZone(input: CloseInput): string {
  return safeZone(input.timeZone) ?? DATE_ONLY_DEFAULT_ZONE;
}

/** Card label for a close time. */
export function describeClose(input: CloseInput, now: Date, viewerTimeZone?: string): CloseLabel {
  const at = valid(input.closesAt);
  if (input.closed) return { text: 'Closed', tone: 'muted', countdown: false, dateTime: null };
  if (!at) return { text: 'Close time not listed', tone: 'muted', countdown: false, dateTime: null };

  if (input.precision === 'date_only') {
    const zone = dateOnlyZone(input);
    const date = fmt(at, { month: 'short', day: 'numeric' }, zone);
    const dateTime = isoDateIn(at, zone);
    if (at.getTime() <= now.getTime()) {
      return { text: `Close date ${date} has passed`, tone: 'muted', countdown: false, dateTime };
    }
    return { text: `Closes ${date} · time not published`, tone: 'notice', countdown: false, dateTime };
  }

  if (input.precision === 'unknown') {
    // The precision lookup failed: the date is safe to show, a time or a countdown is not.
    const date = fmt(at, { month: 'short', day: 'numeric' }, viewerTimeZone);
    return { text: `Closes ${date}`, tone: 'normal', countdown: false, dateTime: at.toISOString() };
  }

  const left = at.getTime() - now.getTime();
  if (left <= 0) return { text: 'Close time has passed', tone: 'muted', countdown: false, dateTime: at.toISOString() };
  if (left < DAY) {
    return { text: `Closes in ${formatCountdown(left)}`, tone: left < HOUR ? 'urgent' : 'normal', countdown: true, dateTime: at.toISOString() };
  }
  const when = fmt(at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, viewerTimeZone);
  return { text: `Closes ${when}`, tone: 'normal', countdown: false, dateTime: at.toISOString() };
}

/** "2026-10-03" for "2026-10-02": the next calendar date, whatever the clocks do overnight. */
function nextIsoDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Card label for a sale's close (0023): the time of day in the viewer's zone,
 * never a countdown. "Closes today, 7:00 PM", "Closes tomorrow, 10:00 AM",
 * "Closes Fri, Oct 2, 6:00 PM". A date-only or unknown close has no time to
 * state, so it reads exactly as describeClose has it.
 */
export function describeCloseLocal(input: CloseInput, now: Date, viewerTimeZone?: string): CloseLabel {
  const at = valid(input.closesAt);
  if (input.closed || !at || input.precision !== 'precise') return describeClose(input, now, viewerTimeZone);
  const left = at.getTime() - now.getTime();
  if (left <= 0) return { text: 'Close time has passed', tone: 'muted', countdown: false, dateTime: at.toISOString() };
  const day = isoDateIn(at, viewerTimeZone);
  const today = isoDateIn(now, viewerTimeZone);
  const time = fmt(at, { hour: 'numeric', minute: '2-digit' }, viewerTimeZone);
  const when =
    day === today
      ? `today, ${time}`
      : day === nextIsoDate(today)
        ? `tomorrow, ${time}`
        : fmt(at, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, viewerTimeZone);
  return { text: `Closes ${when}`, tone: left < HOUR ? 'urgent' : 'normal', countdown: false, dateTime: at.toISOString() };
}

export interface CloseSentence {
  /** "Closes Thursday, Oct 2." / "Closes Thursday, Oct 2 at 6:00 PM CDT." */
  readonly headline: string;
  /** "in 2d 3h" for a precise close within a week; null otherwise. */
  readonly countdown: string | null;
  readonly tone: CloseTone;
  readonly precise: boolean;
}

/** The lot page's closing-time section. */
export function describeCloseLong(input: CloseInput, now: Date, viewerTimeZone?: string): CloseSentence {
  const at = valid(input.closesAt);
  if (input.closed) return { headline: 'This lot has closed.', countdown: null, tone: 'muted', precise: false };
  if (!at) return { headline: 'The source did not list a close time.', countdown: null, tone: 'muted', precise: false };
  if (input.precision !== 'precise') {
    const zone = input.precision === 'date_only' ? dateOnlyZone(input) : viewerTimeZone;
    const date = fmt(at, { weekday: 'long', month: 'short', day: 'numeric' }, zone);
    const passed = at.getTime() <= now.getTime();
    return {
      headline: passed ? `The close date, ${date}, has passed.` : `Closes ${date}.`,
      countdown: null,
      tone: input.precision === 'date_only' && !passed ? 'notice' : 'muted',
      precise: false,
    };
  }
  const left = at.getTime() - now.getTime();
  const when = fmt(at, { weekday: 'long', month: 'short', day: 'numeric' }, viewerTimeZone);
  const time = fmt(at, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, viewerTimeZone);
  if (left <= 0) return { headline: `Its close time, ${when} at ${time}, has passed.`, countdown: null, tone: 'muted', precise: true };
  return {
    headline: `Closes ${when} at ${time}.`,
    countdown: left < 7 * DAY ? `in ${formatCountdown(left)}` : null,
    tone: left < HOUR ? 'urgent' : 'normal',
    precise: true,
  };
}

/**
 * When 0013's queue_watch_alerts reminds about a watched lot: 08:00 on the close
 * date in the auction's zone for a date-only close, otherwise
 * remind_seconds_before (default 600) ahead of the close.
 */
export function reminderInstant(input: {
  readonly closesAt: string | null;
  readonly precise: boolean;
  readonly timeZone: string | null;
  readonly remindSecondsBefore: number | null;
}): Date | null {
  const at = valid(input.closesAt);
  if (!at) return null;
  if (!input.precise) {
    const zone = safeZone(input.timeZone) ?? DATE_ONLY_DEFAULT_ZONE;
    const { year, month, day } = zonedDate(at, zone);
    return zonedWallTimeToInstant(year, month, day, 8, 0, zone);
  }
  return new Date(at.getTime() - (input.remindSecondsBefore ?? 600) * 1000);
}

/**
 * When the lot page says the reminder comes: "Oct 2, 5:50 PM, 10 minutes
 * before it closes", or "8:00 AM EDT that morning" for a date-only close, in
 * the auction's zone. Null when there is no close to remind before.
 */
export function reminderWords(input: {
  readonly closesAt: string | null;
  readonly precise: boolean;
  readonly timeZone: string | null;
  readonly remindSecondsBefore: number;
}): string | null {
  const reminder = reminderInstant(input);
  if (!reminder) return null;
  return input.precise
    ? `${formatShortDateTime(reminder)}, ${Math.round(input.remindSecondsBefore / 60)} minutes before it closes`
    : `${formatTimeIn(reminder, input.timeZone ?? DATE_ONLY_DEFAULT_ZONE)} that morning`;
}

/** "Oct 2, 8:00 AM" in the viewer's zone. */
export function formatShortDateTime(date: Date, viewerTimeZone?: string): string {
  return fmt(date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, viewerTimeZone);
}

/** "8:00 AM CDT" in a zone. */
export function formatTimeIn(date: Date, timeZone: string): string {
  return fmt(date, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, timeZone);
}

/** Alert timestamps: "Just now", "12 min ago", "8:00 AM", "Yesterday", "Mon", "Sep 29", "Sep 29, 2025". */
export function formatRelativeTime(iso: string, now: Date, viewerTimeZone?: string): string {
  const at = valid(iso);
  if (!at) return '';
  const diff = now.getTime() - at.getTime();
  if (diff < 60_000 && diff > -60_000) return 'Just now';
  if (diff > 0 && diff < HOUR) return `${Math.floor(diff / 60_000)} min ago`;
  const today = isoDateIn(now, viewerTimeZone);
  const that = isoDateIn(at, viewerTimeZone);
  if (that === today) return fmt(at, { hour: 'numeric', minute: '2-digit' }, viewerTimeZone);
  const yesterday = isoDateIn(new Date(now.getTime() - DAY), viewerTimeZone);
  if (that === yesterday) return 'Yesterday';
  if (diff > 0 && diff < 6 * DAY) return fmt(at, { weekday: 'short' }, viewerTimeZone);
  const sameYear = zonedDate(at, viewerTimeZone).year === zonedDate(now, viewerTimeZone).year;
  return fmt(at, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }, viewerTimeZone);
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "on Sep 29". */
export function formatAgo(iso: string | null, now: Date, viewerTimeZone?: string): string | null {
  const at = valid(iso);
  if (!at) return null;
  const diff = Math.max(0, now.getTime() - at.getTime());
  if (diff < 60_000) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (isoDateIn(at, viewerTimeZone) === isoDateIn(new Date(now.getTime() - DAY), viewerTimeZone)) return 'yesterday';
  return `on ${fmt(at, { month: 'short', day: 'numeric' }, viewerTimeZone)}`;
}

/** "within the hour", "within a minute", "within 30 seconds": tier_limits.alert_latency_seconds in words. */
export function latencyWords(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'as soon as it is found';
  if (seconds >= 3600 && seconds % 3600 === 0) return seconds === 3600 ? 'within the hour' : `within ${seconds / 3600} hours`;
  if (seconds >= 60 && seconds % 60 === 0) return seconds === 60 ? 'within a minute' : `within ${seconds / 60} minutes`;
  return `within ${seconds} seconds`;
}

/** "every hour", "every minute", "every 30 seconds": how often a hunt is re-checked on a plan. */
export function cadenceWords(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'regularly';
  if (seconds >= 3600 && seconds % 3600 === 0) return seconds === 3600 ? 'every hour' : `every ${seconds / 3600} hours`;
  if (seconds >= 60 && seconds % 60 === 0) return seconds === 60 ? 'every minute' : `every ${seconds / 60} minutes`;
  return `every ${seconds} seconds`;
}
