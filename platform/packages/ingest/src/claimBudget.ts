/**
 * How much one crawl invocation may take on.
 *
 * Supabase stops an Edge Function invocation at 2 s of CPU, counted across all
 * of it however long it lives, and a worker it stops this way is simply gone:
 * the run in flight writes nothing and is closed as abandoned later. The worker
 * claims due sources one at a time, and a large BidWrangler house spends most of
 * that budget by itself. On 2026-10-08 Hansen Auction Group (~6,400 open lots)
 * used 0.9-1.7 s of CPU per run, and 1.05 s on a run that read no lots at all:
 * the fixed cost follows what the database already holds for the source, not
 * what the run reads. Claimed second, after Hueckman or Bennett, it took the
 * invocation past 2 s four times that day, and each time a quarter of Hansen's
 * hourly watch went unread.
 *
 * So a large source only ever runs first. Before each claim the worker asks
 * mayClaimAnother(), which says yes only while everything this invocation has
 * crawled is small. A run weighs the larger of the lots it read and the lots the
 * database held for its source. A run that failed has an unknown cost, so it
 * ends the invocation. Whatever is still due waits for the next cron tick, five
 * minutes later; claim_due_sources hands it out oldest-due first.
 *
 * The remaining risk is a small source first and a large one second: about
 * 0.1 s to start, ~0.25 s for the small one and ~1.1 s for Hansen, which fits.
 */

/** An invocation that has crawled this many lots, or more, claims nothing else. */
export const LIGHT_LOTS = 300;

/** What the worker records for a run it finished (or could not). */
export interface RunWeight {
  /** Lots the run handed to ingest_batch. */
  readonly lots?: number;
  /** Open lots the database held for the source when the run began (0055). */
  readonly known_lots?: number;
  readonly error?: string;
}

export function runWeight(r: RunWeight): number {
  if (r.error) return Infinity;
  return Math.max(r.lots ?? 0, r.known_lots ?? 0);
}

/** True while the runs so far are small enough for one more claim. */
export function mayClaimAnother(done: readonly RunWeight[], limit = LIGHT_LOTS): boolean {
  let total = 0;
  for (const r of done) total += runWeight(r);
  return total < limit;
}
