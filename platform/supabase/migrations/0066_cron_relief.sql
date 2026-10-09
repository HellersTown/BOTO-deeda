-- 0066: stop the background jobs from starving the database.
--
-- On 2026-10-08 from 04:00 UTC every statement crawled. A pg_settings read took
-- 12 s. queue_watch_alerts(), with no watched lots at all, took 15 to 52 s. Cron
-- logged "job startup timeout" and connections timed out. The database is only
-- 405 MB (20k lots, 4 hunts, 0 watches), so no single query was the problem. The
-- small burstable instance was out of CPU from steady background work:
--
--   run_hunt_matcher   every 30 s  17,366 s since 08-11
--   ingest_batch       crawls      14,980 s, 30 GB of temp spills at work_mem 2 MB
--   queue_watch_alerts every 30 s   6,749 s
--   cron bookkeeping   every run   ~11,600 s across job_run_details writes
--   reclassify_lots    every min    2,863 s
--   invoke_look_at_lots every 3 min   991 s; the function answers configured:false
--
-- Alerts cannot be fresher than the lots behind them, and sources are read every
-- 5 minutes, so a 30-second matcher bought nothing. A minute keeps each tier's
-- promise: free 3600 s, pro 60 s; dealer's 30 s becomes about a minute. Reclassify
-- does work only after a vocabulary change or for lots the trigger did not
-- classify, so every 5 minutes is enough. look-at-lots does nothing until the
-- Anthropic key is set, so hourly until then (0067 makes it skip by itself).
--
-- ingest_batch sorts and hashes a few hundred lots of jsonb a call. At 2 MB of
-- work_mem that went to disk on every call. Three crawlers at most, at 16 MB each.
--
-- Applied with execute_sql.

select cron.alter_job(j.jobid, schedule := v.schedule)
  from (values ('hunt-matcher',    '* * * * *'),
               ('watch-alerts',    '* * * * *'),
               ('reclassify-lots', '3-59/5 * * * *'),
               ('look-at-lots',    '41 * * * *')) v(jobname, schedule)
  join cron.job j on j.jobname = v.jobname;

alter function public.ingest_batch(bigint, jsonb, jsonb) set work_mem = '16MB';
