-- 0006_ranking_and_sleeper_fixes.sql
--
-- Three bugs, all found by executing 0005's functions against real rows for the
-- first time. Every one of them passed "the function exists" and failed "the
-- function is correct", which is the whole argument for testing with data.

-- ---------------------------------------------------------------------------
-- BUG 1: ts_rank_cd punished the more specific listing by 3x.
--
-- Observed: searching "DJI thermal drone" from a Milwaukee zip ranked a lot
-- 74.8 miles away ABOVE one 5.2 miles away on a location-first product.
--
-- Root cause was not the proximity weight. It was the ranker:
--
--   title                          ts_rank_cd   ts_rank
--   "DJI drone thermal Madison"      1.0000      1.0000
--   "DJI Mavic 3T thermal drone"     0.3333      1.0000
--
-- ts_rank_cd is COVER DENSITY ranking: it rewards query terms appearing close
-- together. In "DJI drone thermal Madison" the three terms are consecutive; in
-- "DJI Mavic 3T thermal drone" they are interleaved with the model number, so
-- cover density docks it 3x.
--
-- For auction titles that is backwards. Word adjacency carries no meaning here —
-- "DJI Mavic 3T thermal drone" is the MORE specific and more relevant listing,
-- and it names the exact model. Cover density is for prose, where proximity of
-- terms implies they are about each other. An auction title is a bag of
-- attributes: brand, model, condition, quantity, in whatever order the
-- cataloguer typed them.
--
-- Fix: plain ts_rank.

-- ---------------------------------------------------------------------------
-- BUG 2: proximity had a cliff at the radius boundary.
--
-- Old: greatest(0, 1 - dist/radius)  ->  every lot beyond the radius scored
-- exactly 0, making a lot 51 miles away indistinguishable from one 3,000 miles
-- away. Since the whole point of the disjunction is that out-of-radius lots
-- still appear (in_state, ships_to_you), they then had no proximity ordering at
-- all among themselves.
--
-- Fix: continuous decay, 1/(1 + dist/radius). At the origin it is 1.0, at the
-- radius edge 0.5, at twice the radius 0.33, and it never reaches zero. Ordering
-- degrades smoothly instead of falling off a shelf.
--
-- A null distance is NOT treated as "infinitely far". A shippable lot with no
-- published location is not distant, it is location-irrelevant, so it gets a
-- neutral 0.35 — below anything genuinely local, above the far tail.

-- ---------------------------------------------------------------------------
-- BUG 3: the sleeper score barely noticed whether a lot had photos.
--
-- Observed, holding everything else equal:
--   thin description, 0 bids, under estimate, 5 photos -> 7.253
--   thin description, 0 bids, under estimate, 0 photos -> 7.037   (97% of it)
--
-- And a perfectly catalogued, heavily-bid lot sitting at its estimate scored
-- 1.200 purely for having 12 photos.
--
-- The comment in 0005 said photo count is "a multiplier on confidence rather
-- than a reason on its own" — and then implemented it as an additive term worth
-- 1.2 out of ~10. The comment was right and the code was wrong.
--
-- The entire sleeper thesis is that YOU can out-identify the cataloguer by
-- looking at the pictures. With no pictures there is nothing to look at, so the
-- same thin description is a gamble rather than an opportunity. Photos must
-- gate the score, not top it up.
--
-- Fix: score = normalised_base * confidence, where confidence comes from the
-- photo count. A no-photo lot now scores ~35% of its photographed twin, and a
-- well-catalogued lot scores 0 rather than 1.2.

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
stable
parallel safe
as $$
declare
  v_tokens     integer;
  v_poverty    numeric := 0;
  v_quiet      numeric := 0;
  v_gap        numeric := 0;
  v_imminent   numeric := 0;
  v_base       numeric := 0;
  v_conf       numeric := 1.0;
  v_score      numeric := 0;
  v_reasons    jsonb := '[]'::jsonb;
  -- 3.2 + 2.3 + 2.3 + 1.0; used to rescale onto a 0-10 read.
  c_base_max   constant numeric := 8.8;
begin
  v_tokens := coalesce(array_length(
                regexp_split_to_array(
                  trim(coalesce(p_title,'') || ' ' || coalesce(p_description,'')),
                  '\s+'), 1), 0);

  -- 1. Description poverty. "Box of misc tools" is the single richest signal in
  --    the auction world: it means nobody looked closely.
  if v_tokens > 0 and v_tokens < 12 then
    v_poverty := least(1.0, (12 - v_tokens) / 12.0);
    v_reasons := v_reasons || jsonb_build_object(
      'code','thin_description',
      'detail', format('Only %s words of description', v_tokens),
      'weight', round(v_poverty, 3));
  end if;

  -- 2. Quiet lot: the crowd has not found it.
  if coalesce(p_bid_count, 0) <= 1 then
    v_quiet := case when coalesce(p_bid_count,0) = 0 then 1.0 else 0.5 end;
    v_reasons := v_reasons || jsonb_build_object(
      'code','low_competition',
      'detail', format('%s bids so far', coalesce(p_bid_count,0)),
      'weight', round(v_quiet, 3));
  end if;

  -- 3. Priced below the house's own published estimate.
  if p_estimate_low is not null and p_estimate_low > 0
     and coalesce(p_current_cents, 0) < p_estimate_low then
    v_gap := least(1.0, (p_estimate_low - coalesce(p_current_cents,0))::numeric / p_estimate_low);
    v_reasons := v_reasons || jsonb_build_object(
      'code','under_estimate',
      'detail', format('Bid is %s%% below the low estimate', round(v_gap * 100)),
      'weight', round(v_gap, 3));
  end if;

  -- 4. Closing soon AND still quiet. Urgency alone is not a signal; a busy lot
  --    closing soon is just a normal auction.
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

  v_base := 3.2 * v_poverty + 2.3 * v_quiet + 2.3 * v_gap + 1.0 * v_imminent;

  -- CONFIDENCE GATE (bug 3). Photographs are what make a thin description an
  -- opportunity instead of a gamble, so they scale the whole score.
  v_conf := case
              when coalesce(p_image_count,0) >= 3 then 1.00
              when coalesce(p_image_count,0) = 2  then 0.80
              when coalesce(p_image_count,0) = 1  then 0.60
              else 0.35
            end;

  if coalesce(p_image_count,0) >= 3 then
    v_reasons := v_reasons || jsonb_build_object(
      'code','well_photographed',
      'detail', format('%s photos to inspect, so the lot can be identified by eye', p_image_count),
      'weight', v_conf);
  else
    -- Say why the score was held back. An unexplained discount is as useless to
    -- a user as an unexplained score.
    v_reasons := v_reasons || jsonb_build_object(
      'code','few_photos',
      'detail', format('Only %s photo(s): score discounted to %s%% because the lot cannot be verified by eye',
                       coalesce(p_image_count,0), round(v_conf * 100)),
      'weight', v_conf);
  end if;

  v_score := (v_base / c_base_max) * 10.0 * v_conf;

  return jsonb_build_object(
    'score',      round(v_score, 3),
    'base',       round(v_base, 3),
    'confidence', v_conf,
    'tokens',     v_tokens,
    'reasons',    v_reasons);
end $$;

comment on function compute_sleeper is
  'Sleeper score, 0-10. Photo count is a CONFIDENCE MULTIPLIER, not an additive signal: a thin description with no photos is a gamble, not an opportunity. Every component is returned in reasons so the UI can justify the number.';

-- ---------------------------------------------------------------------------
-- search_lots: ts_rank instead of ts_rank_cd (bug 1), and continuous proximity
-- decay instead of a cliff at the radius (bug 2). Signature unchanged.

create or replace function search_lots(
  p_query text default null, p_postal_code text default null,
  p_radius_miles integer default 50, p_include_shippable boolean default true,
  p_states text[] default null, p_min_cents bigint default null,
  p_max_cents bigint default null, p_category_ids bigint[] default null,
  p_tiers source_tier[] default null, p_closing_within_hours integer default null,
  p_min_sleeper numeric default null, p_sort text default 'relevance',
  p_limit integer default 50, p_offset integer default 0)
returns table (
  lot_id uuid, title text, lot_number text, url text, primary_image_url text,
  image_count integer, current_bid_cents bigint, next_bid_cents bigint,
  estimate_low_cents bigint, bid_count integer, closes_at timestamptz,
  auction_title text, auctioneer text, source_name text, source_tier source_tier,
  pickup_city text, pickup_state text, pickup_postal_code text, ships boolean,
  distance_miles numeric, sleeper_score numeric, sleeper_reasons jsonb,
  relevance numeric, match_basis text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_origin extensions.geography; v_meters double precision; v_tsq tsquery;
begin
  v_origin := resolve_origin(p_postal_code);
  v_meters := greatest(coalesce(p_radius_miles,50),1) * 1609.344;
  if p_query is not null and length(trim(p_query)) > 0 then
    v_tsq := websearch_to_tsquery('english', p_query);
  end if;

  return query
  with candidate as (
    select l.*, a.title as a_title, a.auctioneer as a_auctioneer,
           s.name as s_name, s.tier as s_tier,
           case when v_origin is not null and l.pickup_geom is not null
                then (extensions.st_distance(l.pickup_geom, v_origin)/1609.344)::numeric end as dist_miles
      from lots l
      join sources s on s.id = l.source_id
      left join auctions a on a.id = l.auction_id
     where l.closed = false and s.active
       and (v_tsq is null or l.search_tsv @@ v_tsq)
       and (p_min_cents is null
            or coalesce(l.current_bid_cents, l.starting_bid_cents, 0) >= p_min_cents)
       and (p_max_cents is null
            or coalesce(l.next_bid_cents, l.current_bid_cents, l.starting_bid_cents, 0) <= p_max_cents)
       and (p_category_ids is null or l.category_id = any(p_category_ids))
       and (p_tiers is null or s.tier = any(p_tiers))
       and (p_closing_within_hours is null
            or (l.closes_at is not null and l.closes_at <= now() + make_interval(hours => p_closing_within_hours)))
       and (p_min_sleeper is null or coalesce(l.sleeper_score,0) >= p_min_sleeper)
       -- The disjunction. Verified working against real rows.
       and (
             (v_origin is null and p_states is null)
          or (v_origin is not null and l.pickup_geom is not null
              and extensions.st_dwithin(l.pickup_geom, v_origin, v_meters))
          or (p_states is not null and l.pickup_state = any(p_states))
          or (coalesce(p_include_shippable, true) and l.ships)
       )
  ), scored as (
    select c.*,
      -- BUG 1 FIX: ts_rank, not ts_rank_cd. Cover density is for prose; an
      -- auction title is an unordered bag of attributes.
      case when v_tsq is null then 0::numeric else ts_rank(c.search_tsv, v_tsq)::numeric end as r_text,
      -- BUG 2 FIX: smooth decay, no cliff at the radius. Null distance means
      -- "location irrelevant" (a shippable lot), not "infinitely far".
      case when c.dist_miles is null then 0.35::numeric
           else (1.0 / (1.0 + (c.dist_miles / greatest(p_radius_miles,1)))) end as r_prox,
      case when c.closes_at is null or c.closes_at <= now() then 0::numeric
           else greatest(0::numeric, 1 - (extract(epoch from (c.closes_at - now()))/(72*3600))::numeric) end as r_urgency,
      (coalesce(c.sleeper_score,0)/10.0)::numeric as r_sleeper,
      case when c.primary_image_url is not null then 1::numeric else 0::numeric end as r_photo,
      case when c.dist_miles is not null and c.dist_miles <= p_radius_miles then 'nearby'
           when p_states is not null and c.pickup_state = any(p_states) then 'in_state'
           when c.ships then 'ships_to_you' else 'other' end as basis
    from candidate c
  )
  select sc.id, sc.title, sc.lot_number, sc.url, sc.primary_image_url, sc.image_count,
         sc.current_bid_cents, sc.next_bid_cents, sc.estimate_low_cents, sc.bid_count,
         sc.closes_at, sc.a_title, sc.a_auctioneer, sc.s_name, sc.s_tier,
         sc.pickup_city, sc.pickup_state, sc.pickup_postal_code, sc.ships,
         round(sc.dist_miles,1), sc.sleeper_score, sc.sleeper_reasons,
         -- Proximity weight raised 1.2 -> 1.5: this is a location-first product,
         -- and the test showed text rank swamping distance.
         round(2.0*sc.r_text + 1.5*sc.r_prox + 0.8*sc.r_urgency
             + 0.6*sc.r_sleeper + 0.15*sc.r_photo, 4) as relevance,
         sc.basis
    from scored sc
   order by
     case when p_sort='closing'  then sc.closes_at end asc nulls last,
     case when p_sort='nearest'  then sc.dist_miles end asc nulls last,
     case when p_sort='cheapest' then coalesce(sc.current_bid_cents, sc.starting_bid_cents) end asc nulls last,
     case when p_sort='sleeper'  then sc.sleeper_score end desc nulls last,
     case when p_sort='newest'   then sc.first_seen_at end desc nulls last,
     case when p_sort not in ('closing','nearest','cheapest','sleeper','newest')
          then (2.0*sc.r_text + 1.5*sc.r_prox + 0.8*sc.r_urgency
              + 0.6*sc.r_sleeper + 0.15*sc.r_photo) end desc nulls last,
     sc.id
   limit greatest(least(coalesce(p_limit,50),200),1)
   offset greatest(coalesce(p_offset,0),0);
end $$;

-- refresh_sleeper_scores stores the new components too, so the UI can show the
-- confidence discount rather than just an unexplained smaller number.
create or replace function refresh_sleeper_scores(p_limit integer default 5000)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_updated integer := 0;
begin
  with target as (
    select id from lots
     where closed = false
       and (sleeper_score is null or updated_at > now() - interval '2 hours')
     order by coalesce(closes_at, 'infinity'::timestamptz) asc
     limit p_limit
  ), scored as (
    select l.id, compute_sleeper(l.title, l.description, l.bid_count, l.current_bid_cents,
             l.estimate_low_cents, l.image_count, l.closes_at) as s
      from lots l join target t on t.id = l.id
  )
  update lots l
     set sleeper_score   = (sc.s ->> 'score')::numeric,
         desc_richness   = (sc.s ->> 'tokens')::integer,
         sleeper_reasons = sc.s -> 'reasons'
    from scored sc where l.id = sc.id;
  get diagnostics v_updated = row_count;
  return v_updated;
end $$;
