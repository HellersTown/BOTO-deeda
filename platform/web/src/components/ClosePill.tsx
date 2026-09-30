import type { ClosePrecision } from '../data/lotSummary';
import { describeClose } from '../lib/dates';

/** "Closes Oct 2 · time not published" (amber) or a countdown, never both. */
export function ClosePill({
  closesAt,
  precision,
  timeZone,
  closed,
  now,
}: {
  closesAt: string | null;
  precision: ClosePrecision;
  timeZone: string | null;
  closed?: boolean;
  now: Date;
}) {
  const label = describeClose({ closesAt, precision, timeZone, closed }, now);
  return (
    <span className={`close-pill close-pill--${label.tone}`}>
      <time dateTime={label.dateTime ?? undefined}>{label.text}</time>
    </span>
  );
}
