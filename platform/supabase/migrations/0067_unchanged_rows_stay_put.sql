-- 0067: stop rewriting what has not changed.
--
-- 0066 slowed the jobs; this removes the work itself. Measured 2026-10-08:
--
-- * lots took 1,523,317 updates for 20,232 rows, 60% of them non-HOT, so each
--   inserted into all 17 lots indexes. 98% of the last day's 128,950 lot writes
--   were watch-mode re-reads that changed nothing but last_seen_at. Two causes:
--   - search_tsv was a STORED GENERATED column, and lots has BEFORE UPDATE
--     triggers. With a BEFORE trigger Postgres recomputes every stored generated
--     column on every UPDATE, so even a price-only write ran four to_tsvector
--     calls. The new datum never compared equal to the stored, compressed one,
--     so the update was never HOT, and the tsvector was written to TOAST again.
--     It is now a plain column kept by a trigger that recomputes it only when
--     title, brand, model, description or lot_number change. Same expression,
--     same values, no table rewrite.
--   - fillfactor was 100, so a new row version had no room on its page. Now 70.
--   In a lab with the live row shape and index set: 0% HOT before, 97% after;
--   3,000 price-only updates went from 1,370 ms and 36 MB of WAL to 185 ms and 18 MB.
--
-- * refresh_sleeper_scores rewrote up to 5,000 lots every 15 minutes whether or
--   not a score moved: 346 MB of WAL a day for a 405 MB database. ingest_batch
--   already rescores a lot whenever a score input changes. The one input that
--   moves by itself is the clock (compute_sleeper's "closes within 12 hours with
--   at most one bid"), so the job now rescores only never-scored lots and lots
--   whose closing_quiet reason disagrees with the clock, and writes only rows
--   whose score changed.
--
-- * search_lots stopped using its indexes on 2026-10-05: 0057 added
--   "or l.seen_tsv @@ v_any" to the candidate filter, and seen_tsv has no index,
--   so the planner's BitmapOr lost an arm and every search, and every hunt,
--   read every open lot. lots_seen_tsv_idx restores the bitmap plan.
--
-- * ingest_batch parsed each batch three times and rewrote every auction on
--   every run (88k updates for 2.5k auctions; each fired the gazetteer twice).
--   It now parses once, and an auction is rewritten only when a column it maps
--   changes, its items were read in full, or (raw alone: BidWrangler's
--   total_price and is_closing move with every bid) at most hourly. Nothing
--   reads auctions.raw or auctions.last_seen_at.
--
-- * crawl_run_finish read a source's lots up to three times; once now.
--
-- * resolve_location_from_gazetteer re-resolved on every upsert that named the
--   pickup columns, though the INSERT side of the same upsert had just resolved
--   them. It returns early when they are unchanged; ingest_batch keeps the
--   label the INSERT side resolved. After loading new gazetteer data, force a
--   re-resolve in one transaction:
--     begin; set local skeuos.regeocode = 'on';
--     update public.auctions set pickup_city = pickup_city;
--     update public.lots set pickup_city = pickup_city; commit;
--
-- * queue_watch_alerts returns at once when nothing is watched, and runs each
--   section only when some watch could qualify.
--
-- * reclassify_lots returns at once when no lot is behind the vocabulary; after
--   a vocabulary load run select public.reclassify_lots(3000) by hand until 0.
--
-- * invoke_look_at_lots remembers the function's last answer. While it answers
--   configured:false (no ANTHROPIC_API_KEY) it asks every 3 hours and the job
--   runs hourly; once it answers configured:true the job returns to */3 by itself.
--
-- Each replaced function was read live first and matched this repo (0055, 0065,
-- 0017, 0013+0025, 0054, 0057). The hunt matcher, paused while every run hit
-- the statement timeout, is turned back on at the end.
--
-- Checked before apply in a PG16 lab: old and new ingest_batch,
-- crawl_run_finish and gazetteer trigger diffed over 18 crawl steps (only the
-- intended auctions.last_seen_at/raw differences); search_tsv equal to the
-- generated expression; every function compiled and run.
--
-- Applied in four execute_sql calls, in file order: the functions, the
-- search_tsv block, the index, the cron block.

-- --------------------------------------------------------------- functions
-- First, so the every-minute jobs run their new, lighter bodies before the
-- block below waits for its lock on lots. The guard stops the file if
-- queue_watch_alerts is not the 0013+0025 body it replaces (or 0067 already ran).
do $$ begin
  if md5(pg_get_functiondef('public.queue_watch_alerts()'::regprocedure)) <> '2f71a6e39319740703c4ab157817f1fb' then
    raise exception 'queue_watch_alerts changed since 0066 part 3 was written; re-derive from the live definition';
  end if;
end $$;

-- ------------------------------------------------------------ ingest_batch
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
                                     e.estimate_low_cents, e.image_count, p.closes_at) end as sc
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
  select (select count(*) from upd),
         (select count(*) from up),
         (select count(*) from resolved where existing_id is null),
         (select count(*) from ins)
    into v_light, v_full, v_new, v_images;

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
    'lots_updated', v_full + v_light - v_new, 'lots_price_only', v_light, 'images', v_images);
end $function$;

-- --------------------------------------------------------- crawl_run_finish
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
  select count(*) filter (where last_seen_at >= v_run.started_at),
         count(*) filter (where closed = false),
         round(avg((current_bid_cents is null)::int) filter (where last_seen_at >= v_run.started_at), 3),
         round(avg((image_count = 0)::int)          filter (where last_seen_at >= v_run.started_at), 3),
         round(avg((closes_at is null)::int)        filter (where last_seen_at >= v_run.started_at), 3)
    into v_seen, v_open_now, v_null_price, v_null_image, v_null_close
    from lots
   where source_id = v_run.source_id;
  if p_status = 'ok' and p_complete_snapshot then
    v_open_before := v_open_now;
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

-- ------------------------------------------- resolve_location_from_gazetteer
create or replace function public.resolve_location_from_gazetteer()
returns trigger
language plpgsql
set search_path = public, extensions
as $function$
declare
  v_state    text;
  v_zip_geom extensions.geography;
  v_city     extensions.geography;
  v_spread   float8;
  v_label    text;
begin
  if tg_op = 'UPDATE'
     and coalesce(current_setting('skeuos.regeocode', true), '') <> 'on'
     and new.pickup_postal_code is not distinct from old.pickup_postal_code
     and new.pickup_state       is not distinct from old.pickup_state
     and new.pickup_city        is not distinct from old.pickup_city
     and new.pickup_geom::text  is not distinct from old.pickup_geom::text
     and new.pickup_geo_source  is not distinct from old.pickup_geo_source then
    if tg_table_name <> 'lots' then
      return new;
    elsif new.auction_id is not distinct from old.auction_id then
      -- A lot's label may come from its auction; same auction, same label.
      return new;
    end if;
  end if;

  if new.pickup_postal_code is not null and length(trim(new.pickup_postal_code)) > 0 then
    new.pickup_postal_code := substring(trim(new.pickup_postal_code) from 1 for 5);
    select pc.state, pc.geom
      into v_state, v_zip_geom
      from postal_codes pc
     where pc.postal_code = new.pickup_postal_code;
  end if;

  if v_state is not null and new.pickup_state is null then
    new.pickup_state := v_state;
  end if;

  if v_zip_geom is null
     and nullif(trim(new.pickup_state), '') is not null
     and nullif(trim(new.pickup_city), '') is not null then
    select r.point, r.spread_m into v_city, v_spread
      from resolve_place_point(new.pickup_state, new.pickup_city) r;
    if v_spread is null or v_spread > 32187 then
      v_city := null;
    end if;
  end if;

  if new.pickup_geom is null then
    if v_zip_geom is not null then
      new.pickup_geom := v_zip_geom;
      new.pickup_geo_source := 'postal_code';
    elsif v_city is not null then
      new.pickup_geom := v_city;
      new.pickup_geo_source := 'city';
    else
      new.pickup_geo_source := null;
    end if;
    return new;
  end if;

  if v_zip_geom is not null and st_dwithin(new.pickup_geom, v_zip_geom, 1) then
    new.pickup_geo_source := 'postal_code';
  elsif v_city is not null and st_dwithin(new.pickup_geom, v_city, 1) then
    new.pickup_geo_source := 'city';
  else
    if tg_table_name = 'lots' then
      if new.auction_id is not null then
        select a.pickup_geo_source
          into v_label
          from auctions a
         where a.id = new.auction_id
           and a.pickup_geom is not null
           and st_dwithin(a.pickup_geom, new.pickup_geom, 1);
      end if;
    end if;
    new.pickup_geo_source := coalesce(v_label, 'source');
  end if;

  return new;
end $function$;

-- --------------------------------------------------- refresh_sleeper_scores
create or replace function public.refresh_sleeper_scores(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare v_updated integer := 0;
begin
  -- ingest_batch rescores a lot whenever a score input changes (full path:
  -- every new or changed lot; price-only path: whenever bid_count,
  -- current_bid_cents or closes_at moves). The one input that moves by itself
  -- is the clock, through compute_sleeper's closing_quiet term (closes within
  -- 12 hours, at most one bid). So: lots never scored, plus lots whose stored
  -- closing_quiet disagrees with the clock; and a row is written only when its
  -- score, word count or reasons actually changed. The score is compared at the
  -- column's precision, numeric(6,3).
  with target as materialized (
    select l.id
      from lots l
     where l.closed = false
       and not l.sale_level
       and (l.sleeper_score is null
            or (l.closes_at < now() + interval '12 hours'
                and ((l.closes_at > now() and coalesce(l.bid_count, 0) <= 1)
                     is distinct from
                     coalesce(l.sleeper_reasons @> '[{"code":"closing_quiet"}]'::jsonb, false))))
     order by coalesce(l.closes_at, 'infinity'::timestamptz)
     limit greatest(coalesce(p_limit, 5000), 1)
       for update skip locked
  ), scored as (
    select l.id,
           compute_sleeper(l.title, l.description, l.bid_count, l.current_bid_cents,
                           l.estimate_low_cents, l.image_count, l.closes_at) as s
      from lots l join target t on t.id = l.id
  )
  update lots l
     set sleeper_score   = (sc.s ->> 'score')::numeric,
         desc_richness   = (sc.s ->> 'tokens')::integer,
         sleeper_reasons = sc.s -> 'reasons'
    from scored sc
   where l.id = sc.id
     and (l.sleeper_score, l.desc_richness, l.sleeper_reasons)
         is distinct from
         (((sc.s ->> 'score')::numeric)::numeric(6,3), (sc.s ->> 'tokens')::integer, sc.s -> 'reasons');
  get diagnostics v_updated = row_count;
  return v_updated;
end $function$;

-- ------------------------------------------------------- queue_watch_alerts

create or replace function public.queue_watch_alerts()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_closing integer := 0;
  v_outbid  integer := 0;
  v_closed  integer := 0;
begin
  if not exists (select 1 from watchlist) then
    return jsonb_build_object('closing_soon', 0, 'outbid', 0, 'closed', 0);
  end if;

  if exists (select 1 from watchlist where reminded_at is null) then
    with due as (
      select w.id as watch_id, w.user_id, l.id as lot_id, l.title, l.url, l.closes_at,
             w.max_bid_cents, l.current_bid_cents, l.next_bid_cents, l.primary_image_url, l.sale_level,
             coalesce((l.raw -> '_meta' ->> 'closeTimePrecise')::boolean, true) as precise,
             coalesce(a.timezone, 'America/Chicago') as tz,
             p.notify_email
        from watchlist w
        join lots l on l.id = w.lot_id
        join profiles p on p.id = w.user_id
        left join auctions a on a.id = l.auction_id
       where w.reminded_at is null
         and not l.closed
         and l.closes_at is not null
         and l.closes_at > now()
         and case
               when l.closes_at > now() + greatest(make_interval(secs => coalesce(w.remind_seconds_before, 600)),
                                                   interval '25 hours')
                 then false
               when coalesce((l.raw -> '_meta' ->> 'closeTimePrecise')::boolean, true)
                 then l.closes_at - make_interval(secs => coalesce(w.remind_seconds_before, 600)) <= now()
               else ((date_trunc('day', l.closes_at at time zone coalesce(a.timezone, 'America/New_York'))
                      + interval '8 hours') at time zone coalesce(a.timezone, 'America/New_York')) <= now()
             end
         for update of w skip locked
    ), ins as (
      insert into alerts (user_id, kind, lot_id, channel, title, body, payload, sent_at)
      select d.user_id, 'closing_soon', d.lot_id, ch.channel,
             'Closing soon: ' || left(d.title, 100),
             concat_ws(' ',
               case when d.precise
                    then format('Closes in about %s minutes.',
                                greatest(1, ceil(extract(epoch from (d.closes_at - now())) / 60))::int)
                    else 'Closes today. The source does not publish the exact time, so place your bid early.' end,
               case when d.max_bid_cents is not null
                    then format('Your walk-away number is %s.', fmt_cents(d.max_bid_cents)) end,
               case when d.current_bid_cents is not null
                    then format('Current bid %s.', fmt_cents(d.current_bid_cents)) end,
               case when d.sale_level then 'Open the sale to see its lots; bidding happens on the source site.' else 'Enter your one maximum bid on the source site.' end),
             jsonb_build_object('url', d.url, 'image', d.primary_image_url, 'closes_at', d.closes_at,
                                'close_time_precise', d.precise, 'max_bid_cents', d.max_bid_cents,
                                'current_bid_cents', d.current_bid_cents, 'next_bid_cents', d.next_bid_cents),
             case when ch.channel = 'in_app' then now() end
        from due d
        cross join (values ('in_app'), ('email')) ch(channel)
       where ch.channel = 'in_app' or coalesce(d.notify_email, false)
      returning 1
    ), marked as (
      update watchlist set reminded_at = now()
       where id in (select watch_id from due)
      returning 1
    )
    select (select count(*) from ins) into v_closing;
  end if;

  if exists (select 1 from watchlist where placed_bid and placed_bid_cents is not null) then
    insert into alerts (user_id, kind, lot_id, channel, title, body, payload, sent_at)
    select w.user_id, 'outbid', l.id, 'in_app',
           'Outbid: ' || left(l.title, 100),
           format('The current bid is %s, above your %s. Raise it only if your walk-away number allows.',
                  fmt_cents(l.current_bid_cents), fmt_cents(w.placed_bid_cents)),
           jsonb_build_object('url', l.url, 'at_cents', l.current_bid_cents,
                              'your_bid_cents', w.placed_bid_cents, 'max_bid_cents', w.max_bid_cents),
           now()
      from watchlist w
      join lots l on l.id = w.lot_id
     where w.placed_bid
       and w.placed_bid_cents is not null
       and l.current_bid_cents is not null
       and l.current_bid_cents > w.placed_bid_cents
       and not l.closed
       and not exists (select 1 from alerts x
                        where x.user_id = w.user_id and x.lot_id = l.id and x.kind = 'outbid'
                          and (x.payload ->> 'at_cents')::bigint >= l.current_bid_cents);
    get diagnostics v_outbid = row_count;
  end if;

  if exists (select 1 from watchlist where outcome is null) then
    insert into alerts (user_id, kind, lot_id, channel, title, body, payload, sent_at)
    select w.user_id, 'lot_sold', l.id, 'in_app',
           'Closed: ' || left(l.title, 100),
           case when coalesce(l.sold_price_cents, l.current_bid_cents) is not null
                then format('Final price %s.', fmt_cents(coalesce(l.sold_price_cents, l.current_bid_cents)))
                else 'Bidding has ended.' end
             || ' Record whether you won so your numbers improve.',
           jsonb_build_object('url', l.url, 'final_cents', coalesce(l.sold_price_cents, l.current_bid_cents),
                              'your_bid_cents', w.placed_bid_cents, 'max_bid_cents', w.max_bid_cents),
           now()
      from watchlist w
      join lots l on l.id = w.lot_id
     where l.closed
       and w.outcome is null
       and not exists (select 1 from alerts x
                        where x.user_id = w.user_id and x.lot_id = l.id and x.kind = 'lot_sold');
    get diagnostics v_closed = row_count;
  end if;

  return jsonb_build_object('closing_soon', v_closing, 'outbid', v_outbid, 'closed', v_closed);
end $function$;

-- ----------------------------------------------------------- reclassify_lots
create or replace function public.reclassify_lots(p_limit integer default 2000)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_ver integer;
  v_n   integer;
begin
  select vocabulary_version into v_ver from public.search_meta where id;
  -- Nothing behind the vocabulary (the usual case: lots_classify keeps every
  -- write current): two probes of lots_item_class_v_idx, no locks, no sort.
  if not exists (select 1 from public.lots where item_class_v < v_ver)
     and not exists (select 1 from public.lots where item_class_v is null) then
    return 0;
  end if;
  with todo as (
    select id from public.lots
     where item_class_v is null or item_class_v < v_ver
     order by closed, id
     limit greatest(coalesce(p_limit, 2000), 1)
       for update skip locked
  ), c as (
    -- A lateral call: (f(x)).* would run the classifier once per column.
    select l.id, x.heads, x.mods, x.mentions, x.head_words,
           public.extract_measures(l.title, l.description) as measures
      from public.lots l join todo using (id)
      cross join lateral public.classify_listing(l.title, l.description) x
  )
  update public.lots l
     set item_heads = c.heads, item_mods = c.mods, item_mentions = c.mentions,
         head_words = c.head_words, measures = c.measures, item_class_v = v_ver
    from c
   where l.id = c.id;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

-- ------------------------------------------------------- invoke_look_at_lots
create table if not exists private.look_at_lots_state (
  id             boolean primary key default true check (id),
  last_request   bigint,
  last_called_at timestamptz,
  configured     boolean,
  answered_at    timestamptz
);
insert into private.look_at_lots_state (id) values (true) on conflict (id) do nothing;
revoke all on private.look_at_lots_state from public, anon, authenticated;

create or replace function public.invoke_look_at_lots()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_state private.look_at_lots_state%rowtype;
  v_body  text;
  v_at    timestamptz;
  v_conf  boolean;
  v_want  text;
  v_url   text;
  v_key   text;
  v_token text;
  v_id    bigint;
begin
  select * into v_state from private.look_at_lots_state where id for update;

  -- What did look-at-lots answer last time? pg_net keeps responses for
  -- pg_net.ttl (6 h); this job runs at least hourly, so the answer is there.
  if v_state.last_request is not null then
    select r.content, r.created into v_body, v_at
      from net._http_response r
     where r.id = v_state.last_request and r.status_code = 200;
    if found then
      begin
        v_conf := (v_body::jsonb ->> 'configured')::boolean;
      exception when others then
        v_conf := null;
      end;
      update private.look_at_lots_state
         set configured = v_conf, answered_at = v_at, last_request = null
       where id;
      v_state.configured := v_conf;
    end if;
  end if;

  -- Every 3 minutes while it can look (0057); hourly while it has no key.
  if v_state.configured is not null then
    v_want := case when v_state.configured then '*/3 * * * *' else '41 * * * *' end;
    begin
      perform cron.alter_job(j.jobid, schedule := v_want)
         from cron.job j
        where j.jobname = 'look-at-lots' and j.schedule is distinct from v_want;
    exception when others then
      raise warning 'look-at-lots: could not reschedule: %', sqlerrm;
    end;
  end if;

  -- No ANTHROPIC_API_KEY: the function only answers {"configured":false}. Ask
  -- again every 3 hours, so it starts by itself within ~4 h of the key being set.
  if v_state.configured is false and v_state.last_called_at > now() - interval '2 hours 50 minutes' then
    return null;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'edge_functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'edge_functions_anon_key';
  select token into v_token from private.function_tokens where name = 'look-at-lots';
  if v_url is null or v_key is null or v_token is null then
    raise exception 'edge function secrets or the look-at-lots token are missing';
  end if;
  select net.http_post(
           url                  := rtrim(v_url, '/') || '/look-at-lots',
           body                 := '{}'::jsonb,
           headers              := jsonb_build_object('Content-Type', 'application/json',
                                                      'Authorization', 'Bearer ' || v_key,
                                                      'x-look-token', v_token),
           timeout_milliseconds := 150000)
    into v_id;
  update private.look_at_lots_state set last_request = v_id, last_called_at = now() where id;
  return v_id;
end $function$;

-- ------------------------------------------------- search_tsv, kept by trigger
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.lots_search_tsv()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  -- The 0002 generated expression, recomputed only when an input changes. A
  -- price-only update leaves the stored datum alone, so it can be HOT.
  -- A BEFORE trigger that rewrites one of these five columns must also make
  -- sure this one runs: the UPDATE must name that column (this trigger fires
  -- only on UPDATE OF its columns), and it must sort before 'lots_search_tsv'.
  if tg_op = 'UPDATE'
     and new.title       is not distinct from old.title
     and new.brand       is not distinct from old.brand
     and new.model       is not distinct from old.model
     and new.description is not distinct from old.description
     and new.lot_number  is not distinct from old.lot_number then
    return new;
  end if;
  new.search_tsv :=
       setweight(to_tsvector('english'::regconfig, coalesce(new.title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(new.brand, '') || ' ' || coalesce(new.model, '')), 'B')
    || setweight(to_tsvector('english'::regconfig, coalesce(new.description, '')), 'C')
    || setweight(to_tsvector('english'::regconfig, coalesce(new.lot_number, '')), 'D');
  return new;
end $function$;

revoke execute on function public.lots_search_tsv() from public, anon, authenticated;

-- Invalid leftovers of interrupted CONCURRENTLY builds of lots_seen_tsv_idx
-- (see the index section below). None was ready, so none held data or was
-- maintained; they are dropped here, under the lock this block takes anyway.
do $$ begin
  if exists (select 1 from pg_index where indexrelid = to_regclass('public.lots_seen_tsv_idx') and not indisvalid) then
    drop index public.lots_seen_tsv_idx;
  end if;
end $$;
drop index if exists public.lots_seen_tsv_idx_ccnew;
drop index if exists public.lots_seen_tsv_idx_ccnew1;
drop index if exists public.lots_seen_tsv_idx_ccnew2;
drop index if exists public.lots_seen_tsv_idx_ccnew3;
drop index if exists public.lots_seen_tsv_idx_ccnew4;
drop index if exists public.lots_seen_tsv_idx_ccnew5;
drop index if exists public.lots_seen_tsv_idx_ccnew6;
drop index if exists public.lots_seen_tsv_idx_ccnew7;
drop index if exists public.lots_seen_tsv_idx_ccnew8;
drop index if exists public.lots_seen_tsv_idx_ccnew9;
drop index if exists public.lots_seen_tsv_idx_ccnew10;
drop index if exists public.lots_seen_tsv_idx_ccnew11;
drop index if exists public.lots_seen_tsv_idx_ccnew12;
drop index if exists public.lots_seen_tsv_idx_ccnew13;
drop index if exists public.lots_seen_tsv_idx_ccnew14;

do $$
begin
  if exists (select 1 from pg_attribute
              where attrelid = 'public.lots'::regclass and attname = 'search_tsv' and attgenerated = 's') then
    alter table public.lots alter column search_tsv drop expression;
  end if;
end $$;

drop trigger if exists lots_search_tsv on public.lots;
create trigger lots_search_tsv
  before insert or update of title, brand, model, description, lot_number on public.lots
  for each row execute function public.lots_search_tsv();

alter table public.lots set (fillfactor = 70);

commit;

-- ------------------------------------------------------------- the index
-- Its own call, after the block above. CREATE INDEX CONCURRENTLY was tried
-- first (from execute_sql and from a one-off cron job): on the starved
-- instance its waits for older transactions outlasted every timeout, and each
-- interrupted build left an invalid index that IF NOT EXISTS would then skip.
-- A plain build is transactional, so an interrupted one leaves nothing. It
-- holds a SHARE lock: reads go on, lot writes wait for the build (seen_tsv is
-- empty for most lots, so it is small).
begin;
set local lock_timeout = '3s';
set local statement_timeout = '120s';
create index if not exists lots_seen_tsv_idx on public.lots using gin (seen_tsv);
commit;

-- --------------------------------------------------------------------- cron
-- Sleeper back to every 15 minutes, reclassify down from every 5 to every 15.
-- The hunt matcher stays every 5 minutes (alerts cannot be fresher than the
-- 5-minute crawl) and comes back on only once search_lots has its index.
do $$ begin
  if not exists (select 1 from pg_index
                  where indexrelid = to_regclass('public.lots_seen_tsv_idx') and indisvalid and indisready) then
    raise exception 'lots_seen_tsv_idx is missing or invalid: leave hunt-matcher paused';
  end if;
end $$;

select cron.alter_job(j.jobid, schedule := v.schedule, active := true)
  from (values ('sleeper-refresh', '8-59/15 * * * *'),
               ('reclassify-lots', '3-59/15 * * * *'),
               ('hunt-matcher',    '4-59/5 * * * *')) v(jobname, schedule)
  join cron.job j on j.jobname = v.jobname;

-- The one-off job that tried the concurrent build.
select cron.unschedule(jobname) from cron.job where jobname = 'build-seen-tsv-idx';
