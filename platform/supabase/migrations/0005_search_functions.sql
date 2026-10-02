-- 0005_search_functions.sql
-- Search, geography and the sleeper score.
--
-- THE RELEVANCE MODEL is the important idea in this file, so it gets explained
-- before the code.
--
-- Every existing auction site models location as a single field: the auction is
-- "in Wisconsin" or it is not. That is wrong, and it is why a Wisconsin buyer
-- misses most of what they could actually buy. Three different things get
-- flattened into one:
--
--   * A federal surplus lot sitting in Milwaukee, listed by an agency in
--     Virginia, on a nationwide platform, tagged "VA".
--   * An online-only auction with no physical address at all that ships
--     anywhere, therefore just as buyable from Beaver Dam as from Boston.
--   * A small private auction house in Fond du Lac that never tags its state
--     because every one of its customers already knows where it is.
--
-- So a lot is RELEVANT to a buyer if ANY of these hold:
--   1. It is within driving radius of them  (real PostGIS distance, not state text)
--   2. It is in a state they named           (declared location, when it exists)
--   3. It ships                             (geography is irrelevant)
--
-- That is a disjunction, not a filter chain. Writing it as ANDed filters — which
-- is what every competitor does — is precisely how the good lots disappear.

-- ------------------------------------------------------------------ geography

create or replace function resolve_origin(p_postal_code text)
returns extensions.geography
language sql
stable
parallel safe
as $$
  select geom from postal_codes where postal_code = p_postal_code limit 1
$$;

comment on function resolve_origin is
  'Zip centroid as a geography point. Null when the zip is unknown, which callers must treat as "no geographic constraint" rather than "no results".';

-- --------------------------------------------------------------- sleeper score
-- The "hidden gem" detector. A sleeper is a lot that is worth more than the
-- listing makes it look, usually because whoever catalogued it did not know what
-- they had. The score is a sum of independently meaningful components, and every
-- component is written back into sleeper_reasons so the UI can justify itself.
-- An unexplainable score gets ignored by users, and rightly so.

create or replace function compute_sleeper(
  p_title            text,
  p_description      text,
  p_bid_count        integer,
  p_current_cents    bigint,
  p_estimate_low     bigint,
  p_image_count      integer,
  p_closes_at        timestamptz
)
returns jsonb
language plpgsql
-- STABLE, not IMMUTABLE: this reads now() to judge "closing soon". Declaring it
-- immutable would let the planner fold a single evaluation across a whole batch,
-- so every lot in a refresh run would be scored against one frozen timestamp.
stable
parallel safe
as $$
declare
  v_tokens     integer;
  v_poverty    numeric := 0;   -- catalogued lazily => opportunity
  v_quiet      numeric := 0;   -- nobody is bidding
  v_visible    numeric := 0;   -- enough photos to identify it yourself
  v_gap        numeric := 0;   -- priced below its own stated estimate
  v_imminent   numeric := 0;   -- closing soon and still quiet
  v_score      numeric := 0;
  v_reasons    jsonb := '[]'::jsonb;
begin
  v_tokens := coalesce(array_length(
                regexp_split_to_array(
                  trim(coalesce(p_title,'') || ' ' || coalesce(p_description,'')),
                  '\s+'), 1), 0);

  -- 1. Description poverty. "Box of misc tools" is the single richest signal in
  --    the entire auction world. Under ~12 tokens means nobody looked closely.
  if v_tokens > 0 and v_tokens < 12 then
    v_poverty := least(1.0, (12 - v_tokens) / 12.0);
    v_reasons := v_reasons || jsonb_build_object(
      'code','thin_description',
      'detail', format('Only %s words of description', v_tokens),
      'weight', round(v_poverty, 3));
  end if;

  -- 2. Quiet lot. Zero or one bid means the crowd has not found it.
  if coalesce(p_bid_count, 0) <= 1 then
    v_quiet := case when coalesce(p_bid_count,0) = 0 then 1.0 else 0.5 end;
    v_reasons := v_reasons || jsonb_build_object(
      'code','low_competition',
      'detail', format('%s bids so far', coalesce(p_bid_count,0)),
      'weight', round(v_quiet, 3));
  end if;

  -- 3. Visually identifiable. Photos are what let YOU out-identify the
  --    cataloguer. A thin description WITH many photos is the ideal case; a thin
  --    description with no photos is just a gamble.
  if coalesce(p_image_count, 0) >= 3 then
    v_visible := least(1.0, p_image_count / 8.0);
    v_reasons := v_reasons || jsonb_build_object(
      'code','well_photographed',
      'detail', format('%s photos to inspect', p_image_count),
      'weight', round(v_visible, 3));
  end if;

  -- 4. Below its own estimate. Only counts when the house published one.
  if p_estimate_low is not null and p_estimate_low > 0
     and coalesce(p_current_cents, 0) < p_estimate_low then
    v_gap := least(1.0, (p_estimate_low - coalesce(p_current_cents,0))::numeric / p_estimate_low);
    v_reasons := v_reasons || jsonb_build_object(
      'code','under_estimate',
      'detail', format('Bid is %s%% below the low estimate', round(v_gap * 100)),
      'weight', round(v_gap, 3));
  end if;

  -- 5. Closing soon and still quiet. Urgency only counts as a signal when it is
  --    combined with silence; a busy lot closing soon is just a normal auction.
  if p_closes_at is not null
     and p_closes_at > now()
     and p_closes_at < now() + interval '12 hours'
     and coalesce(p_bid_count, 0) <= 1 then
    v_imminent := 1.0;
    v_reasons := v_reasons || jsonb_build_object(
      'code','closing_quiet',
      'detail','Closes within 12 hours with almost no bidding',
      'weight', 1.0);
  end if;

  -- Weights: poverty and the price gap are the load-bearing signals. Photo count
  -- is a multiplier on confidence rather than a reason on its own, so it is
  -- weighted low. Max possible is 10.0 so the number reads as "out of ten".
  v_score := 3.2 * v_poverty
           + 2.3 * v_quiet
           + 1.2 * v_visible
           + 2.3 * v_gap
           + 1.0 * v_imminent;

  return jsonb_build_object(
    'score',   round(v_score, 3),
    'tokens',  v_tokens,
    'reasons', v_reasons);
end $$;

-- Recompute in bounded batches so this can be driven from cron without ever
-- taking a long lock on a hot table.
create or replace function refresh_sleeper_scores(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_updated integer := 0;
begin
  with target as (
    select id from lots
     where closed = false
       and (sleeper_score is null or updated_at > now() - interval '2 hours')
     order by coalesce(closes_at, 'infinity'::timestamptz) asc
     limit p_limit
  ),
  scored as (
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
   where l.id = sc.id;

  get diagnostics v_updated = row_count;
  return v_updated;
end $$;

-- ------------------------------------------------------------------ lot search

create or replace function search_lots(
  p_query               text          default null,
  p_postal_code         text          default null,
  p_radius_miles        integer       default 50,
  p_include_shippable   boolean       default true,
  p_states              text[]        default null,
  p_min_cents           bigint        default null,
  p_max_cents           bigint        default null,
  p_category_ids        bigint[]      default null,
  p_tiers               source_tier[] default null,
  p_closing_within_hours integer      default null,
  p_min_sleeper         numeric       default null,
  p_sort                text          default 'relevance',
  p_limit               integer       default 50,
  p_offset              integer       default 0
)
returns table (
  lot_id            uuid,
  title             text,
  lot_number        text,
  url               text,
  primary_image_url text,
  image_count       integer,
  current_bid_cents bigint,
  next_bid_cents    bigint,
  estimate_low_cents bigint,
  bid_count         integer,
  closes_at         timestamptz,
  auction_title     text,
  auctioneer        text,
  source_name       text,
  source_tier       source_tier,
  pickup_city       text,
  pickup_state      text,
  pickup_postal_code text,
  ships             boolean,
  distance_miles    numeric,
  sleeper_score     numeric,
  sleeper_reasons   jsonb,
  relevance         numeric,
  match_basis       text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_origin  extensions.geography;
  v_meters  double precision;
  v_tsq     tsquery;
begin
  v_origin := resolve_origin(p_postal_code);
  v_meters := greatest(coalesce(p_radius_miles, 50), 1) * 1609.344;

  -- websearch_to_tsquery handles quoted phrases and OR/-negation the way a user
  -- already expects from every search box they have ever used.
  if p_query is not null and length(trim(p_query)) > 0 then
    v_tsq := websearch_to_tsquery('english', p_query);
  end if;

  return query
  with candidate as (
    select
      l.*,
      a.title      as a_title,
      a.auctioneer as a_auctioneer,
      s.name       as s_name,
      s.tier       as s_tier,
      case
        when v_origin is not null and l.pickup_geom is not null
        then (extensions.st_distance(l.pickup_geom, v_origin) / 1609.344)::numeric
      end as dist_miles
    from lots l
    join sources  s on s.id = l.source_id
    left join auctions a on a.id = l.auction_id
    where l.closed = false
      and s.active
      and (v_tsq is null or l.search_tsv @@ v_tsq)
      and (p_min_cents is null
           or coalesce(l.current_bid_cents, l.starting_bid_cents, 0) >= p_min_cents)
      -- "under $50" must mean "I can still get in for under $50", so the ceiling
      -- is tested against the NEXT bid a user would have to make, not the last
      -- one somebody else made.
      and (p_max_cents is null
           or coalesce(l.next_bid_cents, l.current_bid_cents, l.starting_bid_cents, 0) <= p_max_cents)
      and (p_category_ids is null or l.category_id = any(p_category_ids))
      and (p_tiers is null or s.tier = any(p_tiers))
      and (p_closing_within_hours is null
           or (l.closes_at is not null
               and l.closes_at <= now() + make_interval(hours => p_closing_within_hours)))
      and (p_min_sleeper is null or coalesce(l.sleeper_score, 0) >= p_min_sleeper)
      -- The disjunction. See the header comment: this is the whole point.
      and (
            (v_origin is null and p_states is null)
         or (v_origin is not null and l.pickup_geom is not null
             and extensions.st_dwithin(l.pickup_geom, v_origin, v_meters))
         or (p_states is not null and l.pickup_state = any(p_states))
         or (coalesce(p_include_shippable, true) and l.ships)
      )
  ),
  scored as (
    select
      c.*,
      case when v_tsq is null then 0::numeric
           else ts_rank_cd(c.search_tsv, v_tsq)::numeric end as r_text,
      case when c.dist_miles is null then 0::numeric
           else greatest(0::numeric, 1 - (c.dist_miles / greatest(p_radius_miles, 1))) end as r_prox,
      case when c.closes_at is null or c.closes_at <= now() then 0::numeric
           else greatest(0::numeric,
                  1 - (extract(epoch from (c.closes_at - now())) / (72 * 3600))::numeric) end as r_urgency,
      (coalesce(c.sleeper_score, 0) / 10.0)::numeric as r_sleeper,
      case when c.primary_image_url is not null then 1::numeric else 0::numeric end as r_photo,
      -- Why this row is here at all. Surfacing it in the UI is what makes the
      -- disjunction legible instead of feeling arbitrary.
      case
        when c.dist_miles is not null and c.dist_miles <= p_radius_miles
          then 'nearby'
        when p_states is not null and c.pickup_state = any(p_states)
          then 'in_state'
        when c.ships then 'ships_to_you'
        else 'other'
      end as basis
    from candidate c
  )
  select
    sc.id, sc.title, sc.lot_number, sc.url, sc.primary_image_url, sc.image_count,
    sc.current_bid_cents, sc.next_bid_cents, sc.estimate_low_cents, sc.bid_count,
    sc.closes_at, sc.a_title, sc.a_auctioneer, sc.s_name, sc.s_tier,
    sc.pickup_city, sc.pickup_state, sc.pickup_postal_code, sc.ships,
    round(sc.dist_miles, 1),
    sc.sleeper_score, sc.sleeper_reasons,
    round(2.0 * sc.r_text
        + 1.2 * sc.r_prox
        + 0.8 * sc.r_urgency
        + 0.6 * sc.r_sleeper
        + 0.15 * sc.r_photo, 4) as relevance,
    sc.basis
  from scored sc
  order by
    case when p_sort = 'closing'  then sc.closes_at end asc nulls last,
    case when p_sort = 'nearest'  then sc.dist_miles end asc nulls last,
    case when p_sort = 'cheapest' then coalesce(sc.current_bid_cents, sc.starting_bid_cents) end asc nulls last,
    case when p_sort = 'sleeper'  then sc.sleeper_score end desc nulls last,
    case when p_sort = 'newest'   then sc.first_seen_at end desc nulls last,
    case when p_sort not in ('closing','nearest','cheapest','sleeper','newest')
         then (2.0 * sc.r_text + 1.2 * sc.r_prox + 0.8 * sc.r_urgency
               + 0.6 * sc.r_sleeper + 0.15 * sc.r_photo) end desc nulls last,
    sc.id
  limit greatest(least(coalesce(p_limit, 50), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end $$;

comment on function search_lots is
  'Unified lot search. Location is a DISJUNCTION of drivable / declared-in-state / ships, never an ANDed filter chain. match_basis tells the UI which arm matched so the result can explain itself.';

-- --------------------------------------------------------------- image search
-- "Find me this, whatever the seller happened to call it."
--
-- This is the feature no competitor has, and the reason is that it requires the
-- listing text to be treated as unreliable rather than authoritative. We rank on
-- pixels, then let the caller decide how much text agreement to require.

create or replace function match_lots_by_image(
  p_embedding         extensions.vector(768),
  p_min_similarity    numeric default 0.78,
  p_postal_code       text    default null,
  p_radius_miles      integer default null,
  p_include_shippable boolean default true,
  p_states            text[]  default null,
  p_max_cents         bigint  default null,
  p_limit             integer default 50
)
returns table (
  lot_id            uuid,
  title             text,
  url               text,
  primary_image_url text,
  matched_image_url text,
  similarity        numeric,
  current_bid_cents bigint,
  closes_at         timestamptz,
  source_name       text,
  pickup_city       text,
  pickup_state      text,
  distance_miles    numeric,
  sleeper_score     numeric,
  -- High visual similarity + almost no description is the arbitrage signal:
  -- the photo says one thing, the catalogue entry says nothing, and the price
  -- reflects the catalogue entry.
  underdescribed    boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_origin extensions.geography;
  v_meters double precision;
begin
  v_origin := resolve_origin(p_postal_code);
  v_meters := greatest(coalesce(p_radius_miles, 50), 1) * 1609.344;

  return query
  with hits as (
    -- One row per IMAGE, then collapsed to best-per-lot. A coin's obverse and
    -- reverse are separate vectors; either one matching is a hit.
    select
      li.lot_id,
      li.url as img_url,
      (1 - (li.clip_embedding <=> p_embedding))::numeric as sim,
      row_number() over (
        partition by li.lot_id
        order by li.clip_embedding <=> p_embedding
      ) as rn
    from lot_images li
    where li.clip_embedding is not null
      and (1 - (li.clip_embedding <=> p_embedding)) >= p_min_similarity
  )
  select
    l.id, l.title, l.url, l.primary_image_url, h.img_url, round(h.sim, 4),
    l.current_bid_cents, l.closes_at, s.name, l.pickup_city, l.pickup_state,
    case when v_origin is not null and l.pickup_geom is not null
         then round((extensions.st_distance(l.pickup_geom, v_origin) / 1609.344)::numeric, 1)
    end,
    l.sleeper_score,
    (coalesce(l.desc_richness, 0) < 12 and h.sim >= p_min_similarity + 0.03)
  from hits h
  join lots    l on l.id = h.lot_id
  join sources s on s.id = l.source_id
  where h.rn = 1
    and l.closed = false
    and s.active
    and (p_max_cents is null
         or coalesce(l.next_bid_cents, l.current_bid_cents, l.starting_bid_cents, 0) <= p_max_cents)
    and (
          (v_origin is null and p_states is null)
       or (v_origin is not null and l.pickup_geom is not null
           and extensions.st_dwithin(l.pickup_geom, v_origin, v_meters))
       or (p_states is not null and l.pickup_state = any(p_states))
       or (coalesce(p_include_shippable, true) and l.ships)
    )
  order by h.sim desc
  limit greatest(least(coalesce(p_limit, 50), 200), 1);
end $$;

comment on function match_lots_by_image is
  'Visual search over CLIP embeddings. Ranks on pixels, deliberately ignoring the seller''s wording, and flags lots whose photos say more than their description does.';

-- ------------------------------------------------------------- lot detail view

create or replace view v_lot_detail
with (security_invoker = true)
as
select
  l.id, l.external_id, l.lot_number, l.title, l.description, l.brand, l.model,
  l.condition, l.quantity, l.url,
  l.starting_bid_cents, l.current_bid_cents, l.next_bid_cents,
  l.estimate_low_cents, l.estimate_high_cents, l.sold_price_cents,
  l.bid_count, l.reserve_met, l.closes_at, l.closed, l.extended_count,
  l.primary_image_url, l.image_urls, l.image_count,
  l.sleeper_score, l.sleeper_reasons, l.desc_richness,
  l.pickup_city, l.pickup_state, l.pickup_postal_code, l.ships,
  l.first_seen_at, l.last_seen_at,
  a.id     as auction_id,
  a.title  as auction_title,
  a.auctioneer,
  a.url    as auction_url,
  a.ends_at as auction_ends_at,
  a.timezone,
  a.buyer_premium_pct,
  a.buyer_premium_note,
  a.terms_url,
  a.pickup_line1,
  s.id     as source_id,
  s.name   as source_name,
  s.slug   as source_slug,
  s.tier   as source_tier,
  s.url    as source_url,
  -- What the buyer will actually pay, premium included. Showing the hammer price
  -- alone is how auction platforms quietly mislead people.
  case when l.current_bid_cents is not null and a.buyer_premium_pct is not null
       then round(l.current_bid_cents * (1 + a.buyer_premium_pct / 100.0))::bigint
  end as est_total_cents
from lots l
join sources s on s.id = l.source_id
left join auctions a on a.id = l.auction_id;
