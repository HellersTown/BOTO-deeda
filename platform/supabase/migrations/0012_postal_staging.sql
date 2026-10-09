-- 0012_postal_staging.sql
--
-- Load the national ZIP gazetteer by parsing in Postgres, not in an Edge Function.
--
-- WHY. The first loader parsed three public files (Census ZCTA gazetteer, Census
-- ZCTA-to-county relationship file, GeoNames US postal codes: ~20 MB of text) in
-- one Edge Function call. Production logs: "CPU Time exceeded", 7 seconds in,
-- after it had written 20,000 of ~41,000 rows. Edge Functions have a small
-- per-request CPU budget; splitting 20 MB into hundreds of thousands of JS
-- strings and serializing 5,000-row upserts does not fit in it.
--
-- NEW SHAPE. The function only downloads, unzips, and hands raw text to Postgres
-- in ~1 MB chunks (stage_file_part): cheap in CPU. One SQL function
-- (load_postal_codes_from_staging) then parses, joins and upserts everything in
-- a single transaction, where there is no such limit. If any file is missing or
-- implausibly small it raises, and nothing is written, so there is never a
-- half-loaded table again. The partial rows from the failed run are overwritten
-- by the upsert.

create schema if not exists staging;
revoke all on schema staging from public, anon, authenticated;

create table if not exists staging.file_parts (
  name       text not null,
  part       integer not null,
  body       text not null,
  fetched_at timestamptz not null default now(),
  primary key (name, part)
);

-- Only these three names may be staged; anything else is a bug or an abuse.
create or replace function public.stage_file_reset(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name not in ('census_zcta_gazetteer_2023', 'census_zcta_county_rel_2020', 'geonames_us') then
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
  if p_name not in ('census_zcta_gazetteer_2023', 'census_zcta_county_rel_2020', 'geonames_us') then
    raise exception 'unknown staging file %', p_name;
  end if;
  insert into staging.file_parts (name, part, body)
  values (p_name, p_part, p_body)
  on conflict (name, part) do update set body = excluded.body, fetched_at = now();
end $$;

-- When each file was last staged, so the loader can refuse to re-download a file
-- it already holds (the function URL is public; census.gov should not pay for that).
create or replace function public.staged_files()
returns table (name text, parts integer, chars bigint, fetched_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select name, count(*)::int, sum(length(body))::bigint, max(fetched_at)
    from staging.file_parts group by name
$$;

create or replace function public.load_postal_codes_from_staging()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gaz_hdr text[];
  v_rel_hdr text[];
  i_zip int; i_lat int; i_lon int;
  r_zcta int; r_county int; r_name int; r_land int;
  v_gaz int; v_rel int; v_geo int;
  v_written int;
  v_report jsonb;
begin
  drop table if exists pg_temp._lines, pg_temp._gaz, pg_temp._rel, pg_temp._geo;

  -- Reassemble each file from its parts, then split into numbered lines.
  create temp table _lines on commit drop as
    select f.name, t.n, rtrim(t.line, E'\r') as line
      from (select name, string_agg(body, '' order by part) as txt
              from staging.file_parts group by name) f
      cross join lateral string_to_table(f.txt, E'\n') with ordinality as t(line, n);

  -- Headers are located by NAME, not position, and trimmed: Census gazetteer
  -- headers carry trailing whitespace and files can start with a BOM.
  select array_agg(upper(btrim(x)) order by o) into v_gaz_hdr
    from _lines l
    cross join lateral unnest(string_to_array(replace(l.line, U&'\FEFF', ''), E'\t')) with ordinality u(x, o)
   where l.name = 'census_zcta_gazetteer_2023' and l.n = 1;
  i_zip := array_position(v_gaz_hdr, 'GEOID');
  i_lat := array_position(v_gaz_hdr, 'INTPTLAT');
  i_lon := array_position(v_gaz_hdr, 'INTPTLONG');
  if i_zip is null or i_lat is null or i_lon is null then
    raise exception 'gazetteer header not recognised: %', v_gaz_hdr;
  end if;

  select array_agg(upper(btrim(x)) order by o) into v_rel_hdr
    from _lines l
    cross join lateral unnest(string_to_array(replace(l.line, U&'\FEFF', ''), '|')) with ordinality u(x, o)
   where l.name = 'census_zcta_county_rel_2020' and l.n = 1;
  r_zcta   := array_position(v_rel_hdr, 'GEOID_ZCTA5_20');
  r_county := array_position(v_rel_hdr, 'GEOID_COUNTY_20');
  r_name   := array_position(v_rel_hdr, 'NAMELSAD_COUNTY_20');
  r_land   := array_position(v_rel_hdr, 'AREALAND_PART');
  if r_zcta is null or r_county is null or r_name is null or r_land is null then
    raise exception 'relationship header not recognised: %', v_rel_hdr;
  end if;

  -- 1. Census coordinates (the ZCTA internal point).
  create temp table _gaz on commit drop as
    select zip, lat_s::float8 as lat, lon_s::float8 as lon
      from (select btrim(split_part(line, E'\t', i_zip)) as zip,
                   btrim(split_part(line, E'\t', i_lat)) as lat_s,
                   btrim(split_part(line, E'\t', i_lon)) as lon_s
              from _lines where name = 'census_zcta_gazetteer_2023' and n > 1) x
     where zip ~ '^\d{5}$' and lat_s ~ '^-?\d+(\.\d+)?$' and lon_s ~ '^-?\d+(\.\d+)?$';

  -- 2. State and county: the county holding the most land in each ZCTA.
  create temp table _rel on commit drop as
    select distinct on (x.zip) x.zip, st.abbr as state, x.county
      from (select btrim(split_part(line, '|', r_zcta)) as zip,
                   left(btrim(split_part(line, '|', r_county)), 2) as fips,
                   btrim(split_part(line, '|', r_name)) as county,
                   case when btrim(split_part(line, '|', r_land)) ~ '^\d+$'
                        then btrim(split_part(line, '|', r_land))::bigint else 0 end as land
              from _lines where name = 'census_zcta_county_rel_2020' and n > 1) x
      join (values
        ('01','AL'),('02','AK'),('04','AZ'),('05','AR'),('06','CA'),('08','CO'),('09','CT'),('10','DE'),
        ('11','DC'),('12','FL'),('13','GA'),('15','HI'),('16','ID'),('17','IL'),('18','IN'),('19','IA'),
        ('20','KS'),('21','KY'),('22','LA'),('23','ME'),('24','MD'),('25','MA'),('26','MI'),('27','MN'),
        ('28','MS'),('29','MO'),('30','MT'),('31','NE'),('32','NV'),('33','NH'),('34','NJ'),('35','NM'),
        ('36','NY'),('37','NC'),('38','ND'),('39','OH'),('40','OK'),('41','OR'),('42','PA'),('44','RI'),
        ('45','SC'),('46','SD'),('47','TN'),('48','TX'),('49','UT'),('50','VT'),('51','VA'),('53','WA'),
        ('54','WV'),('55','WI'),('56','WY'),('60','AS'),('66','GU'),('69','MP'),('72','PR'),('78','VI')
      ) as st(fips, abbr) on st.fips = x.fips
     where x.zip ~ '^\d{5}$'
     order by x.zip, x.land desc;

  -- 3. GeoNames (no header): 1 country, 2 postal code, 3 place, 4 state name,
  --    5 state code, 6 county, ..., 10 lat, 11 lon.
  create temp table _geo on commit drop as
    select distinct on (zip) zip, city, state, county, lat_s::float8 as lat, lon_s::float8 as lon
      from (select btrim(split_part(line, E'\t', 2)) as zip,
                   nullif(btrim(split_part(line, E'\t', 3)), '') as city,
                   upper(btrim(split_part(line, E'\t', 5))) as state,
                   nullif(btrim(split_part(line, E'\t', 6)), '') as county,
                   btrim(split_part(line, E'\t', 10)) as lat_s,
                   btrim(split_part(line, E'\t', 11)) as lon_s
              from _lines where name = 'geonames_us' and split_part(line, E'\t', 1) = 'US') x
     where zip ~ '^\d{5}$' and state ~ '^[A-Z]{2}$'
       and lat_s ~ '^-?\d+(\.\d+)?$' and lon_s ~ '^-?\d+(\.\d+)?$'
     order by zip;

  select count(*) into v_gaz from _gaz;
  select count(*) into v_rel from _rel;
  select count(*) into v_geo from _geo;

  -- Refuse a partial load. Real volumes: ~33,800 ZCTAs, ~33,800 related ZCTAs,
  -- ~41,000 GeoNames ZIPs. The thresholds leave room for vintage changes while
  -- catching a truncated download. (The test harness sets the floor to 1.)
  if v_gaz < coalesce(nullif(current_setting('app.postal_min_rows', true), '')::int, 30000)
     or v_rel < coalesce(nullif(current_setting('app.postal_min_rows', true), '')::int, 30000)
     or v_geo < coalesce(nullif(current_setting('app.postal_min_rows', true), '')::int, 30000) then
    raise exception 'refusing partial load: gazetteer %, relationship %, geonames % rows', v_gaz, v_rel, v_geo;
  end if;

  with merged as (
    select g.zip, geo.city,
           coalesce(r.state, geo.state) as state,
           coalesce(r.county, geo.county) as county,
           g.lat, g.lon,
           case when r.zip is not null then 'census_zcta_2023'
                else 'census_zcta_2023+geonames_state' end as source
      from _gaz g
      left join _rel r on r.zip = g.zip
      left join _geo geo on geo.zip = g.zip
     where coalesce(r.state, geo.state) is not null
    union all
    -- PO-box and single-organisation ZIPs: no Census geography, but real, and
    -- often exactly what federal and state facilities use.
    select geo.zip, geo.city, geo.state, geo.county, geo.lat, geo.lon, 'geonames'
      from _geo geo
     where not exists (select 1 from _gaz g where g.zip = geo.zip)
  ), up as (
    insert into public.postal_codes (postal_code, city, state, county, lat, lon, source)
    select zip, city, state, county, lat, lon, source from merged
    on conflict (postal_code) do update set
      city = excluded.city, state = excluded.state, county = excluded.county,
      lat = excluded.lat, lon = excluded.lon, source = excluded.source
    returning 1
  )
  select count(*) into v_written from up;

  v_report := jsonb_build_object(
    'gazetteer_zctas', v_gaz,
    'relationship_zctas', v_rel,
    'geonames_zips', v_geo,
    'written', v_written,
    'zctas_without_state', (select count(*) from _gaz g
                             where not exists (select 1 from _rel r where r.zip = g.zip)
                               and not exists (select 1 from _geo n where n.zip = g.zip)),
    'total_rows', (select count(*) from public.postal_codes),
    'wisconsin', (select count(*) from public.postal_codes where state = 'WI'),
    'by_source', (select jsonb_object_agg(coalesce(source, 'null'), n)
                    from (select source, count(*) n from public.postal_codes group by source) s));

  -- Staged text is only needed until it is parsed.
  delete from staging.file_parts;
  return v_report;
end $$;

revoke execute on function public.stage_file_reset(text) from public, anon, authenticated;
revoke execute on function public.stage_file_part(text, integer, text) from public, anon, authenticated;
revoke execute on function public.staged_files() from public, anon, authenticated;
revoke execute on function public.load_postal_codes_from_staging() from public, anon, authenticated;
grant execute on function public.stage_file_reset(text) to service_role;
grant execute on function public.stage_file_part(text, integer, text) to service_role;
grant execute on function public.staged_files() to service_role;
grant execute on function public.load_postal_codes_from_staging() to service_role;
