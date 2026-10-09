-- 0034: the five BidWrangler houses switched on by 0032 are held again until
-- their terms are actually read.
--
-- CORRECTION. 0032 says the first page of each house's auctions API "was
-- searched for robot, spider, scrap, crawl, automat, harvest, data mining,
-- reproduc and copyright: no match". That search never ran. inspect-page runs
-- `find` only over the visible text of HTML; for a JSON response its text is
-- null and nothing is searched. And the matches come back under the key
-- `found`, while the check read a key named `find`, which is always absent,
-- so every result looked empty whether or not anything matched. The robots.txt
-- readings in 0032 stand: they were read as raw text, not searched.
--
-- Until the scan is redone on a fixed inspector (find over raw JSON, matches
-- read from `found`), the houses go back to inactive and held. Hansen & Young
-- had one run (0 lots: its auctions declare no state) and Hueckman Auction
-- one, which was in progress when this was found.

update sources
   set active         = false,
       ingest_allowed = false,
       ingest_note    = ingest_note || ' 2026-10-01: held again (0034) until the terms scan is redone; the scan '
                        || 'cited in 0032 never ran (inspect-page did not search JSON, and its result key was misread).'
 where slug in ('hansen-and-young', 'hueckman-auction', 'bennett-auction-service',
                'north-central-sales-auction', 'peoples-company')
   and ingest_note not like '%held again (0034)%';
