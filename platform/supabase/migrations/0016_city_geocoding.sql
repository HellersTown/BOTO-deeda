-- 0016_city_geocoding.sql
--
-- Place lots that publish a city and a state but no ZIP code.
--
-- Until now a lot got a point on the map only from explicit coordinates or from
-- its ZIP (0007). Many Wisconsin sources publish "Waukesha, WI" and nothing
-- more, so those lots had no point and silently fell out of every radius
-- search, the product's main way of looking.
--
-- The fix resolves CITY + DECLARED STATE to the centroid of that place's ZIP
-- points in the gazetteer. It is still a lookup, not a guess:
--   * The state must be declared by the source. A city alone is never enough:
--     there is a Beloit in Wisconsin and one in Kansas (see 0007).
--   * If the place's ZIP points spread more than 20 miles from their centroid,
--     the name is treated as ambiguous and left unresolved. In Wisconsin the
--     widest spread is Milwaukee at about 15 miles end to end.
--   * A declared value is never overwritten, as in 0007.
--
-- Every point now records how it was found, in pickup_geo_source:
--   'source'       coordinates the source published (or a lot sharing the
--                  point its auction published);
--   'postal_code'  the ZIP's centroid;
--   'city'         the city's centroid. Distances from these are approximate,
--                  and the app can say so.

alter table lots
  add column if not exists pickup_geo_source text
  check (pickup_geo_source in ('source', 'postal_code', 'city'));
alter table auctions
  add column if not exists pickup_geo_source text
  check (pickup_geo_source in ('source', 'postal_code', 'city'));

comment on column lots.pickup_geo_source is
  'How pickup_geom was found: source coordinates, the ZIP centroid, or the city centroid (approximate).';
comment on column auctions.pickup_geo_source is
  'How pickup_geom was found: source coordinates, the ZIP centroid, or the city centroid (approximate).';

create index if not exists postal_codes_state_city_idx on postal_codes (state, lower(city));

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

  -- The city's centroid, when there is no known ZIP but a city and a DECLARED
  -- state. Left NULL when the name spreads over more than 20 miles (ambiguous).
  if v_zip_geom is null
     and nullif(trim(new.pickup_state), '') is not null
     and nullif(trim(new.pickup_city), '') is not null then
    with place as (
      select pc.geom
        from postal_codes pc
       where pc.state = upper(trim(new.pickup_state))
         and lower(pc.city) = lower(trim(new.pickup_city))
         and pc.geom is not null
    ), c as (
      select st_centroid(st_collect(geom::geometry))::geography as centroid from place
    )
    select c.centroid, (select max(st_distance(p.geom, c.centroid)) from place p)
      into v_city, v_spread
      from c;
    if v_spread is null or v_spread > 32187 then  -- 20 miles, in metres
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
    -- The source's own coordinates, or, for a lot, the point it shares with its
    -- auction, which then carries the auction's label.
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

comment on function resolve_location_from_gazetteer is
  'Fills pickup_state and pickup_geom from the postal_codes gazetteer: by ZIP, else by city plus a declared state (never a city alone, and never a place spread over 20+ miles). Never overwrites a declared value. Records how the point was found in pickup_geo_source.';

-- Re-create the triggers so a changed city also re-resolves.
drop trigger if exists lots_resolve_location on lots;
create trigger lots_resolve_location
  before insert or update of pickup_postal_code, pickup_state, pickup_city, pickup_geom on lots
  for each row execute function resolve_location_from_gazetteer();

drop trigger if exists auctions_resolve_location on auctions;
create trigger auctions_resolve_location
  before insert or update of pickup_postal_code, pickup_state, pickup_city, pickup_geom on auctions
  for each row execute function resolve_location_from_gazetteer();

-- Label and, where possible, place the rows already stored. Auctions first, so
-- lots that share their auction's point pick up the auction's label.
update auctions set pickup_city = pickup_city;
update lots set pickup_city = pickup_city;
