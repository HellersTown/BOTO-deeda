-- 0019: the first Wisconsin connectors go live.
--
-- 1. crawl_run_start closes runs a worker abandoned. Crawl workers now run in
--    the background for up to about five minutes (edge/worker.ts). If the Edge
--    Runtime stops one mid-run, its crawl_runs row would stay 'running' forever;
--    the next run of the same source closes it as failed, so history and health
--    stay honest.
-- 2. The sources rows the new adapters read: platform keys, the hosts the
--    bidding actually happens on, scope and pace. Plus the sources our crawler
--    must not read: GovPlanet (an AWS WAF CAPTCHA on the Wisconsin search) and
--    Proxibid (Imperva, and no way to scope it to Wisconsin within robots.txt),
--    and HiBid, held back until the owner decides on its terms of use.
-- 3. Cron for the new family workers, a minute apart from crawl-worker (GSA).

create or replace function public.crawl_run_start(p_source_id uuid, p_method ingest_method default null)
returns bigint
language plpgsql
set search_path = public, extensions
as $$
declare
  v_id bigint;
begin
  -- No worker lives 15 minutes, so a run still 'running' after that was abandoned.
  update crawl_runs
     set status      = 'failed',
         finished_at = now(),
         error_text  = coalesce(error_text, 'abandoned: the worker stopped before finishing this run')
   where source_id = p_source_id
     and status = 'running'
     and started_at < now() - interval '15 minutes';

  insert into crawl_runs (source_id, method, status, started_at)
  values (p_source_id,
          coalesce(p_method, (select ingest from sources where id = p_source_id)),
          'running', now())
  returning id into v_id;
  update sources set last_crawled_at = now() where id = p_source_id;
  return v_id;
end $$;

-- State surplus: Wisconsin Surplus Online Auction. wisconsinsurplus.com is a
-- WordPress front; the auctions are served by Maxanet at bid.wisconsinsurplus.com.
update sources
   set platform   = 'wisconsin-surplus',
       url        = 'https://wisconsinsurplus.com',
       api_base   = 'https://bid.wisconsinsurplus.com',
       robots_url = 'https://bid.wisconsinsurplus.com/robots.txt',
       ingest     = 'html',
       states     = array['WI', 'IL', 'MI', 'IA', 'MN'],
       active     = true
 where slug = 'wisconsin-surplus';

-- Schools, counties, cities, technical colleges: Public Surplus, Wisconsin's
-- whole live catalogue each run, detail pages at one request every 2 s.
update sources
   set states = array['WI'], rate_limit_rpm = 30
 where slug = 'public-surplus';

-- Police property. Vehicles declare where they sit; everything else ships.
update sources
   set ingest = 'html', states = array['WI'], rate_limit_rpm = 12
 where slug = 'propertyroom';

-- Hansen Auction Group bids on BidWrangler, at its own bidding host.
update sources
   set platform          = 'bidwrangler',
       api_base          = 'https://bid.hansenauctiongroup.com',
       robots_url        = 'https://bid.hansenauctiongroup.com/robots.txt',
       ingest            = 'internal_json',
       states            = array['WI'],
       rate_limit_rpm    = 20,
       crawl_cadence_min = 60
 where slug = 'hansen-auction-group';

update sources
   set ingest            = 'deeplink_only',
       active            = false,
       access_status     = 'blocked',
       access_checked_at = now(),
       access_note       = 'AWS WAF CAPTCHA (HTTP 405 "Human Verification") on /jsp/s/search.ips?l2=USA-WI, '
                           || '2026-09-30. robots.txt allows the path; the challenge is the answer. Deep links only.'
 where slug = 'govplanet';

update sources
   set access_note = 'Event pages load Imperva''s script and our detector stops there (2026-09-30). Wisconsin '
                     || 'lots cannot be enumerated within robots.txt either: the sitemaps carry no location and '
                     || 'the search is disallowed. No adapter; per-seller sources would be the way in.'
 where slug = 'proxibid';

update sources
   set access_note = 'Open to our crawler; 8 current Wisconsin catalogues of 454 (2026-09-30). The state '
                     || 'filter URL is disallowed by robots.txt, so an adapter must discover sales from the '
                     || 'allowed catalogue listing. Not built yet.'
 where slug = 'bidspotter';

-- HiBid: the adapter is built and tested (hibid.com/graphql filtered to WI:
-- 82 open auctions and 24,565 open lots on 2026-09-30), but HiBid's terms of
-- use, as indexed, forbid automated collection and "aggregating data or
-- content" (docs/08 §3.1, RED). ingest_allowed was only the column default,
-- never a decision, so it is set to false here until the owner decides. The
-- rows stay active for the hourly probe and deep links.
update sources
   set ingest_allowed = false,
       ingest_note    = 'Adapter built and tested (GraphQL, WI filter). Not ingested: HiBid''s terms of use, as '
                        || 'indexed, forbid automated collection and aggregating its data (docs/08 §3.1). Owner '
                        || 'decision pending; deep links meanwhile.'
 where platform = 'hibid';

-- Beloit Auction & Realty bids on Marknet's software, not HiBid: its /graphql
-- answers "Cannot POST /graphql" and its page loads Marknet's auctioneer script.
update sources set platform = null where slug = 'beloit-auction';

do $$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname in ('crawl-public', 'crawl-private') loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('crawl-public',  '1-59/5 * * * *', $$select public.invoke_edge_function('crawl-public')$$);
select cron.schedule('crawl-private', '2-59/5 * * * *', $$select public.invoke_edge_function('crawl-private')$$);
