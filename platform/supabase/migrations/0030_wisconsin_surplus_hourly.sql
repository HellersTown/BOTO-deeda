-- 0030: Wisconsin Surplus is read once an hour.
--
-- The permission request to Wisconsin Surplus (docs/10 section 1) states the
-- load exactly: the Current and Upcoming auction lists, two requests an hour.
-- The source's cadence was 30 minutes; it is now 60, so the letter is true on
-- the day permission arrives. Its rows are sale cards (crawl-public,
-- adapters/wisconsin-surplus.ts), which change slowly: an auction is listed
-- days before it opens and runs about two weeks.
--
-- The source stays held (ingest_allowed = false, 0020) until Wisconsin Surplus
-- gives written permission.

update sources
   set crawl_cadence_min = 60
 where slug = 'wisconsin-surplus';

update sources
   set ingest_note = ingest_note || ' 2026-10-01: built as sale cards, one row per auction from the Current and '
                     || 'Upcoming lists (two requests an hour); held until written permission (docs/10 section 1).'
 where slug = 'wisconsin-surplus' and ingest_note not like '%built as sale cards%';
