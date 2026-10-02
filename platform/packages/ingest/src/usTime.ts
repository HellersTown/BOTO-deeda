/**
 * US state time zones, and local wall-clock times as ISO-8601 with an offset.
 *
 * Sources give times like "Oct 28, 2026 12:00 PM" with no zone: the sale's own
 * local time. The only honest reading is the zone of the state the sale is in,
 * and for a state that spans zones that zone is a guess about most of it, so
 * `exact` says whether the time can be trusted to the minute.
 *
 * The same table and conversion live in the AuctionGuide adapter, which came
 * first; this module is the shared copy for adapters that load without it.
 */

export interface UsZone {
  /** IANA zone most of the state keeps. */
  zone: string;
  /** False when the state spans zones and `zone` is only the one most of it keeps. */
  exact: boolean;
}

const z = (zone: string, exact = true): UsZone => ({ zone, exact });

export const US_ZONES: Readonly<Record<string, UsZone>> = {
  AL: z('America/Chicago'),
  AK: z('America/Anchorage', false),
  AZ: z('America/Phoenix'),
  AR: z('America/Chicago'),
  CA: z('America/Los_Angeles'),
  CO: z('America/Denver'),
  CT: z('America/New_York'),
  DE: z('America/New_York'),
  DC: z('America/New_York'),
  FL: z('America/New_York', false),
  GA: z('America/New_York'),
  HI: z('Pacific/Honolulu'),
  ID: z('America/Boise', false),
  IL: z('America/Chicago'),
  IN: z('America/Indiana/Indianapolis', false),
  IA: z('America/Chicago'),
  KS: z('America/Chicago', false),
  KY: z('America/New_York', false),
  LA: z('America/Chicago'),
  ME: z('America/New_York'),
  MD: z('America/New_York'),
  MA: z('America/New_York'),
  MI: z('America/Detroit', false),
  MN: z('America/Chicago'),
  MS: z('America/Chicago'),
  MO: z('America/Chicago'),
  MT: z('America/Denver'),
  NE: z('America/Chicago', false),
  NV: z('America/Los_Angeles', false),
  NH: z('America/New_York'),
  NJ: z('America/New_York'),
  NM: z('America/Denver'),
  NY: z('America/New_York'),
  NC: z('America/New_York'),
  ND: z('America/Chicago', false),
  OH: z('America/New_York'),
  OK: z('America/Chicago'),
  OR: z('America/Los_Angeles', false),
  PA: z('America/New_York'),
  PR: z('America/Puerto_Rico'),
  RI: z('America/New_York'),
  SC: z('America/New_York'),
  SD: z('America/Chicago', false),
  TN: z('America/Chicago', false),
  TX: z('America/Chicago', false),
  UT: z('America/Denver'),
  VT: z('America/New_York'),
  VA: z('America/New_York'),
  VI: z('America/St_Thomas'),
  WA: z('America/Los_Angeles'),
  WV: z('America/New_York'),
  WI: z('America/Chicago'),
  WY: z('America/Denver'),
  GU: z('Pacific/Guam'),
};

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC, in minutes, at an instant (CDT is -300). */
export function zoneOffsetMinutes(utcMs: number, zone: string): number {
  const p: Record<string, number> = {};
  for (const part of format(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A local wall-clock time in a zone as ISO-8601 with its offset, e.g.
 * "2026-10-28T12:00:00-04:00". A time inside a spring-forward gap resolves to
 * the offset after the change; sale times are daytime, so this does not arise.
 */
export function zonedIso(y: number, m: number, d: number, h: number, mi: number, zone: string): string {
  const wall = Date.UTC(y, m - 1, d, h, mi, 0);
  let off = zoneOffsetMinutes(wall, zone);
  const again = zoneOffsetMinutes(wall - off * 60_000, zone);
  if (again !== off) off = again;
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
