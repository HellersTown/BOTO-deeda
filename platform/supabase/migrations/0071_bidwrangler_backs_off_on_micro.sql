-- 0071: BidWrangler backs off on its own, and runs at a pace Micro can carry.
--
-- With 0070 in, the hourly BidWrangler watch still starved the Micro instance:
-- crawl-private resumed at 15:38 on 2026-10-08, timeouts returned at 16:29, and
-- it was paused at 16:40. 0070 had cut lots row rewrites by ~86%. What is left
-- is reading: every run reads its house's lot list and up to 48 MB of lot JSON,
-- and on 1 GB of RAM lots and lot_images do not stay in memory (docs/11).
--
-- Leaving crawl-private paused is worse than running it slowly. Search hides a
-- lot its source has not shown for 6 hours (0061), so after 6 paused hours the
-- 13,000 BidWrangler lots, two thirds of the catalogue, drop out of search.
--
-- 1. A circuit breaker. crawl-private's cron gate does not wake the worker while
--    2 or more of the last 40 cron runs failed on a timeout (a job that could
--    not start, or a statement cancelled). That is about the last 15 minutes of
--    cron. The worker wakes again by itself once those failures age out. It
--    reads 40 rows by cron.job_run_details' primary key. A healthy instance has
--    none (0 of 74 runs from 15:38 to 16:12). In the 16:29 wave the logs show
--    five cron startup timeouts between 16:31:16 and 16:31:28 alone.
--
-- 2. A slower pace, until the instance moves to Small. Hansen Auction Group
--    (6,700 open lots) runs every 60 minutes, the other houses every 120. A run
--    re-reads at most ~2,400 lots (0070), so Hansen goes round in about 3 hours
--    and the other houses, all under 2,400 open lots, in one run. Every open lot
--    is then seen well inside search's 6-hour window. That is ~5,400 re-reads and
--    ~4 runs an hour, against ~19,000 and ~25 at the hourly pace. Prices,
--    including those of lots about to close, are as old as their house's last
--    run, up to 2 hours.
--
--    After the move to Small, restore the hourly watch:
--      update public.sources
--         set crawl_cadence_min = case when slug = 'hansen-auction-group' then 10 else 15 end
--       where platform = 'bidwrangler';
--
-- The gate's platform list and every other crawler are unchanged.
-- Applied with execute_sql.

create or replace function public.invoke_crawler_if_due(p_name text, p_platforms text[])
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 0071: the heaviest crawler stays asleep while the instance is starved.
  if p_name = 'crawl-private' and (
       select count(*)
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
   set crawl_cadence_min = case when slug = 'hansen-auction-group' then 60 else 120 end
 where platform = 'bidwrangler';
