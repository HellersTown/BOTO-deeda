-- 0055: every open lot's price and bids fresh within the hour, cheaply.
--
-- WHY. Asked for on 2026-10-05: once a listing is known, keep watching its
-- price and current bids at least every hour. Measured that day, Hansen Auction
-- Group had 4,759 open lots and 3,862 of them unseen for 6+ hours: each hourly
-- run re-read whole sales and its budget reached ~800 lots. And every run
-- rewrote every lot it read, every column, and upserted every photo again
-- (lot_images: 2.5 million updates for 85,590 rows; lots: 898,000 for 14,449).
-- That weight is what cancelled a Hueckman ingest_batch chunk on its 30 s
-- statement timeout (2026-10-04 17:45 UTC), while refresh_sleeper_scores held
-- up to 5,000 lots locked in one statement.
--
-- WHAT CHANGES.
-- 1. ingest_batch hashes each incoming lot's content: everything except price,
--    bids, reserve, close time and raw, plus raw._meta and the location it
--    resolves to (ingest_content_md5, kept in lots.content_md5). A known lot
--    whose content is unchanged gets a price-only update: price, bids, reserve,
--    close time, closed, last_seen_at, and its sleeper score only when those
--    moved. No text, location or photo is rewritten, so neither the classifier
--    nor the gazetteer trigger fires. Photos are upserted only for new lots and
--    lots whose photo list changed, and an unchanged photo row is not rewritten.
--    A new or changed lot takes the full path, exactly as 0010 and 0023 left it.
--    crawl_runs.lots_price_only counts the light updates.
-- 2. An auction the adapter read in full (NormalizedAuction.itemsComplete) gets
--    auctions.items_read_at and items_read_count, and is listed in
--    crawl_runs.complete_auctions. crawl_run_finish then closes that auction's
--    open lots the run did not see (withdrawn), behind the same 30% drift
--    guard the whole-source snapshot uses.
-- 3. crawl_known_state(source) answers what the database holds for a source,
--    compactly, so the BidWrangler adapter reads new sales in full and refreshes
--    known lots by id where due (packages/ingest/src/known.ts, planWatch).
-- 4. refresh_sleeper_scores claims its rows FOR UPDATE SKIP LOCKED, as 0054's
--    reclassifier does: it never makes a crawler wait.
-- 5. BidWrangler houses run every 15 minutes. A run with nothing due costs one
--    request (the sale list); the cadence is what makes "every open lot within
--    the hour, lots closing within 3 hours on every run" hold.
--
-- Applied with execute_sql. Nothing here deletes or drops.

alter table public.lots add column if not exists content_md5 text;
alter table public.auctions add column if not exists items_read_at timestamptz;
alter table public.auctions add column if not exists items_read_count integer;
alter table public.crawl_runs add column if not exists lots_price_only integer not null default 0;
alter table public.crawl_runs add column if not exists complete_auctions text[] not null default '{}';

-- What a lot IS, as one hash: the incoming NormalizedLot minus what changes as
-- it is bid on, plus raw._meta (the adapter's notes the app reads) and where it
-- resolves (its own pickup, else its auction's, and the auction's point).
create or replace function public.ingest_content_md5(p_lot jsonb, p_eff_pickup jsonb, p_auction_geom text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select md5((
    (p_lot - array['startingBidCents', 'currentBidCents', 'nextBidCents', 'soldPriceCents',
                   'bidCount', 'reserveMet', 'closesAt', 'closed', 'raw'])
    || jsonb_build_object('_meta', p_lot -> 'raw' -> '_meta',
                          '_eff', p_eff_pickup,
                          '_ageo', p_auction_geom)
  )::text)
$$;

-- One batch of NormalizedLots for one source, read once into rows, with what
-- the database already holds for each. ingest_batch reads it for each step.
create or replace function public.ingest_parse_lots(p_source uuid, p_lots jsonb)
returns table (
  external_id text, auction_external_id text, lot_number text, title text,
  description text, brand text, model text, condition text, quantity integer,
  starting_bid_cents bigint, current_bid_cents bigint, next_bid_cents bigint,
  estimate_low_cents bigint, estimate_high_cents bigint, sold_price_cents bigint,
  bid_count integer, reserve_met boolean, closes_at timestamptz, closed boolean,
  url text, pickup jsonb, ships boolean, images jsonb, raw jsonb, sale_level boolean,
  auction_id uuid, auction_geom extensions.geography, eff_pickup jsonb, urls text[],
  md5 text, existing_id uuid, old_md5 text, old_image_urls text[])
language sql
stable
set search_path = public, extensions
as $$
  with src as (
    select distinct on (l."externalId") l.*, to_jsonb(l) as j
      from jsonb_to_recordset(coalesce(p_lots, '[]'::jsonb)) as l(
        "externalId" text, "auctionExternalId" text, "lotNumber" text, title text,
        description text, brand text, model text, condition text, quantity integer,
        "startingBidCents" bigint, "currentBidCents" bigint, "nextBidCents" bigint,
        "estimateLowCents" bigint, "estimateHighCents" bigint, "soldPriceCents" bigint,
        "bidCount" integer, "reserveMet" boolean, "closesAt" timestamptz,
        closed boolean, url text, pickup jsonb, ships boolean, images jsonb, raw jsonb,
        "saleLevel" boolean)
     where l."externalId" is not null and l.title is not null
     order by l."externalId"
  ), joined as (
    select s.*,
           a.id          as a_id,
           a.pickup_geom as a_geom,
           coalesce(s.pickup, case when a.id is not null then jsonb_build_object(
             'line1', a.pickup_line1, 'city', a.pickup_city,
             'state', a.pickup_state, 'postalCode', a.pickup_postal_code) end) as eff,
           coalesce((select array_agg(i->>'url' order by coalesce((i->>'position')::int, n::int))
                       from jsonb_array_elements(coalesce(s.images, '[]'::jsonb))
                            with ordinality as x(i, n)
                      where nullif(i->>'url', '') is not null), '{}'::text[]) as u
      from src s
      left join auctions a
        on a.source_id = p_source and a.external_id = s."auctionExternalId"
  )
  select j."externalId", j."auctionExternalId", j."lotNumber", j.title,
         j.description, j.brand, j.model, j.condition, j.quantity,
         j."startingBidCents", j."currentBidCents", j."nextBidCents",
         j."estimateLowCents", j."estimateHighCents", j."soldPriceCents",
         j."bidCount", j."reserveMet", j."closesAt", j.closed,
         j.url, j.pickup, j.ships, j.images, j.raw, j."saleLevel",
         j.a_id, j.a_geom, j.eff, j.u,
         public.ingest_content_md5(j.j, j.eff, j.a_geom::text),
         e.id, e.content_md5, e.image_urls
    from joined j
    left join lots e on e.source_id = p_source and e.external_id = j."externalId"
$$;

-- As 0010 (patched in place by 0023), with the price-only path, the photo diff
-- and the full-read marks.
create or replace function public.ingest_batch(p_run_id bigint, p_auctions jsonb default '[]'::jsonb, p_lots jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
set search_path = public, extensions
as $function$
declare
  v_source   uuid;
  v_auctions integer := 0;
  v_full     integer := 0;
  v_new      integer := 0;
  v_light    integer := 0;
  v_images   integer := 0;
  v_img_ext  text[];
begin
  select source_id into v_source
    from crawl_runs where id = p_run_id and status = 'running';
  if v_source is null then
    raise exception 'crawl run % is not running', p_run_id;
  end if;

  -- Auctions, as before; an auction read in full this run is marked so.
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
      last_seen_at       = now(),
      items_read_at      = coalesce(excluded.items_read_at, t.items_read_at),
      items_read_count   = case when excluded.items_read_at is not null
                                then excluded.items_read_count else t.items_read_count end
    returning 1
  )
  select count(*) into v_auctions from up;

  update crawl_runs r
     set complete_auctions = array(select distinct e from unnest(r.complete_auctions || c.ids) e order by e)
    from (select array_agg(a->>'externalId') as ids
            from jsonb_array_elements(coalesce(p_auctions, '[]'::jsonb)) a
           where nullif(a->>'externalId', '') is not null
             and coalesce((a->>'itemsComplete')::boolean, false)) c
   where r.id = p_run_id and c.ids is not null;

  -- 1. Known lots whose content is unchanged: price, bids and close only.
  with light as (
    select p.existing_id as id, p.starting_bid_cents, p.current_bid_cents, p.next_bid_cents,
           p.sold_price_cents, p.bid_count, p.reserve_met, p.closes_at,
           coalesce(p.closed, false) as closed,
           case when not e.sale_level
                 and (e.bid_count, e.current_bid_cents, e.closes_at)
                     is distinct from (p.bid_count, p.current_bid_cents, p.closes_at)
                then compute_sleeper(e.title, e.description, p.bid_count, p.current_bid_cents,
                                     e.estimate_low_cents, e.image_count, p.closes_at) end as sc
      from ingest_parse_lots(v_source, p_lots) p
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
  )
  select count(*) into v_light from upd;

  -- Which lots' photos to write: new lots, and lots whose photo list changed.
  -- Read before the full write below replaces lots.image_urls.
  select coalesce(array_agg(p.external_id), '{}') into v_img_ext
    from ingest_parse_lots(v_source, p_lots) p
   where p.existing_id is null or p.old_image_urls is distinct from p.urls;

  -- 2. New lots and lots whose content changed: the full write, as before.
  with resolved as (
    select * from ingest_parse_lots(v_source, p_lots) p
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
      last_seen_at        = now(),
      updated_at = case
        when (t.title, t.description, t.current_bid_cents, t.bid_count,
              t.closes_at, t.closed, t.image_count)
             is distinct from
             (excluded.title, excluded.description, excluded.current_bid_cents,
              excluded.bid_count, excluded.closes_at, excluded.closed, excluded.image_count)
        then now() else t.updated_at end
    returning t.id
  )
  select count(*), (select count(*) from resolved where existing_id is null)
    into v_full, v_new
    from up;

  -- 3. Photos, only where needed; an unchanged row is not rewritten.
  with src as (
    select distinct on (l."externalId") l."externalId", l.images
      from jsonb_to_recordset(coalesce(p_lots, '[]'::jsonb)) as l("externalId" text, images jsonb)
     where l."externalId" = any(v_img_ext)
     order by l."externalId"
  ), img as (
    select lt.id as lot_id, i->>'url' as url,
           coalesce((i->>'position')::int, n::int - 1) as position,
           (i->>'width')::int as width, (i->>'height')::int as height
      from src s
      join lots lt on lt.source_id = v_source and lt.external_id = s."externalId"
      cross join lateral jsonb_array_elements(coalesce(s.images, '[]'::jsonb))
           with ordinality as x(i, n)
     where nullif(i->>'url', '') is not null
  ), ins as (
    insert into lot_images as li (lot_id, url, position, width, height)
    select distinct on (lot_id, url) lot_id, url, position, width, height
      from img order by lot_id, url, position
    on conflict (lot_id, url) do update set position = excluded.position
     where li.position is distinct from excluded.position
    returning 1
  )
  select count(*) into v_images from ins;

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

-- As 0010, plus: an auction read in full in this run closes its lots the run
-- did not see, when the run saw at least 30% of that auction's open lots.
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
             count(*) filter (where l.last_seen_at >= v_run.started_at) as seen_n
        from auctions a
        join lots l on l.auction_id = a.id and l.closed = false
       where a.source_id = v_run.source_id
         and a.external_id = any(v_run.complete_auctions)
       group by a.id
    ), gone as (
      update lots l
         set closed = true, updated_at = now()
        from per p
       where l.auction_id = p.auction_id
         and l.closed = false
         and l.last_seen_at < v_run.started_at
         and p.seen_n >= 0.3 * p.open_n
      returning 1
    )
    select (select count(*) from gone),
           (select count(*) from per where seen_n < 0.3 * open_n)
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

-- What the database holds for one source, for the crawler (known.ts reads it).
create or replace function public.crawl_known_state(p_source_id uuid)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'lots', coalesce((
      select jsonb_agg(jsonb_build_array(
               l.external_id, a.external_id,
               (extract(epoch from l.last_seen_at) * 1000)::bigint,
               (extract(epoch from l.closes_at) * 1000)::bigint))
        from lots l
        left join auctions a on a.id = l.auction_id
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
$$;

-- As 0006, with its rows claimed FOR UPDATE SKIP LOCKED.
create or replace function public.refresh_sleeper_scores(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare v_updated integer := 0;
begin
  with target as (
    select id from lots
     where closed = false and not sale_level
       and (sleeper_score is null or updated_at > now() - interval '2 hours')
     order by coalesce(closes_at, 'infinity'::timestamptz) asc
     limit p_limit
       for update skip locked
  ), scored as (
    select l.id, compute_sleeper(l.title, l.description, l.bid_count, l.current_bid_cents,
             l.estimate_low_cents, l.image_count, l.closes_at) as s
      from lots l join target t on t.id = l.id
  )
  update lots l
     set sleeper_score = (sc.s ->> 'score')::numeric,
         desc_richness = (sc.s ->> 'tokens')::integer,
         sleeper_reasons = sc.s -> 'reasons'
    from scored sc where l.id = sc.id;
  get diagnostics v_updated = row_count;
  return v_updated;
end $function$;

revoke execute on function public.ingest_content_md5(jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.ingest_parse_lots(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.crawl_known_state(uuid) from public, anon, authenticated;
grant execute on function public.ingest_content_md5(jsonb, jsonb, text) to service_role;
grant execute on function public.ingest_parse_lots(uuid, jsonb) to service_role;
grant execute on function public.crawl_known_state(uuid) to service_role;

-- BidWrangler houses every 15 minutes (point 5).
update public.sources
   set crawl_cadence_min = 15
 where platform = 'bidwrangler' and crawl_cadence_min <> 15;
