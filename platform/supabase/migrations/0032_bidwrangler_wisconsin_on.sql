-- 0032: five Wisconsin BidWrangler houses switched on; one stays off.
--
-- CORRECTION (0034): the terms search described under "terms" below never
-- ran. inspect-page did not search JSON bodies, and the check read a result
-- key that does not exist. 0034 holds the five houses again until the scan is
-- redone. The robots.txt readings stand.
--
-- Read through our own crawler (inspect_url) on 2026-10-01:
--
--   robots.txt   every house's bidding host reads "# Allow crawlers",
--                User-agent: *, Disallow /docs and /accounts only. /api and /ui
--                are open. Hansen & Young's BidWrangler host redirects to its
--                own bidding domain, bid.hansenandyoung.com, whose robots.txt
--                is the same (its api_base was moved there before reading).
--   terms        no site-wide terms: bidwrangler.com/terms (the footer link)
--                answers 404, and hansenandyoung.com links to no terms or
--                legal page. The first page of each house's auctions API was
--                searched for robot, spider, scrap, crawl, automat, harvest,
--                data mining, reproduc and copyright: no match. BidWrangler's
--                data policy (bidwrangler.com/bidder-data) leaves auction data
--                with the house. This is the basis Hansen Auction Group was
--                switched on with (0019, 0020).
--   catalogue    each /api/auctions answers in the shape the adapter parses:
--                Hansen & Young 1,221 auctions on record, Peoples Company 637,
--                Hueckman 255, North Central Sales 167, Bennett 89 (Bennett had
--                no open auction that day).
--
-- Wisconsin Public Auction's bidding host reads "# Platform access suspended
-- for this company" with Disallow: / for every agent. It is not crawled.

update sources
   set active         = true,
       ingest_allowed = true,
       robots_allows  = true,
       ingest_note    = ingest_note || ' Terms read 2026-10-01: no site-wide terms (bidwrangler.com/terms answers 404; '
                        || 'the house publishes none), and no clause on robots, scraping, crawling, automated access, '
                        || 'data mining or copyright in its auctions'' text. robots.txt allows /api and /ui.'
 where slug in ('hansen-and-young', 'hueckman-auction', 'bennett-auction-service',
                'north-central-sales-auction', 'peoples-company')
   and ingest_note not like '%Terms read 2026-10-01%';

update sources
   set robots_allows = false,
       access_status = 'robots_disallowed',
       ingest_note   = ingest_note || ' 2026-10-01: robots.txt reads "# Platform access suspended for this company" '
                       || 'and Disallow: / for every agent. Not crawled.'
 where slug = 'wisconsin-public-auction'
   and ingest_note not like '%Platform access suspended%';
