-- 0068: wake a crawl worker only when one of its sources is due.
--
-- Each crawl-* job called its Edge Function every 5 minutes, 288 times a day.
-- On 2026-10-07/08 crawl-worker crawled 17 times and crawl-public 16. An empty
-- call does no outbound I/O, because claim_due_sources() returns nothing, but
-- it still costs the database:
--   - invoke_edge_function: vault reads and net.http_post, 367 ms mean;
--   - a pg_net response row;
--   - the worker's claim_due_sources over PostgREST, 167 ms mean and 8.6 s during
--     the starved waves.
-- That is about 0.6 s of database time per empty call, and about 500 empty calls
-- a day.
--
-- The cron command now asks claim_due_sources' question first, without locking,
-- and calls the worker only when the answer is yes. The worker does nothing but
-- claim (packages/ingest/src/edge/worker.ts), so nothing else is skipped. Tick,
-- cadences and what a worker claims are unchanged. A source that becomes due just
-- after the check waits for the next tick, the same as one that became due just
-- after a claim.
--
-- Each platform list must equal the adapters its worker serves. A worker serving
-- a platform its gate omits would never be woken for it, so
-- packages/ingest/test/crawl-gates.test.ts fails when they differ.
--
-- Applied with execute_sql.

create or replace function public.invoke_crawler_if_due(p_name text, p_platforms text[])
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
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

select cron.alter_job(j.jobid, command := v.command)
  from (values
    ('crawl-worker',  $c$select public.invoke_crawler_if_due('crawl-worker', array['gsa', 'irs-auctions'])$c$),
    ('crawl-public',  $c$select public.invoke_crawler_if_due('crawl-public', array['public-surplus', 'wisconsin-surplus', 'propertyroom', 'municibid', 'dane-county-tax-deed', 'wi-dor'])$c$),
    ('crawl-private', $c$select public.invoke_crawler_if_due('crawl-private', array['bidwrangler', 'auctionguide'])$c$)
  ) v(jobname, command)
  join cron.job j on j.jobname = v.jobname;
