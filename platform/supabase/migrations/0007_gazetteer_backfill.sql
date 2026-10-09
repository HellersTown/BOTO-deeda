-- 0007_gazetteer_backfill.sql
--
-- BUG 4, and the most expensive one found so far, because it silently hides real
-- inventory rather than merely mis-ordering it.
--
-- Observed end-to-end with real GSA adapter output: a 2015 Ford F-150 sitting in
-- Beloit, WISCONSIN did not appear in a Wisconsin search.
--
-- Why all three disjunction arms failed:
--   nearby       -> Beloit is 67.5 mi from Milwaukee, outside the 50 mi radius
--   in_state     -> GSA left PropertyState blank, so pickup_state was NULL
--   ships_to_you -> GSA surplus is pickup-only
--
-- The function behaved exactly as written. The rule it was obeying was too broad.
--
-- The adapter deliberately refuses to infer a state from a city name, and that is
-- correct: there is a Beloit in Wisconsin and a Beloit in Kansas, and a Hansen
-- auction house in each. Guessing puts Kansas lots in Wisconsin results.
--
-- But a ZIP CODE is not a city name. 53511 is Beloit, Wisconsin and nowhere else.
-- Deriving state from a postal code is an authoritative gazetteer lookup, not an
-- inference. Refusing to do it throws away inventory we can positively identify.
--
-- Fix: resolve location from the gazetteer at WRITE time, so every consumer of the
-- table sees complete data and no query has to re-derive it.
--
-- Two properties held deliberately:
--
--  1. A DECLARED VALUE IS NEVER OVERWRITTEN. We only fill NULLs. If a source says
--     the lot is in Colorado and the zip says Wisconsin, that disagreement is
--     evidence of a data problem, and silently picking one would destroy it. See
--     v_location_conflicts below for surfacing those instead.
--  2. Adapters no longer need to know about geography. They emit city/state/zip as
--     published and the database resolves the point. That keeps twelve adapters
--     from each reimplementing geocoding slightly differently.

create or replace function resolve_location_from_gazetteer()
returns trigger
language plpgsql
as $$
declare
  v_state text;
  v_geom  extensions.geography;
begin
  if new.pickup_postal_code is null or length(trim(new.pickup_postal_code)) = 0 then
    return new;
  end if;

  -- Normalise ZIP+4 down to the 5-digit key the gazetteer is keyed on.
  new.pickup_postal_code := substring(trim(new.pickup_postal_code) from 1 for 5);

  select pc.state, pc.geom
    into v_state, v_geom
    from postal_codes pc
   where pc.postal_code = new.pickup_postal_code;

  if v_state is null then
    -- Unknown ZIP. Leave everything as the source gave it; an unresolvable
    -- postal code is a gazetteer gap to fill, not a reason to invent a location.
    return new;
  end if;

  -- Fill only what is missing. Never overwrite what the source declared.
  if new.pickup_state is null then
    new.pickup_state := v_state;
  end if;

  if new.pickup_geom is null then
    new.pickup_geom := v_geom;
  end if;

  return new;
end $$;

comment on function resolve_location_from_gazetteer is
  'Fills pickup_state and pickup_geom from the postal_codes gazetteer when the source omitted them. Never overwrites a declared value: a ZIP-vs-state disagreement is data to investigate, not data to silently correct.';

drop trigger if exists lots_resolve_location on lots;
create trigger lots_resolve_location
  before insert or update of pickup_postal_code, pickup_state, pickup_geom on lots
  for each row execute function resolve_location_from_gazetteer();

drop trigger if exists auctions_resolve_location on auctions;
create trigger auctions_resolve_location
  before insert or update of pickup_postal_code, pickup_state, pickup_geom on auctions
  for each row execute function resolve_location_from_gazetteer();

-- ---------------------------------------------------------------------------
-- Surfacing conflicts instead of resolving them.
--
-- This is the Beloit WI / Beloit KS trap made visible. A row here means the
-- source's declared state disagrees with what its own ZIP code says, which is
-- either a source data error or a parser mapping the wrong field. Either way a
-- human should look, and neither value should be trusted until they do.

create or replace view v_location_conflicts
with (security_invoker = true)
as
select
  'lot'             as kind,
  l.id              as record_id,
  l.external_id,
  l.title,
  s.slug            as source_slug,
  l.pickup_city,
  l.pickup_state    as declared_state,
  pc.state          as gazetteer_state,
  l.pickup_postal_code,
  l.url
from lots l
join sources s        on s.id = l.source_id
join postal_codes pc  on pc.postal_code = l.pickup_postal_code
where l.pickup_state is not null
  and pc.state is not null
  and l.pickup_state <> pc.state

union all

select
  'auction', a.id, a.external_id, a.title, s.slug,
  a.pickup_city, a.pickup_state, pc.state, a.pickup_postal_code, a.url
from auctions a
join sources s        on s.id = a.source_id
join postal_codes pc  on pc.postal_code = a.pickup_postal_code
where a.pickup_state is not null
  and pc.state is not null
  and a.pickup_state <> pc.state;

comment on view v_location_conflicts is
  'Rows whose declared state disagrees with their own ZIP code. Each one is either bad source data or a parser mapping the wrong field (GSA PropertyState vs LocationST is exactly this hazard). Review, do not auto-correct.';

-- ---------------------------------------------------------------------------
-- Backfill any rows that predate the trigger.

update lots l
   set pickup_state = pc.state
  from postal_codes pc
 where pc.postal_code = l.pickup_postal_code
   and l.pickup_state is null
   and pc.state is not null;

update lots l
   set pickup_geom = pc.geom
  from postal_codes pc
 where pc.postal_code = l.pickup_postal_code
   and l.pickup_geom is null
   and pc.geom is not null;

update auctions a
   set pickup_state = pc.state
  from postal_codes pc
 where pc.postal_code = a.pickup_postal_code
   and a.pickup_state is null
   and pc.state is not null;

update auctions a
   set pickup_geom = pc.geom
  from postal_codes pc
 where pc.postal_code = a.pickup_postal_code
   and a.pickup_geom is null
   and pc.geom is not null;
