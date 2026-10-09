-- 0036: the five Wisconsin BidWrangler houses held by 0034 are switched on
-- again, now that their terms have actually been read.
--
-- Read through our own crawler on 2026-10-01 with inspect-page v7, which
-- searches a JSON body's raw text and returns the matches under `found` (the
-- two faults behind 0032's empty result, see 0034):
--
--   terms        page 1 of each house's /api/auctions, which carries every open
--                sale first with its full description and terms of sale:
--                Hansen & Young 874,988 bytes, Hueckman 968,291, Bennett
--                789,529, North Central Sales 1,435,816, Peoples Company
--                676,523. Searched for robot, spider, scrap, crawl, automat
--                (other than "automatically extend" and "automatic bid"),
--                harvest, data mining, reproduc, copyright, "unauthorized use"
--                and systematic.
--                Every match was merchandise or styling:
--                  - merchandise: "Steel Stock & Scrap", "Scrap Metal", a
--                    "Pull Behind Scraper", a "Nuhn Lagoon Crawler",
--                    "Automatic Roller Mill", "International Harvester",
--                    "Spiderman" collectibles, crops "after harvest";
--                  - styling: the font name "Roboto" in inline styles.
--                Hueckman matched nothing at all. No house matched copyright,
--                reproduc, data mining or "unauthorized use".
--   platform     www.bidwrangler.com links only /bidder-data and
--                /privacy-policy. It publishes no terms of use (/terms answers
--                404), so there is no platform clause on automated access.
--   robots.txt   unchanged from 0032: /api and /ui allowed for every agent.
--
-- Hansen & Young and Peoples Company leave every sale's location object empty
-- and state the place in the sale's summary ("ADDRESS: ELEVA, WI"; "Dane
-- County, Wisconsin"). crawl-private v7 reads those two labelled forms
-- (textDeclaredLocation), so their Wisconsin sales are no longer set aside.
-- The lots stored before 0034 (Hueckman 729, North Central Sales 389) stay:
-- they were read under the same terms.

update sources
   set active         = true,
       ingest_allowed = true,
       robots_allows  = true,
       ingest_note    = ingest_note || ' 2026-10-01 (0036): terms scan redone on inspect-page v7 over each house''s '
                        || 'open sales: no clause on robots, scraping, crawling, automated access, data mining, '
                        || 'reproduction or copyright; every match was merchandise or styling. BidWrangler publishes '
                        || 'no terms of use. Switched on again.'
 where slug in ('hansen-and-young', 'hueckman-auction', 'bennett-auction-service',
                'north-central-sales-auction', 'peoples-company')
   and ingest_note not like '%(0036)%';
