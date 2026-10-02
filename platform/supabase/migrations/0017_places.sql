-- 0017_places.sql
--
-- Municipality names for placing lots that publish a city and a state but no ZIP.
--
-- 0016 placed such lots from the ZIP table's city names. Those are postal names,
-- and postal names lump suburbs into the big city: every Wauwatosa ZIP is named
-- "Milwaukee", so a lot listed as "Wauwatosa, WI" still had no point. Many
-- Wisconsin sellers are towns, villages and cities that publish exactly that.
--
-- This adds the Census Bureau's gazetteer of places (cities, villages, CDPs) and
-- county subdivisions (Wisconsin's towns), both public domain, as `places`, and
-- one function that resolves a declared state plus a city name to a point:
--
--   resolve_place_point(state, city) -> the point, and how far its candidates
--   spread. Candidates come from places, county subdivisions and the ZIP table's
--   city names. If they spread more than 20 miles from their centroid the name
--   is ambiguous ("Lincoln, WI" is a town in several counties) and the caller
--   must not use it. Otherwise the most specific source wins: an incorporated
--   place or CDP, then a town, then the postal city.
--
-- Names are compared after norm_place_name(): lower case, no punctuation,
-- "Saint"/"St." unified, and a leading "Town of" / "Village of" / "City of"
-- dropped (sellers write "Town of Vernon"). Stored Census names also lose their
-- one trailing descriptor ("Wauwatosa city" -> "wauwatosa").

-- ------------------------------------------------------------------ names

create or replace function public.norm_place_name(p text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           lower(coalesce(p, '')),
           '^(city|village|town|township) of\s+', ''),
           '^(saint|st\.?)\s+', 'st '),
           '[^a-z0-9 ]', '', 'g'),
           '\s+', ' ', 'g')), '')
$$;

comment on function public.norm_place_name(text) is
  'Normalises a place name for matching: lower case, no punctuation, St./Saint unified, a leading "Town of"/"Village of"/"City of" dropped.';

-- ------------------------------------------------------------------ table

create table if not exists public.places (
  geoid     text primary key,           -- 'P' || Census GEOID for places, 'S' || GEOID for county subdivisions
  kind      text not null check (kind in ('place', 'cousub')),
  state     text not null,
  name      text not null,              -- as the Census publishes it, e.g. "Wauwatosa city"
  name_norm text not null,              -- e.g. "wauwatosa"
  lat       double precision not null,
  lon       double precision not null,
  geom      extensions.geography(Point, 4326)
              generated always as (
                extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)::extensions.geography
              ) stored,
  source    text not null
);

create index if not exists places_state_name_idx on public.places (state, name_norm);
create index if not exists postal_codes_state_normcity_idx on public.postal_codes (state, public.norm_place_name(city));

alter table public.places enable row level security;
drop policy if exists places_public_read on public.places;
create policy places_public_read on public.places for select to anon, authenticated using (true);

comment on table public.places is
  'Census places (cities, villages, CDPs) and county subdivisions (towns): internal points for resolving a declared state plus a city name. Public domain (US Census Bureau Gazetteer 2023).';

-- ------------------------------------------------------------ resolution

create or replace function public.resolve_place_point(p_state text, p_city text)
returns table (point extensions.geography, spread_m double precision, basis text)
language sql
stable
set search_path = public, extensions
as $$
  with q as (
    select upper(btrim(p_state)) as st, public.norm_place_name(p_city) as nm
  ), cand as (
    select pl.geom, case pl.kind when 'place' then 1 else 2 end as pri,
           case pl.kind when 'place' then 'place' else 'town' end as basis
      from public.places pl, q
     where q.nm is not null and pl.state = q.st and pl.name_norm = q.nm
    union all
    select pc.geom, 3, 'postal_city'
      from public.postal_codes pc, q
     where q.nm is not null and pc.state = q.st and public.norm_place_name(pc.city) = q.nm
       and pc.geom is not null
  ), everything as (
    select st_centroid(st_collect(geom::geometry))::geography as c from cand
  ), best as (
    select min(pri) as p from cand
  )
  select (select st_centroid(st_collect(cand.geom::geometry))::geography
            from cand, best where cand.pri = best.p),
         (select max(st_distance(cand.geom, everything.c)) from cand, everything),
         (select min(cand.basis) from cand, best where cand.pri = best.p)
   where exists (select 1 from cand)
$$;

comment on function public.resolve_place_point(text, text) is
  'Resolves a declared state plus a city name to a point. spread_m is how far the candidates spread from their centroid: callers must treat more than 20 miles (32,187 m) as ambiguous.';

grant execute on function public.resolve_place_point(text, text) to anon, authenticated;
grant execute on function public.norm_place_name(text) to anon, authenticated;

-- ------------------------------------------------ the trigger uses it now

create or replace function resolve_location_from_gazetteer()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_state    text;
  v_zip_geom extensions.geography;
  v_city     extensions.geography;
  v_spread   float8;
  v_label    text;
begin
  -- The ZIP, normalised to the 5-digit key the gazetteer uses.
  if new.pickup_postal_code is not null and length(trim(new.pickup_postal_code)) > 0 then
    new.pickup_postal_code := substring(trim(new.pickup_postal_code) from 1 for 5);
    select pc.state, pc.geom
      into v_state, v_zip_geom
      from postal_codes pc
     where pc.postal_code = new.pickup_postal_code;
  end if;

  -- A ZIP names its state authoritatively. Fill it only when the source left it out.
  if v_state is not null and new.pickup_state is null then
    new.pickup_state := v_state;
  end if;

  -- The city's point, when there is no known ZIP but a city and a DECLARED state.
  if v_zip_geom is null
     and nullif(trim(new.pickup_state), '') is not null
     and nullif(trim(new.pickup_city), '') is not null then
    select r.point, r.spread_m into v_city, v_spread
      from resolve_place_point(new.pickup_state, new.pickup_city) r;
    if v_spread is null or v_spread > 32187 then  -- 20 miles: ambiguous
      v_city := null;
    end if;
  end if;

  -- No point yet: take the ZIP's, else the city's.
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

  -- A point is already present: label it by what it matches.
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
end $$;

-- --------------------------------------------------- staging the Census files

create or replace function public.stage_file_reset(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name not in ('census_zcta_gazetteer_2023', 'census_zcta_county_rel_2020', 'geonames_us',
                    'census_places_2023', 'census_cousubs_2023') then
    raise exception 'unknown staging file %', p_name;
  end if;
  delete from staging.file_parts where name = p_name;
end $$;

create or replace function public.stage_file_part(p_name text, p_part integer, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name not in ('census_zcta_gazetteer_2023', 'census_zcta_county_rel_2020', 'geonames_us',
                    'census_places_2023', 'census_cousubs_2023') then
    raise exception 'unknown staging file %', p_name;
  end if;
  insert into staging.file_parts (name, part, body)
  values (p_name, p_part, p_body)
  on conflict (name, part) do update set body = excluded.body, fetched_at = now();
end $$;

-- Parse both staged Census files into `places` in one transaction. Headers are
-- found by name. Refuses to write anything if a file is missing or implausibly small.
create or replace function public.load_places_from_staging()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        record;
  v_hdr    text[];
  i_usps   int; i_geoid int; i_name int; i_lat int; i_lon int;
  v_counts jsonb := '{}'::jsonb;
  v_n      int;
begin
  drop table if exists pg_temp._pl_lines, pg_temp._pl_rows;
  create temp table _pl_lines on commit drop as
    select fp.name, t.n, rtrim(t.line, E'\r') as line
      from (select name, string_agg(body, '' order by part) as txt
              from staging.file_parts
             where name in ('census_places_2023', 'census_cousubs_2023')
             group by name) fp
      cross join lateral string_to_table(fp.txt, E'\n') with ordinality as t(line, n);

  create temp table _pl_rows (geoid text, kind text, state text, name text, lat float8, lon float8, source text)
    on commit drop;

  for f in select * from (values ('census_places_2023', 'place', 'P'),
                                 ('census_cousubs_2023', 'cousub', 'S')) as v(file, kind, prefix) loop
    select array_agg(upper(btrim(x)) order by o) into v_hdr
      from pg_temp._pl_lines l
      cross join lateral unnest(string_to_array(replace(l.line, U&'\FEFF', ''), E'\t')) with ordinality u(x, o)
     where l.name = f.file and l.n = 1;
    if v_hdr is null then
      raise exception '% is not staged', f.file;
    end if;
    i_usps  := array_position(v_hdr, 'USPS');
    i_geoid := array_position(v_hdr, 'GEOID');
    i_name  := array_position(v_hdr, 'NAME');
    i_lat   := array_position(v_hdr, 'INTPTLAT');
    i_lon   := array_position(v_hdr, 'INTPTLONG');
    if i_usps is null or i_geoid is null or i_name is null or i_lat is null or i_lon is null then
      raise exception '% header not recognised: %', f.file, v_hdr;
    end if;

    insert into pg_temp._pl_rows
    select f.prefix || geoid, f.kind, usps, name, lat_s::float8, lon_s::float8, 'census_gazetteer_2023_' || f.kind
      from (select btrim(split_part(line, E'\t', i_usps))  as usps,
                   btrim(split_part(line, E'\t', i_geoid)) as geoid,
                   btrim(split_part(line, E'\t', i_name))  as name,
                   btrim(split_part(line, E'\t', i_lat))   as lat_s,
                   btrim(split_part(line, E'\t', i_lon))   as lon_s
              from pg_temp._pl_lines where name = f.file and n > 1) x
     where usps ~ '^[A-Z]{2}$' and geoid ~ '^\d+$' and length(name) > 0
       and name !~* 'not defined'
       and lat_s ~ '^-?\d+(\.\d+)?$' and lon_s ~ '^-?\d+(\.\d+)?$';
    get diagnostics v_n = row_count;
    if v_n < 10000 then
      raise exception '% parsed only % rows; refusing a partial load', f.file, v_n;
    end if;
    v_counts := v_counts || jsonb_build_object(f.file, v_n);
  end loop;

  insert into public.places (geoid, kind, state, name, name_norm, lat, lon, source)
  select geoid, kind, state, name,
         public.norm_place_name(regexp_replace(name,
           '\s+(charter township|city and borough|city|village|town|township|borough|cdp|municipality|plantation)$',
           '', 'i')),
         lat, lon, source
    from pg_temp._pl_rows
   where public.norm_place_name(regexp_replace(name,
           '\s+(charter township|city and borough|city|village|town|township|borough|cdp|municipality|plantation)$',
           '', 'i')) is not null
  on conflict (geoid) do update set
    kind = excluded.kind, state = excluded.state, name = excluded.name,
    name_norm = excluded.name_norm, lat = excluded.lat, lon = excluded.lon, source = excluded.source;
  get diagnostics v_n = row_count;

  delete from staging.file_parts where name in ('census_places_2023', 'census_cousubs_2023');
  return v_counts || jsonb_build_object('written', v_n);
end $$;

revoke execute on function public.load_places_from_staging() from public, anon, authenticated;
grant execute on function public.load_places_from_staging() to service_role;
