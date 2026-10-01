-- 0038: the Wisconsin Department of Revenue's public auctions page switched on.
--
-- Its terms were read in 0037: revenue.wi.gov pages are public domain unless a
-- copyright is indicated, and robots.txt blocks only SharePoint internals.
-- crawl-public v4 carries the adapter (platform 'wi-dor'): one request an hour
-- to /Pages/PublicAuction/home.aspx, one sale-level row per listed sale, the
-- notice of sale (PDF) linked and never fetched.

update sources
   set active         = true,
       ingest_allowed = true,
       robots_allows  = true,
       ingest_note    = ingest_note || ' 2026-10-01 (0038): switched on with its adapter (crawl-public v4): sale-level '
                        || 'rows, one request an hour.'
 where slug = 'wi-dor-auctions'
   and ingest_note not like '%(0038)%';
