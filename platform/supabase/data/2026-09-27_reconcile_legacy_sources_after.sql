-- data/2026-09-27_reconcile_legacy_sources_after.sql  (runs after seed/sources.sql)

-- STEP 3: `verified = true` on all 23 legacy rows was a column default of the old
-- app, not a review. Nothing has been verified until the live probe says so.
update public.sources
   set verified = false
 where id in (select id from archive.sources_legacy_20260927);

-- STEP 4: the seed deliberately does not overwrite `active` on conflict (so a
-- re-run never undoes an admin's switch). For this one-time reconciliation the
-- seed's value is the reviewed one, so copy it for the legacy rows.
update public.sources s
   set active = v.active
  from (values
    ('govplanet', false), ('b-stock', false), ('liquidation-com', false),
    ('copart', false), ('iaai', false)
  ) as v(slug, active)
 where s.slug = v.slug;

-- STEP 5: wholesale is on hold (owner, 2026-09-27). Registered, never crawled.
update public.sources
   set active = false
 where tier = 'wholesale';

-- STEP 6: deep-link-only sources can never be ingested, whatever else changes.
update public.sources
   set ingest = 'deeplink_only', ingest_allowed = false
 where slug in ('facebook-marketplace', 'craigslist');
