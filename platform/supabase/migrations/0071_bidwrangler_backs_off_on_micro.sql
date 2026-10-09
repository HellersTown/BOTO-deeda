-- 0071: the crawlers back off on their own while the instance is starved, and
-- the smaller BidWrangler houses run at the hourly pace instead of faster.
--
-- With 0070 in, the full BidWrangler watch still starved the Micro instance:
-- crawl-private resumed at 15:38 on 2026-10-08, timeouts returned at 16:29, and
-- pausing crawl-private at 16:40 was not enough. The app's searches averaged
-- 53 s with 5xx until every crawler and the hunt matcher were paused at 17:15.
-- 0070 had cut lots row rewrites by ~86%; what is left is reading, and on 1 GB of
-- RAM lots and lot_images do not stay in memory (docs/11).
--
-- 1. A circuit breaker in every crawler's cron gate. A gate does not wake its
--    worker while 2 or more of the last 40 cron runs failed on a timeout (a job
--    that could not start, or a statement cancelled), about the last 15 minutes
--    of cron. The workers wake again by themselves once those failures age out.
--    It reads 40 rows by cron.job_run_details' primary key. Checked against the
--    16:29 wave: all 66 failed runs from 16:30 to 17:19 have status 'failed' and
--    return_message 'job startup timeout'. A healthy hour has none (0 of 74 runs
--    from 15:38 to 16:12).
--
-- 2. The six smaller BidWrangler houses run every 50 minutes, as 0064 set for
--    the other hourly sources, instead of every 15. Each has fewer open lots than
--    a run can re-read (~2,400, 0070), so every run re-reads all of them and each
--    listing is still seen within the hour: the owner's requirement (0010's
--    hourly floor, 0064). That is ~1.1 runs an hour per house instead of ~3, and
--    ~27% fewer re-reads of their 6,360 lots.
--
--    Hansen Auction Group keeps its 10-minute cadence. It has 6,700 open lots and
--    a run re-reads ~2,400, so only runs ~15 minutes apart see each listing
--    within the hour. It is now the larger part of the watch's load. Seeing its
--    listings less often than hourly is the owner's decision; the move to Small
--    is the alternative (docs/11).
--
-- The gates' platform lists and the other crawlers' cadences are unchanged.
-- Applied with execute_sql.

create or replace function public.invoke_crawler_if_due(p_name text, p_platforms text[])
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 0071: no crawler wakes while the instance is starved.
  if (select count(*)
        from (select d.status, d.return_message
                from cron.job_run_details d
               order by d.runid desc
               limit 40) r
       where r.status = 'failed'
         and r.return_message ilike '%timeout%') >= 2 then
    return null;
  end if;
  -- claim_due_sources' gates (0010), read without locking.
  if not exists (
    select 1
      from public.sources c
     where c.active
       and coalesce(c.ingest_allowed, false)
       and c.ingest is distinct from 'deeplink_only'
       and (c.robots_allows is true or c.ingest = 'official_api')
       and coalesce(c.access_status, 'unknown') not in ('blocked', 'robots_disallowed')
       and c.platform = any(p_platforms)
       and coalesce(c.next_due_at, '-infinity'::timestamptz) <= now()
       and coalesce(c.lease_until, '-infinity'::timestamptz) < now()) then
    return null;
  end if;
  return public.invoke_edge_function(p_name);
end $$;

revoke execute on function public.invoke_crawler_if_due(text, text[]) from public, anon, authenticated;

update public.sources
   set crawl_cadence_min = 50
 where platform = 'bidwrangler'
   and slug <> 'hansen-auction-group'
   and crawl_cadence_min < 50;
