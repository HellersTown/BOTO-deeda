-- 0057: what each lot's photos show, and search that uses it.
--
-- WHY. Asked for on 2026-10-05: confirm every listing by its photos, not only
-- its words. That day 1,273 of 11,098 open lots (11.5%) had titles the search
-- vocabulary could not place ("Lot 19", "Garage items", "Assortment of
-- Parts"), and none of the 85,590 stored photos had ever been looked at
-- (lot_images.clip_embedding was null on every row; no worker existed).
--
-- HOW. The look-at-lots Edge Function (packages/ingest/src/look.ts) runs every
-- 3 minutes. It asks next_lots_to_look for open lots that are due (never
-- looked at, or their first photo changed; lots whose titles name no kind
-- first), fetches their photos as our crawler, and asks Claude which kinds of
-- items each lot holds, in search_concepts' ids, with a one-line caption and a
-- brand or model only when legible. record_lot_looks keeps the answer in
-- lot_looks and, when the model is at least moderately sure, gives search the
-- photo's kinds: lots.seen_main (what the lot is), seen_heads (everything it
-- holds) and seen_tsv (caption, brand and model as searchable words).
--
-- search_lots (below) then counts a lot whose photos show the kind asked for,
-- and whose title names no other kind, as an exact match; one whose photos
-- show it among other things as a close match; and a brand legible in a photo
-- as the brand.
--
-- COST. The function is off until the ANTHROPIC_API_KEY secret is set, and it
-- never looks at more than LOOK_DAILY_CAP lots (default 1,500) in 24 hours.
-- Every model call is logged in look_batches with its tokens.
--
-- Only lots of active sources whose terms allow Skeuos to use their listings
-- are looked at. Nothing here deletes or drops. Applied with execute_sql.

create table if not exists public.look_batches (
  id                 bigserial primary key,
  created_at         timestamptz not null default now(),
  model              text not null,
  lots               integer not null default 0,
  looked             integer not null default 0,
  photos             integer not null default 0,
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cache_write_tokens integer,
  stop_reason        text,
  error              text
);
create index if not exists look_batches_created_at_idx on public.look_batches (created_at);

create table if not exists public.lot_looks (
  lot_id       uuid primary key references public.lots (id),
  looked_at    timestamptz not null default now(),
  model        text not null,
  batch_id     bigint references public.look_batches (id),
  image_urls   text[] not null default '{}',
  kinds        text[] not null default '{}',
  main_kind    text,
  caption      text,
  brand        text,
  model_number text,
  title_agrees boolean,
  confidence   text not null check (confidence in ('high', 'medium', 'low'))
);

-- A lot handed to one call is not handed to another for ten minutes.
create table if not exists public.look_claims (
  lot_id        uuid primary key,
  claimed_until timestamptz not null
);

alter table public.lots add column if not exists seen_main text;
alter table public.lots add column if not exists seen_heads text[] not null default '{}';
alter table public.lots add column if not exists seen_tsv tsvector;
create index if not exists lots_seen_heads_idx on public.lots using gin (seen_heads);

alter table public.look_batches enable row level security;
alter table public.lot_looks enable row level security;
alter table public.look_claims enable row level security;

-- A lot's look is as public as the lot: readable when its source is shown.
do $policy$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'lot_looks' and policyname = 'lot_looks_read') then
    create policy lot_looks_read on public.lot_looks for select to anon, authenticated
      using (exists (select 1 from public.lots l join public.sources s on s.id = l.source_id
                      where l.id = lot_looks.lot_id and s.active and s.ingest_allowed));
  end if;
end $policy$;
revoke all on public.lot_looks, public.look_batches, public.look_claims from anon, authenticated;
grant select (lot_id, looked_at, kinds, main_kind, caption, brand, model_number, title_agrees, confidence)
  on public.lot_looks to anon, authenticated;

-- Lots due a look, claimed for this call. Lots whose titles name no kind come
-- first (their photos are all search has), then lots never looked at, then
-- the soonest to close. A lot closing within 15 minutes is not worth a look.
create or replace function public.next_lots_to_look(p_limit integer default 24)
returns table (id uuid, title text, description text, image_urls text[], item_heads text[])
language sql
volatile
security definer
set search_path = public, extensions
as $$
  with picked as (
    select l.id, l.title, l.description, l.image_urls[1:2] as image_urls,
           coalesce(l.item_heads, '{}') as item_heads,
           (coalesce(cardinality(l.item_heads), 0) = 0) as nameless,
           (k.lot_id is null) as never, l.closes_at
      from lots l
      join sources s on s.id = l.source_id
      left join lot_looks k on k.lot_id = l.id
      left join look_claims c on c.lot_id = l.id
     where l.closed = false
       and not l.sale_level
       and (l.closes_at is null or l.closes_at > now() + interval '15 minutes')
       and coalesce(l.image_count, 0) > 0
       and s.active and s.ingest_allowed
       and (k.lot_id is null or k.image_urls[1] is distinct from l.image_urls[1])
       and (c.lot_id is null or c.claimed_until < now())
     order by nameless desc, never desc, l.closes_at asc nulls last, l.id
     limit greatest(least(coalesce(p_limit, 24), 100), 1)
  ), claimed as (
    insert into look_claims as c (lot_id, claimed_until)
    select p.id, now() + interval '10 minutes' from picked p
    on conflict (lot_id) do update set claimed_until = excluded.claimed_until
    returning c.lot_id
  )
  select p.id, p.title, p.description, p.image_urls, p.item_heads
    from picked p join claimed c on c.lot_id = p.id
   order by p.nameless desc, p.never desc, p.closes_at asc nulls last, p.id
$$;

-- Keep the answers. Kinds outside the vocabulary are dropped. Only a look the
-- model is at least moderately sure of reaches search.
create or replace function public.record_lot_looks(p_batch_id bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_n integer := 0;
begin
  with src as (
    select distinct on (r.lot_id) r.*
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
        lot_id uuid, kinds text[], main_kind text, caption text, brand text, model_number text,
        title_agrees boolean, confidence text, image_urls text[], model text)
     where r.lot_id is not null and r.confidence in ('high', 'medium', 'low')
     order by r.lot_id
  ), checked as (
    select s.lot_id, s.caption, s.brand, s.model_number, s.title_agrees, s.confidence,
           coalesce(s.image_urls, '{}') as image_urls, coalesce(s.model, 'unknown') as model,
           array(select k from unnest(coalesce(s.kinds, '{}')) with ordinality as x(k, o)
                  where exists (select 1 from search_concepts c where c.id = x.k)
                  order by x.o) as kinds,
           case when exists (select 1 from search_concepts c where c.id = s.main_kind) then s.main_kind end as main_kind
      from src s
      join lots l on l.id = s.lot_id
  ), up as (
    insert into lot_looks as t (lot_id, looked_at, model, batch_id, image_urls, kinds, main_kind,
                                caption, brand, model_number, title_agrees, confidence)
    select lot_id, now(), model, p_batch_id, image_urls, kinds, main_kind,
           caption, brand, model_number, title_agrees, confidence
      from checked
    on conflict (lot_id) do update set
      looked_at    = now(),
      model        = excluded.model,
      batch_id     = excluded.batch_id,
      image_urls   = excluded.image_urls,
      kinds        = excluded.kinds,
      main_kind    = excluded.main_kind,
      caption      = excluded.caption,
      brand        = excluded.brand,
      model_number = excluded.model_number,
      title_agrees = excluded.title_agrees,
      confidence   = excluded.confidence
    returning t.lot_id
  ), seen as (
    update lots l
       set seen_main  = case when c.confidence <> 'low' then c.main_kind end,
           seen_heads = case when c.confidence <> 'low' then c.kinds else '{}' end,
           seen_tsv   = case when c.confidence <> 'low' then
                          setweight(to_tsvector('english', coalesce(c.brand, '') || ' ' || coalesce(c.model_number, '')), 'B')
                          || setweight(to_tsvector('english', coalesce(c.caption, '')), 'C') end
      from checked c
     where l.id = c.lot_id
    returning 1
  )
  select count(*) into v_n from up;
  return v_n;
end $$;

revoke execute on function public.next_lots_to_look(integer) from public, anon, authenticated;
revoke execute on function public.record_lot_looks(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.next_lots_to_look(integer) to service_role;
grant execute on function public.record_lot_looks(bigint, jsonb) to service_role;

-- Only the schedule may start a look: every Edge Function URL accepts the
-- public anon key, so look-at-lots also checks this token (as 0015 does for
-- inspect-page). The token stays in the database.
insert into private.function_tokens (name, token)
values ('look-at-lots', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (name) do nothing;

create or replace function public.invoke_look_at_lots()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url   text;
  v_key   text;
  v_token text;
  v_id    bigint;
begin
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
  return v_id;
end $$;

revoke execute on function public.invoke_look_at_lots() from public, anon, authenticated;

select cron.schedule('look-at-lots', '*/3 * * * *', 'select public.invoke_look_at_lots()');

-- As 0050, with what a lot's photos show (lots.seen_main, seen_heads, seen_tsv):
-- a lot whose photos show the kind asked for, and whose title names no other
-- kind, is an exact match; one whose photos show it among other things is a
-- close match; a brand legible in a photo counts as the brand.
create or replace function public.search_lots(
  p_query                text default null,
  p_postal_code          text default null,
  p_radius_miles         integer default 50,
  p_include_shippable    boolean default true,
  p_states               text[] default null,
  p_min_cents            bigint default null,
  p_max_cents            bigint default null,
  p_category_ids         bigint[] default null,
  p_tiers                source_tier[] default null,
  p_closing_within_hours integer default null,
  p_min_sleeper          numeric default null,
  p_sort                 text default 'relevance',
  p_limit                integer default 50,
  p_offset               integer default 0,
  p_tsquery              text default null,
  p_scope                text default 'all'
)
returns table (
  lot_id uuid, title text, lot_number text, url text, primary_image_url text, image_count integer,
  current_bid_cents bigint, next_bid_cents bigint, estimate_low_cents bigint, bid_count integer,
  closes_at timestamptz, auction_title text, auctioneer text, source_name text, source_tier source_tier,
  pickup_city text, pickup_state text, pickup_postal_code text, ships boolean, distance_miles numeric,
  sleeper_score numeric, sleeper_reasons jsonb, relevance numeric, match_basis text, pickup_geo_source text,
  sale_level boolean, sale_lot_count integer, match_tier integer, match_concept text, match_label text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_origin   extensions.geography;
  v_meters   double precision;
  v_tsq      tsquery;
  v_res      jsonb;
  v_items    boolean := false;
  v_brand    boolean := false;
  v_exp      text[] := '{}';
  v_all      text[] := '{}';
  v_rel      text[] := '{}';
  v_brd      text[] := '{}';
  v_reqw     text[] := '{}';
  v_req      tsquery;
  v_req_ab   tsquery;
  v_any      tsquery;
  v_excl     tsquery;
  v_meas     jsonb;
  v_ident    boolean := false;
  v_max_tier integer;
begin
  v_origin := resolve_origin(p_postal_code);
  v_meters := greatest(coalesce(p_radius_miles, 50), 1) * 1609.344;
  v_max_tier := case p_scope when 'exact' then 1 when 'related' then 2 else 3 end;

  -- The parser's grouped query first (synonyms, model variants). If it does
  -- not parse, or holds only stop words, fall back to the plain string.
  if p_tsquery is not null and length(trim(p_tsquery)) > 0 then
    begin
      v_tsq := to_tsquery('english', p_tsquery);
    exception when others then
      v_tsq := null;
    end;
    if v_tsq is not null and numnode(v_tsq) = 0 then
      v_tsq := null;
    end if;
  end if;
  if v_tsq is null and p_query is not null and length(trim(p_query)) > 0 then
    v_tsq := websearch_to_tsquery('english', p_query);
    if numnode(v_tsq) = 0 then v_tsq := null; end if;
  end if;

  if p_query is not null and length(btrim(p_query)) > 0 then
    v_res := search_resolve(p_query);
  end if;
  if v_res is not null then
    v_items := jsonb_array_length(v_res -> 'primary') > 0;
    v_brand := coalesce((v_res ->> 'brand_only')::boolean, false);
    v_exp := array(select jsonb_array_elements_text(v_res -> 'expanded'));
    v_all := array(select jsonb_array_elements_text(v_res -> 'expanded_all'));
    v_rel := array(select jsonb_array_elements_text(v_res -> 'related'));
    v_brd := array(select jsonb_array_elements_text(coalesce(v_res -> 'broader', '[]')));
    v_reqw := array(select jsonb_array_elements_text(v_res -> 'required'));
    -- Each required word is a tsquery over stemmed words ('f' <-> '-150':* |
    -- 'f150':* for a model number); required_q_ab asks the same of the title,
    -- brand and model.
    if jsonb_array_length(coalesce(v_res -> 'required_q', '[]')) > 0 then
      v_req := to_tsquery('simple', array_to_string(array(
                 select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'required_q') q), ' & '));
      v_req_ab := to_tsquery('simple', array_to_string(array(
                    select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'required_q_ab') q), ' & '));
    end if;
    if jsonb_array_length(coalesce(v_res -> 'words_q', '[]')) > 0 then
      v_any := to_tsquery('simple', array_to_string(array(
                 select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'words_q') q), ' & '));
    end if;
    v_meas := nullif(v_res -> 'measures', '{}'::jsonb);
    v_ident := coalesce((v_res ->> 'identifiers_only')::boolean, false);
    if jsonb_array_length(coalesce(v_res -> 'excluded', '[]')) > 0 then
      v_excl := to_tsquery('simple', array_to_string(array(
                  select '(' || q || ')' from jsonb_array_elements_text(v_res -> 'excluded') q), ' | '));
    end if;
  end if;

  return query
  with candidate as (
    select l.*, a.title as a_title, a.auctioneer as a_auctioneer, a.lot_count as a_lot_count,
           s.name as s_name, s.tier as s_tier,
           case when v_origin is not null and l.pickup_geom is not null
                then (extensions.st_distance(l.pickup_geom, v_origin) / 1609.344)::numeric end as dist_miles
      from lots l
      join sources s on s.id = l.source_id
      left join auctions a on a.id = l.auction_id
     where l.closed = false and s.active and s.ingest_allowed
       and (
             v_res is null
          or (v_items and (l.item_heads && (v_all || v_rel || v_brd) or l.item_mods && (v_all || v_rel)
                           or l.item_mentions && (v_all || v_rel)
                           -- What its photos show (0057).
                           or l.seen_heads && (v_all || v_rel)))
          or (v_any is not null and (l.search_tsv @@ v_any or l.seen_tsv @@ v_any))
          or (not v_items and v_tsq is not null and l.search_tsv @@ v_tsq)
       )
       and (v_excl is null or not l.search_tsv @@ v_excl)
       and (p_min_cents is null
            or coalesce(l.current_bid_cents, l.starting_bid_cents, 0) >= p_min_cents)
       and (p_max_cents is null
            or coalesce(l.next_bid_cents, l.current_bid_cents, l.starting_bid_cents, 0) <= p_max_cents)
       and (p_category_ids is null or l.category_id = any(p_category_ids))
       and (p_tiers is null or s.tier = any(p_tiers))
       and (p_closing_within_hours is null
            or (l.closes_at is not null and l.closes_at <= now() + make_interval(hours => p_closing_within_hours)))
       and (p_min_sleeper is null or coalesce(l.sleeper_score, 0) >= p_min_sleeper)
       and (
             (v_origin is null and p_states is null)
          or (v_origin is not null and l.pickup_geom is not null
              and extensions.st_dwithin(l.pickup_geom, v_origin, v_meters))
          or (p_states is not null and l.pickup_state = any(p_states))
          or (coalesce(p_include_shippable, true) and l.ships)
       )
  ), measured as (
    -- A measure asked for ("20 acres") must be met within its unit's give:
    -- acreage 0.75 to 1.5 times, screens to 5%, capacity exactly, hours and
    -- miles at most, most others a fifth either way.
    select c.*,
      (v_meas is null or not exists (
         select 1 from jsonb_each(v_meas) q(u, qv)
          where not exists (
            select 1 from jsonb_array_elements_text(coalesce(c.measures -> q.u, '[]'::jsonb)) lv(x)
             where lv.x::numeric
                   between (qv ->> 0)::numeric * (case q.u when 'acre' then 0.75 when 'inch' then 0.95 when 'gb' then 0.99
                                                           when 'volt' then 0.99 when 'ft' then 0.9 when 'cc' then 0.9
                                                           when 'yard' then 0.9 when 'mile' then 0 when 'hour' then 0
                                                           else 0.8 end)
                       and (qv ->> 0)::numeric * (case q.u when 'acre' then 1.5 when 'inch' then 1.05 when 'gb' then 1.01
                                                           when 'volt' then 1.01 when 'ft' then 1.1 when 'cc' then 1.1
                                                           when 'yard' then 1.1 when 'mile' then 1.1 when 'hour' then 1.1
                                                           else 1.25 end)))) as meas_ok
      from candidate c
  ), tiered as (
    select c.*,
      case
        when v_res is null then 1
        when v_items then
          case
            -- It IS one, and everything else typed is there.
            when (c.item_heads && v_exp or (c.sale_level and c.item_mentions && v_exp))
                 and (v_req is null or c.search_tsv @@ v_req) and c.meas_ok then 1
            -- Its photos show it is one (0057), and its title names nothing
            -- else: no kind, or only coarser ones ("Furniture", "Lot 19").
            when c.seen_main = any(v_exp) and coalesce(c.item_heads, '{}') <@ (v_exp || v_brd)
                 and (v_req is null or c.search_tsv @@ v_req or c.seen_tsv @@ v_req) and c.meas_ok then 1
            -- A close match: another thing the query names, a related kind, a
            -- coarser kind it may be, or a lot whose description says it
            -- includes the thing.
            when c.item_heads && (v_all || v_rel || v_brd) or c.item_mentions && v_exp
                 or c.seen_heads && (v_exp || v_all || v_rel) then 2
            else 3
          end
        when v_brand then
          case when ((v_req_ab is not null and (c.search_tsv @@ v_req_ab or c.seen_tsv @@ v_req_ab)) or c.sale_level)
                    and c.meas_ok then 1 else 3 end
        else
          case
            when c.sale_level and (v_req is null or c.search_tsv @@ v_req) and c.meas_ok then 1
            when v_req_ab is not null and c.search_tsv @@ v_req_ab and (c.head_words && v_reqw or v_ident)
                 and c.meas_ok then 1
            when v_meas is not null and c.meas_ok and (v_req is null or c.search_tsv @@ v_req) then 1
            when v_req_ab is not null and c.search_tsv @@ v_req_ab then 2
            when v_req is null and v_tsq is not null and c.search_tsv @@ v_tsq then 2
            else 3
          end
      end as tier,
      coalesce(
        (select h from unnest(c.item_heads) h where h = any(v_exp) limit 1),
        case when c.seen_main = any(v_exp) then c.seen_main end,
        (select h from unnest(c.seen_heads) h where h = any(v_exp) limit 1),
        (select h from unnest(c.item_heads) h where h = any(v_all || v_rel) limit 1),
        (select h from unnest(c.seen_heads) h where h = any(v_all || v_rel) limit 1),
        c.item_heads[1],
        c.seen_main
      ) as concept
    from measured c
  ), scored as (
    select t.*,
      -- ts_rank, NOT ts_rank_cd: cover density is for prose, and an auction
      -- title is an unordered bag of attributes.
      case when v_tsq is null then 0::numeric else ts_rank(t.search_tsv, v_tsq)::numeric end as r_text,
      -- Smooth decay, no cliff at the radius. Null distance means "location
      -- irrelevant" (shippable), not "infinitely far".
      case when t.dist_miles is null then 0.35::numeric
           else (1.0 / (1.0 + (t.dist_miles / greatest(p_radius_miles, 1)))) end as r_prox,
      case when t.closes_at is null or t.closes_at <= now() then 0::numeric
           else greatest(0::numeric, 1 - (extract(epoch from (t.closes_at - now())) / (72 * 3600))::numeric) end as r_urgency,
      (coalesce(t.sleeper_score, 0) / 10.0)::numeric as r_sleeper,
      case when t.primary_image_url is not null then 1::numeric else 0::numeric end as r_photo,
      case when t.dist_miles is not null and t.dist_miles <= p_radius_miles then 'nearby'
           when p_states is not null and t.pickup_state = any(p_states) then 'in_state'
           when t.ships then 'ships_to_you' else 'other' end as basis
    from tiered t
    where t.tier <= v_max_tier
  )
  select sc.id, sc.title, sc.lot_number, sc.url, sc.primary_image_url, sc.image_count,
         sc.current_bid_cents, sc.next_bid_cents, sc.estimate_low_cents, sc.bid_count,
         sc.closes_at, sc.a_title, sc.a_auctioneer, sc.s_name, sc.s_tier,
         sc.pickup_city, sc.pickup_state, sc.pickup_postal_code, sc.ships,
         round(sc.dist_miles, 1), sc.sleeper_score, sc.sleeper_reasons,
         round(2.0 * sc.r_text + 1.5 * sc.r_prox + 0.8 * sc.r_urgency
             + 0.6 * sc.r_sleeper + 0.15 * sc.r_photo, 4) as relevance,
         sc.basis,
         sc.pickup_geo_source,
         sc.sale_level,
         sc.a_lot_count,
         sc.tier,
         sc.concept,
         (select k.label from search_concepts k where k.id = sc.concept)
    from scored sc
   order by
     sc.tier,
     case when p_sort = 'closing'  then sc.closes_at end asc nulls last,
     case when p_sort = 'nearest'  then sc.dist_miles end asc nulls last,
     case when p_sort = 'cheapest' then coalesce(sc.current_bid_cents, sc.starting_bid_cents) end asc nulls last,
     case when p_sort = 'sleeper'  then sc.sleeper_score end desc nulls last,
     case when p_sort = 'newest'   then sc.first_seen_at end desc nulls last,
     case when p_sort not in ('closing', 'nearest', 'cheapest', 'sleeper', 'newest')
          then (2.0 * sc.r_text + 1.5 * sc.r_prox + 0.8 * sc.r_urgency
              + 0.6 * sc.r_sleeper + 0.15 * sc.r_photo) end desc nulls last,
     sc.id
   limit greatest(least(coalesce(p_limit, 50), 200), 1)
   offset greatest(coalesce(p_offset, 0), 0);
end $$;
