import type { ClosePrecision } from '../data/lotSummary';
import { describeClose, describeCloseLocal } from '../lib/dates';

/**
 * "Closes Oct 2 · time not published" (amber) or a countdown, never both.
 * `clock` states a precise close as a time of day in the viewer's zone instead
 * of counting down ("Closes today, 7:00 PM"): the sale card's form.
 */
export function ClosePill({
  closesAt,
  precision,
  timeZone,
  closed,
  now,
  clock = false,
}: {
  closesAt: string | null;
  precision: ClosePrecision;
  timeZone: string | null;
  closed?: boolean;
  now: Date;
  clock?: boolean;
}) {
  const input = { closesAt, precision, timeZone, closed };
  const label = clock ? describeCloseLocal(input, now) : describeClose(input, now);
  return (
    <span className={`close-pill close-pill--${label.tone}`}>
      <time dateTime={label.dateTime ?? undefined}>{label.text}</time>
    </span>
  );
}
