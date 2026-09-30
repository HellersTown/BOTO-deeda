-- platform_functions.sql
--
-- Executable verification of every platform function, each tested individually
-- against real rows.
--
-- WHY THIS FILE EXISTS: every function below originally passed "it exists" and
-- several failed "it is correct". Six bugs were found by running this suite,
-- including a critical privilege escalation. Existence is not correctness.
--
-- HOW TO RUN: paste into the Supabase SQL editor, or
--     psql "$DATABASE_URL" -f platform/supabase/tests/platform_functions.sql
--
-- SAFETY: the entire suite runs inside one transaction that ROLLS BACK. It
-- inserts fixture rows, asserts, and leaves the database exactly as it found it.
-- Safe to run against production.
--
-- OUTPUT: one row per assertion. Any row with pass = false is a regression.

begin;

create temp table _t (n int, area text, test text, pass boolean, detail text) on commit drop;
grant all on _t to authenticated;

-- ====================================================================== fixtures

insert into postal_codes (postal_code, city, state, lat, lon) values
  ('53202','Milwaukee','WI',43.0389,-87.9065), ('53213','Wauwatosa','WI',43.0495,-88.0076),
  ('53511','Beloit','WI',42.5236,-89.0343),    ('53703','Madison','WI',43.0747,-89.3843),
  ('60601','Chicago','IL',41.8855,-87.6221),   ('80202','Denver','CO',39.7392,-104.9903)
on conflict (postal_code) do nothing;

insert into sources (slug, name, url, tier, ingest, active)
values ('t-src','Test Source','https://t.test','federal','official_api', true);
insert into auctions (source_id, external_id, title)
select id, 'A1', 'Test auction' from sources where slug = 't-src';

-- Lots are inserted WITHOUT pickup_geom, exactly as an adapter emits them.
-- The gazetteer trigger (0007) must resolve location from the ZIP.
insert into lots (source_id, auction_id, external_id, title, description,
                  current_bid_cents, next_bid_cents, bid_count, closes_at,
                  pickup_city, pickup_state, pickup_postal_code, ships,
                  primary_image_url, image_count)
select s.id, a.id, v.ext, v.title, v.descr, v.bid, v.nb, v.bids, now() + interval '2 days',
       v.city, v.st, v.zip, v.ships, v.img, v.imgs
from sources s join auctions a on a.source_id = s.id
cross join (values
  ('L-near',   'DJI Mavic 3T thermal drone',        'Thermal drone, flies',
     145000::bigint,150000::bigint,3,'Wauwatosa','WI','53213',false,'http://i/1',4),
  ('L-ships',  'DJI Mavic 3T thermal drone shipped','Ships anywhere',
      90000::bigint, 95000::bigint,1,'Chicago',  'IL','60601',true, 'http://i/2',2),
  ('L-instate','DJI drone thermal Madison',         'Pickup only',
      50000::bigint, 55000::bigint,0,'Madison',  'WI','53703',false,'http://i/3',5),
  ('L-excl',   'DJI Mavic 3T thermal drone Denver', 'Pickup only Denver',
      10000::bigint, 12000::bigint,0,'Denver',   'CO','80202',false,'http://i/4',1),
  -- Adapter left the state blank; ZIP 53511 is unambiguously Wisconsin.
  ('L-beloit', 'DJI thermal drone Beloit',          'Pickup only',
      20000::bigint, 22500::bigint,0,'BELOIT',   null,'53511',false,'http://i/5',3),
  -- The Beloit WI / Beloit KS trap: declares Kansas, ZIP says Wisconsin.
  ('L-trap',   'Hansen tractor',                    'Declared Kansas',
      30000::bigint, 32500::bigint,0,'BELOIT',   'KS','53511',false,'http://i/6',3)
) as v(ext,title,descr,bid,nb,bids,city,st,zip,ships,img,imgs)
where s.slug = 't-src';

-- City and declared state but no ZIP, as many Wisconsin sites publish (0016,
-- 0017). Postal city names call every Wauwatosa ZIP "Milwaukee", so this lot is
-- placed from the Census place, the row below in a fresh database.
insert into places (geoid, kind, state, name, name_norm, lat, lon, source)
values ('P5584675', 'place', 'WI', 'Wauwatosa city', 'wauwatosa', 43.063165, -88.035583, 'census_gazetteer_2023_place')
on conflict (geoid) do nothing;

insert into lots (source_id, auction_id, external_id, title, current_bid_cents, closes_at,
                  pickup_city, pickup_state, pickup_postal_code)
select s.id, a.id, v.ext, v.title, 10000, now() + interval '2 days', v.city, v.st, null
from sources s join auctions a on a.source_id = s.id
cross join (values
  ('L-cityonly', 'Log splitter, city only', 'Wauwatosa', 'WI'),
  -- A city with no declared state must never be placed: Beloit WI or Beloit KS?
  ('L-nostate',  'Log splitter, no state',  'Beloit',    null)
) as v(ext, title, city, st)
where s.slug = 't-src';

-- ======================================================= 1. location disjunction

with r as (
  select (select external_id from lots l where l.id = s.lot_id) as ext, s.match_basis
  from search_lots(p_query => 'DJI thermal drone', p_postal_code => '53202',
                   p_radius_miles => 50, p_include_shippable => true,
                   p_states => array['WI']) s)
insert into _t
select 1, 'search', 'nearby arm: 5 mi lot is in',
       exists (select 1 from r where ext='L-near' and match_basis='nearby'), null
union all select 2, 'search', 'in_state arm: 75 mi WI lot is in',
       exists (select 1 from r where ext='L-instate' and match_basis='in_state'), null
union all select 3, 'search', 'ships arm: out-of-state shippable lot is in',
       exists (select 1 from r where ext='L-ships' and match_basis='ships_to_you'), null
union all select 4, 'search', 'far + no ship + out of state is EXCLUDED',
       not exists (select 1 from r where ext='L-excl'), null;

-- ============================================================== 2. ranking

with r as (
  select (select external_id from lots l where l.id = s.lot_id) as ext, s.relevance
  from search_lots(p_query => 'DJI thermal drone', p_postal_code => '53202',
                   p_radius_miles => 50, p_states => array['WI']) s)
insert into _t
select 5, 'ranking', 'near lot outranks far lot (was inverted by ts_rank_cd)',
       (select relevance from r where ext='L-near') > (select relevance from r where ext='L-instate'),
       format('near=%s instate=%s',
              (select relevance from r where ext='L-near'),
              (select relevance from r where ext='L-instate'));

-- ======================================================== 3. gazetteer backfill

insert into _t
select 6, 'gazetteer', 'blank state filled from ZIP',
       (select pickup_state = 'WI' and pickup_geom is not null from lots where external_id='L-beloit'),
       (select format('state=%s', pickup_state) from lots where external_id='L-beloit')
union all select 7, 'gazetteer', 'declared state NOT overwritten',
       (select pickup_state = 'KS' from lots where external_id='L-trap'), null
union all select 8, 'gazetteer', 'KS/WI conflict surfaced for review',
       exists (select 1 from v_location_conflicts where external_id='L-trap'
                  and declared_state='KS' and gazetteer_state='WI'), null
-- A query that names the fixture keeps this independent of how many real
-- Wisconsin lots production holds: an unfiltered search returns at most 200.
union all select 9, 'gazetteer', 'previously-invisible WI lot now found',
       exists (select 1 from search_lots(p_query => 'thermal drone Beloit', p_postal_code => '53202',
                                         p_radius_miles => 50, p_states => array['WI']) s
                where s.lot_id = (select id from lots where external_id='L-beloit')), null;

-- ===================================================== 3b. city placement (0016)

insert into _t
select 28, 'gazetteer', 'city + declared state placed without a ZIP',
       (select pickup_geo_source = 'city'
               and st_dwithin(pickup_geom, (select geom from postal_codes where postal_code = '53213'), 8047)
          from lots where external_id = 'L-cityonly'),
       (select format('source=%s', pickup_geo_source) from lots where external_id = 'L-cityonly')
union all select 29, 'gazetteer', 'city without a state is never placed',
       (select pickup_geom is null and pickup_geo_source is null from lots where external_id = 'L-nostate'), null
union all select 30, 'gazetteer', 'city-placed lot appears in a radius search',
       exists (select 1 from search_lots(p_query => 'log splitter', p_postal_code => '53202',
                                         p_radius_miles => 50) s
                where s.lot_id = (select id from lots where external_id = 'L-cityonly')), null
union all select 31, 'gazetteer', 'ZIP-placed lot labelled postal_code',
       (select pickup_geo_source = 'postal_code' from lots where external_id = 'L-near'), null
union all select 32, 'gazetteer', 'a name shared by far-apart towns is refused',
       coalesce((select spread_m > 32187 from resolve_place_point('WI', 'Lincoln')), true),
       (select format('spread=%s mi', round((spread_m / 1609.34)::numeric, 1)) from resolve_place_point('WI', 'Lincoln'))
union all select 33, 'gazetteer', '"Village of", "Town of" and "Saint" forms normalise',
       norm_place_name('Village of Hales Corners') = 'hales corners'
       and norm_place_name('Town of Vernon') = 'vernon'
       and norm_place_name('Saint Francis') = norm_place_name('St. Francis'), null;

-- ================================================ 3c. held sources (0021)
-- A source held on its terms (ingest_allowed = false) keeps its stored rows,
-- but search, and so the hunt matcher, must not return them.

insert into sources (slug, name, url, tier, ingest, active, ingest_allowed)
values ('t-held','Held Source','https://held.test','county','html', true, false);
insert into lots (source_id, external_id, title, current_bid_cents, closes_at,
                  pickup_city, pickup_state, pickup_postal_code)
select id, 'L-held', 'DJI Mavic 3T thermal drone held', 1000, now() + interval '2 days',
       'Wauwatosa', 'WI', '53213'
from sources where slug = 't-held';

insert into _t
select 34, 'search', 'a source held on its terms is hidden from search',
       not exists (select 1 from search_lots(p_query => 'DJI thermal drone held', p_postal_code => '53202',
                                             p_radius_miles => 50) s
                    where s.lot_id = (select id from lots where external_id = 'L-held'))
       and exists (select 1 from search_lots(p_query => 'DJI thermal drone', p_postal_code => '53202',
                                             p_radius_miles => 50) s
                    where s.lot_id = (select id from lots where external_id = 'L-near')), null;

-- =========================================================== 4. sleeper score

with s as (
  select (compute_sleeper('Box of misc tools',null,0,1000::bigint,10000::bigint,5,
                          now()+interval '3 days')->>'score')::numeric as photographed,
         (compute_sleeper('Box of misc tools',null,0,1000::bigint,10000::bigint,0,
                          now()+interval '3 days')->>'score')::numeric as no_photos,
         (compute_sleeper('1909-S VDB Lincoln Wheat Cent VF-20 key date professionally graded PCGS',
                          'Certified by PCGS strong strike even wear obverse and reverse fields',
                          27,120000::bigint,100000::bigint,12,now()+interval '5 days')->>'score')::numeric as catalogued)
insert into _t
select 10, 'sleeper', 'no-photo lot discounted well below photographed twin',
       no_photos < photographed * 0.5, format('photo=%s none=%s', photographed, no_photos) from s
union all
select 11, 'sleeper', 'well-catalogued busy lot scores zero',
       catalogued = 0, format('score=%s', catalogued) from s;

-- ============================================================ 5. image search

insert into lot_images (lot_id, url, clip_embedding, embed_model)
select l.id, l.primary_image_url,
       case when l.external_id='L-near'
            then (select ('['||string_agg('1',',')||']')::extensions.vector(768) from generate_series(1,768))
            else (select ('['||string_agg(case when g<=100 then '0.5' else '1' end,',')||']')::extensions.vector(768)
                    from generate_series(1,768) g) end,
       'test'
from lots l where l.external_id in ('L-near','L-beloit');

-- L-beloit has a 4-word description, so a strong visual match should flag it.
update lots set desc_richness = 4 where external_id='L-beloit';

with m as (
  select (select external_id from lots l where l.id = x.lot_id) as ext, x.underdescribed
  from match_lots_by_image(
    p_embedding => (select ('['||string_agg('1',',')||']')::extensions.vector(768) from generate_series(1,768)),
    p_min_similarity => 0.78) x)
insert into _t
select 12, 'image', 'visually similar lots returned',
       (select count(*) from m) = 2, (select count(*)::text from m)
union all select 13, 'image', 'thin-description match flagged underdescribed',
       coalesce((select underdescribed from m where ext='L-beloit'), false), null;

-- ===================================================== 6. tiers and downgrade

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000aaaa','tier@example.test','authenticated','authenticated');

do $$
declare u uuid := '00000000-0000-4000-8000-00000000aaaa';
        v extensions.vector(768);
begin
  select ('['||string_agg('0.1',',')||']')::extensions.vector(768) into v from generate_series(1,768);

  insert into _t select 14, 'tiers', 'signup creates free profile',
    (select tier = 'free' from profiles where id = u), null;

  insert into hunts(user_id,name) values (u,'t1'),(u,'t2'),(u,'t3');
  begin insert into hunts(user_id,name) values (u,'t4');
        insert into _t values (15,'tiers','free 4th hunt blocked',false,'allowed');
  exception when check_violation then
        insert into _t values (15,'tiers','free 4th hunt blocked',true,null); end;

  begin insert into hunts(user_id,name,active,reference_embedding) values (u,'p0',true,v);
        insert into _t values (16,'tiers','free photo hunt blocked',false,'allowed');
  exception when check_violation then
        insert into _t values (16,'tiers','free photo hunt blocked',true,null); end;

  update profiles set tier = 'pro' where id = u;
  insert into hunts(user_id,name,reference_embedding)
    select u, 'p'||g, v from generate_series(1,10) g;
  begin insert into hunts(user_id,name,reference_embedding) values (u,'p11',v);
        insert into _t values (17,'tiers','pro 11th photo hunt blocked',false,'allowed');
  exception when check_violation then
        insert into _t values (17,'tiers','pro 11th photo hunt blocked',true,null); end;

  -- The subscribe-create-cancel exploit.
  update profiles set tier = 'free' where id = u;
  insert into _t select 18, 'tiers', 'downgrade pauses photo hunts (exploit closed)',
    count(*) filter (where active and reference_embedding is not null) = 0,
    format('photo_active=%s', count(*) filter (where active and reference_embedding is not null))
    from hunts where user_id = u;
  insert into _t select 19, 'tiers', 'downgrade keeps oldest text hunts',
    string_agg(name, ',' order by name) = 't1,t2,t3', string_agg(name, ',' order by name)
    from hunts where user_id = u and active;
  insert into _t select 20, 'tiers', 'paused hunts are paused, not deleted',
    count(*) = 13, count(*)::text from hunts where user_id = u;
end $$;

-- ================================================================ 7. security
-- Everything below runs as the real `authenticated` role, through RLS, exactly
-- as the browser client would.

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000bbbb','atk@example.test','authenticated','authenticated');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-00000000bbbb","role":"authenticated"}';

do $$ begin
  begin update profiles set tier = 'dealer' where id = auth.uid();
        insert into _t values (21,'security','user cannot self-promote tier (CRITICAL)',false,'SUCCEEDED');
  exception when others then
        insert into _t values (21,'security','user cannot self-promote tier (CRITICAL)',true,null); end;

  begin update profiles set display_name = 'ok' where id = auth.uid();
        insert into _t values (22,'security','user can still edit own name',true,null);
  exception when others then
        insert into _t values (22,'security','user can still edit own name',false,sqlerrm); end;

  begin insert into sources(name,url,submitted_by,robots_allows)
        values ('x','https://victim.test',auth.uid(),true);
        insert into _t values (23,'security','submission cannot pre-authorise crawl',false,'allowed');
  exception when others then
        insert into _t values (23,'security','submission cannot pre-authorise crawl',true,null); end;

  begin insert into sources(name,url,submitted_by) values ('Joe','https://joe.test',auth.uid());
        insert into _t values (24,'security','clean submission still accepted',true,null);
  exception when others then
        insert into _t values (24,'security','clean submission still accepted',false,sqlerrm); end;

  begin insert into alerts(user_id,kind,title) values (auth.uid(),'hunt_match','FAKE');
        insert into _t values (25,'security','user cannot forge alerts',false,'allowed');
  exception when others then
        insert into _t values (25,'security','user cannot forge alerts',true,null); end;

  insert into _t select 26,'security','free user cannot read rival intel',
    count(*) = 0, count(*)::text from rivals;
end $$;

reset role;

insert into _t select 27, 'security', 'submitted source is quarantined',
  (not active and robots_allows is null and not ingest_allowed),
  format('active=%s robots=%s ingest=%s', active, robots_allows, ingest_allowed)
  from sources where url = 'https://joe.test';

-- ================================================================== report

-- One result set, so the verdict is visible in any client, including ones that
-- only display the final statement's rows.
select n, area, test, pass, detail from _t
union all
select 999, 'SUMMARY',
       format('%s passed, %s failed, %s total',
              count(*) filter (where pass), count(*) filter (where not pass), count(*)),
       bool_and(pass), null
from _t
order by n;

rollback;
