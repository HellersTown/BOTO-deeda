-- 0010_ingest_pipeline.sql
--
-- The write path from an adapter's output into the catalogue, the scheduler's
-- work queue, and the probe log that records what each live site actually does
-- when our crawler knocks.
--
-- DESIGN: the database is the scheduler. Edge Functions are workers that ask
-- "what is due?" and are told. That has a property worth more than elegance:
-- an Edge Function URL is reachable by anyone holding the public anon key, so a
-- worker that crawled whatever it was asked to could be turned into a tool for
-- hammering a small auctioneer's website. A worker that can only crawl what the
-- database says is DUE cannot be made to crawl faster than the source's cadence,
-- however often it is invoked.
--
-- Everything here that writes is callable by the service role only.

-- ------------------------------------------------------------- hourly floor
-- Owner requirement (2026-09-27): every monitored site is refreshed at least
-- once an hour. Enforced as data rather than convention: a cadence longer than
-- 60 minutes cannot be stored. deeplink_only sources are never crawled at all,
-- so they are exempt.

alter table sources drop constraint if exists sources_hourly_floor;
alter table sources add constraint sources_hourly_floor
  check (ingest = 'deeplink_only' or crawl_cadence_min between 1 and 60);

-- ------------------------------------------------------ access + scheduling

alter table sources add column if not exists access_status text;
alter table sources add column if not exists access_checked_at timestamptz;
alter table sources add column if not exists access_note text;
alter table sources add column if not exists next_due_at timestamptz;
alter table sources add column if not exists lease_until timestamptz;

alter table sources drop constraint if exists sources_access_status_check;
alter table sources add constraint sources_access_status_check
  check (access_status is null or access_status in
    ('open', 'blocked', 'robots_disallowed', 'unreachable', 'deeplink_only', 'unknown'));

comment on column sources.access_status is
  'What the live probe observed for OUR honest client. blocked = a 403/429/challenge from a bot manager: route to deep links, never work around it.';

-- ------------------------------------------------------------- probe log
-- One row per request the probe made. Kept raw on purpose: when a site's
-- behaviour changes, the history of exactly what it returned is the evidence.

create table if not exists source_probes (
  id             bigserial primary key,
  source_id      uuid not null references sources(id) on delete cascade,
  probed_at      timestamptz not null default now(),
  target         text not null,      -- robots | home | listing | api | sitemap | feed
  url            text not null,
  status         integer,            -- HTTP status; 0 = network error or timeout
  final_url      text,               -- after redirects
  latency_ms     integer,
  bytes          integer,
  content_type   text,
  server         text,
  blocked_by     text,               -- cloudflare | akamai | perimeterx | datadome | incapsula | aws_waf | sucuri | captcha
  challenge      boolean not null default false,
  robots_verdict text,               -- allowed | disallowed | unreachable | absent
  crawl_delay_s  numeric,
  jsonld_types   text[],
  feed_urls      text[],
  sitemaps       text[],
  error          text,
  detail         jsonb
);
create index if not exists source_probes_source_idx on source_probes (source_id, probed_at desc);

alter table source_probes enable row level security;
-- No policy: an ops table, readable by the service role only (see 0003 on
-- crawl_runs for the same reasoning).

-- ---------------------------------------------------------- crawl_run_start

create or replace function crawl_run_start(p_source_id uuid, p_method ingest_method default null)
returns bigint
language plpgsql
set search_path = public, extensions
as $$
declare
  v_id bigint;
begin
  insert into crawl_runs (source_id, method, status, started_at)
  values (p_source_id,
          coalesce(p_method, (select ingest from sources where id = p_source_id)),
          'running', now())
  returning id into v_id;

  update sources set last_crawled_at = now() where id = p_source_id;
  return v_id;
end $$;

-- ------------------------------------------------------------ ingest_batch
-- Takes the adapter's normalized output exactly as the TypeScript types define
-- it (camelCase), so no worker has to re-map fields: one mapping, here.
--
-- Idempotent: re-sending the same batch updates rows in place, keyed on
-- (source_id, external_id). A batch may be one chunk of a run; call it as many
-- times as needed, then crawl_run_finish once.

create or replace function ingest_batch(
  p_run_id   bigint,
  p_auctions jsonb default '[]'::jsonb,
  p_lots     jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_source   uuid;
  v_auctions integer := 0;
  v_lots     integer := 0;
  v_new      integer := 0;
  v_images   integer := 0;
begin
  select source_id into v_source
    from crawl_runs where id = p_run_id and status = 'running';
  if v_source is null then
    raise exception 'crawl run % is not running', p_run_id;
  end if;

  -- ---------------------------------------------------------------- auctions
  with src as (
    -- DISTINCT ON: a duplicate key inside one batch would otherwise abort the
    -- whole statement ("cannot affect row a second time").
    select distinct on (a."externalId") a.*
      from jsonb_to_recordset(coalesce(p_auctions, '[]'::jsonb)) as a(
        "externalId" text, title text, description text, auctioneer text, url text,
        format text, "startsAt" timestamptz, "endsAt" timestamptz, timezone text,
        pickup jsonb, "pickupRequired" boolean, ships boolean, "shipsNote" text,
        "sellerName" text, "sellerState" text, "lotCount" integer, currency text,
        "buyerPremiumPct" numeric, "buyerPremiumNote" text, "termsUrl" text, raw jsonb)
     where a."externalId" is not null and a.title is not null
     order by a."externalId"
  ), up as (
    insert into auctions as t (
      source_id, external_id, title, description, auctioneer, url, format,
      starts_at, ends_at, timezone,
      pickup_line1, pickup_city, pickup_state, pickup_postal_code, pickup_geom,
      pickup_required, ships, ships_note, seller_name, seller_state, lot_count,
      currency, buyer_premium_pct, buyer_premium_note, terms_url, raw, last_seen_at)
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
      s."termsUrl", s.raw, now()
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
      last_seen_at       = now()
    returning 1
  )
  select count(*) into v_auctions from up;

  -- -------------------------------------------------------------------- lots
  with src as (
    select distinct on (l."externalId") l.*
      from jsonb_to_recordset(coalesce(p_lots, '[]'::jsonb)) as l(
        "externalId" text, "auctionExternalId" text, "lotNumber" text, title text,
        description text, brand text, model text, condition text, quantity integer,
        "startingBidCents" bigint, "currentBidCents" bigint, "nextBidCents" bigint,
        "estimateLowCents" bigint, "estimateHighCents" bigint, "soldPriceCents" bigint,
        "bidCount" integer, "reserveMet" boolean, "closesAt" timestamptz,
        closed boolean, url text, pickup jsonb, ships boolean, images jsonb, raw jsonb)
     where l."externalId" is not null and l.title is not null
     order by l."externalId"
  ), resolved as (
    select s.*,
           a.id          as auction_id,
           a.pickup_geom as auction_geom,
           -- A lot inherits its auction's pickup unless it declares its own:
           -- some auctions span several sites, and the lot is what you drive to.
           coalesce(s.pickup, case when a.id is not null then jsonb_build_object(
             'line1', a.pickup_line1, 'city', a.pickup_city,
             'state', a.pickup_state, 'postalCode', a.pickup_postal_code) end) as eff_pickup,
           coalesce((select array_agg(i->>'url' order by coalesce((i->>'position')::int, n::int))
                       from jsonb_array_elements(coalesce(s.images, '[]'::jsonb))
                            with ordinality as x(i, n)
                      where nullif(i->>'url', '') is not null), '{}'::text[]) as urls,
           exists (select 1 from lots e
                    where e.source_id = v_source and e.external_id = s."externalId") as existed
      from src s
      left join auctions a
        on a.source_id = v_source and a.external_id = s."auctionExternalId"
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
      raw, last_seen_at, updated_at)
    select
      r.auction_id, v_source, r."externalId", r."lotNumber", r.title, r.description,
      r.brand, r.model, r.condition, coalesce(r.quantity, 1),
      r."startingBidCents", r."currentBidCents", r."nextBidCents",
      r."estimateLowCents", r."estimateHighCents", r."soldPriceCents",
      r."bidCount", r."reserveMet", r."closesAt", coalesce(r.closed, false), r.url,
      nullif(r.eff_pickup->>'city', ''), upper(nullif(r.eff_pickup->>'state', '')),
      nullif(r.eff_pickup->>'postalCode', ''),
      -- Explicit coordinates win; otherwise the gazetteer trigger resolves the
      -- ZIP; a lot with neither falls back to its auction's resolved point.
      coalesce(
        case when r.eff_pickup->>'lat' is not null and r.eff_pickup->>'lon' is not null
             then st_setsrid(st_makepoint((r.eff_pickup->>'lon')::float8,
                                          (r.eff_pickup->>'lat')::float8), 4326)::geography end,
        case when nullif(r.eff_pickup->>'postalCode', '') is null then r.auction_geom end),
      coalesce(r.ships, false),
      r.urls[1], r.urls, coalesce(array_length(r.urls, 1), 0),
      (sc.s ->> 'tokens')::integer, (sc.s ->> 'score')::numeric, sc.s -> 'reasons',
      r.raw, now(), now()
    from resolved r
    cross join lateral (
      select compute_sleeper(r.title, r.description, r."bidCount", r."currentBidCents",
                             r."estimateLowCents", coalesce(array_length(r.urls, 1), 0),
                             r."closesAt") as s) sc
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
      -- A soft close that moved later is an EXTENSION: count it, because a lot
      -- that keeps extending is a lot with a live bidding war.
      extended_count      = t.extended_count
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
      last_seen_at        = now(),
      -- updated_at moves only on a MATERIAL change. The hunt matcher keys on it,
      -- so bumping it on every hourly re-crawl would re-alert on unchanged lots.
      updated_at = case
        when (t.title, t.description, t.current_bid_cents, t.bid_count,
              t.closes_at, t.closed, t.image_count)
             is distinct from
             (excluded.title, excluded.description, excluded.current_bid_cents,
              excluded.bid_count, excluded.closes_at, excluded.closed, excluded.image_count)
        then now() else t.updated_at end
    returning t.id
  )
  select count(*), (select count(*) from resolved where not existed)
    into v_lots, v_new
    from up;

  -- ------------------------------------------------------------------ images
  with src as (
    select distinct on (l."externalId") l."externalId", l.images
      from jsonb_to_recordset(coalesce(p_lots, '[]'::jsonb)) as l("externalId" text, images jsonb)
     where l."externalId" is not null
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
    insert into lot_images (lot_id, url, position, width, height)
    select distinct on (lot_id, url) lot_id, url, position, width, height
      from img order by lot_id, url, position
    on conflict (lot_id, url) do update set position = excluded.position
    returning 1
  )
  select count(*) into v_images from ins;

  update crawl_runs
     set auctions_seen = auctions_seen + v_auctions,
         lots_seen     = lots_seen + v_lots,
         lots_new      = lots_new + v_new,
         lots_updated  = lots_updated + (v_lots - v_new),
         images_queued = images_queued + v_images
   where id = p_run_id;

  return jsonb_build_object(
    'auctions', v_auctions, 'lots', v_lots, 'lots_new', v_new,
    'lots_updated', v_lots - v_new, 'images', v_images);
end $$;

-- -------------------------------------------------------- crawl_run_finish

create or replace function crawl_run_finish(
  p_run_id            bigint,
  p_status            crawl_status,
  p_http_requests     integer default 0,
  p_warnings          jsonb   default '[]'::jsonb,
  p_error             text    default null,
  p_complete_snapshot boolean default false
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_run          crawl_runs;
  v_open_before  integer := 0;
  v_closed       integer := 0;
  v_close_skip   boolean := false;
  v_median       numeric;
  v_seen         integer;
begin
  select * into v_run from crawl_runs where id = p_run_id for update;
  if not found then
    raise exception 'crawl run % not found', p_run_id;
  end if;

  -- Count what this run actually saw, from the rows themselves. Summing batch
  -- sizes double-counts any chunk a worker retried (the rolled-back test of this
  -- migration showed 8 "seen" for 4 lots), and an inflated count would weaken
  -- the drift guard below.
  select count(*) into v_seen
    from lots where source_id = v_run.source_id and last_seen_at >= v_run.started_at;

  -- A COMPLETE snapshot (the source returned its whole live catalogue, as GSA
  -- does) lets us close lots that disappeared. The drift guard matters more than
  -- the feature: a snapshot under 30% of what was open is far likelier to be a
  -- parser that broke than a mass close, and closing on it would silently hide
  -- the catalogue from every user.
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
                           'close_skipped_drift', case when v_close_skip then true end))
   where id = p_run_id;

  if p_status in ('ok', 'partial') then
    update sources
       set last_ok_at = now(),
           consecutive_failures = 0,
           next_due_at = now() + make_interval(mins => least(greatest(crawl_cadence_min, 1), 60)),
           lease_until = null
     where id = v_run.source_id;
  else
    -- Back off on failure, but never past the hourly floor: the owner's
    -- requirement is that every monitored site is tried at least once an hour.
    update sources
       set consecutive_failures = coalesce(consecutive_failures, 0) + 1,
           next_due_at = now() + least(
             make_interval(mins => least(greatest(crawl_cadence_min, 1), 60))
               * power(2, least(coalesce(consecutive_failures, 0), 4)),
             interval '60 minutes'),
           lease_until = null
     where id = v_run.source_id;
  end if;

  -- Source health: last vs median lots per run is the drift signal that tells
  -- "no new lots" apart from "the parser silently broke".
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
    'open_before', v_open_before);
end $$;

-- ------------------------------------------------------- claim_due_sources
-- The scheduler. Returns sources that are due, and leases them so two workers
-- never crawl the same source at once. SKIP LOCKED makes concurrent claims safe.
--
-- Crawl eligibility is every gate at once, and any one failing means NO:
--   active, a legal determination that allows ingest, not deep-link-only, a
--   robots verdict that allows (official APIs are exempt: robots.txt governs
--   crawling websites, not using a published keyed API), and no observed block.

create or replace function claim_due_sources(
  p_platforms     text[]  default null,
  p_limit         integer default 5,
  p_lease_minutes integer default 10
)
returns setof sources
language sql
set search_path = public, extensions
as $$
  update sources s
     set lease_until = now() + make_interval(mins => greatest(p_lease_minutes, 1))
   where s.id in (
     select c.id
       from sources c
      where c.active
        and coalesce(c.ingest_allowed, false)
        and c.ingest is distinct from 'deeplink_only'
        and (c.robots_allows is true or c.ingest = 'official_api')
        and coalesce(c.access_status, 'unknown') not in ('blocked', 'robots_disallowed')
        and (p_platforms is null or c.platform = any(p_platforms))
        and coalesce(c.next_due_at, '-infinity'::timestamptz) <= now()
        and coalesce(c.lease_until, '-infinity'::timestamptz) < now()
      order by c.priority, c.next_due_at nulls first
      limit greatest(least(p_limit, 50), 1)
      for update skip locked)
  returning s.*;
$$;

-- ------------------------------------------------------ record_source_probe

create or replace function record_source_probe(
  p_source_id     uuid,
  p_rows          jsonb,
  p_access_status text,
  p_robots_allows boolean,
  p_note          text default null
)
returns integer
language plpgsql
set search_path = public, extensions
as $$
declare
  v_n integer;
begin
  insert into source_probes (source_id, target, url, status, final_url, latency_ms,
                             bytes, content_type, server, blocked_by, challenge,
                             robots_verdict, crawl_delay_s, jsonld_types, feed_urls,
                             sitemaps, error, detail)
  select p_source_id, r.target, r.url, r.status, r.final_url, r.latency_ms, r.bytes,
         r.content_type, r.server, r.blocked_by, coalesce(r.challenge, false),
         r.robots_verdict, r.crawl_delay_s, r.jsonld_types, r.feed_urls, r.sitemaps,
         r.error, r.detail
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
      target text, url text, status integer, final_url text, latency_ms integer,
      bytes integer, content_type text, server text, blocked_by text, challenge boolean,
      robots_verdict text, crawl_delay_s numeric, jsonld_types text[], feed_urls text[],
      sitemaps text[], error text, detail jsonb)
   where r.target is not null and r.url is not null;
  get diagnostics v_n = row_count;

  update sources
     set access_status     = p_access_status,
         access_checked_at = now(),
         access_note       = p_note,
         robots_allows     = p_robots_allows,
         robots_checked_at = now()
   where id = p_source_id;

  return v_n;
end $$;

-- ------------------------------------------------------------ v_source_status
-- What the app may show publicly about a source's health: "last refreshed 12
-- minutes ago" is the trust signal competitors' users say they never get. No
-- operational internals (error text, rate limits, notes) are exposed here.

create or replace view v_source_status
with (security_invoker = true)
as
select s.slug, s.name, s.url, s.tier, s.platform, s.ingest,
       s.access_status, s.access_checked_at, s.last_ok_at, s.crawl_cadence_min,
       (select count(*) from lots l where l.source_id = s.id and not l.closed) as open_lots
  from sources s
 where s.active;

grant select on v_source_status to anon, authenticated;

-- --------------------------------------------------------------- privileges
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase
-- exposes public-schema functions as RPC endpoints. Without these revokes, any
-- visitor could write lots into the catalogue.

revoke execute on function crawl_run_start(uuid, ingest_method) from public, anon, authenticated;
revoke execute on function ingest_batch(bigint, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function crawl_run_finish(bigint, crawl_status, integer, jsonb, text, boolean) from public, anon, authenticated;
revoke execute on function claim_due_sources(text[], integer, integer) from public, anon, authenticated;
revoke execute on function record_source_probe(uuid, jsonb, text, boolean, text) from public, anon, authenticated;

grant execute on function crawl_run_start(uuid, ingest_method) to service_role;
grant execute on function ingest_batch(bigint, jsonb, jsonb) to service_role;
grant execute on function crawl_run_finish(bigint, crawl_status, integer, jsonb, text, boolean) to service_role;
grant execute on function claim_due_sources(text[], integer, integer) to service_role;
grant execute on function record_source_probe(uuid, jsonb, text, boolean, text) to service_role;
