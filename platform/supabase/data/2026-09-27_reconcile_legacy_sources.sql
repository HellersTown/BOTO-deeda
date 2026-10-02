-- data/2026-09-27_reconcile_legacy_sources.sql
--
-- Reconcile the 23 source rows the earlier Waystock app created (2026-06-03) with
-- seed/sources.sql, then load the seed. Run as ONE transaction:
--
--   psql -1 -f data/2026-09-27_reconcile_legacy_sources.sql -f seed/sources.sql \
--        -f data/2026-09-27_reconcile_legacy_sources_after.sql
--
-- (In production it was sent as a single multi-statement query, which Postgres
-- executes atomically: if any statement fails, nothing is applied.)
--
-- WHY THIS IS NOT JUST "LOAD THE SEED":
-- The legacy rows have slug NULL. The seed upserts ON CONFLICT (slug), so loading
-- it directly would have created a second GSA, a second HiBid, a second GovDeals
-- (12 duplicates in all), and the legacy twins would stay active=true,
-- verified=true with no tier, no ingest method and no politeness settings.
--
-- STEP 1: snapshot, into a schema the API does not expose.
create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;
create table if not exists archive.sources_legacy_20260927 as
  select * from public.sources;

-- STEP 2: give each legacy row its slug, so the seed UPDATES it in place and its
-- id (and anything that later references it) survives.
update public.sources s set slug = m.slug
  from (values
    -- 12 that the seed already describes
    ('AuctionZip',            'auctionzip'),
    ('Craigslist',            'craigslist'),
    ('EstateSales.net',       'estatesales-net'),
    ('Facebook Marketplace',  'facebook-marketplace'),
    ('GoToAuction',           'gotoauction'),
    ('GovDeals Wisconsin',    'govdeals'),
    ('GovPlanet',             'govplanet'),
    ('GSA Auctions',          'gsa-auctions'),
    ('HiBid',                 'hibid'),
    ('Municibid',             'municibid'),
    ('PublicSurplus',         'public-surplus'),
    ('Wisconsin Surplus',     'wisconsin-surplus'),
    -- 11 that were missing from the seed and have now been added to it
    ('B-Stock',               'b-stock'),
    ('BidSpotter',            'bidspotter'),
    ('Copart',                'copart'),
    ('IAAI',                  'iaai'),
    ('IronPlanet',            'ironplanet'),
    ('Jones Auction Service', 'jones-auction-service'),
    ('Liquidation.com',       'liquidation-com'),
    ('PropertyRoom',          'propertyroom'),
    ('Ritchie Bros',          'ritchie-bros'),
    ('ShopGoodwill',          'shopgoodwill'),
    ('Smith Auctions',        'smith-auctions')
  ) as m(name, slug)
 where s.name = m.name
   and s.slug is null;
