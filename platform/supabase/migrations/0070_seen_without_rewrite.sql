-- 0070: a re-read that changes nothing no longer rewrites the lot.
--
-- After 0066-0069 every job fit on Micro except the BidWrangler watch. When
-- crawl-private resumed at 12:30 on 2026-10-08, statements and cron jobs timed
-- out again from 12:55 to 14:30: 89 cron startup timeouts and 18 statement
-- timeouts in the first hour. Pausing crawl-private at 13:58 ended it.
--
-- Measured:
--
-- * BidWrangler has 13,042 open lots, and the watch re-reads each one about
--   every 40 minutes. In the 3 hours before the pause it re-read 9,219 lots, and
--   586 (6.4%) had changed. Each of the other 94% still went through the
--   price-only write, a full new version of a 2.4 KB lots row (48 MB of heap for
--   20,409 rows), only to move last_seen_at. That is about 20,000 row rewrites an
--   hour: WAL (wal_level is logical, so whole tuples), a full-page image of every
--   page it touches after each 5-minute checkpoint, and dead rows that send
--   autovacuum through lots, its TOAST and its 18 indexes (384 runs so far).
-- * The instance is short of memory, not CPU. In a fresh session the first count
--   of open lots took 3,425 ms and the same count right after took 12.7 ms: lots
--   had been pushed out of RAM and came back at Micro's disk baseline. lots
--   (152 MB) and lot_images (164 MB) together exceed the 224 MB of shared
--   buffers on a 1 GB machine. Writing less is what keeps them in memory.
--
-- The change:
--
-- * public.lot_seen (lot_id, seen_at) records when a lot was last seen without
--   changing. A row is about 60 bytes, so 20,000 lots fit in ~2 MB, and an update
--   is HOT (seen_at is not indexed; fillfactor 50).
-- * ingest_batch: of the known lots whose content is unchanged (the price-only
--   set), those whose price, bids, close and closed state are also unchanged go
--   to lot_seen. Any lot with something to write is written exactly as before,
--   last_seen_at included. crawl_runs counts and the returned lots_price_only are
--   unchanged; the result also reports lots_unchanged.
-- * Every reader of last_seen_at now reads the later of lots.last_seen_at and
--   lot_seen.seen_at: crawl_known_state (the watch planner), crawl_run_finish
--   (lots seen this run, null rates, and which missing lots it closes),
--   search_lots (its watched-only filter, 0061) and v_lot_detail. Nothing else
--   in the database, the crawlers or the app reads lots.last_seen_at.
--   lots.last_seen_at keeps its meaning for every lot that changes; for one
--   that does not, the newer time is in lot_seen.
-- * BidWrangler's cadence goes to 20 minutes (Hansen Auction Group was 10, the
--   rest 15). crawl_run_finish sets next_due_at to finish + cadence, and
--   crawl-private wakes every 5 minutes, so a house's runs, about 2 minutes
--   long, start about 25 minutes apart. The adapter re-reads a lot unseen for 30
--   minutes (BW_WATCH.staleMs), so each lot is re-read every second run, about
--   every 50 minutes, within the hourly promise. Before, Hansen Auction Group
--   ran every 15 minutes and re-read each lot every 30. This removes about a
--   third of the re-reads and 40% of Hansen's runs (each run's
--   crawl_known_state and crawl_run_finish read all of the house's lots).
--   Limit: a run reads at most 3,500 known lots (35 requests of 100 ids, half of
--   BW_DEFAULTS.maxRequests). Hansen Auction Group has 6,700 open lots and needs
--   about half of them each run. Above about 7,000 open lots at one house, some
--   lots would wait a third run.
--
-- Checked before apply in the PG16 lab: 0067 and 0070 fed the same crawl
-- batches. After every step, every table matched except lots.last_seen_at, and
-- that matched wherever 0067's value equals the later of 0070's last_seen_at and
-- lot_seen.seen_at. crawl_known_state's output, every run's counts and closures,
-- and every function's result (lots_unchanged aside) were equal.
--
-- Applied with execute_sql in file order: guard, table, readers, writer,
-- cadence. Readers go first, so lot_seen is read before anything writes it.
-- Nothing drops or deletes.

-- ------------------------------------------------------------------ guard
-- Stops the file if a function it replaces is not the body it was written
-- against (0067's ingest_batch and crawl_run_finish, 0055's crawl_known_state,
-- the live search_lots), unless 0070 already ran.
do $$
declare r record;
begin
  for r in select * from (values
      ('public.ingest_batch(bigint,jsonb,jsonb)', 'b6079a73e8eff5d3b130dfc470f20c3c'),
      ('public.crawl_run_finish(bigint,crawl_status,integer,jsonb,text,boolean)', '2d061ca71be91b9dcb62304c6496412c'),
      ('public.crawl_known_state(uuid)', '7c56ed02d8a30328d0f5b35e4bec8b47'),
      ('public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text,text)',
       '4c472cfcb6e14699faf602786e14148a')) v(fn, md5)
  loop
    if md5(pg_get_functiondef(r.fn::regprocedure)) <> r.md5
       and position('lot_seen' in pg_get_functiondef(r.fn::regprocedure)) = 0 then
      raise exception '% changed since 0070 was written; re-derive from the live definition', r.fn;
    end if;
  end loop;
end $$;

-- --------------------------------------------------------------- lot_seen
create table if not exists public.lot_seen (
  lot_id  uuid primary key references public.lots (id) on delete cascade,
  seen_at timestamptz not null
) with (fillfactor = 50);

comment on table public.lot_seen is
  'When a lot was last seen unchanged (0070). A lot was last seen at greatest(lots.last_seen_at, lot_seen.seen_at).';
comment on column public.lots.last_seen_at is
  'When this row was last written by a crawl. A re-read that changes nothing is recorded in lot_seen instead (0070); the lot was last seen at greatest(last_seen_at, lot_seen.seen_at).';

-- Readable like lots (lots_public_read); only the crawlers' service role writes it.
alter table public.lot_seen enable row level security;
do $$ begin
  if not exists (select 1 from pg_policy
                  where polrelid = 'public.lot_seen'::regclass and polname = 'lot_seen_public_read') then
    create policy lot_seen_public_read on public.lot_seen for select using (true);
  end if;
end $$;
grant select on public.lot_seen to anon, authenticated;
grant select, insert, update on public.lot_seen to service_role;

-- ---------------------------------------------------------------- readers
-- crawl_known_state: as 0055, with the later of the two times.
create or replace function public.crawl_known_state(p_source_id uuid)
returns jsonb
language sql
stable
set search_path = public, extensions
as $function$
  select jsonb_build_object(
    'lots', coalesce((
      select jsonb_agg(jsonb_build_array(
               l.external_id, a.external_id,
               (extract(epoch from greatest(l.last_seen_at, ls.seen_at)) * 1000)::bigint,
               (extract(epoch from l.closes_at) * 1000)::bigint))
        from lots l
        left join auctions a on a.id = l.auction_id
        left join lot_seen ls on ls.lot_id = l.id
       where l.source_id = p_source_id
         and l.closed = false
         and (l.closes_at is null or l.closes_at > now() - interval '1 hour')), '[]'::jsonb),
    'auctions', coalesce((
      select jsonb_agg(jsonb_build_array(
               a.external_id,
               (extract(epoch from a.items_read_at) * 1000)::bigint,
               a.items_read_count))
        from auctions a
       where a.source_id = p_source_id
         and (a.ends_at is null or a.ends_at > now() - interval '1 day')), '[]'::jsonb))
$function$;

-- crawl_run_finish: as 0067; seen = the later of the two times, and a lot is
-- closed as missing only when neither time is inside the run.
create or replace function public.crawl_run_finish(p_run_id bigint, p_status crawl_status, p_http_requests integer default 0, p_warnings jsonb default '[]'::jsonb, p_error text default null::text, p_complete_snapshot boolean default false)
returns jsonb
language plpgsql
set search_path = public, extensions
as $function$
declare
  v_run          crawl_runs;
  v_open_before  integer := 0;
  v_open_now     integer := 0;
  v_closed       integer := 0;
  v_close_skip   boolean := false;
  v_withdrawn    integer := 0;
  v_drift_sales  integer := 0;
  v_median       numeric;
  v_seen         integer;
  v_null_price   numeric;
  v_null_image   numeric;
  v_null_close   numeric;
begin
  select * into v_run from crawl_runs where id = p_run_id for update;
  if not found then
    raise exception 'crawl run % not found', p_run_id;
  end if;
  -- 0070: a lot was last seen at the later of last_seen_at and lot_seen.seen_at.
  select count(*) filter (where greatest(l.last_seen_at, ls.seen_at) >= v_run.started_at),
         count(*) filter (where l.closed = false),
         round(avg((l.current_bid_cents is null)::int) filter (where greatest(l.last_seen_at, ls.seen_at) >= v_run.started_at), 3),
         round(avg((l.image_count = 0)::int)          filter (where greatest(l.last_seen_at, ls.seen_at) >= v_run.started_at), 3),
         round(avg((l.closes_at is null)::int)        filter (where greatest(l.last_seen_at, ls.seen_at) >= v_run.started_at), 3)
    into v_seen, v_open_now, v_null_price, v_null_image, v_null_close
    from lots l
    left join lot_seen ls on ls.lot_id = l.id
   where l.source_id = v_run.source_id;
  if p_status = 'ok' and p_complete_snapshot then
    v_open_before := v_open_now;
    if v_seen >= 0.3 * v_open_before then
      update lots l
         set closed = true, updated_at = now()
       where l.source_id = v_run.source_id
         and l.closed = false
         and l.last_seen_at < v_run.started_at
         and not exists (select 1 from lot_seen ls
                          where ls.lot_id = l.id and ls.seen_at >= v_run.started_at);
      get diagnostics v_closed = row_count;
    else
      v_close_skip := true;
    end if;
  elsif p_status = 'ok' and cardinality(v_run.complete_auctions) > 0 then
    with per as (
      select a.id as auction_id,
             count(*) as open_n,
             count(*) filter (where greatest(l.last_seen_at, ls.seen_at) >= v_run.started_at) as seen_n,
             max(a.lot_count) as published_n
        from auctions a
        join lots l on l.auction_id = a.id and l.closed = false
        left join lot_seen ls on ls.lot_id = l.id
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
         and not exists (select 1 from lot_seen ls
                          where ls.lot_id = l.id and ls.seen_at >= v_run.started_at)
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
    values (v_run.source_id, v_median, v_seen,
            case when coalesce(v_median, 0) > 0 then round(v_seen / v_median, 3) end,
            v_null_price, v_null_image, v_null_close, now())
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

-- search_lots: the watched-only filter (0061) reads the later of the two times.
-- Patched in place, so the rest of the function is untouched.
do $patch$
declare
  v_def text := pg_get_functiondef('public.search_lots(text,text,integer,boolean,text[],bigint,bigint,bigint[],source_tier[],integer,numeric,text,integer,integer,text,text)'::regprocedure);
  v_old text := 'or l.last_seen_at > now() - greatest(';
  v_new text := 'or greatest(l.last_seen_at, (select ls.seen_at from public.lot_seen ls where ls.lot_id = l.id)) > now() - greatest(';
begin
  if position('lot_seen' in v_def) > 0 then
    raise notice 'search_lots already reads lot_seen';
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'search_lots: the watched-only filter is not there exactly once; patch by hand';
  end if;
  execute replace(v_def, v_old, v_new);
end $patch$;

-- v_lot_detail: same columns; last_seen_at is the later of the two times.
create or replace view public.v_lot_detail with (security_invoker = true) as
 select l.id,
    l.external_id,
    l.lot_number,
    l.title,
    l.description,
    l.brand,
    l.model,
    l.condition,
    l.quantity,
    l.url,
    l.starting_bid_cents,
    l.current_bid_cents,
    l.next_bid_cents,
    l.estimate_low_cents,
    l.estimate_high_cents,
    l.sold_price_cents,
    l.bid_count,
    l.reserve_met,
    l.closes_at,
    l.closed,
    l.extended_count,
    l.primary_image_url,
    l.image_urls,
    l.image_count,
    l.sleeper_score,
    l.sleeper_reasons,
    l.desc_richness,
    l.pickup_city,
    l.pickup_state,
    l.pickup_postal_code,
    l.ships,
    l.first_seen_at,
    greatest(l.last_seen_at, ls.seen_at) as last_seen_at,
    a.id as auction_id,
    a.title as auction_title,
    a.auctioneer,
    a.url as auction_url,
    a.ends_at as auction_ends_at,
    a.timezone,
    a.buyer_premium_pct,
    a.buyer_premium_note,
    a.terms_url,
    a.pickup_line1,
    s.id as source_id,
    s.name as source_name,
    s.slug as source_slug,
    s.tier as source_tier,
    s.url as source_url,
        case
            when l.current_bid_cents is not null and a.buyer_premium_pct is not null then round(l.current_bid_cents::numeric * (1::numeric + a.buyer_premium_pct / 100.0))::bigint
            else null::bigint
        end as est_total_cents
   from public.lots l
     join public.sources s on s.id = l.source_id
     left join public.auctions a on a.id = l.auction_id
     left join public.lot_seen ls on ls.lot_id = l.id;

-- ----------------------------------------------------------------- writer
-- ingest_batch: as 0067, except that a price-only lot with nothing to write
-- goes to lot_seen.
create or replace function public.ingest_batch(p_run_id bigint, p_auctions jsonb default '[]'::jsonb, p_lots jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
set search_path = public, extensions
set work_mem = '16MB'
as $function$
declare
  v_source   uuid;
  v_auctions integer := 0;
  v_full     integer := 0;
  v_new      integer := 0;
  v_light    integer := 0;
  v_images   integer := 0;
  v_unchanged integer := 0;
begin
  select source_id into v_source
    from crawl_runs where id = p_run_id and status = 'running';
  if v_source is null then
    raise exception 'crawl run % is not running', p_run_id;
  end if;

  -- Auctions; an auction read in full this run is marked so (0055). An
  -- unchanged auction is not rewritten (A): it is only locked by ON CONFLICT.
  with src as (
    select distinct on (a."externalId") a.*
      from jsonb_to_recordset(coalesce(p_auctions, '[]'::jsonb)) as a(
        "externalId" text, title text, description text, auctioneer text, url text,
        format text, "startsAt" timestamptz, "endsAt" timestamptz, timezone text,
        pickup jsonb, "pickupRequired" boolean, ships boolean, "shipsNote" text,
        "sellerName" text, "sellerState" text, "lotCount" integer, currency text,
        "buyerPremiumPct" numeric, "buyerPremiumNote" text, "termsUrl" text, raw jsonb,
        "itemsComplete" boolean)
     where a."externalId" is not null and a.title is not null
     order by a."externalId"
  ), up as (
    insert into auctions as t (
      source_id, external_id, title, description, auctioneer, url, format,
      starts_at, ends_at, timezone,
      pickup_line1, pickup_city, pickup_state, pickup_postal_code, pickup_geom,
      pickup_required, ships, ships_note, seller_name, seller_state, lot_count,
      currency, buyer_premium_pct, buyer_premium_note, terms_url, raw, last_seen_at,
      items_read_at, items_read_count)
    select
      v_source, s."externalId", s.title, s.description, s.auctioneer, s.url,
      case when s.format in ('live','online','hybrid','sealed_bid','fixed_price')
           then s.format::auction_format else 'online' end,
      s."startsAt", s."endsAt", coalesce(s.timezone, 'America/Chicago'),
      nullif(s.pickup->>'line1', ''), nullif(s.pickup->>'city', ''),
      upper(nullif(s.pickup->>'state', '')), nullif(s.pickup->>'postalCode', ''),
      case when s.pickup->>'lat' is not null and s.pickup->>'lon' is not null
           then st_setsrid(st_makepoint((s.pickup->>'lon')::float8,
                                        (s.pickup->>'lat')::float8), 4326)::geography end,
      coalesce(s."pickupRequired", true), coalesce(s.ships, false), s."shipsNote",
      s."sellerName", upper(nullif(s."sellerState", '')), s."lotCount",
      coalesce(s.currency, 'USD'), s."buyerPremiumPct", s."buyerPremiumNote",
      s."termsUrl", s.raw, now(),
      case when s."itemsComplete" then now() end,
      case when s."itemsComplete" then s."lotCount" end
    from src s
    on conflict (source_id, external_id) do update set
      title              = excluded.title,
      description        = excluded.description,
      auctioneer         = excluded.auctioneer,
      url                = excluded.url,
      format             = excluded.format,
      starts_at          = excluded.starts_at,
      ends_at            = excluded.ends_at,
      timezone           = excluded.timezone,
      pickup_line1       = excluded.pickup_line1,
      pickup_city        = excluded.pickup_city,
      pickup_state       = excluded.pickup_state,
      pickup_postal_code = excluded.pickup_postal_code,
      pickup_geom        = excluded.pickup_geom,
      pickup_required    = excluded.pickup_required,
      ships              = excluded.ships,
      ships_note         = excluded.ships_note,
      seller_name        = excluded.seller_name,
      seller_state       = excluded.seller_state,
      lot_count          = excluded.lot_count,
      currency           = excluded.currency,
      buyer_premium_pct  = excluded.buyer_premium_pct,
      buyer_premium_note = excluded.buyer_premium_note,
      terms_url          = excluded.terms_url,
      raw                = excluded.raw,
      pickup_geo_source  = excluded.pickup_geo_source,
      last_seen_at       = now(),
      items_read_at      = coalesce(excluded.items_read_at, t.items_read_at),
      items_read_count   = case when excluded.items_read_at is not null
                                then excluded.items_read_count else t.items_read_count end
    where (t.title, t.description, t.auctioneer, t.url, t.format, t.starts_at, t.ends_at,
           t.timezone, t.pickup_line1, t.pickup_city, t.pickup_state, t.pickup_postal_code,
           t.pickup_required, t.ships, t.ships_note, t.seller_name, t.seller_state,
           t.lot_count, t.currency, t.buyer_premium_pct, t.buyer_premium_note, t.terms_url)
          is distinct from
          (excluded.title, excluded.description, excluded.auctioneer, excluded.url,
           excluded.format, excluded.starts_at, excluded.ends_at, excluded.timezone,
           excluded.pickup_line1, excluded.pickup_city, excluded.pickup_state,
           excluded.pickup_postal_code, excluded.pickup_required, excluded.ships,
           excluded.ships_note, excluded.seller_name, excluded.seller_state,
           excluded.lot_count, excluded.currency, excluded.buyer_premium_pct,
           excluded.buyer_premium_note, excluded.terms_url)
       or t.pickup_geom::text is distinct from excluded.pickup_geom::text
       or excluded.items_read_at is not null
       or t.pickup_geo_source is distinct from excluded.pickup_geo_source
       or (t.raw is distinct from excluded.raw
           and coalesce(t.last_seen_at, '-infinity'::timestamptz) < now() - interval '1 hour')
    returning 1
  )
  -- "up" runs to completion although only src is counted here.
  select count(*) into v_auctions from src;

  update crawl_runs r
     set complete_auctions = array(select distinct e from unnest(r.complete_auctions || c.ids) e order by e)
    from (select array_agg(a->>'externalId') as ids
            from jsonb_array_elements(coalesce(p_auctions, '[]'::jsonb)) a
           where nullif(a->>'externalId', '') is not null
             and coalesce((a->>'itemsComplete')::boolean, false)) c
   where r.id = p_run_id and c.ids is not null;

  -- Lots, in one statement over one parse (B). The price-only set (content
  -- unchanged) and the full set (new, or content changed) are disjoint by
  -- md5, so no row is written twice.
  with p as materialized (
    select * from ingest_parse_lots(v_source, p_lots)
  ), light as (
    -- 1. Known lots whose content is unchanged: price, bids and close only.
    select p.existing_id as id, p.starting_bid_cents, p.current_bid_cents, p.next_bid_cents,
           p.sold_price_cents, p.bid_count, p.reserve_met, p.closes_at,
           coalesce(p.closed, false) as closed,
           case when not e.sale_level
                 and (e.bid_count, e.current_bid_cents, e.closes_at)
                     is distinct from (p.bid_count, p.current_bid_cents, p.closes_at)
                then compute_sleeper(e.title, e.description, p.bid_count, p.current_bid_cents,
                                     e.estimate_low_cents, e.image_count, p.closes_at) end as sc,
           -- 0070: true when the write below would change nothing but
           -- last_seen_at (sold price is only ever filled in, never cleared).
           (e.starting_bid_cents, e.current_bid_cents, e.next_bid_cents, e.bid_count,
            e.reserve_met, e.closes_at, e.closed)
             is not distinct from
           (p.starting_bid_cents, p.current_bid_cents, p.next_bid_cents, p.bid_count,
            p.reserve_met, p.closes_at, coalesce(p.closed, false))
           and (p.sold_price_cents is null
                or p.sold_price_cents is not distinct from e.sold_price_cents) as unchanged
      from p
      join lots e on e.id = p.existing_id
     where p.old_md5 = p.md5
  ), upd as (
    update lots t
       set starting_bid_cents = l.starting_bid_cents,
           current_bid_cents  = l.current_bid_cents,
           next_bid_cents     = l.next_bid_cents,
           sold_price_cents   = coalesce(l.sold_price_cents, t.sold_price_cents),
           bid_count          = l.bid_count,
           reserve_met        = l.reserve_met,
           extended_count     = coalesce(t.extended_count, 0)
                                + case when l.closes_at > t.closes_at then 1 else 0 end,
           closes_at          = l.closes_at,
           closed             = l.closed,
           sleeper_score      = case when l.sc is null then t.sleeper_score else (l.sc ->> 'score')::numeric end,
           desc_richness      = case when l.sc is null then t.desc_richness else (l.sc ->> 'tokens')::integer end,
           sleeper_reasons    = case when l.sc is null then t.sleeper_reasons else l.sc -> 'reasons' end,
           last_seen_at       = now(),
           updated_at = case
             when (t.current_bid_cents, t.bid_count, t.closes_at, t.closed)
                  is distinct from (l.current_bid_cents, l.bid_count, l.closes_at, l.closed)
             then now() else t.updated_at end
      from light l
     where t.id = l.id
       and not l.unchanged
    returning 1
  ), seen as (
    -- 0070: a re-read that changed nothing is recorded here instead of
    -- rewriting the lot's whole row.
    insert into lot_seen as s (lot_id, seen_at)
    select distinct l.id, now() from light l where l.unchanged
    on conflict (lot_id) do update set seen_at = excluded.seen_at
    returning 1
  ), resolved as (
    -- 2. New lots and lots whose content changed: the full write, as before.
    select * from p
     where p.existing_id is null or p.old_md5 is distinct from p.md5
  ), up as (
    insert into lots as t (
      auction_id, source_id, external_id, lot_number, title, description,
      brand, model, condition, quantity,
      starting_bid_cents, current_bid_cents, next_bid_cents,
      estimate_low_cents, estimate_high_cents, sold_price_cents,
      bid_count, reserve_met, closes_at, closed, url,
      pickup_city, pickup_state, pickup_postal_code, pickup_geom, ships,
      primary_image_url, image_urls, image_count,
      desc_richness, sleeper_score, sleeper_reasons,
      raw, last_seen_at, updated_at, sale_level, content_md5)
    select
      r.auction_id, v_source, r.external_id, r.lot_number, r.title, r.description,
      r.brand, r.model, r.condition, coalesce(r.quantity, 1),
      r.starting_bid_cents, r.current_bid_cents, r.next_bid_cents,
      r.estimate_low_cents, r.estimate_high_cents, r.sold_price_cents,
      r.bid_count, r.reserve_met, r.closes_at, coalesce(r.closed, false), r.url,
      nullif(r.eff_pickup->>'city', ''), upper(nullif(r.eff_pickup->>'state', '')),
      nullif(r.eff_pickup->>'postalCode', ''),
      coalesce(
        case when r.eff_pickup->>'lat' is not null and r.eff_pickup->>'lon' is not null
             then st_setsrid(st_makepoint((r.eff_pickup->>'lon')::float8,
                                          (r.eff_pickup->>'lat')::float8), 4326)::geography end,
        case when nullif(r.eff_pickup->>'postalCode', '') is null then r.auction_geom end),
      coalesce(r.ships, false),
      r.urls[1], r.urls, coalesce(array_length(r.urls, 1), 0),
      (sc.s ->> 'tokens')::integer,
      case when coalesce(r.sale_level, false) then null else (sc.s ->> 'score')::numeric end,
      case when coalesce(r.sale_level, false) then null else sc.s -> 'reasons' end,
      r.raw, now(), now(), coalesce(r.sale_level, false), r.md5
    from resolved r
    cross join lateral (
      select compute_sleeper(r.title, r.description, r.bid_count, r.current_bid_cents,
                             r.estimate_low_cents, coalesce(array_length(r.urls, 1), 0),
                             r.closes_at) as s) sc
    on conflict (source_id, external_id) do update set
      auction_id          = excluded.auction_id,
      lot_number          = excluded.lot_number,
      title               = excluded.title,
      description         = excluded.description,
      brand               = excluded.brand,
      model               = excluded.model,
      condition           = excluded.condition,
      quantity            = excluded.quantity,
      starting_bid_cents  = excluded.starting_bid_cents,
      current_bid_cents   = excluded.current_bid_cents,
      next_bid_cents      = excluded.next_bid_cents,
      estimate_low_cents  = excluded.estimate_low_cents,
      estimate_high_cents = excluded.estimate_high_cents,
      sold_price_cents    = coalesce(excluded.sold_price_cents, t.sold_price_cents),
      bid_count           = excluded.bid_count,
      reserve_met         = excluded.reserve_met,
      extended_count      = coalesce(t.extended_count, 0)
                            + case when excluded.closes_at > t.closes_at then 1 else 0 end,
      closes_at           = excluded.closes_at,
      closed              = excluded.closed,
      url                 = excluded.url,
      pickup_city         = excluded.pickup_city,
      pickup_state        = excluded.pickup_state,
      pickup_postal_code  = excluded.pickup_postal_code,
      pickup_geom         = excluded.pickup_geom,
      ships               = excluded.ships,
      primary_image_url   = excluded.primary_image_url,
      image_urls          = excluded.image_urls,
      image_count         = excluded.image_count,
      desc_richness       = excluded.desc_richness,
      sleeper_score       = excluded.sleeper_score,
      sleeper_reasons     = excluded.sleeper_reasons,
      raw                 = excluded.raw,
      sale_level          = excluded.sale_level,
      content_md5         = excluded.content_md5,
      -- The INSERT-side trigger resolved the label afresh (it may come from
      -- the auction); keep it, so the UPDATE-side early return cannot hold
      -- a stale one.
      pickup_geo_source   = excluded.pickup_geo_source,
      last_seen_at        = now(),
      updated_at = case
        when (t.title, t.description, t.current_bid_cents, t.bid_count,
              t.closes_at, t.closed, t.image_count)
             is distinct from
             (excluded.title, excluded.description, excluded.current_bid_cents,
              excluded.bid_count, excluded.closes_at, excluded.closed, excluded.image_count)
        then now() else t.updated_at end
    returning t.id, t.external_id
  ), img_lots as (
    -- 3. Photos of new lots and of lots whose photo list changed (0055's
    -- v_img_ext); a new lot's id comes from the upsert above.
    select coalesce(p.existing_id, u.id) as lot_id, p.images
      from p
      left join up u on u.external_id = p.external_id
     where p.existing_id is null or p.old_image_urls is distinct from p.urls
  ), img as (
    select il.lot_id, i->>'url' as url,
           coalesce((i->>'position')::int, n::int - 1) as position,
           (i->>'width')::int as width, (i->>'height')::int as height
      from img_lots il
      cross join lateral jsonb_array_elements(coalesce(il.images, '[]'::jsonb))
           with ordinality as x(i, n)
     where il.lot_id is not null and nullif(i->>'url', '') is not null
  ), ins as (
    insert into lot_images as li (lot_id, url, position, width, height)
    select distinct on (lot_id, url) lot_id, url, position, width, height
      from img order by lot_id, url, position
    on conflict (lot_id, url) do update set position = excluded.position
     where li.position is distinct from excluded.position
    returning 1
  )
  select (select count(*) from upd) + (select count(*) from seen),
         (select count(*) from up),
         (select count(*) from resolved where existing_id is null),
         (select count(*) from ins),
         (select count(*) from seen)
    into v_light, v_full, v_new, v_images, v_unchanged;

  update crawl_runs
     set auctions_seen   = auctions_seen + v_auctions,
         lots_seen       = lots_seen + v_full + v_light,
         lots_new        = lots_new + v_new,
         lots_updated    = lots_updated + (v_full + v_light - v_new),
         lots_price_only = lots_price_only + v_light,
         images_queued   = images_queued + v_images
   where id = p_run_id;
  return jsonb_build_object(
    'auctions', v_auctions, 'lots', v_full + v_light, 'lots_new', v_new,
    'lots_updated', v_full + v_light - v_new, 'lots_price_only', v_light, 'lots_unchanged', v_unchanged, 'images', v_images);
end $function$;

-- ---------------------------------------------------------------- cadence
-- BidWrangler houses: runs about 25 minutes apart, each lot re-read about
-- every 50 minutes (see the header).
update public.sources
   set crawl_cadence_min = 20
 where platform = 'bidwrangler'
   and crawl_cadence_min < 20;
