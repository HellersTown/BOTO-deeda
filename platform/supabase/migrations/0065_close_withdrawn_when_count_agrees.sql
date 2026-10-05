-- 0065: a sale that really shrank has its withdrawn lots closed.
--
-- WHY. crawl_run_finish (0055) closes the open lots a complete read of a sale
-- did not see, but only when the run saw at least 30% of the sale's open lots:
-- a guard against a broken read wiping a sale. On 2026-10-05 Hansen Auction
-- Group's sale 150799 went from 9 published items to 1. Every complete read
-- returned that one item, the platform's own count agreed (items_read_count
-- 1), and 1 of 9 is under 30%, so its 8 withdrawn lots stayed open, were due
-- for the price watch on every run, and were refused by /api/items ("Record
-- not found!"). They were the oldest due ids, so they led the first batch of
-- every run and kept the other 92 lots of that batch unrefreshed: all 13
-- Hansen Auction Group runs from 20:07 to 23:32 UTC had a refused batch, and
-- 11 skipped a sale's closure on the guard. A dry run against the 23:32 run:
-- sale 150799, 9 open lots, 1 seen, 1 published; the guard says no, this
-- rule says yes, and 8 lots close.
--
-- WHAT. The guard stays, and a second reason to believe a read is added: the
-- run saw at least as many of the sale's lots as the platform says the sale
-- publishes (auctions.lot_count, BidWrangler's published_items_count from the
-- same run's sale list). A read that agrees with the platform's own count is
-- not a broken read. A lot closed this way that comes back is reopened by the
-- next run that sees it, as any lot is.
--
-- Built from 0055's crawl_run_finish by the one change above (the per-sale
-- closure); everything else is unchanged. Applied with execute_sql.

create or replace function public.crawl_run_finish(p_run_id bigint, p_status crawl_status, p_http_requests integer default 0, p_warnings jsonb default '[]'::jsonb, p_error text default null::text, p_complete_snapshot boolean default false)
returns jsonb
language plpgsql
set search_path = public, extensions
as $function$
declare
  v_run          crawl_runs;
  v_open_before  integer := 0;
  v_closed       integer := 0;
  v_close_skip   boolean := false;
  v_withdrawn    integer := 0;
  v_drift_sales  integer := 0;
  v_median       numeric;
  v_seen         integer;
begin
  select * into v_run from crawl_runs where id = p_run_id for update;
  if not found then
    raise exception 'crawl run % not found', p_run_id;
  end if;
  select count(*) into v_seen
    from lots where source_id = v_run.source_id and last_seen_at >= v_run.started_at;
  if p_status = 'ok' and p_complete_snapshot then
    select count(*) into v_open_before
      from lots where source_id = v_run.source_id and closed = false;
    if v_seen >= 0.3 * v_open_before then
      update lots
         set closed = true, updated_at = now()
       where source_id = v_run.source_id
         and closed = false
         and last_seen_at < v_run.started_at;
      get diagnostics v_closed = row_count;
    else
      v_close_skip := true;
    end if;
  elsif p_status = 'ok' and cardinality(v_run.complete_auctions) > 0 then
    with per as (
      select a.id as auction_id,
             count(*) as open_n,
             count(*) filter (where l.last_seen_at >= v_run.started_at) as seen_n,
             max(a.lot_count) as published_n
        from auctions a
        join lots l on l.auction_id = a.id and l.closed = false
       where a.source_id = v_run.source_id
         and a.external_id = any(v_run.complete_auctions)
       group by a.id
    ), sure as (
      -- A sale whose missing lots may be closed: the run saw 30% of its open
      -- lots (the drift guard), or every item the platform itself says the
      -- sale now publishes (0065), so a sale that really shrank is believed.
      select p.auction_id
        from per p
       where p.seen_n >= 0.3 * p.open_n
          or (coalesce(p.published_n, 0) > 0 and p.seen_n >= p.published_n)
    ), gone as (
      update lots l
         set closed = true, updated_at = now()
        from sure s
       where l.auction_id = s.auction_id
         and l.closed = false
         and l.last_seen_at < v_run.started_at
      returning 1
    )
    select (select count(*) from gone),
           (select count(*) from per where auction_id not in (select auction_id from sure))
      into v_withdrawn, v_drift_sales;
  end if;
  update crawl_runs
     set status        = p_status,
         finished_at   = now(),
         lots_seen     = v_seen,
         http_requests = coalesce(p_http_requests, 0),
         error_text    = p_error,
         errors        = jsonb_strip_nulls(jsonb_build_object(
                           'warnings', nullif(coalesce(p_warnings, '[]'::jsonb), '[]'::jsonb),
                           'closed_missing', nullif(v_closed, 0),
                           'close_skipped_drift', case when v_close_skip then true end,
                           'closed_withdrawn', nullif(v_withdrawn, 0),
                           'withdrawn_skipped_drift', nullif(v_drift_sales, 0)))
   where id = p_run_id;
  if p_status in ('ok', 'partial') then
    update sources
       set last_ok_at = now(),
           consecutive_failures = 0,
           next_due_at = now() + make_interval(mins => least(greatest(crawl_cadence_min, 1), 60)),
           lease_until = null
     where id = v_run.source_id;
  else
    update sources
       set consecutive_failures = coalesce(consecutive_failures, 0) + 1,
           next_due_at = now() + least(
             make_interval(mins => least(greatest(crawl_cadence_min, 1), 60))
               * power(2, least(coalesce(consecutive_failures, 0), 4)),
             interval '60 minutes'),
           lease_until = null
     where id = v_run.source_id;
  end if;
  if p_status in ('ok', 'partial') then
    select percentile_cont(0.5) within group (order by lots_seen)
      into v_median
      from (select lots_seen from crawl_runs
             where source_id = v_run.source_id and status in ('ok', 'partial')
             order by started_at desc limit 10) r;
    insert into source_health (source_id, median_lots_per_run, last_lots_per_run,
                               drift_ratio, null_rate_price, null_rate_image,
                               null_rate_close, updated_at)
    select v_run.source_id, v_median, v_seen,
           case when coalesce(v_median, 0) > 0 then round(v_seen / v_median, 3) end,
           round(avg((current_bid_cents is null)::int), 3),
           round(avg((image_count = 0)::int), 3),
           round(avg((closes_at is null)::int), 3),
           now()
      from lots
     where source_id = v_run.source_id and last_seen_at >= v_run.started_at
    on conflict (source_id) do update set
      median_lots_per_run = excluded.median_lots_per_run,
      last_lots_per_run   = excluded.last_lots_per_run,
      drift_ratio         = excluded.drift_ratio,
      null_rate_price     = excluded.null_rate_price,
      null_rate_image     = excluded.null_rate_image,
      null_rate_close     = excluded.null_rate_close,
      updated_at          = now();
  end if;
  return jsonb_build_object(
    'run_id', p_run_id, 'status', p_status,
    'closed_missing', v_closed, 'close_skipped_drift', v_close_skip,
    'closed_withdrawn', v_withdrawn, 'open_before', v_open_before);
end $function$;
